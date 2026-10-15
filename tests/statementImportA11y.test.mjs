// Image import stabilisation: accessible names, keyboard focus styling, focus transfer after OCR, announcements, the
// unsigned-statement messages, button states and the mobile-layout rules. The browser-only parts (real :focus-visible painting and
// real overlap measurement) are checked in a real browser separately; here the markup and the CSS rules that produce them are pinned.
//
//   npm run test:statement-a11y
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
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; }, (err) => { console.error('FAIL:', name); throw err; });

const calls = { parseStatement: [], extract: [] };
let extractImpl = async () => ({ text: '', confidence: null, warnings: [] });
let parseImpl = async () => ({ count: 2, skipped: 0 });
globalThis.__fin = {
  transactions: [], loading: false, addTransaction: async () => {}, deleteTransaction: async () => {},
  parseStatement: (input) => { calls.parseStatement.push(input); return parseImpl(input); },
  extractTextFromImage: (file) => { calls.extract.push(file); return extractImpl(file); }
};
const vite = await createServer({
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
  plugins: [{
    name: 'a11y-mocks', enforce: 'pre',
    resolveId(id, importer) {
      if (id.endsWith('/context/FinanceContext') && importer && importer.replace(/\\/g, '/').endsWith('pages/Transactions.jsx')) return '\0finance-mock';
    },
    load(id) { if (id === '\0finance-mock') return 'export const useFinance=()=>globalThis.__fin;'; }
  }]
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const rgbToHex = (rgb) => '#' + rgb.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');

try {
  // ═══ pure helpers ════════════════════════════════════════════════════════════════════════════════════════════════
  const ui = await vite.ssrLoadModule('/src/utils/statementImportUi.js');

  await check('unsigned-statement message: explains signs and DR/CR, says nothing is guessed, other errors unchanged', () => {
    const server = 'No valid transactions found: 3 row(s) failed validation.';
    const msg = ui.explainImportError(server);
    assert.ok(msg.startsWith(server), 'the server message is kept');
    assert.match(msg, /minus \(-450\.00\) or plus \(\+450\.00\) sign/);
    assert.match(msg, /DR \/ CR, Debit \/ Credit/);
    assert.match(msg, /never guessed/);
    assert.match(msg, /dates and amounts must also be readable/i);
    const noLines = ui.explainImportError('Could not parse any transactions from the provided statement. Check the format.');
    assert.match(noLines, /date \(for example 05\/03\/2026\)/);
    assert.match(noLines, /never guessed/);
    for (const other of ['File too large. Maximum allowed size is 5 MB.', 'Session expired', 'Could not parse transactions from Excel. Make sure it is a valid bank statement.', 'Failed to save']) assert.equal(ui.explainImportError(other), other);
    assert.equal(ui.explainImportError(undefined), '');
  });

  await check('success message: unchanged when nothing was skipped; says rows were not imported (never guessed) when some were', () => {
    assert.equal(ui.importSuccessMessage({ count: 2, skipped: 0 }), 'Success! Imported 2 transactions.');
    assert.equal(ui.importSuccessMessage({ count: 3 }, 'a.csv'), 'Success! Imported 3 transactions from a.csv.');
    assert.match(ui.importSuccessMessage({ count: 2, skipped: 1 }), /^Success! Imported 2 transactions\. 1 row was not imported because the direction, date or amount was unclear\. Nothing was guessed\.$/);
    assert.match(ui.importSuccessMessage({ count: 2, skipped: 3 }, 'x.txt'), /from x\.txt\. 3 rows were not imported/);
  });

  await check('import button colours: enabled, disabled and busy are distinct and every text/background pair is at least 4.5:1', () => {
    const { enabled, disabled, busy } = ui.IMPORT_BUTTON_COLORS;
    for (const [name, c] of Object.entries({ enabled, disabled, busy })) assert.ok(contrast(c.color, c.background) >= 4.5, `${name} contrast ${contrast(c.color, c.background).toFixed(2)}`);
    assert.notEqual(enabled.background, disabled.background);
    assert.ok(contrast(enabled.background, disabled.background) >= 3, 'the two states are far apart in lightness');
    assert.notEqual(busy.background, disabled.background);
    assert.equal(ui.importButtonStyle({ disabled: true, busy: false }).cursor, 'not-allowed');
    assert.equal(ui.importButtonStyle({ disabled: false, busy: false }).cursor, 'pointer');
  });

  await check('CSS: keyboard focus ring on the drop zone and the small-screen scroll margin exist', () => {
    const css = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    assert.match(css, /\.upload-dropzone:has\(input\[type="file"\]:focus-visible\)\s*\{[^}]*outline:\s*3px solid #2563eb/);
    assert.match(css, /@media \(max-width: 640px\)\s*\{\s*\.statement-action\s*\{\s*scroll-margin-bottom:\s*9\.5rem/);
    const orb = fs.readFileSync(new URL('../src/components/AIAvatar.css', import.meta.url), 'utf8');
    assert.match(orb, /\.ai-orb-button\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*1\.25rem/, 'the orb is still the fixed bottom-right control this margin is sized for');
    const main = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
    assert.match(main, /pb-40/, 'the page keeps its bottom padding, so the last control can always scroll clear of the orb');
  });

  // ═══ the page ═══════════════════════════════════════════════════════════════════════════════════════════════════
  const { default: Transactions } = await vite.ssrLoadModule('/src/pages/Transactions.jsx');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Transactions)));

  const button = (re) => [...container.querySelectorAll('button')].find((b) => re.test(b.textContent));
  const click = async (re) => { await act(async () => { button(re).click(); }); };
  const fileInput = () => container.querySelector('input[type=file]');
  const textarea = () => container.querySelector('textarea');
  const setFile = async (name) => {
    const file = new window.File([new Uint8Array([1, 2, 3])], name, { type: 'application/octet-stream' });
    await act(async () => { Object.defineProperty(fileInput(), 'files', { value: [file], configurable: true }); fileInput().dispatchEvent(new window.Event('change', { bubbles: true })); });
  };
  const typeInto = (value) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(textarea(), value);
    textarea().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const describedBy = (el) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id));
  const bg = (el) => rgbToHex(el.style.backgroundColor);

  await check('the file input has a meaningful accessible name and description, and sits in the focus-ring drop zone', async () => {
    await click(/^Upload File/);
    const input = fileInput();
    const label = input.getAttribute('aria-label');
    assert.match(label, /statement file/i);
    for (const fmt of ['TXT', 'CSV', 'XLS', 'XLSX', 'JPG', 'JPEG', 'PNG']) assert.ok(label.includes(fmt), fmt);
    const described = describedBy(input);
    assert.equal(described.length, 2);
    assert.ok(described.every(Boolean), 'both aria-describedby ids exist');
    assert.match(described[0].textContent, /Supports TXT/);
    assert.match(described[1].textContent, /OCR on this server/);
    assert.ok(input.closest('.upload-dropzone'), 'the input lives inside the element the focus ring is drawn on');
    assert.equal(input.tabIndex, 0, 'reachable by keyboard');
    assert.equal(input.disabled, false);
  });

  await check('every control in the importer has an accessible name, and the editor is labelled', async () => {
    for (const b of container.querySelectorAll('button')) assert.ok(b.textContent.trim().length > 0 || b.getAttribute('aria-label'), 'unnamed button');
    await click(/^Paste Text Log/);
    assert.equal(textarea().getAttribute('aria-label'), 'Statement text to import');
  });

  await check('the live region is always in the page, empty at first, and the import buttons carry the scroll-margin class', async () => {
    const live = container.querySelector('[data-testid=ocr-live]');
    assert.ok(live);
    assert.equal(live.getAttribute('role'), 'status');
    assert.equal(live.getAttribute('aria-live'), 'polite');
    assert.equal(live.textContent, '');
    assert.ok(button(/Parse Logs/).classList.contains('statement-action'));
    await click(/^Upload File/);
    assert.ok(button(/Parse File/).classList.contains('statement-action'));
  });

  await check('disabled and enabled import buttons look different (paste and file)', async () => {
    const { enabled, disabled } = ui.IMPORT_BUTTON_COLORS;
    await click(/^Upload File/);
    let b = button(/Parse File/);
    assert.equal(b.disabled, true);
    assert.equal(bg(b), disabled.background);
    await setFile('a.csv');
    b = button(/Parse File/);
    assert.equal(b.disabled, false);
    assert.equal(bg(b), enabled.background);
    assert.notEqual(bg(b), disabled.background);
    await click(/^Paste Text Log/);
    b = button(/Parse Logs/);
    assert.equal(b.disabled, true);
    assert.equal(bg(b), disabled.background);
    await typeInto('20/05/2026 Amazon Spend -1599.00');
    b = button(/Parse Logs/);
    assert.equal(bg(b), enabled.background);
    await typeInto('');
  });

  await check('after a successful extraction the editor is focused with its text and caret untouched, and it is announced', async () => {
    await click(/^Upload File/);
    await setFile('statement.png');
    let finish;
    extractImpl = () => new Promise((r) => { finish = r; });
    await click(/Extract Text from Image/);
    assert.match(container.querySelector('[data-testid=ocr-live]').textContent, /Reading the image/);
    assert.equal(document.activeElement === textarea(), false);
    const text = '05/03/2026 ZOMATO -120.50\n06/03/2026 SALARY +50000.00';
    await act(async () => finish({ text, confidence: 80, warnings: ['one', 'two'] }));
    await flush();
    const editor = textarea();
    assert.equal(document.activeElement, editor, 'focus moved to the editor');
    assert.equal(editor.value, text, 'the text is exactly what OCR returned');
    assert.equal(editor.selectionStart, 0);
    assert.equal(editor.selectionEnd, 0, 'nothing is selected');
    const live = container.querySelector('[data-testid=ocr-live]').textContent;
    assert.match(live, /Text read from statement\.png/);
    assert.match(live, /Nothing has been imported yet/);
    assert.match(live, /2 warnings shown above the text/);
    const notice = container.querySelector('[data-testid=ocr-notice]');
    assert.equal(notice.getAttribute('role'), 'group', 'the visible notice is not a second live region');
    assert.equal(document.getElementById(notice.getAttribute('aria-labelledby')).textContent.trim(), 'Text read from statement.png');
    assert.deepEqual(describedBy(editor), [notice], 'the editor is described by the notice');
    assert.equal(calls.parseStatement.length, 0);
  });

  await check('focus is moved once: a later tab switch does not steal it, and typing keeps working', async () => {
    await click(/^Upload File/);
    assert.notEqual(document.activeElement, textarea());
    await click(/^Paste Text Log/);
    assert.notEqual(document.activeElement, textarea(), 'returning to the editor does not re-focus it');
    textarea().focus();
    await typeInto('edited');
    assert.equal(textarea().value, 'edited');
  });

  await check('extraction into an editor that already has text keeps it, focuses the editor and leaves the caret at the start', async () => {
    await typeInto('my note 1.00');
    extractImpl = async () => ({ text: 'OCR LINE -2.00', confidence: null, warnings: [] });
    await click(/^Upload File/);
    await setFile('b.jpg');
    await click(/Extract Text from Image/);
    await flush();
    assert.equal(textarea().value, 'my note 1.00\n\nOCR LINE -2.00');
    assert.equal(document.activeElement, textarea());
    assert.deepEqual([textarea().selectionStart, textarea().selectionEnd], [0, 0]);
  });

  await check('a failed extraction does not move focus, keeps the file and announces the error through role=alert', async () => {
    extractImpl = async () => { throw new Error('Text recognition is busy. Please try again in a moment.'); };
    await typeInto('');
    await click(/^Upload File/);
    await setFile('c.png');
    button(/Extract Text from Image/).focus();
    await click(/Extract Text from Image/);
    await flush();
    assert.equal(document.activeElement, button(/Extract Text from Image/), 'focus stays on the button for a retry');
    assert.equal(container.querySelector('[role=alert]').textContent, 'Text recognition is busy. Please try again in a moment.');
    assert.equal(container.querySelector('[data-testid=ocr-live]').textContent, '');
  });

  await check('unsigned statement: the user is told what is needed, nothing is guessed or imported, and the text sent is exactly the typed text', async () => {
    calls.parseStatement.length = 0;
    parseImpl = async () => { throw new Error('No valid transactions found: 3 row(s) failed validation.'); };
    await click(/^Paste Text Log/);
    const unsigned = '05/03/2026 ZOMATO ORDER 120.50\n06/03/2026 SALARY ACME 50000.00';
    await typeInto(unsigned);
    await click(/Parse Logs/);
    await flush();
    const alert = container.querySelector('[role=alert]').textContent;
    assert.match(alert, /No valid transactions found: 3 row\(s\) failed validation\./);
    assert.match(alert, /minus \(-450\.00\) or plus \(\+450\.00\)/);
    assert.match(alert, /DR \/ CR/);
    assert.match(alert, /never guessed/);
    assert.deepEqual(calls.parseStatement, [unsigned], 'sent verbatim: no sign was added');
    assert.equal(textarea().value, unsigned, 'the text stays so the user can fix it');
    assert.ok(!/Success!/.test(container.textContent));
  });

  await check('rows skipped by the server are reported on success; the notice about direction is shown with OCR text', async () => {
    parseImpl = async () => ({ count: 2, skipped: 1 });
    await typeInto('05/03/2026 A -1.00\n06/03/2026 B +2.00\n07/03/2026 C 3.00');
    await click(/Parse Logs/);
    await flush();
    assert.match(container.textContent, /Success! Imported 2 transactions\. 1 row was not imported because the direction, date or amount was unclear\. Nothing was guessed\./);
    extractImpl = async () => ({ text: '05/03/2026 A 1.00', confidence: 90, warnings: [] });
    await click(/^Upload File/);
    await setFile('d.png');
    await click(/Extract Text from Image/);
    await flush();
    assert.match(container.querySelector('[data-testid=ocr-notice]').textContent, /Every line needs a date and an amount with a \+\/.{1,2} sign or a DR\/CR marker, otherwise it is skipped/);
  });

  await check('file import errors get the same explanation, and unrelated errors pass through unchanged', async () => {
    parseImpl = async () => { throw new Error('Could not parse any transactions from the provided statement. Check the format.'); };
    await click(/^Upload File/);
    await setFile('e.txt');
    await click(/Parse File/);
    await flush();
    assert.match(container.querySelector('[role=alert]').textContent, /Check the format\. Each line needs a date \(for example 05\/03\/2026\) and an amount\..*never guessed/);
    parseImpl = async () => { throw new Error('File too large. Maximum allowed size is 5 MB.'); };
    await click(/Parse File/);
    await flush();
    assert.equal(container.querySelector('[role=alert]').textContent, 'File too large. Maximum allowed size is 5 MB.');
  });

  await act(async () => root.unmount());
  console.log(`Statement import a11y/usability: ${pass} checks passed`);
} finally {
  await vite.close();
  dom.window.close();
  delete globalThis.__fin;
}
