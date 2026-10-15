// Duplicate-import matching: pure unit tests (no database, no HTTP).
//
//   npm --prefix server run test:import-duplicates
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMPORT_ROWS, normalizeTitleKey, toPaise, duplicateKey, findDuplicates, summarizeDuplicates, buildPreview,
  reviewDigest, digestsEqual, parseConfirmRequest, planImport
} from '../importDuplicates.js';

const row = (title, amount, date = '2026-03-05', type = amount < 0 ? 'expense' : 'income', category = 'General') => ({ title, amount, date, type, category });
const saved = (id, title, amount, date = '2026-03-05', type = amount < 0 ? 'expense' : 'income') => ({ id: String(id), title, amount, date, type });
const tiers = (candidates, existing) => findDuplicates(candidates, existing).map((r) => r.tier);

test('title keys ignore case, punctuation, spacing and width variants but keep digits and letters', () => {
  assert.equal(normalizeTitleKey('  ZOMATO   Order #12  '), 'zomato order 12');
  assert.equal(normalizeTitleKey('zomato-order/12'), 'zomato order 12');
  assert.equal(normalizeTitleKey('ＺＯＭＡＴＯ ＯＲＤＥＲ'), 'zomato order');          // full-width letters (NFKC)
  assert.equal(normalizeTitleKey('Café Münch'), 'café münch');
  assert.notEqual(normalizeTitleKey('Zomato 12'), normalizeTitleKey('Zomato 13'));
  assert.equal(normalizeTitleKey(null), '');
  assert.equal(normalizeTitleKey('***'), '');
});

test('amount is compared in whole paise, direction is separate', () => {
  assert.equal(toPaise(120.5), 12050);
  assert.equal(toPaise(-120.5), 12050);
  assert.equal(toPaise(0.1 + 0.2), 30);
  assert.equal(toPaise(1.005 * 1000), 100500);
  assert.notEqual(duplicateKey(row('a', 100)), duplicateKey(row('a', -100)), 'income and expense of the same size are different');
  assert.equal(duplicateKey(row('a', -100)), duplicateKey(row('zzz', -100)), 'the title is not part of the key');
});

test('likely when date, amount, direction and normalized title agree; possible when only the title differs', () => {
  const existing = [saved(1, 'Zomato Order', -120.5)];
  assert.deepEqual(tiers([row('ZOMATO  order', -120.5)], existing), ['likely']);
  assert.deepEqual(tiers([row('Zomato', -120.5)], existing), ['possible']);
  assert.deepEqual(tiers([row('Zomato Order', -120.5, '2026-03-06')], existing), [null], 'another date');
  assert.deepEqual(tiers([row('Zomato Order', -120.51)], existing), [null], 'another amount');
  assert.deepEqual(tiers([row('Zomato Order', 120.5)], existing), [null], 'the other direction');
  assert.deepEqual(tiers([row('Zomato Order', -120.5)], []), [null]);
  const [r] = findDuplicates([row('Zomato', -120.5)], existing);
  assert.equal(r.match.id, '1');
  assert.equal(r.index, 0);
});

test('multiset: identical payments in ONE statement are not duplicates of each other', () => {
  const twoCoffees = [row('Coffee', -50), row('Coffee', -50)];
  assert.deepEqual(tiers(twoCoffees, []), [null, null]);
});

test('multiset: re-importing a statement flags every row; a longer statement only flags the rows already present', () => {
  const existing = [saved(1, 'Coffee', -50), saved(2, 'Coffee', -50)];
  assert.deepEqual(tiers([row('Coffee', -50), row('Coffee', -50)], existing), ['likely', 'likely'], 're-import of the same two');
  assert.deepEqual(tiers([row('Coffee', -50), row('Coffee', -50), row('Coffee', -50)], existing), ['likely', 'likely', null], 'a third identical payment is new');
  assert.deepEqual(tiers([row('Coffee', -50)], existing), ['likely'], 'a shorter statement is all already present');
  assert.deepEqual(tiers([row('Coffee', -50), row('Coffee', -50)], [saved(1, 'Coffee', -50)]), ['likely', null], 'one saved, two on the statement: one is new');
});

test('each saved row is matched by at most one candidate, and likely matches are served before possible ones', () => {
  const existing = [saved(1, 'Tea', -20), saved(2, 'Coffee', -20)];
  // A "Coffee" candidate listed after a "Chai" candidate must still get the Coffee row as a LIKELY match.
  const results = findDuplicates([row('Chai', -20), row('Coffee', -20)], existing);
  assert.deepEqual(results.map((r) => [r.tier, r.match?.id]), [['possible', '1'], ['likely', '2']]);
  assert.equal(new Set(results.map((r) => r.match.id)).size, 2, 'no saved row is used twice');
  assert.deepEqual(tiers([row('Chai', -20), row('Chai', -20), row('Chai', -20)], existing), ['possible', 'possible', null]);
});

test('candidate order is preserved and results line up with the candidates', () => {
  const existing = [saved(9, 'B', -2)];
  const candidates = [row('A', -1), row('B', -2), row('C', -3), row('B', -2)];
  const results = findDuplicates(candidates, existing);
  assert.deepEqual(results.map((r) => r.index), [0, 1, 2, 3]);
  assert.deepEqual(results.map((r) => r.tier), [null, 'likely', null, null], 'the EARLIEST matching candidate takes the saved row');
});

test('legacy repeated ids do not confuse matching', () => {
  const existing = [saved(7, 'Rent', -18000), saved(7, 'Rent', -18000)];
  assert.deepEqual(tiers([row('Rent', -18000), row('Rent', -18000)], existing), ['likely', 'likely']);
});

test('summary counts', () => {
  const results = findDuplicates([row('A', -1), row('B', -2), row('X', -3)], [saved(1, 'A', -1), saved(2, 'other', -2)]);
  assert.deepEqual(summarizeDuplicates(results), { total: 3, new: 1, likely: 1, possible: 1 });
});

test('preview exposes only the candidate rows and the one matched saved row (public fields)', () => {
  const existing = [{ ...saved(1, 'Zomato', -120.5), userId: 99, category: 'Secret', classification: 'income' }];
  const rows = [{ id: 'x', userId: 5, ...row('Zomato', -120.5) }, row('New', -5)];
  const results = findDuplicates(rows, existing);
  const preview = buildPreview(rows, results, { skipped: 2, digest: 'd'.repeat(64) });
  assert.deepEqual(preview.summary, { total: 2, new: 1, likely: 1, possible: 0 });
  assert.equal(preview.skipped, 2);
  assert.equal(preview.maxRows, MAX_IMPORT_ROWS);
  assert.deepEqual(preview.rows[0].duplicate, { tier: 'likely', match: { id: '1', title: 'Zomato', amount: -120.5, date: '2026-03-05', type: 'expense' } });
  assert.equal(preview.rows[1].duplicate, null);
  const text = JSON.stringify(preview);
  assert.ok(!/userId|Secret|classification|"id":"x"/.test(text), 'nothing beyond the public fields');
  assert.deepEqual(Object.keys(preview.rows[0]).sort(), ['amount', 'category', 'date', 'duplicate', 'index', 'title', 'type']);
});

test('review digest: bound to the user, the rows, every match and the whole pool of matchable saved rows; keyed with a secret', () => {
  const secret = 's'.repeat(40);
  const rows = [row('Zomato', -120.5), row('Pay', 50)];
  const pool = [saved(1, 'Zomato', -120.5)];
  const results = findDuplicates(rows, pool);
  const d = reviewDigest(secret, 5, rows, results, pool);
  assert.match(d, /^[a-f0-9]{64}$/);
  assert.equal(reviewDigest(secret, 5, rows, results, pool), d, 'deterministic');
  assert.notEqual(reviewDigest(secret, 6, rows, results, pool), d, 'another user');
  assert.notEqual(reviewDigest('t'.repeat(40), 5, rows, results, pool), d, 'another secret');
  assert.notEqual(reviewDigest(secret, 5, [row('Zomato', -120.51), rows[1]], results, pool), d, 'an edited amount');
  assert.notEqual(reviewDigest(secret, 5, [row('Zomato!', -120.5), rows[1]], results, pool), d, 'an edited title');
  assert.notEqual(reviewDigest(secret, 5, [{ ...rows[0], category: 'Food' }, rows[1]], results, pool), d, 'an edited category');
  assert.notEqual(reviewDigest(secret, 5, [rows[1], rows[0]], results, pool), d, 'reordered rows');
  assert.notEqual(reviewDigest(secret, 5, rows, findDuplicates(rows, []), []), d, 'the saved match disappeared');
  const grown = [...pool, saved(2, 'Pay', 50)];
  assert.notEqual(reviewDigest(secret, 5, rows, findDuplicates(rows, grown), grown), d, 'a new saved match appeared');
  const swapped = [saved(2, 'Zomato', -120.5)];
  assert.notEqual(reviewDigest(secret, 5, rows, findDuplicates(rows, swapped), swapped), d, 'a different saved row matches');
  // The double-click case: an identical extra copy was saved. Every candidate still matches the same (oldest) row, but the pool grew.
  const twoCopies = [saved(1, 'Zomato', -120.5), saved(3, 'Zomato', -120.5)];
  const sameMatches = findDuplicates(rows, twoCopies);
  assert.deepEqual(sameMatches.map((r) => r.match?.id), results.map((r) => r.match?.id), 'the matches themselves did not change');
  assert.notEqual(reviewDigest(secret, 5, rows, sameMatches, twoCopies), d, 'but the digest does, so a replayed confirm is stale');
  assert.equal(reviewDigest(secret, 5, rows.map((r) => ({ ...r, id: 'anything', userId: 77 })), results, pool), d, 'ids and owner fields on the rows are not part of it');
});

test('digestsEqual is strict', () => {
  const a = 'a'.repeat(64);
  assert.equal(digestsEqual(a, a), true);
  assert.equal(digestsEqual(a, 'b'.repeat(64)), false);
  for (const bad of [undefined, null, 5, '', 'a'.repeat(63), 'g'.repeat(64), 'A'.repeat(64)]) assert.equal(digestsEqual(a, bad), false, String(bad));
});

test('confirm envelope validation', () => {
  const ok = { rows: [row('A', -1)], policy: 'skip_duplicates', reviewDigest: 'a'.repeat(64) };
  assert.equal(parseConfirmRequest(ok).ok, true);
  assert.deepEqual(parseConfirmRequest({ ...ok, skipIndexes: [0, 0] }).value.skipIndexes, [0]);
  for (const body of [null, [], 'x', 5, {}]) assert.equal(parseConfirmRequest(body).ok, false);
  assert.equal(parseConfirmRequest({ ...ok, rows: [] }).ok, false, 'no rows');
  assert.equal(parseConfirmRequest({ ...ok, rows: 'nope' }).ok, false);
  assert.equal(parseConfirmRequest({ ...ok, rows: Array(MAX_IMPORT_ROWS).fill(row('A', -1)) }).ok, true, `${MAX_IMPORT_ROWS} rows is the limit`);
  const over = parseConfirmRequest({ ...ok, rows: Array(MAX_IMPORT_ROWS + 1).fill(row('A', -1)) });
  assert.equal(over.ok, false);
  assert.match(over.error, /500/);
  for (const policy of [undefined, 'skip', 'IMPORT_ALL', 'allow', 5]) assert.equal(parseConfirmRequest({ ...ok, policy }).ok, false, String(policy));
  for (const reviewDigest of [undefined, 'short', 'z'.repeat(64), 5]) assert.equal(parseConfirmRequest({ ...ok, reviewDigest }).ok, false, String(reviewDigest));
  for (const skipIndexes of ['0', [1], [-1], [0.5], ['0']]) assert.equal(parseConfirmRequest({ ...ok, skipIndexes }).ok, false, JSON.stringify(skipIndexes));
});

test('import plan: skip_duplicates leaves out likely matches only; possible matches are never skipped by policy', () => {
  const rows = [row('A', -1), row('B', -2), row('C', -3), row('D', -4)];
  const results = findDuplicates(rows, [saved(1, 'A', -1), saved(2, 'other', -2)]);          // A likely, B possible, C and D new
  const skip = planImport(rows, results, { policy: 'skip_duplicates' });
  assert.deepEqual(skip.insert.map((r) => r.title), ['B', 'C', 'D'], 'the possible match B is imported, not dropped');
  assert.deepEqual([skip.skippedLikely, skip.possibleImported, skip.likelyImportedAnyway, skip.skippedByUser], [1, 1, 0, 0]);
  const all = planImport(rows, results, { policy: 'import_all' });
  assert.deepEqual(all.insert.map((r) => r.title), ['A', 'B', 'C', 'D'], 'candidate order kept');
  assert.deepEqual([all.skippedLikely, all.possibleImported, all.likelyImportedAnyway], [0, 1, 1]);
});

test('import plan: only an explicit skip omits a possible match, and it is counted separately', () => {
  const rows = [row('A', -1), row('B', -2)];
  const results = findDuplicates(rows, [saved(1, 'A', -1), saved(2, 'other', -2)]);
  const plan = planImport(rows, results, { policy: 'skip_duplicates', skipIndexes: [1] });
  assert.deepEqual(plan.insert, []);
  assert.deepEqual([plan.skippedLikely, plan.skippedByUser, plan.possibleImported], [1, 1, 0]);
  const some = planImport(rows, results, { policy: 'import_all', skipIndexes: [0] });
  assert.deepEqual(some.insert.map((r) => r.title), ['B']);
});

test('repeated identical payments: skip_duplicates keeps exactly the new ones', () => {
  const rows = [row('Coffee', -50), row('Coffee', -50), row('Coffee', -50)];
  const results = findDuplicates(rows, [saved(1, 'Coffee', -50), saved(2, 'Coffee', -50)]);
  const plan = planImport(rows, results, { policy: 'skip_duplicates' });
  assert.equal(plan.insert.length, 1);
  assert.equal(plan.insert[0], rows[2], 'the new payment is the third one');
});
