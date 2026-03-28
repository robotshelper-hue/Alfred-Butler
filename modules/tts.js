/**
 * Text-to-Speech via Gemini 2.0 Flash with AUDIO response modality.
 *
 * The dedicated gemini-2.0-flash-preview-tts model was deprecated 2026-03-27.
 * We now use gemini-2.0-flash (the stable, confirmed-live model) with
 * responseModalities:['AUDIO'] — same API shape, no separate TTS endpoint needed.
 *
 * Voice: Orion — deep, authoritative male voice.
 * Delivery steered via DELIVERY_PREFIX prompt text.
 *
 * TEXT-ONLY rule: all emojis, asterisks, and markdown stripped before synthesis.
 */

const TTS_MODEL = 'gemini-2.0-flash';

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
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Orion' },
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
