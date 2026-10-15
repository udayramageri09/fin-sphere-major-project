// Client side of duplicate-aware statement import (frontend Stage 2). The server decides what is a duplicate; this file only
// understands its answers, builds the confirmation request from exactly what the server previewed, and words the results.
// Nothing here logs, stores or re-parses statement contents.

export const MAX_IMPORT_ROWS = 500;

const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);
const isMatch = (m) => m && typeof m === 'object' && typeof m.title === 'string' && isFiniteNumber(m.amount) && typeof m.date === 'string';

// Accepts only a well-formed preview (the body of a 409 DUPLICATES_FOUND or STALE_PREVIEW) and keeps just the fields the review
// uses. Anything else returns null, so a malformed answer is reported as an ordinary error instead of rendering garbage.
export function normalizePreview(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.rows) || body.rows.length === 0) return null;
  if (typeof body.reviewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.reviewDigest)) return null;
  const rows = [];
  for (let i = 0; i < body.rows.length; i++) {
    const r = body.rows[i];
    if (!r || typeof r.title !== 'string' || !isFiniteNumber(r.amount) || typeof r.date !== 'string' || (r.type !== 'income' && r.type !== 'expense')) return null;
    let duplicate = null;
    if (r.duplicate) {
      if ((r.duplicate.tier !== 'likely' && r.duplicate.tier !== 'possible') || !isMatch(r.duplicate.match)) return null;
      const m = r.duplicate.match;
      duplicate = { tier: r.duplicate.tier, match: { id: String(m.id), title: m.title, amount: m.amount, date: m.date, type: m.type } };
    }
    rows.push({ index: i, title: r.title, amount: r.amount, date: r.date, type: r.type, category: typeof r.category === 'string' ? r.category : 'General', duplicate });
  }
  const likely = rows.filter((r) => r.duplicate?.tier === 'likely').length;
  const possible = rows.filter((r) => r.duplicate?.tier === 'possible').length;
  return {
    rows,
    // Counted from the rows themselves, so the summary can never disagree with the list.
    summary: { total: rows.length, new: rows.length - likely - possible, likely, possible },
    skipped: Number.isInteger(body.skipped) && body.skipped > 0 ? body.skipped : 0,
    maxRows: Number.isInteger(body.maxRows) ? body.maxRows : MAX_IMPORT_ROWS,
    reviewDigest: body.reviewDigest
  };
}

// Default selection: everything except LIKELY duplicates. A "possible" match is only a guess (same date, amount and direction but a
// different description), so it stays selected unless the user excludes it.
export const defaultSelection = (preview) => new Set(preview.rows.filter((r) => r.duplicate?.tier !== 'likely').map((r) => r.index));

export function selectionCounts(preview, selected) {
  const picked = preview.rows.filter((r) => selected.has(r.index));
  return {
    selected: picked.length,
    new: picked.filter((r) => !r.duplicate).length,
    likely: picked.filter((r) => r.duplicate?.tier === 'likely').length,
    possible: picked.filter((r) => r.duplicate?.tier === 'possible').length
  };
}

// The body for POST /api/transactions/import-confirm: the ORIGINAL previewed rows (all of them: the digest covers them all), the
// digest the server issued, and the user's decision. Nothing is re-parsed. Only the five row fields are sent.
//   mode 'all'       -> policy import_all, no exclusions ("Import all anyway")
//   mode 'selected'  -> exactly the ticked rows:
//        no likely duplicate ticked -> policy skip_duplicates (the server's own default) + skipIndexes for every unticked new/possible row
//        a likely duplicate ticked  -> policy import_all + skipIndexes for every unticked row
export function buildConfirmRequest(preview, selected, mode) {
  const rows = preview.rows.map(({ title, amount, date, type, category }) => ({ title, amount, date, type, category }));
  if (mode === 'all') return { rows, policy: 'import_all', reviewDigest: preview.reviewDigest, skipIndexes: [] };
  const unticked = preview.rows.filter((r) => !selected.has(r.index));
  const likelyTicked = preview.rows.some((r) => selected.has(r.index) && r.duplicate?.tier === 'likely');
  if (likelyTicked) return { rows, policy: 'import_all', reviewDigest: preview.reviewDigest, skipIndexes: unticked.map((r) => r.index) };
  return {
    rows, policy: 'skip_duplicates', reviewDigest: preview.reviewDigest,
    skipIndexes: unticked.filter((r) => r.duplicate?.tier !== 'likely').map((r) => r.index)
  };
}

// POST /api/transactions/import-confirm with the session cookie, like every other call. Resolves
//   { stale: false, result }            the import happened (result is the server's body)
//   { stale: true, preview }            409 STALE_PREVIEW: nothing was saved; `preview` is the refreshed review
// Rejects with an Error (status 401 = session expired; the caller decides what to do about it).
export async function requestImportConfirm({ apiUrl, body, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${apiUrl}/transactions/import-confirm`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
  } catch {
    throw new Error('Could not reach the server, so the import may not have completed. Check your transactions, then try again.');
  }
  if (res.status === 401) { const e = new Error('Session expired'); e.status = 401; throw e; }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON: a proxy answered */ }
  if (res.status === 409 && data?.code === 'STALE_PREVIEW') {
    const preview = normalizePreview(data);
    if (preview) return { stale: true, preview };
    throw new Error('Your transactions changed and the import could not be refreshed. Nothing was imported. Start the import again.');
  }
  if (!res.ok) {
    const fallback = { 400: 'The import request was not valid. Nothing was imported.', 413: 'The import is too large to confirm. Nothing was imported.', 429: 'Too many import confirmations. Please wait a minute and try again.' }[res.status];
    const e = new Error((typeof data?.error === 'string' && data.error.trim()) || fallback || 'The import could not be completed. Nothing was imported.');
    e.status = res.status;
    throw e;
  }
  return { stale: false, result: data };
}

// ── words and formats ────────────────────────────────────────────────────────────────────────────────────────────────
export function formatRupees(amount) {
  const abs = Math.abs(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${amount < 0 ? '−' : '+'}₹${abs}`;
}
// 2026-03-05 -> 05/03/2026 (string work only, so no time zone can shift the day)
export const formatDay = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : iso);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export function reviewHeadline(summary) {
  const dup = summary.likely + summary.possible;
  return `${plural(dup, 'row looks', 'rows look')} like ${dup === 1 ? 'a transaction' : 'transactions'} you already have`;
}

// Success text after a confirmed import.
export function confirmSuccessMessage(result, fileName) {
  const count = Number(result?.count) || 0;
  const d = result?.duplicates ?? {};
  const parts = [`Success! Imported ${plural(count, 'transaction', 'transactions')}${fileName ? ` from ${fileName}` : ''}.`];
  if (d.skippedLikely > 0) parts.push(`${plural(d.skippedLikely, 'likely duplicate was', 'likely duplicates were')} skipped.`);
  if (d.skippedByUser > 0) parts.push(`${plural(d.skippedByUser, 'row you excluded was', 'rows you excluded were')} not imported.`);
  if (d.likelyImportedAnyway > 0) parts.push(`${plural(d.likelyImportedAnyway, 'likely duplicate was', 'likely duplicates were')} imported at your request.`);
  return parts.join(' ');
}
