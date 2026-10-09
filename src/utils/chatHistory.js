// chatHistory.js - the bounded, active-session history sent with every assistant request (Issue #69).
// It mirrors the server's contract for POST /api/chat and /api/plan-chat: only "user" / "assistant" turns, each a
// non-empty string of at most CHAT_CONTENT_MAX characters, and only the most recent CHAT_HISTORY_TURNS turns.
// Nothing is stored beyond the open session.

export const CHAT_HISTORY_TURNS = 12;
export const CHAT_CONTENT_MAX = 2000;

const clean = (content) => (typeof content === 'string' ? content.trim().slice(0, CHAT_CONTENT_MAX) : '');

// entries: [{ role, content }] already in the conversation; nextUserText: the message being sent now.
export function buildChatHistory(entries, nextUserText) {
  const turns = (entries || [])
    .filter((e) => e && (e.role === 'user' || e.role === 'assistant'))
    .map((e) => ({ role: e.role, content: clean(e.content) }))
    .filter((e) => e.content.length > 0);
  turns.push({ role: 'user', content: clean(nextUserText) });
  return turns.slice(-CHAT_HISTORY_TURNS);
}
