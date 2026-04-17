/**
 * Module 4 — Google Drive Integration (The Archive)
 *
 * Provides:
 *   listRecentFiles(tokens)              → 7 most recently modified files
 *   searchFiles(tokens, query)           → search by name or full-text keywords
 *   getDocumentContent(tokens, fileId)   → export Google Doc/Sheet/Slide as plain text
 *   summarizeDocument(tokens, fileId)    → returns raw text for Gemini to summarise
 *
 * TEXT-ONLY rule: all content is stripped of markdown/emoji before
 * being passed to Alfred's voice pipeline.
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

// ── MIME type helpers ─────────────────────────────────────────────────────────
const GOOGLE_MIME_LABELS = {
  'application/vnd.google-apps.document':     'Google Doc',
  'application/vnd.google-apps.spreadsheet':  'Google Sheet',
  'application/vnd.google-apps.presentation': 'Google Slides',
  'application/vnd.google-apps.folder':       'Folder',
  'application/pdf':                          'PDF',
  'text/plain':                               'Text file',
};

// Exportable types and their preferred plain-text export MIME
const EXPORT_MIME = {
  'application/vnd.google-apps.document':     'text/plain',
  'application/vnd.google-apps.spreadsheet':  'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

function friendlyType(mimeType) {
  return GOOGLE_MIME_LABELS[mimeType] || mimeType.split('/').pop();
}

function sanitise(text) {
  return (text || '')
    .replace(/[*_~`#>|]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatDate(isoString) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

// ── Drive API calls ───────────────────────────────────────────────────────────

/**
 * List 7 most recently modified files (not trashed, owned by user).
 */
async function listRecentFiles(tokens, maxResults = 7) {
  const drive = google.drive({ version: 'v3', auth: createAuth(tokens) });

  const res = await drive.files.list({
    pageSize: maxResults,
    orderBy: 'modifiedTime desc',
    q: "trashed = false and 'me' in owners",
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink, parents)',
  });

  return (res.data.files || []).map(f => ({
    id:           f.id,
    name:         sanitise(f.name),
    type:         friendlyType(f.mimeType),
    mimeType:     f.mimeType,
    modifiedDate: formatDate(f.modifiedTime),
    modifiedTime: f.modifiedTime,
    webViewLink:  f.webViewLink || null,
  }));
}

/**
 * Search Drive by filename or full-text keywords.
 * Falls back to name-only search if full-text returns nothing.
 */
async function searchFiles(tokens, query, maxResults = 7) {
  const drive = google.drive({ version: 'v3', auth: createAuth(tokens) });

  const safeQuery = query.replace(/'/g, "\\'");

  const res = await drive.files.list({
    pageSize: maxResults,
    orderBy: 'modifiedTime desc',
    q: `(name contains '${safeQuery}' or fullText contains '${safeQuery}') and trashed = false`,
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
  });

  const files = res.data.files || [];

  // Fallback: name-only search
  if (!files.length) {
    const fallback = await drive.files.list({
      pageSize: maxResults,
      q: `name contains '${safeQuery}' and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
    });
    return (fallback.data.files || []).map(f => ({
      id: f.id, name: sanitise(f.name),
      type: friendlyType(f.mimeType), mimeType: f.mimeType,
      modifiedDate: formatDate(f.modifiedTime), webViewLink: f.webViewLink || null,
    }));
  }

  return files.map(f => ({
    id: f.id, name: sanitise(f.name),
    type: friendlyType(f.mimeType), mimeType: f.mimeType,
    modifiedDate: formatDate(f.modifiedTime), webViewLink: f.webViewLink || null,
  }));
}

/**
 * Export a Google Doc/Sheet/Slide as plain text for summarisation.
 * Returns { name, content } or null if the file type isn't exportable.
 */
async function getDocumentContent(tokens, fileId) {
  const drive = google.drive({ version: 'v3', auth: createAuth(tokens) });

  // Fetch file metadata first
  const meta = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType',
  });

  const { name, mimeType } = meta.data;
  const exportMime = EXPORT_MIME[mimeType];

  if (!exportMime) {
    return {
      name: sanitise(name),
      content: null,
      unsupported: true,
      type: friendlyType(mimeType),
    };
  }

  const exported = await drive.files.export(
    { fileId, mimeType: exportMime },
    { responseType: 'text' }
  );

  const rawText = typeof exported.data === 'string'
    ? exported.data
    : JSON.stringify(exported.data);

  // Trim to 4000 chars to keep Gemini context manageable
  const content = sanitise(rawText).slice(0, 4000);

  return { name: sanitise(name), content, type: friendlyType(mimeType) };
}

/**
 * Create an empty folder in the root of Google Drive.
 * Returns { folderId, name }.
 */
async function createFolder(tokens, folderName) {
  const drive = google.drive({ version: 'v3', auth: createAuth(tokens) });

  const res = await drive.files.create({
    requestBody: {
      name:     folderName,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id, name',
  });

  return {
    folderId: res.data.id,
    name:     sanitise(res.data.name),
  };
}

/**
 * List the top 5 folders at the root of sir Horace's Drive.
 * Returns an array of { id, name } — names only for the verbal report.
 */
async function listDriveFolders(tokens) {
  const drive = google.drive({ version: 'v3', auth: createAuth(tokens) });

  const res = await drive.files.list({
    pageSize: 5,
    orderBy: 'name',
    q: "mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false",
    fields: 'files(id, name)',
  });

  return (res.data.files || []).map(f => ({
    id:   f.id,
    name: sanitise(f.name),
  }));
}

/**
 * List the files and sub-folders inside a named folder.
 * Returns up to 10 items: { id, name, type }.
 */
async function listFolderContents(tokens, folderName) {
  const drive = google.drive({ version: 'v3', auth: createAuth(tokens) });
  const safe  = folderName.replace(/'/g, "\\'");

  // Find the folder
  const folderSearch = await drive.files.list({
    pageSize: 1,
    q: `mimeType='application/vnd.google-apps.folder' and name='${safe}' and trashed=false`,
    fields: 'files(id, name)',
  });

  const folders = folderSearch.data.files || [];
  if (!folders.length) return { error: `No folder named "${folderName}" was found.` };

  const folderId = folders[0].id;

  const res = await drive.files.list({
    pageSize: 10,
    orderBy: 'modifiedTime desc',
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id, name, mimeType)',
  });

  return {
    folderName: sanitise(folders[0].name),
    items: (res.data.files || []).map(f => ({
      id:   f.id,
      name: sanitise(f.name),
      type: friendlyType(f.mimeType),
    })),
  };
}

/**
 * Extract a human-readable reason from a googleapis error response.
 */
function extractApiError(err) {
  const apiErr = err?.response?.data?.error || {};
  const reason = apiErr?.errors?.[0]?.reason || '';
  const msg    = apiErr?.message || err.message || 'Unknown error';
  const code   = apiErr?.code   || err.code   || err.status || 0;
  return { code, reason, msg };
}

/**
 * Create a new Google Doc with a title and plain-text body.
 * Returns { documentId, name, webViewLink } or throws with enriched error.
 */
async function createFormattedDoc(tokens, title, body) {
  const auth  = createAuth(tokens);
  const docs  = google.docs({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });

  // Create the document — surface specific error if Docs API is not enabled
  let created;
  try {
    created = await docs.documents.create({
      requestBody: { title: sanitise(title) },
    });
  } catch (err) {
    const { code, reason, msg } = extractApiError(err);
    console.error(`[createFormattedDoc] HTTP ${code} reason="${reason}":`, msg);
    // Re-throw with enriched structure so executeTool can classify it
    const enriched = new Error(msg);
    enriched.code     = code;
    enriched.response = err.response;
    throw enriched;
  }

  const documentId = created.data.documentId;

  // Insert body text if provided
  if (body && body.trim()) {
    try {
      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [{
            insertText: {
              location: { index: 1 },
              text: body.trim(),
            },
          }],
        },
      });
    } catch (err) {
      // Body insert failed — document was created; return what we have
      console.error('[createFormattedDoc] batchUpdate failed:', err.message);
    }
  }

  // Fetch the webViewLink from Drive
  const meta = await drive.files.get({
    fileId: documentId,
    fields: 'id, name, webViewLink',
  });

  return {
    documentId,
    name:        sanitise(meta.data.name),
    webViewLink: meta.data.webViewLink || null,
  };
}

/**
 * Move a file into a folder (search for existing folder, or create it).
 * Returns { moved: true, fileName, folderName }
 */
async function moveToFolder(tokens, fileId, folderName) {
  const auth  = createAuth(tokens);
  const drive = google.drive({ version: 'v3', auth });

  const safeName = folderName.replace(/'/g, "\\'");

  // Find or create the target folder
  let folderId;
  const folderSearch = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.folder' and name='${safeName}' and trashed=false`,
    fields: 'files(id, name)',
    pageSize: 1,
  });

  if (folderSearch.data.files?.length) {
    folderId = folderSearch.data.files[0].id;
  } else {
    const newFolder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    });
    folderId = newFolder.data.id;
  }

  // Get current parents
  const fileMeta = await drive.files.get({
    fileId,
    fields: 'id, name, parents',
  });

  const currentParents = (fileMeta.data.parents || []).join(',');

  // Move file: add new parent, remove old parents
  await drive.files.update({
    fileId,
    addParents:    folderId,
    removeParents: currentParents,
    fields: 'id, parents',
  });

  return {
    moved:      true,
    fileName:   sanitise(fileMeta.data.name),
    folderName: sanitise(folderName),
    folderId,
  };
}

/**
 * Stage a file for deletion — search by name and return metadata.
 * Does NOT trash anything. Returns the staged item metadata.
 */
async function stageDeleteItem(tokens, name) {
  const drive  = google.drive({ version: 'v3', auth: createAuth(tokens) });
  const safe   = name.replace(/'/g, "\\'");

  const res = await drive.files.list({
    q: `name contains '${safe}' and trashed=false`,
    pageSize: 1,
    fields: 'files(id, name, mimeType, modifiedTime)',
    orderBy: 'modifiedTime desc',
  });

  const files = res.data.files || [];
  if (!files.length) return null;

  const f = files[0];
  return {
    fileId:      f.id,
    name:        sanitise(f.name),
    type:        friendlyType(f.mimeType),
    modifiedDate: formatDate(f.modifiedTime),
  };
}

/**
 * Actually move a file to trash after double confirmation.
 * Returns { trashed: true, name }
 */
async function confirmDeleteItem(tokens, fileId) {
  const drive = google.drive({ version: 'v3', auth: createAuth(tokens) });

  const meta = await drive.files.get({ fileId, fields: 'id, name' });

  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
  });

  return { trashed: true, name: sanitise(meta.data.name) };
}

/**
 * Share a Drive file with a given email address and role.
 * role: 'reader' | 'commenter' | 'writer'
 * Returns { shared: true, name, email, role, webViewLink }
 */
async function shareDocument(tokens, fileId, email, role) {
  const auth  = createAuth(tokens);
  const drive = google.drive({ version: 'v3', auth });

  const validRole = ['reader', 'commenter', 'writer'].includes(role) ? role : 'reader';

  await drive.permissions.create({
    fileId,
    requestBody: {
      type:         'user',
      role:         validRole,
      emailAddress: email,
    },
    sendNotificationEmail: false,
  });

  const meta = await drive.files.get({
    fileId,
    fields: 'id, name, webViewLink',
  });

  return {
    shared:      true,
    name:        sanitise(meta.data.name),
    email,
    role:        validRole,
    webViewLink: meta.data.webViewLink || null,
  };
}

module.exports = {
  createFolder,
  listRecentFiles,
  listDriveFolders,
  listFolderContents,
  searchFiles,
  getDocumentContent,
  createFormattedDoc,
  moveToFolder,
  stageDeleteItem,
  confirmDeleteItem,
  shareDocument,
};
