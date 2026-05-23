/**
 * Module 3 — Gmail Integration
 *
 * Provides:
 *   listUnreadEmails(tokens)              → last 5 unread, sender + subject only
 *   findEmailBySender(tokens, name)       → full body of most recent email from sender
 *   searchEmails(tokens, query)           → find emails by subject, sender, or keyword
 *   stageDraft(tokens, name, text)        → stage a reply (does NOT send)
 *   sendStagedEmail(tokens, draft)        → send a previously staged draft
 *   trashMessage(tokens, messageId)       → move a message to the bin
 *
 * TEXT-ONLY rule: email bodies are stripped of HTML, emojis, and markdown
 * before being passed to Alfred so he never reads them aloud verbatim.
 */

const { google } = require('googleapis');

// ── OAuth client ──────────────────────────────────────────────────────────────
function createAuth(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials(tokens);
  return client;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getHeader(headers = [], name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

/** Recursively extract plain text from a Gmail payload */
function extractText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  if (payload.parts?.length) {
    // Prefer text/plain parts
    const plain = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plain) return extractText(plain);
    for (const part of payload.parts) {
      const text = extractText(part);
      if (text) return text;
    }
  }
  return '';
}

/** Strip emojis + special chars so Alfred never reads them aloud */
function sanitiseForSpeech(text) {
  return text
    .replace(/[*_~`#>|]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Gmail API calls ───────────────────────────────────────────────────────────

/**
 * List the 5 most recent unread emails from the last 7 days (metadata only).
 * Results are sorted newest-first by internalDate.
 * Returns array of { id, threadId, from, fromName, subject, date, snippet }
 */
async function listUnreadEmails(tokens) {
  const gmail = google.gmail({ version: 'v1', auth: createAuth(tokens) });

  // Build an after: date string 7 days ago so old receipts/newsletters are excluded
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const afterStr = `${since.getFullYear()}/${String(since.getMonth() + 1).padStart(2, '0')}/${String(since.getDate()).padStart(2, '0')}`;

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: `is:unread in:inbox after:${afterStr}`,
    maxResults: 10, // fetch extra so sort+slice gives the true 5 newest
  });

  const messages = list.data.messages || [];
  if (!messages.length) return [];

  const details = await Promise.all(messages.map(msg =>
    gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    })
  ));

  // Sort by internalDate (ms epoch) — newest first — then take top 5
  details.sort((a, b) => Number(b.data.internalDate) - Number(a.data.internalDate));
  const top5 = details.slice(0, 5);

  return top5.map(({ data }) => {
    const headers = data.payload?.headers || [];
    const from = getHeader(headers, 'From');
    const fromName = from.replace(/<[^>]+>/, '').trim() || from;
    return {
      id: data.id,
      threadId: data.threadId,
      from,
      fromName: sanitiseForSpeech(fromName),
      subject: sanitiseForSpeech(getHeader(headers, 'Subject')),
      date: getHeader(headers, 'Date'),
      snippet: sanitiseForSpeech(data.snippet || ''),
    };
  });
}

/**
 * Find the most recent email from a sender (fuzzy name/address match).
 * Returns full body text (truncated to 2000 chars for context window).
 */
async function findEmailBySender(tokens, senderName) {
  const gmail = google.gmail({ version: 'v1', auth: createAuth(tokens) });

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: `from:${senderName}`,
    maxResults: 1,
  });

  const messages = list.data.messages || [];
  if (!messages.length) return null;

  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id: messages[0].id,
    format: 'full',
  });

  const headers = data.payload?.headers || [];
  const body = sanitiseForSpeech(extractText(data.payload)).slice(0, 2000);
  const from = getHeader(headers, 'From');

  return {
    id: data.id,
    threadId: data.threadId,
    from,
    fromName: sanitiseForSpeech(from.replace(/<[^>]+>/, '').trim() || from),
    to: getHeader(headers, 'To'),
    subject: sanitiseForSpeech(getHeader(headers, 'Subject')),
    date: getHeader(headers, 'Date'),
    body,
  };
}

/**
 * Search emails by Gmail query string (supports subject:, from:, keywords, etc.).
 * Returns up to 5 matches with id, subject, fromName.
 */
async function searchEmails(tokens, query) {
  const gmail = google.gmail({ version: 'v1', auth: createAuth(tokens) });

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 5,
  });

  const messages = list.data.messages || [];
  if (!messages.length) return [];

  const details = await Promise.all(messages.map(msg =>
    gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    })
  ));

  // Sort newest first by internalDate
  details.sort((a, b) => Number(b.data.internalDate) - Number(a.data.internalDate));

  return details.map(({ data }) => {
    const headers  = data.payload?.headers || [];
    const from     = getHeader(headers, 'From');
    const fromName = from.replace(/<[^>]+>/, '').trim() || from;
    return {
      id:       data.id,
      threadId: data.threadId,
      fromName: sanitiseForSpeech(fromName),
      subject:  sanitiseForSpeech(getHeader(headers, 'Subject')),
      date:     getHeader(headers, 'Date'),
    };
  });
}

/**
 * Move a message to the user's Gmail Bin (Trash).
 * Returns { trashed: true, subject, fromName }.
 */
async function trashMessage(tokens, messageId) {
  const gmail = google.gmail({ version: 'v1', auth: createAuth(tokens) });

  // Fetch metadata for the confirmation message
  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: ['From', 'Subject'],
  });

  await gmail.users.messages.trash({ userId: 'me', id: messageId });

  const headers  = data.payload?.headers || [];
  const from     = getHeader(headers, 'From');
  const fromName = from.replace(/<[^>]+>/, '').trim() || from;

  return {
    trashed:  true,
    subject:  sanitiseForSpeech(getHeader(headers, 'Subject')),
    fromName: sanitiseForSpeech(fromName),
  };
}

/**
 * Stage a reply — locate the email, store the pending draft in memory.
 * Does NOT send anything. Returns the staged draft object.
 */
async function stageDraft(tokens, senderName, replyText) {
  const email = await findEmailBySender(tokens, senderName);
  if (!email) return null;

  return {
    messageId: email.id,
    threadId:  email.threadId,
    to:        email.from,          // Reply to the original sender
    subject:   email.subject.match(/^re:/i) ? email.subject : `Re: ${email.subject}`,
    replyText: sanitiseForSpeech(replyText),
  };
}

/**
 * Send the previously staged email draft.
 */
async function sendStagedEmail(tokens, draft) {
  const gmail = google.gmail({ version: 'v1', auth: createAuth(tokens) });

  const rfc2822 = [
    `To: ${draft.to}`,
    `Subject: ${draft.subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    draft.replyText,
  ].join('\r\n');

  const raw = Buffer.from(rfc2822).toString('base64url');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: draft.threadId },
  });

  return { sent: true, to: draft.to, subject: draft.subject };
}

module.exports = { listUnreadEmails, findEmailBySender, searchEmails, stageDraft, sendStagedEmail, trashMessage };
