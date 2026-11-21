// Instant replies for the few messages that need no data and no language model, so they never wait for the server.
// Anything else, including every question about the user's own money, still goes to the grounded server pipeline.
const REPLIES = [
  [/^(?:hi|hello|hey|hey there|good (?:morning|afternoon|evening))(?: fin\s*sphere)?[.!?]*$/i,
    'Hi! Ask about your money, or say “open transactions” or “add 450 for lunch”.'],
  [/^(?:thanks|thank you|thanks a lot|thank you so much)(?: fin\s*sphere)?[.!?]*$/i, "You're welcome!"],
  [/^(?:help|what can you do|what can i say|what can i ask)[.!?]*$/i,
    'I can open any page (“open goals”), add a transaction (“add 450 for lunch”), set budgets, and answer questions about your spending, income, goals and loans.']
];

export function localCommand(text) {
  const clean = String(text ?? '').trim();
  return clean.length <= 60 ? REPLIES.find(([pattern]) => pattern.test(clean))?.[1] ?? null : null;
}
