// localDate.js - the user's LOCAL calendar date as 'YYYY-MM-DD' (Issue #73).
// Sent with assistant messages so "today" and "yesterday" mean the user's today and yesterday, not the server's UTC day.
// It is built from the local year / month / day numbers directly (never toISOString), so no time zone can shift it.
export function localDateString(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
