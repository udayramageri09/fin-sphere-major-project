// Wording and colours for the statement import controls. Display only: nothing here decides what is imported (the server's
// validation does), and nothing guesses a transaction's direction.

// What the importer needs to accept a row. Rows without a clear direction are skipped by the server, never guessed.
export const DIRECTION_HELP =
  'Each transaction needs a clear direction: a minus (-450.00) or plus (+450.00) sign on the amount, or a debit/credit marker next to it (DR / CR, Debit / Credit). Rows without one are skipped, never guessed.';

// The server's "nothing could be imported" answers, with the reason a user can act on. Other messages pass through unchanged.
export function explainImportError(message) {
  const text = String(message ?? '').trim();
  if (/^No valid transactions found/i.test(text)) {
    return `${text} The most common cause is amounts with no direction. ${DIRECTION_HELP} Dates and amounts must also be readable.`;
  }
  if (/^Could not parse any transactions from the provided statement/i.test(text)) {
    return `${text} Each line needs a date (for example 05/03/2026) and an amount. ${DIRECTION_HELP}`;
  }
  return text;
}

// "Success! Imported 3 transactions." (+ " from file.csv") with a plain note when the server skipped rows.
export function importSuccessMessage({ count, skipped } = {}, fileName) {
  const base = `Success! Imported ${count} transactions${fileName ? ` from ${fileName}` : ''}.`;
  return skipped > 0
    ? `${base} ${skipped} row${skipped === 1 ? ' was' : 's were'} not imported because the direction, date or amount was unclear. Nothing was guessed.`
    : base;
}

// Import buttons: dark with white text when available; clearly lighter, flat and outlined when not. Both pairs are above 4.5:1.
export const IMPORT_BUTTON_COLORS = Object.freeze({
  enabled: { background: '#27272a', color: '#ffffff' },
  busy: { background: '#52525b', color: '#ffffff' },
  disabled: { background: '#e4e4e7', color: '#52525b', border: '1px dashed #a1a1aa' }
});
export function importButtonStyle({ disabled, busy }) {
  const c = busy ? IMPORT_BUTTON_COLORS.busy : disabled ? IMPORT_BUTTON_COLORS.disabled : IMPORT_BUTTON_COLORS.enabled;
  return { ...c, border: c.border ?? '1px solid transparent', cursor: disabled || busy ? 'not-allowed' : 'pointer' };
}
