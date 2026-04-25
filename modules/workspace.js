/**
 * Module 5 — The Directory & Ledgers
 *
 * Provides:
 *   lookupContact(tokens, name)                    → People API contact search
 *   manageLedger(tokens, title, action, data)       → Google Sheets create / append / read
 */

const { google } = require('googleapis');

function createAuth(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials(tokens);
  return client;
}

function sanitise(text) {
  return (text || '')
    .replace(/[*_~`#>|]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Directory ─────────────────────────────────────────────────────────────────

/**
 * Search Google Contacts for a person by name.
 * Returns an array of { name, emails, phones } or null if no match.
 */
async function lookupContact(tokens, name) {
  const people = google.people({ version: 'v1', auth: createAuth(tokens) });

  const res = await people.people.searchContacts({
    query: name,
    readMask: 'names,emailAddresses,phoneNumbers',
    pageSize: 3,
  });

  const results = res.data.results || [];
  if (!results.length) return null;

  return results.map(r => {
    const p = r.person;
    return {
      name:   sanitise(p.names?.[0]?.displayName || 'Unknown'),
      emails: (p.emailAddresses || []).map(e => e.value),
      phones: (p.phoneNumbers   || []).map(p => p.value),
    };
  });
}

// ── Ledgers ───────────────────────────────────────────────────────────────────

/**
 * Find an existing Google Sheet by title, or return null.
 */
async function findSheet(drive, title) {
  const safe = title.replace(/'/g, "\\'");
  const res  = await drive.files.list({
    q:       `mimeType='application/vnd.google-apps.spreadsheet' and name='${safe}' and trashed=false`,
    pageSize: 1,
    fields:  'files(id, name, webViewLink)',
    orderBy: 'modifiedTime desc',
  });
  return res.data.files?.[0] || null;
}

/**
 * Create or update a Google Sheets spreadsheet.
 *
 * action: 'create'  — make a new sheet, return { spreadsheetId, name, webViewLink }
 * action: 'append'  — add a row; creates the sheet if it does not exist yet
 *                     data: array of cell values e.g. ['2024-01-15', 'Coffee', '3.50']
 * action: 'read'    — return the last 10 rows
 */
async function manageLedger(tokens, title, action, data) {
  const auth   = createAuth(tokens);
  const sheets = google.sheets({ version: 'v4', auth });
  const drive  = google.drive({ version: 'v3', auth });

  // ── create ──────────────────────────────────────────────────────────────────
  if (action === 'create') {
    const res = await sheets.spreadsheets.create({
      requestBody: { properties: { title: sanitise(title) } },
    });
    const spreadsheetId = res.data.spreadsheetId;
    const meta = await drive.files.get({
      fileId: spreadsheetId,
      fields: 'id, name, webViewLink',
    });
    return {
      spreadsheetId,
      name:        sanitise(res.data.properties.title),
      webViewLink: meta.data.webViewLink || null,
    };
  }

  // ── append ───────────────────────────────────────────────────────────────────
  if (action === 'append') {
    let file = await findSheet(drive, title);
    let spreadsheetId;
    let sheetName;

    if (file) {
      spreadsheetId = file.id;
      sheetName     = sanitise(file.name);
    } else {
      // Auto-create the sheet if it doesn't exist
      const created = await sheets.spreadsheets.create({
        requestBody: { properties: { title: sanitise(title) } },
      });
      spreadsheetId = created.data.spreadsheetId;
      sheetName     = sanitise(title);
    }

    const row = Array.isArray(data) ? data.map(String) : [String(data)];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range:            'Sheet1!A:Z',
      valueInputOption: 'USER_ENTERED',
      requestBody:      { values: [row] },
    });

    return { appended: true, name: sheetName, rowData: row };
  }

  // ── read ─────────────────────────────────────────────────────────────────────
  if (action === 'read') {
    const file = await findSheet(drive, title);
    if (!file) return { error: `No spreadsheet named "${title}" was found.` };

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: file.id,
      range: 'Sheet1!A:Z',
    });
    const rows   = res.data.values || [];
    const recent = rows.slice(-10);
    return { name: sanitise(file.name), rows: recent };
  }

  return { error: `Unknown ledger action "${action}". Use create, append, or read.` };
}

module.exports = { lookupContact, manageLedger };
