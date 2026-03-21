/**
 * Text-to-Speech via Gemini 2.0 Flash TTS API.
 * Returns base64-encoded PCM audio (audio/wav) or null on failure.
 *
 * Chosen voice: "Charon" — a measured, deep, authoritative voice
 * befitting a British gentleman's butler.
 *
 * Strict TEXT-ONLY rule: strip all emojis, asterisks, and markdown
 * characters before synthesis so Alfred never reads them aloud.
 */

const TTS_MODEL = 'gemini-2.0-flash-preview-tts';
const VOICE_NAME = 'Charon';  // Deep, measured, authoritative

// ── Text sanitiser ────────────────────────────────────────────────────────────
function sanitise(text) {
  return text
    // Strip markdown formatting characters
    .replace(/[*_~`#>|]/g, '')
    // Strip emoji (broad Unicode ranges)
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/[\u{FE00}-\u{FEFF}]/gu, '')
    // Collapse multiple spaces
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Convert text to speech using Gemini TTS.
 * @param {string} text - The text Alfred should speak
 * @returns {Promise<{audioBase64: string, mimeType: string}|null>}
 */
async function synthesise(text) {
  const clean = sanitise(text);
  if (!clean) return null;

  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: clean }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: VOICE_NAME },
        },
      },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[TTS] Gemini API error:', res.status, err);
    return null;
  }

  const data = await res.json();
  const part = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!part?.data) {
    console.error('[TTS] No audio data in response');
    return null;
  }

  return { audioBase64: part.data, mimeType: part.mimeType || 'audio/wav' };
}

module.exports = { synthesise, sanitise };
