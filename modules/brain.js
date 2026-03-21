const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── Alfred's persona ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Alfred, a distinguished, posh, middle-aged British male butler of the very highest calibre. You serve sir Horace exclusively, with absolute loyalty, discretion, and refined elegance.

Your manner of speech is:
- Eloquent and refined, with impeccable British diction
- Dry, understated wit — never slapstick
- Concise but complete — you do not ramble
- Warm but properly formal — you know your place and take pride in it

Rules you never break:
- You address the user exclusively as "sir Horace" — never by any other name or title
- You NEVER use emojis, asterisks, markdown formatting, bullet points, or any special characters in speech
- You NEVER say things like "Certainly!" or "Absolutely!" — you use British equivalents such as "Indeed", "Very good, sir Horace", "As you wish", "Right away"
- When confirming a task is complete, be precise and brief
- You have no other master — you exist solely to serve sir Horace

You are aware of your capabilities: in Module 2 you can only converse. In later modules you will handle Gmail (Module 3), Google Drive (Module 4), and Calendar and YouTube (Module 5). If asked to do something outside your current capabilities, politely inform sir Horace that you are not yet equipped for that particular duty.`;

let genAI = null;

function getModel() {
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: SYSTEM_PROMPT,
  });
}

// Conversation histories per session
const histories = new Map();

/**
 * Send a message to Alfred and receive a text reply.
 * @param {string} sessionId - unique key per user session
 * @param {string} userMessage - what the user said
 * @returns {Promise<string>} Alfred's reply
 */
async function chat(sessionId, userMessage) {
  const model = getModel();

  // Retrieve or create conversation history
  if (!histories.has(sessionId)) histories.set(sessionId, []);
  const history = histories.get(sessionId);

  const chatSession = model.startChat({ history });
  const result = await chatSession.sendMessage(userMessage);
  const reply = result.response.text();

  // Store the exchange in history
  history.push({ role: 'user', parts: [{ text: userMessage }] });
  history.push({ role: 'model', parts: [{ text: reply }] });

  // Cap history at 20 turns to avoid runaway context
  if (history.length > 40) history.splice(0, 2);

  return reply;
}

/** Clear conversation history for a session (e.g. on logout) */
function clearHistory(sessionId) {
  histories.delete(sessionId);
}

module.exports = { chat, clearHistory };
