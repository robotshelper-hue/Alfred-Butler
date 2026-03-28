/**
 * Text-to-Speech — Gemini 2.5 Flash with audio response modality.
 *
 * Model: gemini-2.5-flash (2026 stable)
 * Voice: Charon (deep, authoritative male)
 * Delivery steered via DELIVERY_PREFIX prompt.
 *
 * Falls back to browser speechSynthesis (en-GB) if Gemini TTS fails.
 * TEXT-ONLY rule: emojis, asterisks, markdown stripped before synthesis.
 */

const TTS_MODEL = 'gemini-2.5-flash';

const DELIVERY_PREFIX =
  'Speak in a refined, calm, and sophisticated British Received Pronunciation accent. ' +
  'Your tone is slightly gravelly, deeply authoritative, and unhurried — ' +
  'the voice of a dignified, middle-aged British gentleman\'s butler. ' +
  'Never rush. Pause naturally between clauses.\n\n';

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

async function synthesise(text) {
  const clean = sanitise(text);
  if (!clean) return null;

  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: DELIVERY_PREFIX + clean }] }],
    generationConfig: {
      response_modalities: ['audio'],
      speech_config: {
        voice_config: {
          prebuilt_voice_config: { voice_name: 'Charon' },
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
