require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const path = require('path');
const brain = require('./modules/brain');
const tts   = require('./modules/tts');
const drive = require('./modules/drive');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway (and most PaaS) terminate TLS at their load balancer.
// Without this, Express sees plain HTTP internally and refuses to set
// secure: true cookies — breaking the OAuth session handshake.
app.set('trust proxy', 1);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'alfred-butler-fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// ── OAuth2 helpers ────────────────────────────────────────────────────────────
function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/calendar',
];

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  const oauth2Client = createOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=access_denied');

  try {
    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    req.session.tokens = tokens;
    req.session.user = {
      id: userInfo.id,
      name: userInfo.name,
      email: userInfo.email,
      picture: userInfo.picture,
    };

    // Use a JS redirect instead of HTTP 302 — more reliable behind Railway's
    // TLS-terminating proxy where Set-Cookie + Location in the same response
    // can occasionally be dropped by certain browsers.
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<script>window.location.replace('/dashboard');</script>
<noscript><meta http-equiv="refresh" content="0;url=/dashboard"></noscript>
</head><body style="background:#000;color:#FFD700;font-family:serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
<p>One moment, sir Horace&hellip;</p></body></html>`);
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  if (req.session?.user?.id) brain.clearHistory(req.session.user.id);
  req.session.destroy(() => res.redirect('/'));
});

// ── Auth guard ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/');
  next();
}

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/user', requireAuth, (req, res) => {
  res.json(req.session.user);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', name: 'Alfred', module: 4 });
});

/**
 * GET /api/drive/recent
 * Returns the 7 most recently modified Drive files for the dashboard panel.
 */
app.get('/api/drive/recent', requireAuth, async (req, res) => {
  if (!req.session.tokens) return res.json({ files: [] });
  try {
    const files = await drive.listRecentFiles(req.session.tokens);
    res.json({ files });
  } catch (err) {
    console.error('[/api/drive/recent]', err.message);
    res.json({ files: [] });
  }
});

// ── Alfred: Brain + Voice + Gmail (Modules 2 & 3) ────────────────────────────

/**
 * POST /api/alfred/chat
 * Body: { message: string }
 * Returns: { reply: string, hasPendingDraft: boolean }
 *
 * Passes Google OAuth tokens and any staged draft into the brain so
 * Gemini function calling can access Gmail on sir Horace's behalf.
 */
app.post('/api/alfred/chat', requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'No message provided' });

  try {
    const context = {
      tokens:       req.session.tokens       || null,
      pendingDraft: req.session.pendingDraft || null,
    };

    const { reply, pendingDraft } = await brain.chat(
      req.session.user.id,
      message.trim(),
      context
    );

    // Persist updated draft state in session
    req.session.pendingDraft = pendingDraft || null;

    res.json({ reply, hasPendingDraft: !!pendingDraft });
  } catch (err) {
    console.error('[/api/alfred/chat]', err.message);
    const is429 = err.status === 429 || String(err.message).includes('429')
                  || String(err.message).toLowerCase().includes('quota');
    if (is429) return res.status(429).json({ error: 'rate_limited' });
    res.status(500).json({ error: 'Alfred encountered a difficulty, sir Horace.' });
  }
});

/**
 * POST /api/alfred/speak
 * Body: { text: string }
 * Returns: { audioBase64: string, mimeType: string } or { fallback: true, text: string }
 */
app.post('/api/alfred/speak', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'No text provided' });

  try {
    const audio = await tts.synthesise(text.trim());
    if (audio) {
      res.json({ audioBase64: audio.audioBase64, mimeType: audio.mimeType });
    } else {
      // Graceful fallback: send sanitised text for browser TTS
      res.json({ fallback: true, text: tts.sanitise(text.trim()) });
    }
  } catch (err) {
    console.error('[/api/alfred/speak]', err.message);
    res.json({ fallback: true, text: tts.sanitise(text.trim()) });
  }
});

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session?.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Alfred is online — http://localhost:${PORT}`);
});
