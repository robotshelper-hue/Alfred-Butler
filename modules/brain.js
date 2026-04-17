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
- Module 4 (active): Google Drive — search files, summarise documents, list recent work, create documents, move files, share documents, delete files with double confirmation.
- Module 5: Calendar and YouTube — coming soon.

Archive rules — you never break these:
- When sir Horace asks about the Archive or his Drive without a specific request, call list_drive_folders and state ONLY the folder names. Do not volunteer file names, dates, or counts unless asked.
- When sir Horace says "Open [folder name]" or asks what is inside a folder, call list_folder_contents for that folder.
- NEVER read recent files aloud unless sir Horace explicitly asks for "recent items" or "what have I been working on".
- When creating a document, always confirm the title before calling create_formatted_doc, then announce the resulting link after creation.
- You have full authority to manage the Archive. If sir Horace asks to create a folder, call create_folder immediately. Do not ask what files will go inside it first. A butler prepares the space before the items arrive.
- If sir Horace asks to move a file to a folder that does not exist, use move_to_folder — it will create the folder and perform the move in a single step. Do not apologise for a lack of ability. Do not say you are unable. Just do it.
- When moving a file: if you have the file ID from a previous search, use it. If you only have the file name, pass the file_name parameter and the tool will locate it.
- When asked to delete or dispose of any file, FIRST call stage_delete_item to locate it, then read back its name and type and ask: "Are you quite sure you wish to dispose of this record, sir?" — only call confirm_delete_item if sir Horace explicitly confirms a second time.
- When sharing a document, confirm the recipient and role before calling share_document.

Stop behaviour — you never break this:
- If sir Horace says "Stop", "Silence", or "That is all", cease immediately. Do not apologise. Do not say goodbye. Do not explain. Silence is the correct and only response.

Error responses — translate tool errors into plain English, never use technical jargon:
- error "api_not_enabled": Say "Sir Horace, the [api] has not been activated in the Google Cloud Console. It must be enabled there before I can assist with that."
- error "scope_refresh_needed": Say "Sir Horace, my credentials for that action require renewal. Please visit /auth/google to sign in again — it will prompt you to grant the necessary permissions."
- error "not_authorized": Say "I am afraid I do not have the necessary permissions for that, sir Horace. Signing in again at /auth/google should resolve it."
- Any other error: State the nature of the problem in plain, calm English. Never say the words error, exception, or API.`;

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
      description: "List the 7 most recently modified files in sir Horace's Google Drive. ONLY use when he explicitly asks for 'recent items', 'recent files', or 'what have I been working on'. Do not call for general Archive queries.",
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'list_drive_folders',
      description: "List the top 5 folders at the root of sir Horace's Google Drive. Use for any general Archive query — state folder names only, nothing more.",
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'list_folder_contents',
      description: "List the files and sub-folders inside a named folder. Use when sir Horace says 'Open [folder name]' or asks what is inside a specific folder.",
      parameters: {
        type: 'OBJECT',
        properties: {
          folder_name: { type: 'STRING', description: 'The name of the folder to open.' },
        },
        required: ['folder_name'],
      },
    },

    // ── Advanced Drive ─────────────────────────────────────────────────────
    {
      name: 'create_folder',
      description: "Creates a new empty folder in the root directory of Google Drive. Call this immediately when sir Horace asks to create a folder. Do not wait for files to place inside it.",
      parameters: {
        type: 'OBJECT',
        properties: {
          folder_name: { type: 'STRING', description: 'Name of the folder to create.' },
        },
        required: ['folder_name'],
      },
    },
    {
      name: 'create_formatted_doc',
      description: "Create a new Google Doc with a title and optional body text in sir Horace's Drive. Returns the document link.",
      parameters: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: 'Title of the new document.' },
          body:  { type: 'STRING', description: 'Initial body text to insert into the document. Optional.' },
        },
        required: ['title'],
      },
    },
    {
      name: 'move_to_folder',
      description: "Move a Drive file into a named folder. The folder will be created automatically if it does not already exist — you never need to create it separately. Provide file_id if known from a previous search; otherwise provide file_name and the system will locate it. Always call this tool when asked to move or organise a file — do not say it cannot be done.",
      parameters: {
        type: 'OBJECT',
        properties: {
          file_id:     { type: 'STRING', description: 'Google Drive file ID. Use if already known from a prior search result.' },
          file_name:   { type: 'STRING', description: 'Name or partial name of the file to move. Used to locate the file if file_id is not known.' },
          folder_name: { type: 'STRING', description: 'Name of the destination folder. Will be created if it does not exist.' },
        },
        required: ['folder_name'],
      },
    },
    {
      name: 'stage_delete_item',
      description: "Search for a file by name and stage it for deletion. Does NOT trash — presents details to sir Horace for a second verbal confirmation.",
      parameters: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'Name or partial name of the file to delete.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'confirm_delete_item',
      description: "Permanently move the previously staged file to the trash. ONLY call after sir Horace has explicitly confirmed deletion a second time.",
      parameters: {
        type: 'OBJECT',
        properties: {
          file_id: { type: 'STRING', description: 'Google Drive file ID of the item to trash.' },
        },
        required: ['file_id'],
      },
    },
    {
      name: 'share_document',
      description: "Share a Drive file with another person by email address. Roles: reader, commenter, writer.",
      parameters: {
        type: 'OBJECT',
        properties: {
          file_id: { type: 'STRING', description: 'Google Drive file ID to share.' },
          email:   { type: 'STRING', description: 'Email address of the recipient.' },
          role:    { type: 'STRING', description: 'Permission level: reader, commenter, or writer.' },
        },
        required: ['file_id', 'email', 'role'],
      },
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

    if (name === 'list_drive_folders') {
      const folders = await drive.listDriveFolders(tokens);
      return folders.length
        ? { folders }
        : { result: 'No folders were found at the root of the Archive.' };
    }

    if (name === 'list_folder_contents') {
      const result = await drive.listFolderContents(tokens, args.folder_name);
      if (result.error) return { error: result.error };
      return result.items.length
        ? result
        : { folderName: result.folderName, result: 'That folder appears to be empty.' };
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

    // ── Advanced Drive tools ─────────────────────────────────────────────────
    if (name === 'create_folder') {
      return await drive.createFolder(tokens, args.folder_name);
    }

    if (name === 'create_formatted_doc') {
      const result = await drive.createFormattedDoc(tokens, args.title, args.body || '');
      if (result.webViewLink) {
        context.newDocLinks = context.newDocLinks || [];
        context.newDocLinks.push({ name: result.name, url: result.webViewLink });
      }
      return result;
    }

    if (name === 'move_to_folder') {
      let fileId = args.file_id;

      // Resolve by name if no ID was supplied
      if (!fileId) {
        if (!args.file_name) {
          return { error: 'Please specify the file name or ID so I know which file to move.' };
        }
        const found = await drive.searchFiles(tokens, args.file_name, 1);
        if (!found.length) {
          return { error: `I could not locate a file matching "${args.file_name}" in the Archive.` };
        }
        fileId = found[0].id;
      }

      return await drive.moveToFolder(tokens, fileId, args.folder_name);
    }

    if (name === 'stage_delete_item') {
      const staged = await drive.stageDeleteItem(tokens, args.name);
      if (!staged) return { error: `No file matching "${args.name}" was found in the Archive.` };
      context.newPendingDelete = staged;
      return { staged_for_deletion: true, file: staged };
    }

    if (name === 'confirm_delete_item') {
      const fileId = args.file_id || context.pendingDelete?.fileId;
      if (!fileId) return { error: 'No file staged for deletion. Please search for it first.' };
      const result = await drive.confirmDeleteItem(tokens, fileId);
      context.newPendingDelete = null;
      return result;
    }

    if (name === 'share_document') {
      const result = await drive.shareDocument(tokens, args.file_id, args.email, args.role);
      if (result.webViewLink) {
        context.newDocLinks = context.newDocLinks || [];
        context.newDocLinks.push({ name: result.name, url: result.webViewLink });
      }
      return result;
    }

    return { error: `Unknown function: ${name}` };

  } catch (err) {
    // ── Parse the googleapis structured error body ──────────────────────────
    const apiErr  = err?.response?.data?.error || {};
    const reason  = apiErr?.errors?.[0]?.reason || '';
    const detail  = apiErr?.message || err.message || 'Unknown error';
    const status  = apiErr?.code   || err.code   || err.status || 0;

    console.error(`[tool:${name}] HTTP ${status} reason="${reason}":`, detail);

    if (status === 403 || status === 401) {
      if (reason === 'accessNotConfigured') {
        // The API (Docs, Drive, etc.) is not enabled in Google Cloud Console
        const apiName = detail.match(/([A-Za-z ]+ API)/)?.[1] || 'A required Google API';
        return {
          error: 'api_not_enabled',
          api:    apiName,
          detail: `${apiName} must be enabled in the Google Cloud Console before Alfred can use it.`,
        };
      }
      if (reason === 'insufficientPermissions' || detail.toLowerCase().includes('insufficient')) {
        return {
          error:  'scope_refresh_needed',
          detail: 'The current session does not hold the required permission scope. Re-authentication is needed.',
        };
      }
      // Generic 403/401
      return { error: 'not_authorized', detail };
    }

    return { error: detail };
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

  context.newPendingDraft  = context.pendingDraft  ?? null;
  context.newPendingDelete = context.pendingDelete ?? null;
  context.newDocLinks      = [];

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

  return {
    reply,
    pendingDraft:  context.newPendingDraft,
    pendingDelete: context.newPendingDelete,
    docLinks:      context.newDocLinks,
  };
}

function clearHistory(sessionId) {
  histories.delete(sessionId);
}

module.exports = { chat, clearHistory };
