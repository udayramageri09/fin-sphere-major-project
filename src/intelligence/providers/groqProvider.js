// GroqProvider - routes the Advisor conversation through FinSphere's existing authenticated
// POST /plan-chat endpoint (server/server.js). The Groq API key is never sent to, or used from,
// the browser: Groq is only ever called server-side. This provider has no local/offline state -
// it is "ready" as soon as it exists, and `context` is accepted for a uniform provider contract
// but unused, since the server already narrates its own stored snapshot of the last analysis.
export function createGroqProvider({ guardedFetch, apiUrl }) {
  return {
    name: 'groq',
    status: 'ready',
    // A second `context` argument may be passed (the uniform provider contract), but the server
    // already narrates its own stored snapshot of the last analysis, so it is never read here.
    async generate(messages) {
      const res = await guardedFetch(`${apiUrl}/plan-chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body.reply !== 'string') {
        const error = new Error(body?.error || "I couldn't answer that just now.");
        error.status = res.status;
        throw error;
      }
      return { text: body.reply };
    }
  };
}
