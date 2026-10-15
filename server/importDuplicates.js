// importDuplicates.js - pure duplicate-import logic (no database, no HTTP). Opt-in: nothing here runs unless a client asks for
// duplicate reporting (see POST /api/transactions/parse-statement?duplicates=report and POST /api/transactions/import-confirm).
//
// A statement row is a possible duplicate of a transaction the SAME user already has when the date, the amount and the direction
// (income / expense) agree:
//   likely    ... and the normalized titles are equal as well
//   possible  ... but the titles differ (the same payment can read differently across Excel, OCR and an AI parse)
// Matching is by COUNT (a multiset): each saved transaction can be matched by at most one candidate row, so two genuinely
// identical payments are not treated as duplicates of each other, a re-import of the same statement is, and a statement that
// repeats a payment more often than the user already has it only has the already-present ones flagged.
// Nothing here ever decides on a "possible" match alone: the callers either hold the import back (report mode) or import it unless
// the user explicitly said otherwise (confirm).
import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_IMPORT_ROWS = 500;
export const IMPORT_POLICIES = Object.freeze(['skip_duplicates', 'import_all']);

// Letters and digits only, lower case, single spaces: "ZOMATO  Order #12" and "zomato order 12" agree.
export function normalizeTitleKey(title) {
  return String(title ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Whole paise as an integer, so no floating point comparison is ever made. Direction is carried by `type`.
export const toPaise = (amount) => Math.round(Math.abs(Number(amount)) * 100);

export const duplicateKey = (row) => `${row.date}|${toPaise(row.amount)}|${row.type}`;

// candidates: rows in statement order ({ title, amount, date, type, ... }); existing: the user's own saved rows that share a date
// and amount with a candidate ({ id, title, amount, date, type }), in a stable order (oldest first).
// Returns one entry per candidate, in the SAME ORDER: { index, tier: 'likely' | 'possible' | null, match: existingRow | null }.
export function findDuplicates(candidates, existing) {
  const pools = new Map();
  for (const row of existing) {
    const key = duplicateKey(row);
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push({ row, used: false, titleKey: normalizeTitleKey(row.title) });
  }
  const results = candidates.map((_, index) => ({ index, tier: null, match: null }));
  // Pass 1: likely (same normalized title). Each saved row is consumed once, earliest candidate first.
  candidates.forEach((candidate, index) => {
    const pool = pools.get(duplicateKey(candidate));
    if (!pool) return;
    const titleKey = normalizeTitleKey(candidate.title);
    const hit = pool.find((p) => !p.used && p.titleKey === titleKey);
    if (hit) { hit.used = true; results[index] = { index, tier: 'likely', match: hit.row }; }
  });
  // Pass 2: possible (same date, amount and direction, a different title) over what pass 1 left unmatched.
  candidates.forEach((candidate, index) => {
    if (results[index].tier) return;
    const pool = pools.get(duplicateKey(candidate));
    const hit = pool?.find((p) => !p.used);
    if (hit) { hit.used = true; results[index] = { index, tier: 'possible', match: hit.row }; }
  });
  return results;
}

export function summarizeDuplicates(results) {
  const likely = results.filter((r) => r.tier === 'likely').length;
  const possible = results.filter((r) => r.tier === 'possible').length;
  return { total: results.length, new: results.length - likely - possible, likely, possible };
}

// What a client may see: its own candidate rows and, for each, the one saved row it matched (never anything else).
const publicMatch = (m) => ({ id: m.id, title: m.title, amount: m.amount, date: m.date, type: m.type });
export function buildPreview(rows, results, { skipped = 0, digest }) {
  return {
    summary: summarizeDuplicates(results),
    skipped,
    maxRows: MAX_IMPORT_ROWS,
    reviewDigest: digest,
    rows: rows.map((row, index) => ({
      index,
      title: row.title, amount: row.amount, date: row.date, type: row.type, category: row.category,
      duplicate: results[index].tier ? { tier: results[index].tier, match: publicMatch(results[index].match) } : null
    }))
  };
}

// A fingerprint of exactly what was reviewed: the user, every row, every row's match AND the whole pool of the user's saved
// transactions those rows could match (same date and amount). It is keyed with a server secret, so a client cannot produce one.
// It changes if the rows were edited, or if the user's saved transactions changed in any way that could alter a match, including a
// further identical row appearing (which is exactly what a second, double-clicked confirm would have just created). Confirm
// recomputes it inside the import lock; a different value means "stale" and nothing is saved.
export function reviewDigest(secret, userId, rows, results, existing) {
  const canonical = JSON.stringify([
    'finsphere:import-review:v2', Number(userId),
    rows.map((r) => [r.date, toPaise(r.amount), r.type, r.title, r.category]),
    results.map((r) => [r.tier, r.match ? String(r.match.id) : null]),
    existing.map((r) => String(r.id))
  ]);
  return createHmac('sha256', secret).update(canonical).digest('hex');
}
export function digestsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[a-f0-9]+$/.test(a) || !/^[a-f0-9]+$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// Envelope validation for POST /api/transactions/import-confirm. Row CONTENT is validated by the server's transaction normalizer.
export function parseConfirmRequest(body) {
  const bad = (error) => ({ ok: false, error });
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return bad('Request body must be an object');
  const { rows, policy, reviewDigest: digest, skipIndexes } = body;
  if (!Array.isArray(rows) || rows.length === 0) return bad('rows must be a non-empty array');
  if (rows.length > MAX_IMPORT_ROWS) return bad(`At most ${MAX_IMPORT_ROWS} rows can be imported at once`);
  if (!IMPORT_POLICIES.includes(policy)) return bad(`policy must be one of: ${IMPORT_POLICIES.join(', ')}`);
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return bad('reviewDigest is required (the value returned with the duplicate preview)');
  let skip = [];
  if (skipIndexes !== undefined) {
    if (!Array.isArray(skipIndexes) || skipIndexes.length > MAX_IMPORT_ROWS || !skipIndexes.every((i) => Number.isInteger(i) && i >= 0 && i < rows.length)) {
      return bad('skipIndexes must be an array of row positions within rows');
    }
    skip = [...new Set(skipIndexes)];
  }
  return { ok: true, value: { rows, policy, reviewDigest: digest, skipIndexes: skip } };
}

// Which rows are saved. skip_duplicates leaves out LIKELY duplicates only; import_all leaves out none. A "possible" match is never
// left out by policy: only the user's explicit skipIndexes can omit it. Order of the saved rows is the candidate order.
export function planImport(rows, results, { policy, skipIndexes = [] }) {
  const explicit = new Set(skipIndexes);
  const insert = [];
  const plan = { skippedLikely: 0, skippedByUser: 0, likelyImportedAnyway: 0, possibleImported: 0 };
  rows.forEach((row, index) => {
    const tier = results[index].tier;
    if (explicit.has(index)) { plan.skippedByUser++; return; }
    if (tier === 'likely' && policy === 'skip_duplicates') { plan.skippedLikely++; return; }
    if (tier === 'likely') plan.likelyImportedAnyway++;
    if (tier === 'possible') plan.possibleImported++;
    insert.push(row);
  });
  return { insert, ...plan };
}
