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
  optimizeDeps: { noDiscovery: true, include: [], entries: [] }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error',
  plugins: [{ name: 'auth-mock', enforce: 'pre', resolveId(id) { if (id.endsWith('/context/AuthContext')) return '\0auth-mock'; }, load(id) { if (id === '\0auth-mock') return 'export const useAuth=()=>globalThis.__auth();'; } }]
});

try {
  const { default: Onboarding } = await vite.ssrLoadModule('/src/components/Onboarding.jsx');
  const mount = async () => { calls = []; navigated = []; behaviour = async () => ({}); await act(async () => root.unmount()); root = createRoot(container); await act(async () => root.render(React.createElement(Onboarding, { onNavigate: (v) => navigated.push(v) }))); };

  await check('first-login tour opens real pages and persists completion only at the end', async () => {
    await mount();
    assert.equal(q('[role=dialog]').getAttribute('aria-modal'), 'false');
    assert.equal(document.querySelector('[inert]'), null);
    await click(qa('button').find(b => text(b) === 'Start feature tour'));
    assert.deepEqual(navigated, ['dashboard']);
    assert.deepEqual(calls, []);
    for (let i = 1; i < 8; i++) await click(qa('button').find(b => text(b) === 'Next'));
    assert.deepEqual(navigated, ['dashboard','transactions','liabilities','portfolio','goals','subscriptions','plans','settings']);
    assert.equal(text(q('[data-testid=tour-title]')), 'Settings');
    await click(qa('button').find(b => text(b) === 'Back'));
    assert.equal(navigated.at(-1), 'plans');
    await click(qa('button').find(b => text(b) === 'Next'));
    await click(qa('button').find(b => text(b) === 'Finish tour'));
    assert.deepEqual(calls, ['completed']);
  });
  await check('skip saves once and a failed save remains retryable', async () => {
    await mount();
    behaviour = async () => { throw new Error('Offline'); };
    await click(q('[data-testid=onboarding-skip]'));
    assert.equal(text(q('[role=alert]')), 'Offline');
    behaviour = async () => ({});
    await act(async () => { q('[data-testid=onboarding-skip]').click(); q('[data-testid=onboarding-skip]').click(); });
    assert.deepEqual(calls, ['skipped','skipped']);
  });
  await check('audio starts only on request, follows navigation and stops on unmount', async () => {
    const spoken = []; let cancels = 0;
    window.speechSynthesis = { speak: u => spoken.push(u), cancel: () => { cancels++; } };
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    await mount();
    assert.equal(spoken.length, 0);
    await click(qa('button').find(b => text(b) === 'Start audio tour'));
    assert.match(spoken[0].text, /^Dashboard/);
    await click(qa('button').find(b => text(b) === 'Next'));
    assert.match(spoken[1].text, /^Transactions/);
    assert.equal(navigated.at(-1), 'transactions');
    const before = cancels;
    await mount(); assert.ok(cancels > before);
    delete window.speechSynthesis; delete window.SpeechSynthesisUtterance;
  });
  await check('no audio support leaves text and navigation usable; no financial writes', async () => {
    await mount();
    await click(qa('button').find(b => text(b) === 'Start audio tour'));
    assert.match(text(q('[role=status]')), /Audio is unavailable/);
    assert.ok(text(q('[data-testid=tour-transcript]')).length > 0);
    assert.equal(fetchCount, 0);
    const app = fs.readFileSync('src/App.jsx','utf8');
    assert.match(app, /user\?\.onboardingState === 'pending' && <Onboarding/);
    assert.ok(!fs.readFileSync('src/pages/Settings.jsx','utf8').includes('setOnboardingState'));
  });

  await act(async () => root.unmount());
  await vite.close();

  // ═══ Part 2: the real AuthProvider ═══
  delete globalThis.__auth;
  const vite2 = await createServer({ optimizeDeps: { noDiscovery: true, include: [], entries: [] }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' });
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
