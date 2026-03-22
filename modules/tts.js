/**
 * Text-to-Speech via Gemini 2.0 Flash TTS API.
 * Returns base64-encoded PCM audio (audio/wav) or null on failure.
 *
 * Voice: "Orus" — the firmest, most authoritative male voice available
 * in Gemini TTS. Deep, measured, and commanding — perfect for a
 * posh British butler.
 *
 * Delivery steering: a style instruction is prepended to every TTS
 * request so Gemini shapes the prosody toward a refined British RP
 * accent with gravelly authority.
 *
 * Strict TEXT-ONLY rule: all emojis, asterisks, and markdown are
 * stripped before synthesis so Alfred never reads them aloud.
 */

const TTS_MODEL = 'gemini-2.0-flash-preview-tts';
const VOICE_NAME = 'Orus'; // Firm, deep, authoritative — closest to British RP male

// Delivery instruction prepended to every TTS request.
// Gemini TTS uses this to steer prosody and tone.
const DELIVERY_PREFIX =
  'Speak in a refined, calm, and sophisticated British Received Pronunciation accent. ' +
  'Your tone is slightly gravelly, deeply authoritative, and unhurried — ' +
  'the voice of a dignified, middle-aged British gentleman\'s butler. ' +
  'Never rush. Pause naturally between clauses.\n\n';

// ── Text sanitiser ────────────────────────────────────────────────────────────
function sanitise(text) {
  return text
    .replace(/[*_~`#>|]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/[\u{FE00}-\u{FEFF}]/gu, '')
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
    contents: [{ parts: [{ text: DELIVERY_PREFIX + clean }] }],
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

