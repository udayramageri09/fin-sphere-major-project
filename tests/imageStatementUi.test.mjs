// Image statement upload, Stage 2 (frontend): selection, the OCR request, loading, extraction into the editable paste box,
// warnings, errors, and the guarantee that OCR never saves or imports anything by itself.
//
//   npm run test:image-statement
//
// Part 1 renders the real Transactions page with a mocked finance context (so every call the page makes is recorded).
// Part 2 renders the real FinanceProvider with a stubbed fetch to check the actual HTTP request. No server, no database, no
// real images: the "files" are tiny synthetic blobs.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');

let pass = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; }, (err) => { console.error('FAIL:', name); throw err; });

// ── mocks ────────────────────────────────────────────────────────────────────────────────────────────────────────
const calls = { parseStatement: [], extract: [], addTransaction: [], deleteTransaction: [] };
let extractImpl = async () => ({ text: '', confidence: null, warnings: [] });
globalThis.__fin = {
  transactions: [], loading: false,
  addTransaction: async (...a) => { calls.addTransaction.push(a); },
  deleteTransaction: async (...a) => { calls.deleteTransaction.push(a); },
  parseStatement: async (input) => { calls.parseStatement.push(input); return { count: 2, skipped: 0 }; },
  extractTextFromImage: (file) => { calls.extract.push(file); return extractImpl(file); }
};
globalThis.__invalidated = 0;
const vite = await createServer({
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
  plugins: [{
    name: 'ui-test-mocks', enforce: 'pre',
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
const reset = () => { for (const k of Object.keys(calls)) calls[k] = []; extractImpl = async () => ({ text: '', confidence: null, warnings: [] }); };
const logged = [];
const realConsole = {};
for (const level of ['log', 'info', 'warn', 'error', 'debug']) { realConsole[level] = console[level]; }
const captureConsole = () => { for (const level of Object.keys(realConsole)) console[level] = (...a) => logged.push(a.join(' ')); };
const restoreConsole = () => Object.assign(console, realConsole);

try {
  // ═══ Part 1: the Transactions page ═══════════════════════════════════════════════════════════════════════════════
  const { default: Transactions } = await vite.ssrLoadModule('/src/pages/Transactions.jsx');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Transactions)));

  const buttons = () => [...container.querySelectorAll('button')];
  const button = (re) => buttons().find((b) => re.test(b.textContent));
  const click = async (re) => { await act(async () => { button(re).click(); }); };
  const fileInput = () => container.querySelector('input[type=file]');
  const textarea = () => container.querySelector('textarea');
  const text = () => container.textContent;
  const setFile = async (name, type = 'image/png') => {
    const file = new window.File([new Uint8Array([1, 2, 3])], name, { type });
    await act(async () => {
      const input = fileInput();
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    return file;
  };
  const typeInto = async (value) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(textarea(), value);
    textarea().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const openUpload = async () => click(/^Upload File/);
  const openPaste = async () => click(/^Paste Text Log/);

  await check('upload tab offers images, keeps the old formats and explains OCR and Groq', async () => {
    await openUpload();
    assert.equal(fileInput().getAttribute('accept'), '.csv,.txt,.xls,.xlsx,.jpg,.jpeg,.png');
    assert.match(text(), /TXT, CSV, XLS, XLSX, JPG, JPEG and PNG/);
    const note = container.querySelector('[data-testid=ocr-privacy-note]').textContent;
    assert.match(note, /OCR on this server/);
    assert.match(note, /not stored/);
    assert.match(note, /Groq/);
    assert.match(note, /review and edit/);
    assert.equal(button(/Parse File/).disabled, true, 'nothing selected yet');
  });

  await check('selecting an image changes the action to "Extract Text from Image" and sends nothing yet', async () => {
    const file = await setFile('statement.png');
    assert.match(text(), /statement\.png/);
    assert.ok(button(/Extract Text from Image/));
    assert.equal(button(/Extract Text from Image/).disabled, false);
    assert.equal(calls.extract.length + calls.parseStatement.length, 0);
    assert.equal(fileInput().value, '', 'the input is reset so the same file can be chosen again');
    assert.ok(file);
  });

  let pending;
  await check('extraction shows a loading state and ignores repeated clicks', async () => {
    pending = deferred();
    extractImpl = () => pending.promise;
    await act(async () => { const b = button(/Extract Text from Image/); b.click(); b.click(); b.click(); });
    assert.equal(calls.extract.length, 1, 'one request despite three clicks');
    assert.equal(calls.extract[0].name, 'statement.png');
    assert.ok(button(/Reading image/));
    assert.equal(button(/Reading image/).disabled, true);
    assert.equal(fileInput().disabled, true, 'cannot swap the file mid-request');
    await click(/Reading image/);
    assert.equal(calls.extract.length, 1, 'a click on the disabled button does nothing');
    assert.equal(calls.parseStatement.length, 0);
  });

  await check('on success the text fills the paste editor, the tab switches, warnings and confidence are shown, nothing is saved', async () => {
    await act(async () => pending.resolve({ text: '05/03/2026 ZOMATO 120.50\n06/03/2026 SALARY 50000.00', confidence: 72, warnings: ['Low recognition confidence (72%). Check every amount and date carefully.', 'The image resolution is low, so some characters may be misread.'] }));
    await flush();
    assert.ok(textarea(), 'the paste editor is now visible');
    assert.equal(textarea().value, '05/03/2026 ZOMATO 120.50\n06/03/2026 SALARY 50000.00');
    const notice = container.querySelector('[data-testid=ocr-notice]');
    assert.match(notice.textContent, /Text read from statement\.png/);
    assert.match(notice.textContent, /Nothing has been imported or saved yet/);
    assert.match(notice.textContent, /confidence: 72%/);
    assert.match(notice.textContent, /only an estimate, not proof/);
    assert.match(notice.textContent, /resolution is low/);
    assert.match(notice.textContent, /Groq/);
    assert.match(notice.textContent, /OCR on this server/);
    assert.equal(calls.parseStatement.length, 0, 'parseStatement was not called automatically');
    assert.equal(calls.addTransaction.length, 0, 'no transaction was saved');
    assert.equal(container.querySelector('[role=alert]'), null);
    assert.ok(!/Success! Imported/.test(text()));
    assert.equal(button(/Parse Logs/).disabled, false);
  });

  await check('the extracted text is editable and the notice survives edits, but goes when the editor is emptied', async () => {
    await typeInto('05/03/2026 ZOMATO 125.50');
    assert.equal(textarea().value, '05/03/2026 ZOMATO 125.50');
    assert.ok(container.querySelector('[data-testid=ocr-notice]'));
    assert.equal(calls.parseStatement.length, 0);
    await typeInto('   ');
    assert.equal(container.querySelector('[data-testid=ocr-notice]'), null);
    assert.equal(button(/Parse Logs/).disabled, true, 'blank text cannot be imported');
  });

  await check('only the user pressing "Parse Logs" imports, with exactly the edited text, and then the notice is cleared', async () => {
    extractImpl = async () => ({ text: '07/03/2026 AMAZON 1599.00', confidence: 90, warnings: [] });
    await openUpload();
    await setFile('again.JPG', 'image/jpeg');
    await click(/Extract Text from Image/);
    await flush();
    assert.equal(textarea().value, '07/03/2026 AMAZON 1599.00');
    assert.equal(calls.parseStatement.length, 0);
    await typeInto('07/03/2026 AMAZON 1599.00\n08/03/2026 TEA 20.00');
    await click(/Parse Logs/);
    await flush();
    assert.deepEqual(calls.parseStatement, ['07/03/2026 AMAZON 1599.00\n08/03/2026 TEA 20.00'], 'a string went to parseStatement, never a File');
    assert.match(text(), /Success! Imported 2 transactions\./);
    assert.equal(container.querySelector('[data-testid=ocr-notice]'), null);
    assert.equal(textarea().value, '');
  });

  await check('text already in the editor is kept: new OCR text is added below it', async () => {
    reset();
    await typeInto('my own note 1.00');
    extractImpl = async () => ({ text: 'OCR LINE 2.00', confidence: null, warnings: [] });
    await openUpload();
    await setFile('b.png');
    await click(/Extract Text from Image/);
    await flush();
    assert.equal(textarea().value, 'my own note 1.00\n\nOCR LINE 2.00');
    assert.doesNotMatch(container.querySelector('[data-testid=ocr-notice]').textContent, /confidence/i, 'no confidence line when the server sent none');
    assert.equal(calls.parseStatement.length, 0);
  });

  await check('failures show a clear message, keep the file for a retry and leave the editor untouched', async () => {
    reset();
    const before = textarea().value;
    for (const message of ['Image too large. Maximum allowed size is 5 MB.', 'Too many image text recognition requests. Please wait a minute and try again.', 'Text recognition is busy. Please try again in a moment.', 'Reading the image took too long. Try a smaller or clearer image.', 'No readable text was found in this image. Use a sharper, well-lit, straight-on image of the statement.', 'Unsupported image. Upload a JPG, JPEG or PNG image.']) {
      extractImpl = async () => { throw new Error(message); };
      await openUpload();
      if (!/big\.png/.test(text())) await setFile('big.png');
      await click(/Extract Text from Image/);
      await flush();
      assert.equal(container.querySelector('[role=alert]').textContent, message);
      assert.ok(button(/Extract Text from Image/) && !button(/Extract Text from Image/).disabled, 'can retry');
      assert.match(text(), /big\.png/, 'the chosen file is kept');
    }
    await openPaste();
    assert.equal(textarea().value, before, 'a failed extraction never changes the editor');
    assert.equal(container.querySelector('[data-testid=ocr-notice]'), null);
    assert.equal(calls.parseStatement.length + calls.addTransaction.length, 0);
  });

  await check('a retry that succeeds clears the old error; choosing another file clears errors and old warnings', async () => {
    reset();
    extractImpl = async () => { throw new Error('Text recognition is busy. Please try again in a moment.'); };
    await openUpload();
    await setFile('retry.png');
    await click(/Extract Text from Image/);
    await flush();
    assert.ok(container.querySelector('[role=alert]'));
    extractImpl = async () => ({ text: 'LINE 3.00', confidence: 55, warnings: ['Low recognition confidence (55%).'] });
    await click(/Extract Text from Image/);
    await flush();
    assert.equal(container.querySelector('[role=alert]'), null, 'the old error is gone');
    assert.match(container.querySelector('[data-testid=ocr-notice]').textContent, /55%/);
    await openUpload();
    await setFile('next.png');
    await openPaste();
    assert.equal(container.querySelector('[data-testid=ocr-notice]'), null, 'warnings of the previous image no longer shown');
    extractImpl = async () => { throw new Error('Could not read text from this image.'); };
    await openUpload();
    await click(/Extract Text from Image/);
    await flush();
    assert.ok(container.querySelector('[role=alert]'));
    await setFile('third.png');
    assert.equal(container.querySelector('[role=alert]'), null, 're-selecting a file clears the stale error');
  });

  await check('choosing the same file again works (the input is reset after each selection)', async () => {
    reset();
    await setFile('same.png');
    assert.equal(fileInput().value, '');
    await setFile('same.png');
    assert.match(text(), /same\.png/);
    assert.ok(button(/Extract Text from Image/));
  });

  await check('CSV, TXT, XLS and XLSX still use parseStatement and never the OCR path', async () => {
    for (const name of ['a.csv', 'b.txt', 'c.xls', 'd.xlsx', 'E.CSV']) {
      reset();
      const file = await setFile(name, 'application/octet-stream');
      assert.ok(button(/Parse File/), name);
      await click(/Parse File/);
      await flush();
      assert.equal(calls.extract.length, 0, `${name}: no OCR`);
      assert.equal(calls.parseStatement.length, 1, `${name}: existing import`);
      assert.equal(calls.parseStatement[0].name, file.name);
      assert.match(text(), new RegExp(`Imported 2 transactions from ${file.name.replace('.', '\\.')}`));
      await openUpload();
    }
  });

  await check('an image is never sent to parseStatement, and a file named like an image but with another extension is not OCRed', async () => {
    reset();
    await setFile('shot.jpeg', 'image/jpeg');
    extractImpl = async () => ({ text: 'X 1.00', confidence: 80, warnings: [] });
    await click(/Extract Text from Image/);
    await flush();
    assert.equal(calls.parseStatement.length, 0);
    assert.equal(calls.extract.length, 1);
    await openUpload();
    await setFile('image.png.csv', 'image/png');
    assert.ok(button(/Parse File/));
  });

  await check('no extracted text reaches the console', async () => {
    reset();
    captureConsole();
    try {
      extractImpl = async () => ({ text: 'CONFIDENTIAL-MARKER 98765.43', confidence: 80, warnings: [] });
      await openUpload();
      await setFile('log.png');
      await click(/Extract Text from Image/);
      await flush();
      extractImpl = async () => { throw new Error('Reading the image took too long. Try a smaller or clearer image.'); };
      await openUpload();
      await setFile('log2.png');
      await click(/Extract Text from Image/);
      await flush();
    } finally { restoreConsole(); }
    assert.equal(logged.join('\n').includes('CONFIDENTIAL-MARKER'), false);
  });

  await act(async () => root.unmount());

  // ═══ Part 2: the real request (FinanceProvider + requestImageText) ════════════════════════════════════════════════
  const { requestImageText, isOcrImageFile, ImageOcrError } = await vite.ssrLoadModule('/src/utils/imageOcr.js');
  const { FinanceProvider, useFinance } = await vite.ssrLoadModule('/src/context/FinanceContext.jsx');

  const requests = [];
  let ocrResponse = () => new Response(JSON.stringify({ success: true, text: 'LINE 1.00', confidence: 91.6, warnings: ['w1'] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/transactions/ocr-statement-image')) return ocrResponse();
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });   // the provider's own startup reads
  };
  let ctx;
  const Probe = () => { ctx = useFinance(); return null; };
  const root2 = createRoot(document.createElement('div'));
  await act(async () => root2.render(React.createElement(FinanceProvider, { currentView: 'transactions', setCurrentView() {} }, React.createElement(Probe))));
  const ocrRequests = () => requests.filter((r) => r.url.endsWith('/ocr-statement-image'));
  const img = () => new globalThis.File([new Uint8Array([1, 2, 3, 4])], 'statement.png', { type: 'image/png' });
  const failWith = (status, body) => { ocrResponse = () => new Response(body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body)), { status }); };

  await check('request: authenticated multipart POST to the dedicated endpoint, and nothing else', async () => {
    requests.length = 0;
    const file = img();
    const result = await ctx.extractTextFromImage(file);
    assert.deepEqual(result, { text: 'LINE 1.00', confidence: 92, warnings: ['w1'] });
    assert.equal(ocrRequests().length, 1);
    const { url, init } = ocrRequests()[0];
    assert.equal(url, 'http://localhost:5000/api/transactions/ocr-statement-image');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'include', 'sends the session cookie like every other call');
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get('statementImage').name, 'statement.png');
    assert.ok(!Object.keys(init.headers ?? {}).some((k) => k.toLowerCase() === 'content-type'), 'no manual Content-Type: the browser sets the multipart boundary');
    assert.equal(requests.some((r) => r.url.includes('parse-statement')), false, 'never the statement-import endpoint');
    assert.equal(requests.some((r) => /\/transactions$/.test(r.url) && r.init.method === 'POST'), false, 'nothing is saved');
  });

  await check('request: the shared loading and error state is not touched by OCR', async () => {
    await ctx.extractTextFromImage(img());
    assert.equal(ctx.loading, false);
    failWith(500, { error: 'boom' });
    await assert.rejects(ctx.extractTextFromImage(img()));
    assert.equal(ctx.error, null);
  });

  await check('request: 401 invalidates the session like other calls', async () => {
    failWith(401, { error: 'Unauthorized' });
    const before = globalThis.__invalidated;
    await assert.rejects(ctx.extractTextFromImage(img()), /Session expired/);
    assert.equal(globalThis.__invalidated, before + 1);
  });

  await check('request: server messages and status fallbacks become clear errors', async () => {
    for (const [status, body, pattern] of [
      [413, { error: 'Image too large. Maximum allowed size is 5 MB.' }, /Maximum allowed size is 5 MB/],
      [415, { error: 'Unsupported image type. Upload a .jpg, .jpeg or .png image.' }, /Unsupported image type/],
      [400, { error: 'The image file is damaged or incomplete (truncated). Please upload a valid JPG or PNG.' }, /damaged or incomplete/],
      [422, { error: 'No readable text was found in this image. Use a sharper, well-lit, straight-on image of the statement.' }, /No readable text/],
      [429, { error: 'Too many image text recognition requests. Please wait a minute and try again.' }, /Too many/],
      [503, { error: 'Text recognition is busy. Please try again in a moment.' }, /busy/],
      [504, { error: 'Reading the image took too long. Try a smaller or clearer image.' }, /took too long/],
      [500, { error: 'Could not read text from this image.' }, /Could not read text/],
      // gateway answers with HTML or nothing: the status still produces a clear message
      [413, '<html>Request Entity Too Large</html>', /Maximum allowed size is 5 MB/],
      [429, '', /Too many/],
      [503, '<html>busy</html>', /busy/],
      [504, '<html>Gateway Time-out</html>', /took too long/],
      [502, '<html>Bad Gateway</html>', /Could not read text from this image\. Please try again\./]
    ]) {
      failWith(status, body);
      await assert.rejects(ctx.extractTextFromImage(img()), (e) => e instanceof ImageOcrError && e.status === status && pattern.test(e.message), `${status} ${String(body).slice(0, 30)}`);
    }
  });

  await check('request: a network failure and an empty success are reported, not swallowed', async () => {
    globalThis.fetch = async (url) => { if (String(url).endsWith('/ocr-statement-image')) throw new TypeError('Failed to fetch'); return new Response('[]'); };
    await assert.rejects(ctx.extractTextFromImage(img()), /Could not reach the server/);
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, text: '   ', warnings: [] }), { status: 200 });
    await assert.rejects(ctx.extractTextFromImage(img()), /No readable text/);
  });

  await check('requestImageText: normalises confidence and warnings, and image detection is by extension', async () => {
    const make = (body) => async () => new Response(JSON.stringify(body), { status: 200 });
    const file = img();
    assert.deepEqual(await requestImageText({ apiUrl: 'x', file, fetchImpl: make({ text: 'a1', confidence: 250, warnings: ['ok', '', 5, null] }) }), { text: 'a1', confidence: 100, warnings: ['ok'] });
    assert.deepEqual(await requestImageText({ apiUrl: 'x', file, fetchImpl: make({ text: 'a1' }) }), { text: 'a1', confidence: null, warnings: [] });
    for (const [name, expected] of [['a.png', true], ['a.JPG', true], ['a.jpeg', true], ['a.csv', false], ['a.png.csv', false], ['a.gif', false], ['a.pdf', false], ['png', false]]) assert.equal(isOcrImageFile({ name }), expected, name);
    assert.equal(isOcrImageFile(null), false);
  });

  globalThis.fetch = realFetch;
  await act(async () => root2.unmount());
  console.log(`Image statement UI: ${pass} checks passed (selection, OCR request, loading, extraction into the editable editor, warnings, errors, no automatic save)`);
} finally {
  restoreConsole();
  await vite.close();
  dom.window.close();
  delete globalThis.__fin;
  delete globalThis.__invalidated;
}
