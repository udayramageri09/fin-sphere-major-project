import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { aiCandidates, applyAiSuggestions, buildPdfDraft, needsPdfReview, pdfHistoryRules, pdfImportValue, pdfTableRows } from '../src/utils/pdfImportReview.js';
import { readPdfRules, rememberPdfRules } from '../src/utils/categoryRules.js';

const cell = (str, x, y, width = 25) => ({ str, width, transform: [1, 0, 0, 1, x, y] });
const headings = [cell('Transaction', 60, 110, 50), cell('Transaction Remarks', 250, 105, 80),
  cell('Withdrawal', 400, 110, 48), cell('Deposit', 474, 110, 30), cell('Balance', 532, 110, 32)];
const table = pdfTableRows([...headings,
  cell('05.03.2026', 61, 85), cell('Swiggy', 192, 90), cell('order 12345', 192, 80),
  cell('450.00', 427, 85), cell('8550.00', 536, 85, 35),
  cell('06.03.2026', 61, 65), cell('Unfamiliar Payer', 192, 68, 80),
  cell('20.00', 494, 65), cell('8570.00', 536, 65, 35)
]);
assert.deepEqual(table.rows.map(({ title, type, amount }) => [title, type, amount]), [
  ['Swiggy order 12345', 'expense', '450.00'], ['Unfamiliar Payer', 'income', '20.00']
]);
assert.deepEqual(pdfTableRows([cell('07.03.2026', 61, 85), cell('Unfamiliar Payer', 192, 85, 80),
  cell('8590.00', 536, 85, 35)], table.layout).rows.map(({ type, amount }) => [type, amount]), [['', '']]);
const pages = [{ text: '', tableRows: table.rows }];
// A long narration in a single text cell may run past the amount-column boundary without being mistaken for an amount.
const overflow = pdfTableRows([...headings,
  cell('05.03.2026', 61, 85), cell('UPI/Ravi Kumar/XX7088@ybl/NO REMARK/YES BANK', 192, 85, 215),
  cell('450.00', 427, 85), cell('8550.00', 536, 85, 35)]).rows;
assert.deepEqual(overflow.map(({ title, type, amount }) => [title, type, amount]), [['UPI/Ravi Kumar/XX7088@ybl/NO REMARK/YES BANK', 'expense', '450.00']]);
const rows = buildPdfDraft('', { pages });
assert.deepEqual(rows.map(needsPdfReview), [false, false]);
assert.deepEqual(pdfImportValue(rows[0]), {
  title: 'Swiggy order 12345', type: 'expense', date: '2026-03-05', amount: -450, category: 'Food', classification: 'expense'
});
const suspicious = buildPdfDraft('05.03.2026 SWIGGY 450.00 8550.00 CR')[0];
assert.equal(suspicious.amount, '450.00');
assert.equal(suspicious.type, '');
assert.ok(needsPdfReview(suspicious));
assert.ok(needsPdfReview(buildPdfDraft('05.03.2026 SWIGGY -450.00', { usedOcr: true })[0]));
const statementExamples = buildPdfDraft([
  '05.03.2026 ACH DIVIDEND +120.00',
  '06.03.2026 NACH LOAN EMI -1000.00',
  '07.03.2026 UPI TRANSFER TO SELF -300.00',
  '08.03.2026 SWIGGY REFUND +95.00',
  '09.03.2026 UPI UNFAMILIAR PAYER +95.00',
  '10.03.2026 NACH ACH SOME COMPANY +60.00',
  '11.03.2026 UNRECOGNIZED DEBIT -12.00',
  '12.03.2026 CREDIT CARD PAYMENT -100.00'
].join('\n'));
assert.deepEqual(statementExamples.map((row) => [row.category, row.classification, Boolean(needsPdfReview(row))]), [
  ['Dividends', 'income', false], ['Loan Repayment', 'expense', false], ['Transfers', 'transfer', false],
  ['Food', 'refund', false], ['P2P', 'income', false], ['General', 'income', false],
  ['General', 'expense', false], ['Bills', '', true]
]);
assert.ok(statementExamples[6].confidence < 70);
const upiRows = buildPdfDraft('20.11.2026 fcc9d23910c Farid ali UPI/Farid ali/XX7088@ybl/NO REMARK/YES BANK -250.00');
assert.deepEqual([upiRows[0].category, upiRows[0].classification, Boolean(needsPdfReview(upiRows[0]))], ['P2P', 'expense', false]);
const unknownRows = buildPdfDraft('21.11.2026 QWERTY ZXCV HOLDINGS -90.00\n22.11.2026 UPI SALARY ACME CORP +500.00');
assert.deepEqual(aiCandidates(unknownRows).map(({ title, type }) => [title, type]), [['QWERTY ZXCV HOLDINGS', 'expense']]);
const aiApplied = applyAiSuggestions(unknownRows, [
  { index: unknownRows[0].id, category: 'Shopping', classification: 'expense' },
  { index: unknownRows[1].id, category: 'Food', classification: 'expense' }
]);
assert.deepEqual([aiApplied[0].category, aiApplied[0].classification, aiApplied[0].reason, Boolean(needsPdfReview(aiApplied[0]))], ['Shopping', 'expense', 'AI suggestion', false]);
assert.equal(aiApplied[1].category, unknownRows[1].category, 'a suggestion for a row that was not a candidate is ignored');
assert.equal(applyAiSuggestions(unknownRows, [{ index: unknownRows[0].id, category: 'Shopping', classification: 'income' }])[0].category, 'General', 'an invalid direction is ignored');
assert.ok(needsPdfReview(buildPdfDraft('05.03.2026 UNKNOWN +95.00', { usedOcr: true })[0]));
assert.ok(needsPdfReview({ ...statementExamples[4], edited: true }));
assert.ok(needsPdfReview({ ...statementExamples[4], amount: '' }));
const prior = { title: 'Unfamiliar Payer 987654', type: 'income', category: 'Consulting', classification: 'income' };
const history = (records) => pdfHistoryRules(records.map((row, id) => ({ ...row, id: String(id + 1) })));
const later = '12.03.2026 Unfamiliar Payer 864209 +125.00';
assert.equal(buildPdfDraft(later, { history: history([prior]) })[0].category, 'General');
const recognized = buildPdfDraft(later, { history: history([prior, prior]) })[0];
assert.deepEqual([recognized.category, recognized.classification, needsPdfReview(recognized)], ['Consulting', 'income', false]);
assert.ok(needsPdfReview(buildPdfDraft(later, {
  history: history([prior, prior, { ...prior, classification: 'refund' }])
})[0]));
assert.ok(needsPdfReview({ ...recognized, edited: true }));
const local = new Map();
globalThis.window = { localStorage: { getItem: (key) => local.get(key), setItem: (key, value) => local.set(key, value) } };
try {
  rememberPdfRules(11, [{ ...rows[1], category: 'Shopping', classification: 'refund' }]);
  const [unfamiliar] = buildPdfDraft('', { pages: [{ text: '', tableRows: [table.rows[1]] }], rules: readPdfRules(11) });
  assert.deepEqual([unfamiliar.category, unfamiliar.classification, needsPdfReview(unfamiliar)], ['Shopping', 'refund', false]);
  assert.deepEqual(readPdfRules(22), []);
  const [outgoing] = buildPdfDraft('', { pages: [{ text: '', tableRows: [{ ...table.rows[1], type: 'expense' }] }], rules: readPdfRules(11) });
  assert.equal(outgoing.classification, 'expense', 'an income rule is not applied to money out');
} finally {
  delete globalThis.window;
}

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom', logLevel: 'error' });
try {
  const { extractPdfStatement, pdfPageText } = await vite.ssrLoadModule('/src/utils/pdfStatement.js');
  const item = (str, x, y) => ({ str, transform: [1, 0, 0, 1, x, y] });
  assert.equal(pdfPageText([item('100 DR', 200, 10), item('Hotel', 60, 10), item('05/03/2026', 0, 10), item('Header', 0, 20)]), 'Header\n05/03/2026 Hotel 100 DR');

  let destroyed = false, cleaned = 0, ocrCalls = 0;
  const page = {
    getTextContent: async () => ({ items: [item('05/03/2026 Hotel Food -100.00', 0, 10)] }),
    cleanup: () => { cleaned++; },
    getOperatorList: async () => ({ fnArray: [] })
  };
  const load = async () => ({
    GlobalWorkerOptions: {},
    OPS: { paintImageXObject: 1 },
    getDocument: () => ({
      promise: Promise.resolve({ numPages: 1, getPage: async () => page }),
      destroy: async () => { destroyed = true; }
    })
  });
  const file = new File(['%PDF-test'], 'statement.pdf');
  const extracted = await extractPdfStatement(file, async () => { ocrCalls++; }, load);
  assert.equal(extracted.text, '05/03/2026 Hotel Food -100.00');
  assert.equal(ocrCalls, 0);
  assert.equal(cleaned, 1);
  assert.equal(destroyed, true);

  const originalDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({}), toBlob: (callback) => callback(new Blob(['image'])) }) };
  page.getTextContent = async () => ({ items: [] });
  page.getViewport = () => ({ width: 1000, height: 1200 });
  page.render = () => ({ promise: Promise.resolve() });
  try {
    const scan = await extractPdfStatement(file, async (image) => {
      assert.equal(image.type, 'image/png');
      return { text: '05/03/2026 Cafe -120.00', warnings: [] };
    }, load);
    assert.equal(scan.text, '05/03/2026 Cafe -120.00');
    assert.match(scan.warnings[0], /OCR/);
    page.getTextContent = async () => ({ items: [item('Statement header', 0, 10)] });
    page.getOperatorList = async () => ({ fnArray: [1] });
    const mixed = await extractPdfStatement(file, async () => ({ text: '05/03/2026 Cafe -120.00', warnings: [] }), load);
    assert.match(mixed.warnings[0], /OCR/);
    assert.equal(mixed.text, '05/03/2026 Cafe -120.00');
  } finally { globalThis.document = originalDocument; }

  await assert.rejects(() => extractPdfStatement(new File([], 'empty.pdf'), async () => {}, load), /no larger than 5 MB/);
  const protectedPdf = async () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.reject(Object.assign(new Error(), { name: 'PasswordException' })), destroy: async () => {} }) });
  await assert.rejects(() => extractPdfStatement(file, async () => {}, protectedPdf), /password-protected/);
  console.log('PDF statement extraction tests passed');
} finally {
  await vite.close();
}
