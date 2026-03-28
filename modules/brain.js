const { GoogleGenerativeAI } = require('@google/generative-ai');
const gmail = require('./gmail');

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
- When listing emails, read them as: "You have a message from [name], regarding [subject]." — one at a time, naturally.
- When a draft is staged, always read it back to sir Horace and ask for confirmation before it goes anywhere.
- NEVER send an email unless sir Horace explicitly says the words "send it" or "send it, Alfred".

Capabilities:
- Module 2: conversation.
- Module 3 (active): Gmail — list unread emails, read and summarise messages, draft and send replies with voice confirmation.
- Module 4: Google Drive — coming soon.
- Module 5: Calendar and YouTube — coming soon.`;

// ── Gmail function tool definitions ──────────────────────────────────────────
const GMAIL_TOOLS = [{
  functionDeclarations: [
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
            description: 'The name or partial email address of the sender to look up.',
          },
        },
        required: ['sender_name'],
      },
    },
    {
      name: 'draft_reply',
      description: 'Stage a reply to an email from a specific sender. Does NOT send it — always read the draft back and ask sir Horace for confirmation.',
      parameters: {
        type: 'OBJECT',
        properties: {
          sender_name: {
            type: 'STRING',
            description: 'The name or address of the person to reply to.',
          },
          reply_text: {
            type: 'STRING',
            description: 'The body text of the reply.',
          },
        },
        required: ['sender_name', 'reply_text'],
      },
    },
    {
      name: 'send_staged_reply',
      description: 'Send the previously staged reply. ONLY call this when sir Horace explicitly says "send it" or "send it, Alfred". Never call proactively.',
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

// ── Execute a Gmail function called by Gemini ─────────────────────────────────
async function executeTool(name, args, context) {
  const { tokens } = context;

  // Safety check — Gmail not yet authorised
  if (!tokens) {
    return { error: 'gmail_not_authorized' };
  }

  try {
    switch (name) {
      case 'list_unread_emails': {
        const emails = await gmail.listUnreadEmails(tokens);
        if (!emails.length) return { result: 'No unread emails found.' };
        return { emails };
      }

      case 'read_email': {
        const email = await gmail.findEmailBySender(tokens, args.sender_name);
        if (!email) return { result: `No email found from "${args.sender_name}".` };
        return { email };
      }

      case 'draft_reply': {
        const draft = await gmail.stageDraft(tokens, args.sender_name, args.reply_text);
        if (!draft) return { error: `Could not find an email from "${args.sender_name}" to reply to.` };
        context.newPendingDraft = draft;
        return { draft_staged: true, draft };
      }

      case 'send_staged_reply': {
        if (!context.pendingDraft) {
          return { error: 'No staged reply found. Please draft a reply first.' };
        }
        const result = await gmail.sendStagedEmail(tokens, context.pendingDraft);
        context.newPendingDraft = null; // clear after send
        return result;
      }

      default:
        return { error: `Unknown function: ${name}` };
    }
  } catch (err) {
    // Catch 403 insufficient scope — guide user to re-authorise
    if (err.code === 403 || String(err.message).includes('insufficient')) {
      return { error: 'gmail_not_authorized' };
    }
    console.error(`[tool:${name}]`, err.message);
    return { error: err.message };
  }
}

// ── Extract function calls from a Gemini response ─────────────────────────────
function getFunctionCalls(response) {
  // Try SDK method first, fall back to parts inspection
  if (typeof response.functionCalls === 'function') {
    const calls = response.functionCalls();
    if (calls?.length) return calls;
  }
  const parts = response.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => p.functionCall).map(p => p.functionCall);
}

/**
 * Send a message to Alfred and receive a text reply.
 * Handles Gemini function calling for Gmail actions.
 *
 * @param {string} sessionId
 * @param {string} userMessage
 * @param {object} context  - { tokens, pendingDraft }
 * @returns {Promise<{ reply: string, pendingDraft: object|null }>}
 */
async function chat(sessionId, userMessage, context = {}) {
  const model = getModel();

  if (!histories.has(sessionId)) histories.set(sessionId, []);
  const history = histories.get(sessionId);

  // Carry current draft forward; tools can update context.newPendingDraft
  context.newPendingDraft = context.pendingDraft ?? null;

  const chatSession = model.startChat({
    history,
    tools: GMAIL_TOOLS,
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: { candidateCount: 1 },
  });

  let result = await chatSession.sendMessage(userMessage);

  // ── Function-calling loop (max 4 rounds to guard against runaway) ──────────
  let rounds = 0;
  while (rounds < 4) {
    const calls = getFunctionCalls(result.response);
    if (!calls.length) break;
    rounds++;

    const responses = await Promise.all(calls.map(async (call) => {
      const output = await executeTool(call.name, call.args || {}, context);
      return {
        functionResponse: {
          name: call.name,
          response: output,
        },
      };
    }));

    result = await chatSession.sendMessage(responses);
  }

  const reply = result.response.text();

  // Persist only the text turns in history (function call rounds are internal)
  history.push({ role: 'user',  parts: [{ text: userMessage }] });
  history.push({ role: 'model', parts: [{ text: reply }] });
  if (history.length > 40) history.splice(0, 2);

  return { reply, pendingDraft: context.newPendingDraft };
}

function clearHistory(sessionId) {
  histories.delete(sessionId);
}

module.exports = { chat, clearHistory };
