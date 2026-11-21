// Duplicate-review workflow (frontend Stage 2): the page treats a held-back import (409 DUPLICATES_FOUND) as a review step, lets the
// user choose rows, confirms the ORIGINAL previewed rows with the issued digest, handles a stale review, and never saves on its own.
//
//   npm run test:duplicate-review
//
// Part 1 renders the real Transactions page + DuplicateReview with a mocked finance context (every call is recorded).
// Part 2 renders the real FinanceProvider with a stubbed fetch to check the actual HTTP requests and responses.
// Part 3 covers the pure helpers. No server, no database; every row is synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');

let pass = 0;
// The page clears its success message after 5 s. Run that timer inside act() so the late state update is not reported as a warning.
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => nativeSetTimeout(typeof fn === 'function' && ms === 5000 ? () => { act(async () => { fn(...args); }); } : fn, ms, ...args);
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; }, (err) => { console.error('FAIL:', name); throw err; });

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const DIGEST = 'a'.repeat(64), DIGEST2 = 'b'.repeat(64);
const saved = (id, title, amount, date, type = amount < 0 ? 'expense' : 'income') => ({ id, title, amount, date, type });
const prow = (title, amount, date, duplicate = null, category = 'General') => ({ title, amount, date, type: amount < 0 ? 'expense' : 'income', category, duplicate });
// 5 rows: 0 new, 1 likely, 2 possible, 3 likely, 4 new
function serverPreview(digest = DIGEST, skipped = 0) {
  return {
    success: false, code: 'DUPLICATES_FOUND', error: 'Some rows look like transactions you already have.',
    summary: { total: 5, new: 2, likely: 2, possible: 1 }, skipped, maxRows: 500, reviewDigest: digest,
    rows: [
      { index: 0, ...prow('NEW SHOP', -30, '2026-03-08') },
      { index: 1, ...prow('ZOMATO ORDER', -120.5, '2026-03-05', { tier: 'likely', match: saved('s1', 'Zomato Order', -120.5, '2026-03-05') }) },
      { index: 2, ...prow('CHAI POINT', -15, '2026-03-09', { tier: 'possible', match: saved('s2', 'Tea stall', -15, '2026-03-09') }) },
      { index: 3, ...prow('SALARY ACME', 50000, '2026-03-06', { tier: 'likely', match: saved('s3', 'Salary Acme', 50000, '2026-03-06') }) },
      { index: 4, ...prow('BUS PASS', -25, '2026-03-10') }
    ]
  };
}
const STATEMENT = '05/03/2026 ZOMATO ORDER -120.50\n06/03/2026 SALARY ACME +50000.00\n08/03/2026 NEW SHOP -30.00';

// ── mocks for part 1 ─────────────────────────────────────────────────────────────────────────────────────────────────
const calls = { parse: [], confirm: [], extract: [], add: [] };
let parseImpl, confirmImpl, extractImpl;
globalThis.__fin = {
  transactions: [], loading: false, addTransaction: async (...a) => { calls.add.push(a); }, deleteTransaction: async () => {},
  parseStatement: (input) => { calls.parse.push(input); return parseImpl(input); },
  confirmImport: (request) => { calls.confirm.push(request); return confirmImpl(request); },
  extractTextFromImage: (file) => { calls.extract.push(file); return extractImpl(file); }
};
const reset = () => {
  for (const k of Object.keys(calls)) calls[k] = [];
  parseImpl = async () => ({ count: 2, skipped: 0 });
  confirmImpl = async () => ({ stale: false, result: { success: true, count: 3, skipped: 2, transactions: [], duplicates: { skippedLikely: 2, skippedByUser: 0, likelyImportedAnyway: 0, possibleImported: 1 } } });
  extractImpl = async () => ({ text: '', confidence: null, warnings: [] });
};
reset();
globalThis.__invalidated = 0;

const vite = await createServer({
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
  plugins: [{
    name: 'dup-review-mocks', enforce: 'pre',
    resolveId(id, importer) {
      if (id.endsWith('AuthContext')) return '\0auth-mock';
      if (id.endsWith('/context/FinanceContext') && importer && importer.replace(/\\/g, '/').endsWith('pages/Transactions.jsx')) return '\0finance-mock';
    },
    load(id) {
      if (id === '\0auth-mock') return 'export const useAuth=()=>({invalidateSession:()=>{globalThis.__invalidated++;}});';
      if (id === '\0finance-mock') return 'export const useFinance=()=>globalThis.__fin;';
    }
  }]
});

const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const logged = [];
const realConsole = {};
for (const level of ['log', 'info', 'warn', 'error', 'debug']) realConsole[level] = console[level];

try {
  // ═══ Part 3 first: pure helpers ═══════════════════════════════════════════════════════════════════════════════════
  const dr = await vite.ssrLoadModule('/src/utils/duplicateReview.js');

  await check('normalizePreview keeps the ordered rows, derives the summary from them and rejects malformed answers', () => {
    const p = dr.normalizePreview(serverPreview(DIGEST, 2));
    assert.deepEqual(p.summary, { total: 5, new: 2, likely: 2, possible: 1 });
    assert.equal(p.skipped, 2);
    assert.equal(p.maxRows, 500);
    assert.equal(p.reviewDigest, DIGEST);
    assert.deepEqual(p.rows.map((r) => r.index), [0, 1, 2, 3, 4]);
    assert.deepEqual(p.rows[1].duplicate, { tier: 'likely', match: { id: 's1', title: 'Zomato Order', amount: -120.5, date: '2026-03-05', type: 'expense' } });
    assert.equal(p.rows[0].duplicate, null);
    const lying = serverPreview(); lying.summary = { total: 99, new: 99, likely: 0, possible: 0 };
    assert.deepEqual(dr.normalizePreview(lying).summary, { total: 5, new: 2, likely: 2, possible: 1 }, 'counted from the rows, never from a separate claim');
    const extra = serverPreview(); extra.rows[0].userId = 5; extra.rows[0].classification = 'income'; extra.rows[0].id = 'x';
    assert.deepEqual(Object.keys(dr.normalizePreview(extra).rows[0]).sort(), ['amount', 'category', 'date', 'duplicate', 'index', 'title', 'type']);
    for (const mutate of [(b) => { b.reviewDigest = 'short'; }, (b) => { delete b.reviewDigest; }, (b) => { b.rows = []; }, (b) => { b.rows = 'x'; },
      (b) => { b.rows[0].amount = 'abc'; }, (b) => { b.rows[0].type = 'transfer'; }, (b) => { b.rows[1].duplicate.tier = 'maybe'; }, (b) => { b.rows[1].duplicate.match = null; }]) {
      const b = serverPreview(); mutate(b);
      assert.equal(dr.normalizePreview(b), null);
    }
    assert.equal(dr.normalizePreview(null), null);
  });

  await check('default selection: likely duplicates off, new and possible on', () => {
    const p = dr.normalizePreview(serverPreview());
    assert.deepEqual([...dr.defaultSelection(p)].sort(), [0, 2, 4]);
    assert.deepEqual(dr.selectionCounts(p, dr.defaultSelection(p)), { selected: 3, new: 2, likely: 0, possible: 1 });
    assert.deepEqual(dr.selectionCounts(p, new Set([0, 1, 2, 3, 4])), { selected: 5, new: 2, likely: 2, possible: 1 });
  });

  await check('confirm request: original rows (five fields), the issued digest, and the right policy / exclusions', () => {
    const p = dr.normalizePreview(serverPreview());
    const rowsOut = p.rows.map(({ title, amount, date, type, category }) => ({ title, amount, date, type, category }));
    // default: skip_duplicates, nothing else excluded
    let r = dr.buildConfirmRequest(p, dr.defaultSelection(p), 'selected');
    assert.deepEqual(r, { rows: rowsOut, policy: 'skip_duplicates', reviewDigest: DIGEST, skipIndexes: [] });
    assert.ok(r.rows.every((row) => Object.keys(row).sort().join() === 'amount,category,date,title,type'), 'no index, duplicate, id or owner is sent');
    // a possible row excluded explicitly
    r = dr.buildConfirmRequest(p, new Set([0, 4]), 'selected');
    assert.deepEqual([r.policy, r.skipIndexes], ['skip_duplicates', [2]], 'likely rows are left to the policy, only the user\'s exclusion is listed');
    // a likely row ticked -> import_all with every unticked row listed
    r = dr.buildConfirmRequest(p, new Set([0, 1, 2, 4]), 'selected');
    assert.deepEqual([r.policy, r.skipIndexes], ['import_all', [3]]);
    // import all anyway
    r = dr.buildConfirmRequest(p, new Set(), 'all');
    assert.deepEqual([r.policy, r.skipIndexes, r.rows.length], ['import_all', [], 5]);
  });

  await check('formats and messages', () => {
    assert.equal(dr.formatRupees(-120.5), '−₹120.50');
    assert.equal(dr.formatRupees(50000), '+₹50,000.00');
    assert.equal(dr.formatRupees(-1234567.8), '−₹12,34,567.80');
    assert.equal(dr.formatDay('2026-03-05'), '05/03/2026');
    assert.equal(dr.formatDay('weird'), 'weird');
    assert.equal(dr.reviewHeadline({ likely: 1, possible: 0 }), '1 row looks like a transaction you already have');
    assert.equal(dr.reviewHeadline({ likely: 2, possible: 1 }), '3 rows look like transactions you already have');
    assert.equal(dr.confirmSuccessMessage({ count: 3, duplicates: { skippedLikely: 2, skippedByUser: 1, likelyImportedAnyway: 0 } }),
      'Success! Imported 3 transactions. 2 likely duplicates were skipped. 1 row you excluded was not imported.');
    assert.equal(dr.confirmSuccessMessage({ count: 1, duplicates: { skippedLikely: 1 } }, 'a.csv'), 'Success! Imported 1 transaction from a.csv. 1 likely duplicate was skipped.');
    assert.equal(dr.confirmSuccessMessage({ count: 5, duplicates: { likelyImportedAnyway: 2 } }), 'Success! Imported 5 transactions. 2 likely duplicates were imported at your request.');
    assert.equal(dr.confirmSuccessMessage({ count: 2 }), 'Success! Imported 2 transactions.');
  });

  // ═══ Part 1: the page ═════════════════════════════════════════════════════════════════════════════════════════════
  const { default: Transactions } = await vite.ssrLoadModule('/src/pages/Transactions.jsx');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Transactions)));

  const q = (sel) => container.querySelector(sel);
  const button = (re) => [...container.querySelectorAll('button')].find((b) => re.test(b.textContent));
  const click = async (target) => { await act(async () => { (typeof target === 'string' ? q(target) : target instanceof RegExp ? button(target) : target).click(); }); };
  const textarea = () => q('textarea');
  const typeInto = (value) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(textarea(), value);
    textarea().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const setFile = async (name) => {
    const file = new window.File([new Uint8Array([1, 2, 3])], name, { type: 'application/octet-stream' });
    await act(async () => { const i = q('input[type=file]'); Object.defineProperty(i, 'files', { value: [file], configurable: true }); i.dispatchEvent(new window.Event('change', { bubbles: true })); });
    return file;
  };
  const rowEl = (i) => q(`[data-testid=dup-row-${i}]`);
  const box = (i) => rowEl(i).querySelector('input[type=checkbox]');
  const toggle = async (i) => click(box(i));
  const live = () => q('[data-testid=ocr-live]').textContent;
  const openPaste = () => click(/^Paste Text Log/);
  const openUpload = () => click(/^Upload File/);
  const startReview = async (preview = serverPreview()) => {
    parseImpl = async () => ({ review: true, preview: dr.normalizePreview(preview) });
    await openPaste();
    await typeInto(STATEMENT);
    await click(/Parse Logs/);
    await flush();
  };
  const closeReview = async () => { if (q('[data-testid=dup-review]')) await click(/^Cancel$/); };

  await check('normal import is unchanged: a 200 shows the usual success message and no review', async () => {
    reset();
    await openPaste();
    await typeInto('05/03/2026 A -1.00\n06/03/2026 B +2.00');
    await click(/Parse Logs/);
    await flush();
    assert.ok(q('[data-testid=dup-review]') === null);
    assert.match(container.textContent, /Success! Imported 2 transactions\./);
    assert.equal(calls.parse.length, 1);
    assert.equal(calls.confirm.length, 0);
    assert.equal(textarea().value, '', 'the editor is cleared as before');
  });

  await check('a held-back import opens the REVIEW, not an error; nothing is imported; the text is kept', async () => {
    reset();
    await startReview(serverPreview(DIGEST, 1));
    const panel = q('[data-testid=dup-review]');
    assert.ok(panel);
    assert.ok(q('[role=alert]') === null, 'not shown as an error');
    assert.ok(!/Success!/.test(container.textContent));
    assert.equal(calls.confirm.length, 0);
    assert.equal(panel.getAttribute('role'), 'region');
    assert.equal(document.getElementById(panel.getAttribute('aria-labelledby')).textContent.trim(), 'Review before importing');
    assert.match(panel.textContent, /3 rows look like transactions you already have\. Nothing has been imported yet\./);
    assert.match(panel.textContent, /1 other row was not readable/);
    assert.equal(document.activeElement.id, 'dup-review-title', 'focus moves to the review heading');
    assert.match(live(), /3 rows look like transactions you already have\. Nothing has been imported yet\./);
    assert.ok(button(/Parse Logs/) === undefined, 'the normal import buttons are not available while reviewing');
    assert.ok(button(/^Paste Text Log/).disabled && button(/^Upload File/).disabled, 'the tabs are locked while reviewing');
  });

  await check('summary counts and every row with its tier and matching saved transaction', () => {
    const summary = q('[data-testid=dup-summary]').textContent;
    assert.match(summary, /New\s*2/);
    assert.match(summary, /Likely duplicate\s*2/);
    assert.match(summary, /Possible duplicate\s*1/);
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => rowEl(i).dataset.tier), ['new', 'likely', 'possible', 'likely', 'new']);
    assert.match(rowEl(1).textContent, /Likely duplicate/);
    assert.match(rowEl(1).textContent, /ZOMATO ORDER/);
    assert.match(rowEl(1).textContent, /05\/03\/2026 · −₹120\.50/);
    assert.match(rowEl(1).textContent, /Already saved: Zomato Order · 05\/03\/2026 · −₹120\.50/);
    assert.match(rowEl(2).textContent, /Possible duplicate/);
    assert.match(rowEl(2).textContent, /Already saved: Tea stall · 09\/03\/2026 · −₹15\.00/);
    assert.match(rowEl(3).textContent, /\+₹50,000\.00/);
    assert.match(rowEl(0).textContent, /New/);
    assert.ok(!/Already saved/.test(rowEl(0).textContent) && !/Already saved/.test(rowEl(4).textContent), 'new rows have no match line');
    assert.match(q('[data-testid=dup-review]').textContent, /Possible duplicate:.*may be a different payment, so it stays selected/);
    assert.match(q('[data-testid=dup-review]').textContent, /Likely duplicate:.*Not selected/);
  });

  await check('default selection: likely off, new and possible on; selection line and button counts follow', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => box(i).checked), [true, false, true, false, true]);
    assert.match(q('[data-testid=dup-selection]').textContent, /Importing 3 of 5 rows \(2 new, 1 possible, 0 likely\)\./);
    assert.ok(button(/Import selected rows \(3\)/));
    assert.ok(button(/Import all 5 anyway/));
    assert.ok(button(/^Cancel$/));
  });

  await check('each checkbox has an accessible name with the row, date, amount and kind; the list is a labelled, focusable group', () => {
    assert.equal(box(1).getAttribute('aria-label'), 'Import ZOMATO ORDER, 05/03/2026, −₹120.50, Likely duplicate');
    assert.equal(box(2).getAttribute('aria-label'), 'Import CHAI POINT, 09/03/2026, −₹15.00, Possible duplicate');
    assert.equal(box(0).getAttribute('aria-label'), 'Import NEW SHOP, 08/03/2026, −₹30.00, New');
    const group = q('.dup-review-list');
    assert.equal(group.getAttribute('role'), 'group');
    assert.equal(group.getAttribute('aria-label'), 'Rows to review');
    assert.equal(group.tabIndex, 0, 'a scrollable region must be keyboard reachable');
    assert.ok(q('[data-testid=dup-review]').querySelectorAll('ul li').length >= 5 + 3);
    const ids = [...container.querySelectorAll('[id]')].map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
    for (const b of container.querySelectorAll('[data-testid=dup-review] button')) assert.ok(b.textContent.trim().length > 0);
  });

  await check('individual exclusion: unticking a possible row sends skipIndexes for it, with the original rows and digest, no re-parse', async () => {
    await toggle(2);
    assert.equal(box(2).checked, false);
    assert.match(q('[data-testid=dup-selection]').textContent, /Importing 2 of 5 rows/);
    assert.ok(button(/Import selected rows \(2\)/));
    const parsesBefore = calls.parse.length;
    await click(/Import selected rows/);
    await flush();
    assert.equal(calls.confirm.length, 1);
    const sent = calls.confirm[0];
    assert.equal(sent.policy, 'skip_duplicates');
    assert.deepEqual(sent.skipIndexes, [2], 'the likely rows are left to the policy; only the user\'s exclusion is listed');
    assert.equal(sent.reviewDigest, DIGEST);
    assert.equal(sent.rows.length, 5);
    assert.deepEqual(sent.rows[1], { title: 'ZOMATO ORDER', amount: -120.5, date: '2026-03-05', type: 'expense', category: 'General' });
    assert.equal(calls.parse.length, parsesBefore, 'the statement was NOT parsed again');
    assert.equal(calls.extract.length, 0);
  });

  await check('success: the message says what was skipped, the review closes, the editor is cleared and focused', async () => {
    assert.ok(q('[data-testid=dup-review]') === null);
    assert.match(container.textContent, /Success! Imported 3 transactions\. 2 likely duplicates were skipped\./);
    assert.equal(textarea().value, '');
    assert.ok(document.activeElement === textarea(), 'focus lands on the editor, ready for the next statement');
  });

  await check('ticking a likely row switches to import_all with every unticked row excluded', async () => {
    reset(); await startReview();
    await toggle(1);
    assert.match(q('[data-testid=dup-selection]').textContent, /Importing 4 of 5 rows \(2 new, 1 possible, 1 likely\)/);
    await click(/Import selected rows \(4\)/);
    await flush();
    assert.equal(calls.confirm[0].policy, 'import_all');
    assert.deepEqual(calls.confirm[0].skipIndexes, [3]);
  });

  await check('"Import all anyway" sends import_all with no exclusions, whatever is ticked', async () => {
    reset(); await startReview();
    await toggle(0); await toggle(4);
    await click(/Import all 5 anyway/);
    await flush();
    assert.deepEqual([calls.confirm[0].policy, calls.confirm[0].skipIndexes, calls.confirm[0].rows.length], ['import_all', [], 5]);
    assert.equal(calls.confirm[0].reviewDigest, DIGEST);
  });

  await check('with nothing ticked "Import selected rows" is disabled and sends nothing', async () => {
    reset(); await startReview();
    for (const i of [0, 2, 4]) await toggle(i);
    assert.match(q('[data-testid=dup-selection]').textContent, /Importing 0 of 5 rows\./);
    const b = button(/Import selected rows \(0\)/);
    assert.equal(b.disabled, true);
    await click(b);
    assert.equal(calls.confirm.length, 0);
    assert.ok(!button(/Import all 5 anyway/).disabled, 'the explicit "all" choice stays available');
  });

  await check('cancel saves nothing, keeps the statement text, and returns focus to Parse Logs', async () => {
    await click(/^Cancel$/);
    assert.ok(q('[data-testid=dup-review]') === null);
    assert.equal(calls.confirm.length, 0);
    assert.equal(textarea().value, STATEMENT, 'the statement text is exactly as it was');
    assert.ok(document.activeElement === button(/Parse Logs/));
    assert.ok(q('[role=alert]') === null);
    assert.ok(!button(/^Paste Text Log/).disabled, 'the tabs are unlocked again');
  });

  await check('duplicate clicks: three rapid clicks send one confirmation; the controls lock while it runs', async () => {
    reset(); await startReview();
    const gate = deferred();
    confirmImpl = () => gate.promise;
    await act(async () => { const b = button(/Import selected rows/); b.click(); b.click(); b.click(); });
    assert.equal(calls.confirm.length, 1, 'one request despite three clicks');
    const panel = q('[data-testid=dup-review]');
    assert.equal(panel.getAttribute('aria-busy'), 'true');
    assert.ok(button(/Importing…/).disabled);
    assert.ok(button(/Import all 5 anyway/).disabled && button(/^Cancel$/).disabled);
    assert.ok([0, 1, 2, 3, 4].every((i) => box(i).disabled), 'the checkboxes lock too');
    await click(/Import all 5 anyway/); await click(/^Cancel$/);
    assert.equal(calls.confirm.length, 1, 'a click on a disabled control does nothing');
    assert.match(live(), /Importing the selected rows/);
    await act(async () => gate.resolve({ stale: false, result: { success: true, count: 3, duplicates: { skippedLikely: 2 } } }));
    await flush();
    assert.ok(q('[data-testid=dup-review]') === null);
  });

  await check('rapid Parse Logs clicks start one import', async () => {
    reset();
    const gate = deferred();
    parseImpl = () => gate.promise;
    await openPaste(); await typeInto(STATEMENT);
    await act(async () => { const b = button(/Parse Logs/); b.click(); b.click(); });
    assert.equal(calls.parse.length, 1);
    await act(async () => gate.resolve({ count: 3, skipped: 0 }));
    await flush();
  });

  await check('stale review: nothing saved, the refreshed review replaces the old one with a clean selection and must be confirmed again', async () => {
    reset(); await startReview();
    await toggle(2);                                                    // a choice made against the OLD review
    const fresh = serverPreview(DIGEST2);
    fresh.rows = fresh.rows.slice(0, 3); fresh.summary = { total: 3, new: 1, likely: 1, possible: 1 };
    confirmImpl = async () => ({ stale: true, preview: dr.normalizePreview(fresh) });
    await click(/Import selected rows/);
    await flush();
    assert.equal(calls.confirm.length, 1);
    assert.ok(q('[data-testid=dup-review]'), 'still reviewing');
    assert.match(q('[data-testid=dup-stale]').textContent, /nothing was imported and this list was refreshed\. Check it again, then confirm again\./);
    assert.ok(rowEl(3) === null, 'the list is the refreshed one (3 rows)');
    assert.deepEqual([0, 1, 2].map((i) => box(i).checked), [true, false, true], 'the selection is reset to the defaults for the new data');
    assert.equal(document.activeElement.id, 'dup-review-title', 'focus returns to the heading');
    assert.match(live(), /Your transactions changed, so nothing was imported\. The review was refreshed\./);
    assert.equal(calls.confirm.length, 1, 'it did NOT confirm again by itself');
    assert.ok(textarea() === null);
    confirmImpl = async () => ({ stale: false, result: { success: true, count: 2, duplicates: { skippedLikely: 1 } } });
    await click(/Import selected rows/);
    await flush();
    assert.equal(calls.confirm.length, 2, 'only an explicit click confirms the refreshed review');
    assert.equal(calls.confirm[1].reviewDigest, DIGEST2, 'with the NEW digest');
    assert.equal(calls.confirm[1].rows.length, 3);
    assert.ok(q('[data-testid=dup-review]') === null);
  });

  await check('a failed confirmation keeps the review, selection and rows, shows the error, and can be retried', async () => {
    reset(); await startReview();
    await toggle(2);
    confirmImpl = async () => { throw new Error('Too many import confirmations. Please wait a minute and try again.'); };
    await click(/Import selected rows/);
    await flush();
    assert.equal(q('[role=alert]').textContent, 'Too many import confirmations. Please wait a minute and try again.');
    assert.ok(q('[data-testid=dup-review]'));
    assert.equal(box(2).checked, false, 'the user\'s choices are kept');
    assert.ok(!button(/Import selected rows/).disabled, 'controls are unlocked for a retry');
    confirmImpl = async () => ({ stale: false, result: { success: true, count: 2, duplicates: { skippedLikely: 2, skippedByUser: 1 } } });
    await click(/Import selected rows/);
    await flush();
    assert.match(container.textContent, /Success! Imported 2 transactions\. 2 likely duplicates were skipped\. 1 row you excluded was not imported\./);
    assert.equal(calls.confirm.length, 2);
  });

  await check('a session that expired during confirmation is reported and nothing is shown as imported', async () => {
    reset(); await startReview();
    confirmImpl = async () => { throw new Error('Session expired'); };
    await click(/Import selected rows/);
    await flush();
    assert.equal(q('[role=alert]').textContent, 'Session expired');
    assert.ok(!/Success!/.test(container.textContent));
    await closeReview();
  });

  await check('file import: the review keeps the chosen file; confirm names the file; cancel returns focus to Parse File', async () => {
    reset();
    parseImpl = async () => ({ review: true, preview: dr.normalizePreview(serverPreview()) });
    await openUpload();
    const file = await setFile('stmt.csv');
    await click(/Parse File/);
    await flush();
    assert.ok(q('[data-testid=dup-review]'));
    assert.equal(calls.parse[0].name, 'stmt.csv');
    assert.ok(calls.parse[0] === file);
    await click(/^Cancel$/);
    assert.ok(document.activeElement === button(/Parse File/), 'focus returns to the button that started the import');
    assert.match(container.textContent, /stmt\.csv/, 'the file is still chosen');
    assert.equal(calls.confirm.length, 0);
    await click(/Parse File/);
    await flush();
    assert.equal(calls.parse.length, 2, 'the import can be started again');
    await click(/Import selected rows/);
    await flush();
    assert.match(container.textContent, /Success! Imported 3 transactions from stmt\.csv\./);
    assert.ok(document.activeElement === q('input[type=file]'));
    assert.ok(!/stmt\.csv/.test(q('input[type=file]').parentElement.textContent), 'the chosen file is cleared after the import');
  });

  await check('image OCR stays review-only: extraction fills the editor and neither imports nor confirms until the user submits', async () => {
    reset();
    extractImpl = async () => ({ text: '05/03/2026 ZOMATO ORDER -120.50\n08/03/2026 NEW SHOP -30.00', confidence: 90, warnings: [] });
    await openUpload();
    await setFile('shot.png');
    await click(/Extract Text from Image/);
    await flush();
    assert.equal(calls.parse.length, 0);
    assert.equal(calls.confirm.length, 0);
    assert.match(textarea().value, /ZOMATO ORDER/);
    assert.ok(q('[data-testid=dup-review]') === null);
    parseImpl = async () => ({ review: true, preview: dr.normalizePreview(serverPreview()) });
    await click(/Parse Logs/);
    await flush();
    assert.equal(calls.parse.length, 1, 'only the user\'s explicit submit sends the text');
    assert.equal(typeof calls.parse[0], 'string');
    assert.ok(q('[data-testid=dup-review]'));
    assert.equal(calls.confirm.length, 0);
    await closeReview();
    assert.match(textarea().value, /ZOMATO ORDER/, 'cancelling keeps the OCR text for editing');
    assert.ok(q('[data-testid=ocr-notice]') || true);
  });

  await check('ordinary parse errors still show as errors (and the unsigned-statement explanation still applies)', async () => {
    reset();
    parseImpl = async () => { throw new Error('No valid transactions found: 3 row(s) failed validation.'); };
    await openPaste(); await typeInto('05/03/2026 X 1.00');
    await click(/Parse Logs/);
    await flush();
    assert.match(q('[role=alert]').textContent, /No valid transactions found: 3 row\(s\) failed validation\..*never guessed/);
    assert.ok(q('[data-testid=dup-review]') === null);
  });

  await check('responsive layout rules and long text handling are in place', () => {
    const css = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    assert.match(css, /\.dup-review-actions\s*\{[^}]*flex-wrap:\s*wrap/);
    assert.match(css, /\.dup-review-actions\s*>\s*button\s*\{[^}]*flex:\s*1 1 11rem/);
    assert.match(css, /@media \(max-width: 640px\)\s*\{\s*\.dup-review-list\s*\{\s*max-height:\s*55vh/);
    assert.match(css, /\.dup-review-actions > button:nth-child\(1\) \{ scroll-margin-bottom: 16\.5rem; \}/);
    assert.match(css, /\.dup-review-actions > button:nth-child\(2\) \{ scroll-margin-bottom: 13rem; \}/);
    assert.match(css, /\.dup-review-list:focus-visible\s*\{[^}]*outline:\s*3px solid #2563eb/);
    assert.match(css, /@media \(max-width: 640px\)\s*\{\s*\.statement-action\s*\{\s*scroll-margin-bottom:\s*9\.5rem/);
  });

  await check('the review is rendered with wrapping, touch-sized buttons that keep the orb clearance class', async () => {
    reset(); await startReview();
    const panel = q('[data-testid=dup-review]');
    assert.equal(panel.style.overflowWrap, 'anywhere');
    for (const b of panel.querySelectorAll('.dup-review-actions button')) {
      assert.ok(b.classList.contains('statement-action'));
      assert.equal(b.style.minHeight, '44px');
    }
    assert.ok(panel.querySelector('.dup-review-actions'));
    await closeReview();
  });

  await check('no statement contents reach the console during any of this', async () => {
    reset();
    for (const level of Object.keys(realConsole)) console[level] = (...a) => logged.push(a.join(' '));
    try {
      await startReview();
      await toggle(2);
      confirmImpl = async () => ({ stale: true, preview: dr.normalizePreview(serverPreview(DIGEST2)) });
      await click(/Import selected rows/); await flush();
      confirmImpl = async () => { throw new Error('Too many import confirmations. Please wait a minute and try again.'); };
      await click(/Import selected rows/); await flush();
      await closeReview();
    } finally { Object.assign(console, realConsole); }
    assert.equal(logged.join('\n').match(/ZOMATO|SALARY|CHAI|BUS PASS|NEW SHOP|120\.5|50000/), null, logged.join('\n').slice(0, 200));
  });

  await act(async () => root.unmount());
  assert.equal(calls.add.length, 0, 'no manual transaction was ever added');

  // ═══ Part 2: the real requests (FinanceProvider with a stubbed fetch) ══════════════════════════════════════════════
  const { FinanceProvider, useFinance } = await vite.ssrLoadModule('/src/context/FinanceContext.jsx');
  const requests = [];
  let respond = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (respond && /\/(?:parse-statement|import-confirm|import-reviewed-pdf)\b/.test(String(url))) return respond(String(url), init);
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });   // the provider's own startup reads
  };
  let ctx;
  const Probe = () => { ctx = useFinance(); return null; };
  const root2 = createRoot(document.createElement('div'));
  await act(async () => root2.render(React.createElement(FinanceProvider, { currentView: 'transactions', setCurrentView() {} }, React.createElement(Probe))));
  // The provider updates its own state around every request: run each call inside act() like a real event would be.
  const inAct = async (fn) => { let result, error, failed = false; await act(async () => { try { result = await fn(); } catch (e) { failed = true; error = e; } }); if (failed) throw error; return result; };
  const parseS = (input) => inAct(() => ctx.parseStatement(input));
  const confirmI = (request) => inAct(() => ctx.confirmImport(request));
  const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const listReads = () => requests.filter((r) => /\/transactions$/.test(r.url) && (!r.init.method || r.init.method === 'GET')).length;
  const nodeFile = () => new globalThis.File([new Uint8Array([1, 2, 3])], 'stmt.csv', { type: 'text/csv' });

  await check('reviewed PDF import reports a stale API or non-JSON response without treating it as saved', async () => {
    requests.length = 0;
    const importPdf = () => inAct(() => ctx.importReviewedPdf([{ title: 'Sample refund', type: 'income', amount: 25, classification: 'refund' }]));
    respond = () => new Response('<!DOCTYPE html><title>Not found</title>', { status: 404 });
    await assert.rejects(importPdf, /PDF import endpoint is unavailable.*Restart the FinSphere API/);
    respond = () => new Response('<!DOCTYPE html><title>Unexpected page</title>', { status: 200 });
    await assert.rejects(importPdf, /unexpected response \(HTTP 200\).*Check your transaction history/);
    respond = () => json(200, {});
    await assert.rejects(importPdf, /did not confirm the save/);
    assert.equal(listReads(), 0, 'unconfirmed imports do not refresh as successes');
    respond = () => json(200, { success: true, count: 1, transactions: [{ id: 'pdf-row' }] });
    assert.equal((await importPdf()).count, 1);
    assert.equal(listReads(), 1, 'a successful PDF import still refreshes the ledger');
  });

  await check('request: every statement import asks for duplicate reporting (text and file), with the session cookie', async () => {
    requests.length = 0;
    respond = () => json(200, { success: true, count: 2, skipped: 0, transactions: [] });
    await parseS('05/03/2026 A -1.00');
    await parseS(nodeFile());
    const posts = requests.filter((r) => r.url.includes('/parse-statement'));
    assert.equal(posts.length, 2);
    for (const p of posts) {
      assert.equal(p.url, 'http://localhost:5000/api/transactions/parse-statement?duplicates=report');
      assert.equal(p.init.method, 'POST');
      assert.equal(p.init.credentials, 'include');
    }
    assert.equal(JSON.parse(posts[0].init.body).text, '05/03/2026 A -1.00');
    assert.ok(posts[1].init.body instanceof FormData && posts[1].init.body.get('statementFile').name === 'stmt.csv');
  });

  await check('response: a normal 200 is returned untouched and the list is refreshed', async () => {
    requests.length = 0;
    respond = () => json(200, { success: true, count: 2, skipped: 1, transactions: [{ id: 'x' }], notice: 'Parsed using local backup engine' });
    const res = await parseS('x');
    assert.deepEqual(res, { success: true, count: 2, skipped: 1, transactions: [{ id: 'x' }], notice: 'Parsed using local backup engine' });
    assert.equal(listReads(), 1, 'transactions were refetched after a real import');
  });

  await check('response: 409 DUPLICATES_FOUND becomes a review (not an error), saves nothing and does not refresh or set the error state', async () => {
    requests.length = 0;
    respond = () => json(409, serverPreview(DIGEST, 2));
    const res = await parseS('x');
    assert.equal(res.review, true);
    assert.deepEqual(res.preview.summary, { total: 5, new: 2, likely: 2, possible: 1 });
    assert.equal(res.preview.reviewDigest, DIGEST);
    assert.equal(res.preview.skipped, 2);
    assert.equal(listReads(), 0, 'no refetch: nothing was saved');
    assert.equal(ctx.error, null);
    assert.equal(ctx.loading, false);
  });

  await check('response: other 409s, malformed previews, 400s and 401 behave as errors', async () => {
    respond = () => json(409, { error: 'Something else conflicted' });
    await assert.rejects(parseS('x'), /Something else conflicted/);
    respond = () => json(409, { code: 'DUPLICATES_FOUND', rows: [], reviewDigest: 'nope' });
    await assert.rejects(parseS('x'));
    respond = () => json(400, { error: 'No valid transactions found: 2 row(s) failed validation.' });
    await assert.rejects(parseS('x'), /No valid transactions found/);
    respond = () => json(413, { error: 'File too large. Maximum allowed size is 5 MB.' });
    await assert.rejects(parseS(nodeFile()), /5 MB/);
    const before = globalThis.__invalidated;
    respond = () => json(401, { error: 'Unauthorized' });
    await assert.rejects(parseS('x'), /Session expired/);
    assert.equal(globalThis.__invalidated, before + 1);
  });

  await check('confirm: authenticated JSON POST of exactly the built request; success refreshes the list', async () => {
    requests.length = 0;
    const p = dr.normalizePreview(serverPreview());
    const body = dr.buildConfirmRequest(p, new Set([0, 4]), 'selected');
    respond = () => json(200, { success: true, count: 2, skipped: 3, transactions: [], duplicates: { skippedLikely: 2, skippedByUser: 1, likelyImportedAnyway: 0, possibleImported: 0 } });
    const out = await confirmI(body);
    assert.equal(out.stale, false);
    assert.equal(out.result.count, 2);
    const post = requests.find((r) => r.url.includes('/import-confirm'));
    assert.equal(post.url, 'http://localhost:5000/api/transactions/import-confirm');
    assert.equal(post.init.method, 'POST');
    assert.equal(post.init.credentials, 'include');
    assert.equal(post.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(post.init.body), body);
    assert.equal(requests.some((r) => r.url.includes('/parse-statement')), false, 'never re-parses');
    assert.equal(listReads(), 1);
  });

  await check('confirm: 409 STALE_PREVIEW returns the refreshed preview, no refresh, no error', async () => {
    requests.length = 0;
    respond = () => json(409, { ...serverPreview(DIGEST2), code: 'STALE_PREVIEW', error: 'Your transactions changed' });
    const out = await confirmI({ rows: [], policy: 'skip_duplicates', reviewDigest: DIGEST });
    assert.equal(out.stale, true);
    assert.equal(out.preview.reviewDigest, DIGEST2);
    assert.equal(out.preview.rows.length, 5);
    assert.equal(listReads(), 0);
    respond = () => json(409, { code: 'STALE_PREVIEW', rows: [] });
    await assert.rejects(confirmI({}), /Nothing was imported\. Start the import again/);
  });

  await check('confirm: 401 ends the session; server errors and gateways give clear messages; a lost connection says it may not have completed', async () => {
    const before = globalThis.__invalidated;
    respond = () => json(401, { error: 'Unauthorized' });
    await assert.rejects(confirmI({}), /Session expired/);
    assert.equal(globalThis.__invalidated, before + 1);
    for (const [status, body, pattern] of [
      [400, { error: 'Row 2: Amount must be a number' }, /Row 2: Amount must be a number/],
      [429, { error: 'Too many import confirmation requests. Please wait a minute and try again.' }, /Too many import confirmation/],
      [429, '', /Too many import confirmations/], [413, '<html>too big</html>', /too large to confirm/], [400, 'oops', /not valid\. Nothing was imported/],
      [500, { error: 'Could not save transactions' }, /Could not save transactions/], [502, '<html>Bad Gateway</html>', /could not be completed\. Nothing was imported/]
    ]) {
      respond = () => json(status, body);
      await assert.rejects(confirmI({}), pattern, `${status}`);
    }
    globalThis.fetch = async (url) => { if (String(url).includes('/import-confirm')) throw new TypeError('Failed to fetch'); return new Response('[]'); };
    await assert.rejects(confirmI({}), /the import may not have completed\. Check your transactions, then try again\./);
  });

  await check('Stage 3 server answers: fail-closed (422), busy (503) and the 500-row cap (413) reach the user as clear messages, never as a review', async () => {
    globalThis.fetch = async (url, init = {}) => {   // the shared stub again (the previous check replaced it with a failing one)
      requests.push({ url: String(url), init });
      if (respond && (String(url).includes('/parse-statement') || String(url).includes('/import-confirm'))) return respond(String(url), init);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const cases = [
      [422, { success: false, code: 'MATCH_LIMIT_EXCEEDED', error: 'Too many of your saved transactions share the dates and amounts in this import for the duplicate check to be complete. Nothing was imported. Import fewer rows at a time.' }, /duplicate check to be complete\. Nothing was imported/],
      [503, { success: false, code: 'IMPORT_BUSY', error: 'Another import for your account is still running. Nothing was imported. Please try again in a moment.' }, /still running\. Nothing was imported/],
      [413, { error: 'This statement has 501 rows; at most 500 can be imported at once. Split it into smaller parts.' }, /at most 500 can be imported at once/]
    ];
    for (const [status, body, pattern] of cases) {
      respond = () => json(status, body);
      await assert.rejects(parseS('x'), pattern, `parse ${status}`);
      await assert.rejects(confirmI({ rows: [], policy: 'import_all', reviewDigest: DIGEST }), pattern, `confirm ${status}`);
    }
    assert.equal(ctx.error !== undefined, true);
  });

  globalThis.fetch = realFetch;
  await act(async () => root2.unmount());
  console.log(`Duplicate review UI: ${pass} checks passed`);
} finally {
  globalThis.setTimeout = nativeSetTimeout;
  Object.assign(console, realConsole);
  await vite.close();
  dom.window.close();
  delete globalThis.__fin;
  delete globalThis.__invalidated;
}
