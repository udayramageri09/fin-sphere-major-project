// The browser side of the assistant account guard: the REAL FinanceProvider names the account the tab is showing on every assistant
// request, and turns the server's 409 account_changed into an identity re-check instead of acting. Stubbed network; synthetic data.
//
//   npm run test:account-guard-ui
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');

let checks = 0;
const check = async (name, fn) => { try { await fn(); checks++; } catch (err) { console.error('FAIL:', name); throw err; } };

const requests = [];
let respond409 = null;   // null | { code }
let retries = 0;
globalThis.__auth = { invalidateSession: () => {}, user: { id: 7 }, retryIdentityCheck: () => { retries++; } };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, clone() { return json(status, body); } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), method = opts.method ?? 'GET';
  requests.push({ url: u, method, headers: { ...(opts.headers ?? {}) } });
  if (respond409 && (respond409.all || /\/chat$|\/assistant\/actions\//.test(u))) return json(409, { code: respond409.code, error: 'Your account changed in another tab. Nothing was done.' });
  if (/\/chat$/.test(u)) return json(200, { reply: 'ok', action: null });
  if (/\/assistant\/actions\/[^/]+\/confirm$/.test(u)) return json(200, { status: 'executed', kind: 'create_transaction', message: 'Done.' });
  if (/\/assistant\/actions\/[^/]+\/cancel$/.test(u)) return json(200, { status: 'cancelled' });
  if (/\/transactions\/import-confirm$/.test(u)) return json(200, { imported: 1 });
  if (/\/ocr-statement-image$/.test(u)) return json(200, { text: 'a 10', confidence: 90, warnings: [] });
  if (/\/emergency-fund$/.test(u)) return json(200, { configured: false, currentAmount: null, targetAmount: null, createdAt: null, updatedAt: null });
  return json(200, []);
};

const HARNESS = `import { createElement as h } from 'react'; import { FinanceProvider, useFinance } from '/src/context/FinanceContext.jsx';
  export function Probe() { globalThis.__fin = useFinance(); return null; }
  export function App() { return h(FinanceProvider, { currentView: 'dashboard', setCurrentView() {} }, h(Probe)); }`;
const vite = await createServer({
  configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] }, esbuild: { jsx: 'automatic' },
  plugins: [{ name: 'guard-ui', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:guard-harness') return '\0guard-harness'; if (id.startsWith('.') && id.split('/').pop() === 'AuthContext') return '\0stub:auth'; return null; },
    load(id) { if (id === '\0guard-harness') return HARNESS; if (id === '\0stub:auth') return 'export const useAuth = () => globalThis.__auth;'; return null; } }]
});
const root = createRoot(document.getElementById('root'));
try {
  const { App } = await vite.ssrLoadModule('virtual:guard-harness');
  await act(async () => root.render(React.createElement(App)));
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  const fin = () => globalThis.__fin;
  const last = () => requests.at(-1);
  const calls = (re) => requests.filter((r) => re.test(r.url));

  await check('chat, confirm and cancel all name the account the tab is showing', async () => {
    requests.length = 0;
    await act(async () => { await fin().sendAssistantMessage([{ role: 'user', content: 'hi' }]); });
    assert.equal(last().headers['X-FinSphere-User'], '7');
    assert.equal(last().headers['Content-Type'], 'application/json');
    await act(async () => { await fin().confirmAssistantAction('p1'); });
    assert.equal(last().headers['X-FinSphere-User'], '7');
    await act(async () => { await fin().cancelAssistantAction('p2'); });
    assert.equal(last().headers['X-FinSphere-User'], '7');
  });

  await check('a refusal "account changed" is reported, triggers one identity re-check and changes nothing', async () => {
    respond409 = { code: 'account_changed' }; retries = 0;
    const txBefore = fin().transactions.length;
    for (const [name, run] of [['chat', () => fin().sendAssistantMessage([{ role: 'user', content: 'add ₹5 for x' }])], ['confirm', () => fin().confirmAssistantAction('p1')], ['cancel', () => fin().cancelAssistantAction('p2')]]) {
      let error;
      await act(async () => { try { await run(); } catch (e) { error = e; } });
      assert.match(error?.message ?? '', /account changed in another tab/i, `${name} says why`);
    }
    assert.equal(retries, 3, 'each refusal asks the session to re-check whose account this is');
    assert.equal(fin().transactions.length, txBefore, 'no financial state was applied');
    respond409 = null;
  });

  await check('a 409 with some other meaning is not mistaken for an account change', async () => {
    respond409 = { code: 'something_else' }; retries = 0;
    let error;
    await act(async () => { try { await fin().sendAssistantMessage([{ role: 'user', content: 'hi' }]); } catch (e) { error = e; } });
    assert.ok(error && !/account changed/i.test(error.message));
    assert.equal(retries, 0);
    respond409 = null;
  });

  await check('every other request names the account too, and a refusal asks for a re-check without breaking the page', async () => {
    requests.length = 0;
    await act(async () => { await fin().fetchTransactions(); });
    const others = requests.filter((r) => !/\/chat$|\/assistant\/actions\//.test(r.url));
    assert.ok(others.length > 0 && others.every((r) => r.headers['X-FinSphere-User'] === '7'), JSON.stringify(others.map((r) => r.url)));
    respond409 = { code: 'account_changed', all: true }; retries = 0;
    await act(async () => { await fin().fetchTransactions(); });
    assert.ok(retries >= 1, 'a refused read asks the session to re-check');
    respond409 = null;
  });

  await check('import confirmation and image text reading name the account, and a refusal re-checks instead of acting', async () => {
    requests.length = 0;
    await act(async () => { await fin().confirmImport({ rows: [], policy: 'skip_duplicates', reviewDigest: 'd', skipIndexes: [] }); });
    await act(async () => { await fin().extractTextFromImage(new dom.window.File(['x'], 'a.png', { type: 'image/png' })); });
    const sent = [...calls(/import-confirm$/), ...calls(/ocr-statement-image$/)];
    assert.equal(sent.length, 2);
    assert.ok(sent.every((r) => r.headers['X-FinSphere-User'] === '7'), JSON.stringify(sent.map((r) => [r.url, r.headers])));
    assert.equal(sent.find((r) => /import-confirm/.test(r.url)).headers['Content-Type'], 'application/json');
    respond409 = { code: 'account_changed', all: true }; retries = 0;
    for (const [name, run] of [['import confirm', () => fin().confirmImport({ rows: [], policy: 'skip_duplicates', reviewDigest: 'd', skipIndexes: [] })], ['image text', () => fin().extractTextFromImage(new dom.window.File(['x'], 'a.png', { type: 'image/png' }))]]) {
      let error;
      await act(async () => { try { await run(); } catch (e) { error = e; } });
      assert.match(error?.message ?? '', /account changed in another tab/i, `${name} says why, not "could not reach the server"`);
    }
    assert.equal(retries, 2, 'each refusal asks the session to re-check');
    respond409 = null;
  });

  await check('without a known account no header is sent and nothing breaks', async () => {
    const saved = globalThis.__auth; globalThis.__auth = { invalidateSession: () => {} };
    await act(async () => root.render(React.createElement(App, { key: 'no-user' })));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    requests.length = 0;
    await act(async () => { await fin().sendAssistantMessage([{ role: 'user', content: 'hi' }]); });
    assert.ok(!('X-FinSphere-User' in last().headers));
    globalThis.__auth = saved;
  });

  await act(async () => root.unmount());
  console.log(`Assistant account guard UI: ${checks} checks passed`);
} finally {
  await vite.close();
  dom.window.close();
}
