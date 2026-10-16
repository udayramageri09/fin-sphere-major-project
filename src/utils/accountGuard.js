// The browser half of the account guard. Tabs of one browser share one session cookie, so a tab can end up showing account A while the session
// now belongs to account B. Every request the signed-in app makes therefore names the account the tab is showing (X-FinSphere-User); the
// server compares it with the verified session and refuses (409 account_changed) before reading or changing anything. A refusal makes the
// tab re-check whose session it is instead of acting. One place, used by the shared request layers and the pages.
export const ACCOUNT_HEADER = 'X-FinSphere-User';
export const ACCOUNT_CHANGED_MESSAGE = 'Your account changed in another tab. Nothing was done. Checking your session…';

export const accountHeaders = (user) => (user?.id != null ? { [ACCOUNT_HEADER]: String(user.id) } : {});

// Throws (after asking for a session re-check) when the response is the server's "account changed" refusal; otherwise does nothing.
export async function refuseIfAccountChanged(res, recheck) {
  if (res.status !== 409) return;
  const body = await res.clone().json().catch(() => ({}));
  if (body.code !== 'account_changed') return;
  if (typeof recheck === 'function') recheck();
  throw new Error(ACCOUNT_CHANGED_MESSAGE);
}

// fetch() that names the account and turns an "account changed" refusal into a re-check plus an error the caller can show.
export async function guardedFetch(url, init = {}, { user, recheck } = {}) {
  const res = await fetch(url, { ...init, headers: { ...accountHeaders(user), ...(init.headers ?? {}) } });
  await refuseIfAccountChanged(res, recheck);
  return res;
}
