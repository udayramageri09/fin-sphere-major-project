// First-login setup guide: dialog behaviour with a mocked auth context, then the real AuthProvider's request with a stubbed fetch.
//
//   npm run test:onboarding
//
// No server, no database; every value is synthetic. Browser-level checks (registration, reload, account switching) are in the real-browser run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');

let checks = 0;
const check = async (name, fn) => { try { await fn(); checks++; } catch (err) { console.error('FAIL:', name); throw err; } };
const container = document.getElementById('root');
let root = createRoot(container);
const q = (s) => container.querySelector(s);
const qa = (s) => [...container.querySelectorAll(s)];
const text = (el = container) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
const click = (el) => act(async () => { el.click(); });
const keydown = (el, key, extra = {}) => act(async () => { el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })); });

let calls = [], navigated = [], behaviour = async () => ({});
globalThis.__auth = () => ({ setOnboardingState: (state) => { calls.push(state); return behaviour(state); } });
let fetchCount = 0;
globalThis.fetch = async () => { fetchCount++; throw new Error('the guide must not make requests of its own'); };

const vite = await createServer({
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
  plugins: [{ name: 'auth-mock', enforce: 'pre', resolveId(id) { if (id.endsWith('/context/AuthContext')) return '\0auth-mock'; }, load(id) { if (id === '\0auth-mock') return 'export const useAuth=()=>globalThis.__auth();'; } }]
});

try {
  const { default: Onboarding } = await vite.ssrLoadModule('/src/components/Onboarding.jsx');
  const mount = async () => { calls = []; navigated = []; behaviour = async () => ({}); await act(async () => root.unmount()); root = createRoot(container); await act(async () => root.render(React.createElement(Onboarding, { onNavigate: (v) => navigated.push(v) }))); };

  await check('a labelled modal dialog; focus starts on its heading', async () => {
    await mount();
    const dialog = q('[role=dialog]');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(text(document.getElementById(dialog.getAttribute('aria-labelledby'))), 'Welcome to FinSphere');
    assert.match(text(document.getElementById(dialog.getAttribute('aria-describedby'))), /Nothing is added for you/);
    assert.ok(document.activeElement === q('#onboarding-title'), 'heading focused');
  });

  await check('concise: two ways to start and Skip for now; no form, no field, nothing that adds data', async () => {
    await mount();
    assert.deepEqual(qa('button').map((b) => b.querySelector('.font-semibold')?.textContent ?? text(b)), ['Add a transaction', 'Import a statement', 'Skip for now']);
    assert.equal(qa('input, textarea, select, form').length, 0);
    assert.match(text(), /reopen this guide from Settings/);
    assert.ok(text().length < 520, `short copy (${text().length} characters)`);
  });

  for (const [name, testid] of [['Add a transaction', 'onboarding-add'], ['Import a statement', 'onboarding-import']]) {
    await check(`${name}: saves "completed" once, then opens Transactions`, async () => {
      await mount();
      await act(async () => { q(`[data-testid=${testid}]`).click(); q(`[data-testid=${testid}]`).click(); });
      assert.deepEqual(calls, ['completed'], 'one save however often it is clicked');
      assert.deepEqual(navigated, ['transactions']);
    });
  }

  await check('Skip for now saves "skipped" and goes nowhere', async () => {
    await mount();
    await click(q('[data-testid=onboarding-skip]'));
    assert.deepEqual(calls, ['skipped']);
    assert.deepEqual(navigated, []);
  });

  await check('Escape means skip for now, once', async () => {
    await mount();
    await keydown(q('[role=dialog]'), 'Escape'); await keydown(q('[role=dialog]'), 'Escape');
    assert.deepEqual(calls, ['skipped']);
  });

  await check('while saving the buttons are disabled; a failed save keeps the guide open with the reason and allows a retry', async () => {
    await mount();
    let release;
    behaviour = () => new Promise((_, reject) => { release = () => reject(new Error('Could not save your changes. Please try again.')); });
    await act(async () => { q('[data-testid=onboarding-add]').click(); });
    assert.ok(qa('button').every((b) => b.disabled), 'all buttons disabled while the request is in flight');
    await act(async () => { release(); });
    assert.equal(text(q('[role=alert]')), 'Could not save your changes. Please try again.');
    assert.deepEqual(navigated, [], 'no navigation after a failed save');
    assert.ok(qa('button').every((b) => !b.disabled));
    behaviour = async () => ({});
    await click(q('[data-testid=onboarding-add]'));
    assert.deepEqual(calls, ['completed', 'completed']);
    assert.deepEqual(navigated, ['transactions']);
  });

  await check('Tab stays inside the dialog (wraps in both directions)', async () => {
    await mount();
    const buttons = qa('button');
    buttons.at(-1).focus();
    await keydown(buttons.at(-1), 'Tab');
    assert.ok(document.activeElement === buttons[0], 'Tab from the last control goes to the first');
    await keydown(buttons[0], 'Tab', { shiftKey: true });
    assert.ok(document.activeElement === buttons.at(-1), 'Shift+Tab from the first control goes to the last');
    q('#onboarding-title').focus();
    await keydown(q('#onboarding-title'), 'Tab', { shiftKey: true });
    assert.ok(document.activeElement === buttons.at(-1), 'Shift+Tab from the heading goes to the last control');
  });

  await check('the guide makes no requests of its own and does not know about financial data', async () => {
    assert.equal(fetchCount, 0);
    const source = fs.readFileSync('src/components/Onboarding.jsx', 'utf8');
    assert.ok(!/FinanceContext|useFinance|addTransaction|fetch\(/.test(source));
  });

  await act(async () => root.unmount());
  await vite.close();

  // ═══ Part 2: the real AuthProvider ═══
  delete globalThis.__auth;
  const vite2 = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  const { AuthProvider, useAuth } = await vite2.ssrLoadModule('/src/context/AuthContext.jsx');
  const requests = [];
  let respond;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET', credentials: init.credentials, body: init.body ? JSON.parse(init.body) : null });
    return respond(String(url), init);
  };
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const sessionUser = { id: 7, email: 'new.person@example.com', displayName: '', reduceMotion: false, avatarVersion: null, onboardingState: 'pending' };
  respond = (url, init) => {
    if (url.endsWith('/auth/verify')) return json(200, { user: sessionUser });
    if (url.endsWith('/auth/profile')) return json(200, { user: { ...sessionUser, onboardingState: JSON.parse(init.body).onboardingState } });
    return json(404, {});
  };
  let api;
  const attempt = async () => { let error; await act(async () => { try { await api.setOnboardingState('completed'); } catch (e) { error = e; } }); return error; };
  const Probe = () => { api = useAuth(); return React.createElement('p', { 'data-testid': 'probe' }, `${api.status}:${api.user?.onboardingState ?? '-'}`); };
  root = createRoot(container);
  await act(async () => root.render(React.createElement(AuthProvider, null, React.createElement(Probe))));
  await act(async () => { await Promise.resolve(); });

  await check('a verified session carries the account\'s setup-guide state', async () => {
    assert.equal(text(q('[data-testid=probe]')), 'authenticated:pending');
  });
  await check('setOnboardingState sends exactly one PATCH with only that field, with the session cookie, and updates the user', async () => {
    requests.length = 0;
    await act(async () => { await api.setOnboardingState('skipped'); });
    assert.equal(requests.length, 1);
    assert.deepEqual({ method: requests[0].method, credentials: requests[0].credentials, body: requests[0].body }, { method: 'PATCH', credentials: 'include', body: { onboardingState: 'skipped' } });
    assert.ok(requests[0].url.endsWith('/auth/profile'));
    assert.equal(text(q('[data-testid=probe]')), 'authenticated:skipped');
  });
  await check('a server refusal is surfaced as a message and the state does not change', async () => {
    respond = (url) => (url.endsWith('/auth/profile') ? json(400, { error: 'Send a display name of at most 80 characters.' }) : json(404, {}));
    assert.match((await attempt()).message, /Send a display name/);
    assert.equal(text(q('[data-testid=probe]')), 'authenticated:skipped');
  });
  await check('an expired session ends the session instead of pretending to save', async () => {
    respond = () => json(401, { error: 'Invalid or expired token' });
    assert.match((await attempt()).message, /session expired/i);
    assert.equal(text(q('[data-testid=probe]')), 'unauthenticated:-');
  });
  await check('a network failure reads as a connection problem', async () => {
    respond = (url) => { if (url.endsWith('/auth/profile')) throw new Error('down'); return json(200, { user: sessionUser }); };
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => root.render(React.createElement(AuthProvider, null, React.createElement(Probe))));
    await act(async () => { await Promise.resolve(); });
    assert.match((await attempt()).message, /Could not reach the server/);
  });

  await act(async () => root.unmount());
  await vite2.close();
  console.log(`Onboarding UI: ${checks} checks passed`);
} finally {
  dom.window.close();
}
