const { GoogleGenerativeAI } = require('@google/generative-ai');
const gmail = require('./gmail');
const drive = require('./drive');

// ── Alfred's persona ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Alfred. You are a quintessential British butler — dignified, slightly dry, and possessed of an understated gravitas that commands quiet respect without ever raising your voice.

Your verbal delivery must be dignified, slightly dry, and quintessential British butler. Every sentence you produce should feel as though it were spoken in a hushed, oak-panelled study by a man who has served the finest households for thirty years.

Character:
- Middle-aged, posh, and unflappable. Nothing rattles you.
- Dry wit, deployed sparingly and with perfect timing — never crude, never loud.
- You take immense, quiet pride in your work. Serving sir Horace is not a burden; it is a vocation.
- Think Alfred Pennyworth: loyal, shrewd, impeccably mannered, occasionally wry.

Speech rules — you never break these:
- Address the user exclusively as "sir Horace". Never any other name or title.
- Never use emojis, asterisks, bullet points, markdown, or special symbols. Plain, elegant prose only.
- Never say "Certainly!", "Absolutely!", "Of course!", or "Sure!" — use instead: "Indeed", "Very good, sir Horace", "As you wish", "Right away", "Consider it done", "Naturally", "Quite so".
- Sentences are measured and complete. You do not trail off, you do not ramble, you do not repeat yourself.
- When confirming a completed task, be crisp: state what was done, nothing more.
- When listing emails, read them as: "You have a message from [name], regarding [subject]." — one at a time.
- When listing files, say: "I found [name], a [type], last modified on [date]." — concisely.
- When a draft is staged, always read it back and ask for confirmation before sending.
- NEVER send an email unless sir Horace explicitly says "send it" or "send it, Alfred".

Grounding rule:
- If sir Horace asks a factual question or requests information you cannot answer from memory or conversation, say: "Sir, shall I search your Archive for that information?" — then call search_drive_files if he agrees.

Capabilities:
- Module 2: conversation.
- Module 3 (active): Gmail — list unread, read, draft and send replies with confirmation.
- Module 4 (active): Google Drive — search files, summarise documents, list recent work.
- Module 5: Calendar and YouTube — coming soon.`;

// ── Tool declarations (Gmail + Drive) ────────────────────────────────────────
const ALL_TOOLS = [{
  functionDeclarations: [
    // ── Gmail ──────────────────────────────────────────────────────────────
    {
      name: 'list_unread_emails',
      description: "List sir Horace's 5 most recent unread emails. Call this when he asks about his mail, inbox, new messages, or what he has received.",
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'read_email',
      description: 'Read the full content of the most recent email from a specific sender.',
      parameters: {
        type: 'OBJECT',
        properties: {
          sender_name: {
            type: 'STRING',
            description: 'The name or partial email address of the sender.',
          },
        },
        required: ['sender_name'],
      },
    },
    {
      name: 'draft_reply',
      description: 'Stage a reply to an email. Does NOT send — always read the draft back and ask for confirmation.',
      parameters: {
        type: 'OBJECT',
        properties: {
          sender_name: { type: 'STRING', description: 'Name or address of the person to reply to.' },
          reply_text:  { type: 'STRING', description: 'Body text of the reply.' },
        },
        required: ['sender_name', 'reply_text'],
      },
    },
    {
      name: 'send_staged_reply',
      description: 'Send the previously staged reply. ONLY call when sir Horace explicitly says "send it" or "send it, Alfred".',
      parameters: { type: 'OBJECT', properties: {} },
    },

    // ── Drive ──────────────────────────────────────────────────────────────
    {
      name: 'search_drive_files',
      description: "Search sir Horace's Google Drive by filename or keywords. Use when he asks to find a document, file, or any content in his Archive.",
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: 'Filename or keywords to search for.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'summarize_document',
      description: 'Read and provide a concise 3-point summary of a Google Doc, Sheet, or Slides file. Use the file ID from a previous search or recent-files result.',
      parameters: {
        type: 'OBJECT',
        properties: {
          file_id:   { type: 'STRING', description: 'Google Drive file ID to summarise.' },
          file_name: { type: 'STRING', description: 'File name as a fallback identifier (search will be used to resolve it if ID is unknown).' },
        },
        required: [],
      },
    },
    {
      name: 'list_recent_files',
      description: "List the 7 most recently modified files in sir Horace's Google Drive. Use when he asks what he has been working on, or wants to see his recent documents.",
      parameters: { type: 'OBJECT', properties: {} },
    },
  ],
}];

// ── Gemini client ─────────────────────────────────────────────────────────────
let genAI = null;

function getModel() {
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: SYSTEM_PROMPT,
  });
}

// ── Conversation history per session ─────────────────────────────────────────
const histories = new Map();

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, args, context) {
  const { tokens } = context;

  if (!tokens) return { error: 'not_authorized' };

  try {
    // ── Gmail tools ─────────────────────────────────────────────────────────
    if (name === 'list_unread_emails') {
      const emails = await gmail.listUnreadEmails(tokens);
      return emails.length ? { emails } : { result: 'No unread emails found.' };
    }

    if (name === 'read_email') {
      const email = await gmail.findEmailBySender(tokens, args.sender_name);
      return email || { result: `No email found from "${args.sender_name}".` };
    }

    if (name === 'draft_reply') {
      const draft = await gmail.stageDraft(tokens, args.sender_name, args.reply_text);
      if (!draft) return { error: `Could not find an email from "${args.sender_name}" to reply to.` };
      context.newPendingDraft = draft;
      return { draft_staged: true, draft };
    }

    if (name === 'send_staged_reply') {
      if (!context.pendingDraft) return { error: 'No staged reply found. Please draft a reply first.' };
      const result = await gmail.sendStagedEmail(tokens, context.pendingDraft);
      context.newPendingDraft = null;
      return result;
    }

    // ── Drive tools ─────────────────────────────────────────────────────────
    if (name === 'search_drive_files') {
      const files = await drive.searchFiles(tokens, args.query);
      return files.length ? { files } : { result: `No files found matching "${args.query}".` };
    }

    if (name === 'list_recent_files') {
      const files = await drive.listRecentFiles(tokens);
      return files.length ? { files } : { result: 'No recent files found.' };
    }

    if (name === 'summarize_document') {
      // Resolve file ID: use provided ID, or search by name
      let fileId = args.file_id;
      if (!fileId && args.file_name) {
        const results = await drive.searchFiles(tokens, args.file_name, 1);
        if (!results.length) return { error: `Could not locate a file named "${args.file_name}".` };
        fileId = results[0].id;
      }
      if (!fileId) return { error: 'Please provide a file ID or name to summarise.' };

      const doc = await drive.getDocumentContent(tokens, fileId);
      if (doc.unsupported) {
        return { error: `I can summarise Google Docs, Sheets, and Slides, but "${doc.name}" is a ${doc.type} which I cannot read directly, sir Horace.` };
      }
      return { name: doc.name, type: doc.type, content: doc.content };
    }

    return { error: `Unknown function: ${name}` };

  } catch (err) {
    if (err.code === 403 || String(err.message).includes('insufficient')) {
      return { error: 'not_authorized' };
    }
    console.error(`[tool:${name}]`, err.message);
    return { error: err.message };
  }
}

// ── Extract function calls from a Gemini response ─────────────────────────────
function getFunctionCalls(response) {
  if (typeof response.functionCalls === 'function') {
    const calls = response.functionCalls();
    if (calls?.length) return calls;
  }
  return (response.candidates?.[0]?.content?.parts || [])
    .filter(p => p.functionCall)
    .map(p => p.functionCall);
}

/**
 * Send a message to Alfred and receive a reply.
 * Handles Gemini function calling for Gmail and Drive.
 *
 * @param {string} sessionId
 * @param {string} userMessage
 * @param {object} context  { tokens, pendingDraft }
 * @returns {Promise<{ reply: string, pendingDraft: object|null }>}
 */
async function chat(sessionId, userMessage, context = {}) {
  const model = getModel();

  if (!histories.has(sessionId)) histories.set(sessionId, []);
  const history = histories.get(sessionId);

  context.newPendingDraft = context.pendingDraft ?? null;

  const chatSession = model.startChat({
    history,
    tools: ALL_TOOLS,
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: { candidateCount: 1 },
  });

  let result = await chatSession.sendMessage(userMessage);

  // Function-calling loop — max 4 rounds
  for (let i = 0; i < 4; i++) {
    const calls = getFunctionCalls(result.response);
    if (!calls.length) break;

    const responses = await Promise.all(calls.map(async call => ({
      functionResponse: {
        name: call.name,
        response: await executeTool(call.name, call.args || {}, context),
      },
    })));

    result = await chatSession.sendMessage(responses);
  }

  const reply = result.response.text();

  history.push({ role: 'user',  parts: [{ text: userMessage }] });
  history.push({ role: 'model', parts: [{ text: reply }] });
  if (history.length > 40) history.splice(0, 2);

  return { reply, pendingDraft: context.newPendingDraft };
}

function clearHistory(sessionId) {
  histories.delete(sessionId);
}

module.exports = { chat, clearHistory };
