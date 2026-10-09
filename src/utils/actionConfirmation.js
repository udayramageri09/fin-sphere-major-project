// actionConfirmation.js - did the user confirm or cancel a pending assistant action? (Issue #73)
//
// Whole-utterance only. A confirmation has to be the entire message ("yes", "go ahead", "do it"), never a word inside
// a longer sentence: "yes but make it 600" is an EDIT, "yesterday" is a date, and "I said yes earlier" is neither.
// This is only consulted while a proposal is pending; with nothing pending, "yes" is ordinary conversation. The parser
// can only say yes / no: the confirm endpoint, not this module, is what actually executes anything.

const YES = new Set([
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'confirm', 'confirmed', 'go ahead', 'do it', 'add it', 'save it',
  'haan', 'yes please', 'please do', 'yes confirm', 'yes go ahead', 'yes do it', 'yes add it', 'yes save it',
  'sure go ahead', 'ok go ahead', 'okay go ahead', 'looks good', 'that is right', 'correct',
]);
const NO = new Set([
  'no', 'nope', 'nah', 'cancel', 'cancel it', 'stop', "don't", 'dont', "don't add it", 'dont add it', 'never mind',
  'nevermind', 'forget it', 'leave it', 'no thanks', 'no thank you', 'no cancel', 'nahi', 'nahin', 'abort', 'discard it',
]);

const normalise = (text) => String(text ?? '')
  .toLowerCase()
  .replace(/[‘’]/g, "'")
  .replace(/[^a-z' ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// -> 'yes' | 'no' | null
export function parseConfirmation(text) {
  const n = normalise(text);
  if (YES.has(n)) return 'yes';
  if (NO.has(n)) return 'no';
  return null;
}
