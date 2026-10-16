// Account guard on the Portfolio holdings and Plans pages: the REAL pages, with a stubbed network and a mocked session. Every request they make
// must name the account the tab is showing; a refusal ("your account changed in another tab") must make the tab re-check its session and show
// nothing from the refused call; a reply that arrives after the page is gone must not touch anything.
//
//   npm run test:account-guard-pages
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');

let checks = 0, failures = 0;
const check = async (name, fn) => { try { await fn(); checks++; } catch (err) { failures++; console.log('FAIL:', name, '-', String(err.message).split('\n')[0].slice(0, 160)); } };
const container = document.getElementById('root');
const text = () => (container.textContent ?? '').replace(/\s+/g, ' ').trim();
const tick = (ms = 20) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const setValue = (el, value) => act(async () => { const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); });

// the analysis fixture of the Plans suite (kept in one place)
const planSource = fs.readFileSync(new URL('./plansIntelligence.test.mjs', import.meta.url), 'utf8');
const fixtureStart = planSource.indexOf('const step = '), fixtureEnd = planSource.indexOf('let analyzeMode');
const { analysis } = new Function(`${planSource.slice(fixtureStart, fixtureEnd)}; return { analysis };`)();

// ── network and session stubs ─────────────────────────────────────────────────────────────────────────────
const requests = [];
let mode = 'ok';              // 'ok' | 'refuse'
let hold = null;              // a deferred promise that delays the next /holdings read
let retries = 0;
globalThis.__auth = { user: { id: 7 }, invalidateSession: () => {}, retryIdentityCheck: () => { retries++; } };
globalThis.__fin = { transactions: [{ id: 't1', title: 'Salary', amount: 52000, date: '2026-09-01', type: 'income', category: 'Salary' }] };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, clone() { return json(status, body); } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), method = opts.method ?? 'GET';
  requests.push({ url: u, method, headers: { ...(opts.headers ?? {}) }, body: opts.body });
  if (mode === 'refuse') return json(409, { code: 'account_changed', error: 'Your account changed in another tab. Nothing was done.' });
  if (/\/holdings$/.test(u) && method === 'GET') { if (hold) await hold.promise; return json(200, []); }
  if (/\/holdings$/.test(u) && method === 'POST') return json(201, { id: 'h1', ...JSON.parse(opts.body) });
  if (/\/ml\/analyze$/.test(u)) return json(200, analysis());
  if (/\/plan-chat$/.test(u)) return json(200, { reply: 'REPLY' });
  return json(200, []);
};

const vite = await createServer({
  configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] }, esbuild: { jsx: 'automatic' },
  plugins: [{ name: 'guard-pages', enforce: 'pre',
    resolveId(id) {
      if (id.endsWith('/context/AuthContext')) return '\0stub:auth';
      if (id.endsWith('/context/FinanceContext')) return '\0stub:finance';
      if (id.endsWith('/hooks/useAvatarActions')) return '\0stub:avatar';
      return null;
    },
    load(id) {
      if (id === '\0stub:auth') return 'export const useAuth = () => globalThis.__auth;';
      if (id === '\0stub:finance') return 'export const useFinance = () => globalThis.__fin;';
      if (id === '\0stub:avatar') return 'export const useAvatarActions = () => ({ performNavigation() {} });';
      return null;
    } }]
});
let root = createRoot(container);
const mount = async (Page, props) => { await act(async () => root.unmount()); root = createRoot(container); requests.length = 0; retries = 0; mode = 'ok'; hold = null; await act(async () => root.render(React.createElement(Page, props))); await tick(60); };
const named = (re) => requests.filter((r) => re.test(r.url));
const click = (el) => act(async () => { el.click(); });

try {
  const { default: Portfolio } = await vite.ssrLoadModule('/src/pages/Portfolio.jsx');
  const { default: Plans } = await vite.ssrLoadModule('/src/pages/Plans.jsx');

  // ═══ Portfolio holdings ═══
  await check('Portfolio: the holdings read names the account the tab is showing', async () => {
    await mount(Portfolio);
    const reads = named(/\/holdings$/).filter((r) => r.method === 'GET');
    assert.ok(reads.length >= 1);
    assert.ok(reads.every((r) => r.headers['X-FinSphere-User'] === '7'), JSON.stringify(reads.map((r) => r.headers)));
  });

  await check('Portfolio: a holding is saved with the account header, and the normal flow still works', async () => {
    await mount(Portfolio);
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Add holding'));
    const form = container.querySelector('form');
    await setValue(form.querySelector('[name=name]'), 'GUARDHOLD');
    await setValue(form.querySelector('[name=invested]'), '1000');
    await setValue(form.querySelector('[name=current]'), '1200');
    await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await tick(60);
    const writes = named(/\/holdings$/).filter((r) => r.method === 'POST');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].headers['X-FinSphere-User'], '7');
    assert.equal(writes[0].headers['Content-Type'], 'application/json');
    assert.match(text(), /GUARDHOLD/);
    assert.equal(retries, 0, 'no needless re-check on the normal path');
  });

  await check('Portfolio: a refused read shows nothing, asks the session to re-check, and does not break the page', async () => {
    await act(async () => { await Promise.resolve(); });
    await act(async () => root.unmount()); root = createRoot(container); requests.length = 0; retries = 0; mode = 'refuse';
    await act(async () => root.render(React.createElement(Portfolio)));
    await tick(60);
    assert.ok(retries >= 1, 're-check requested');
    assert.ok(!/GUARDHOLD/.test(text()), 'no holding rows were drawn');
    assert.match(text(), /account changed in another tab/i, 'the reason is shown');
  });

  await check('Portfolio: a refused write saves nothing, asks for a re-check and says why', async () => {
    await mount(Portfolio);
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Add holding'));
    const form = container.querySelector('form');
    await setValue(form.querySelector('[name=name]'), 'STALEHOLD');
    await setValue(form.querySelector('[name=invested]'), '10');
    await setValue(form.querySelector('[name=current]'), '12');
    mode = 'refuse';
    await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await tick(60);
    assert.ok(retries >= 1);
    assert.ok(!/STALEHOLD/.test(container.querySelector('ul, table')?.textContent ?? ''), 'the refused holding was not added to the list');
    assert.match(text(), /account changed in another tab/i);
  });

  await check('Portfolio: a reply that arrives after the page is gone changes nothing', async () => {
    await act(async () => root.unmount()); root = createRoot(container); requests.length = 0; retries = 0; mode = 'ok';
    let release; hold = { promise: new Promise((r) => { release = r; }) };
    await act(async () => root.render(React.createElement(Portfolio)));
    await act(async () => root.unmount());
    release();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(container.textContent, '');
    assert.equal(retries, 0);
    root = createRoot(container); hold = null;
  });

  // ═══ Plans: analysis and plan chat ═══
  await check('Plans: the analysis request names the account', async () => {
    await mount(Plans);
    const analyze = named(/\/ml\/analyze$/);
    assert.ok(analyze.length >= 1);
    assert.ok(analyze.every((r) => r.headers['X-FinSphere-User'] === '7'), JSON.stringify(analyze.map((r) => r.headers)));
  });

  await check('Plans: a plan-chat question names the account, sends only the conversation, and the answer is shown', async () => {
    await mount(Plans);
    const chip = [...container.querySelectorAll('.quick-prompt-chip')].find((b) => !b.disabled);
    assert.ok(chip, 'the analysis loaded, so the prompts are enabled');
    await click(chip); await tick(60);
    const chat = named(/\/plan-chat$/);
    assert.equal(chat.length, 1);
    assert.equal(chat[0].headers['X-FinSphere-User'], '7');
    assert.deepEqual(Object.keys(JSON.parse(chat[0].body)), ['messages']);
    assert.match(text(), /REPLY/);
    assert.equal(retries, 0);
  });

  await check('Plans: a refused analysis asks for a re-check and shows no stale or foreign results', async () => {
    await act(async () => root.unmount()); root = createRoot(container); requests.length = 0; retries = 0; mode = 'refuse';
    await act(async () => root.render(React.createElement(Plans)));
    await tick(60);
    assert.ok(retries >= 1);
    assert.ok(!container.querySelector('[data-testid=analysis-details]'), 'no analysis was drawn');
    assert.ok(container.querySelector('[data-testid=analysis-error]'), 'a clear error is shown instead');
  });

  await check('Plans: a refused chat question asks for a re-check and the advisor says nothing about accounts it cannot see', async () => {
    await mount(Plans);
    const chip = [...container.querySelectorAll('.quick-prompt-chip')].find((b) => !b.disabled);
    mode = 'refuse'; retries = 0;
    await click(chip); await tick(60);
    assert.ok(retries >= 1);
    assert.ok(!/REPLY/.test(text()));
  });

  await act(async () => root.unmount());
  console.log(`Account guard on Portfolio and Plans UI: ${checks} checks passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
} finally {
  await vite.close();
  dom.window.close();
}
