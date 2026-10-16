// Cross-tab account/session isolation: the REAL AuthProvider and the REAL App gate, with the heavy pages replaced by small stand-ins that
// remember which account they were first drawn for (so a stale tab shows up as old account data, and a reset as a remount).
//
//   npm run test:session
//
// No server, no database; every value is synthetic. Real-browser two-tab checks are in the browser run.
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
const container = document.getElementById('root');
let root = null;
const q = (s) => container.querySelector(s);
const text = () => (container.innerText ?? container.textContent ?? '').replace(/\s+/g, ' ').trim();
const visibleText = () => {
  // jsdom has no layout: treat anything inside display:none/hidden as not visible
  const walk = (el) => { if (el.hidden || el.style?.display === 'none') return ''; let out = ''; for (const n of el.childNodes) out += n.nodeType === 3 ? n.textContent : n.nodeType === 1 ? ` ${walk(n)} ` : ''; return out; };
  return walk(container).replace(/\s+/g, ' ').trim();
};
const settle = () => act(async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); await Promise.resolve(); });

// ── stand-in modules (mounts are counted so a reset is observable) ─────────────────────────────────────
const counts = { finance: 0, avatarUnmounts: 0, avatarMasked: 0, late: [] };
globalThis.__counts = counts;
const stub = (name, source) => ({ name: `stub-${name}`, enforce: 'pre' });
const mocks = {
  '/context/FinanceContext': `import { createElement as h, useState } from 'react'; export const FinanceProvider = ({ children }) => { const [n] = useState(() => ++globalThis.__counts.finance); return h('div', { 'data-testid': 'finance', 'data-mount': n }, children); }; export const useFinance = () => ({});`,
  '/components/TopNav': `import { createElement as h } from 'react'; import { useAuth } from '/src/context/AuthContext.jsx'; export default function TopNav() { const { user } = useAuth(); return h('nav', null, 'nav ', h('span', { 'data-testid': 'display-name' }, user.displayName)); }`,
  '/pages/Dashboard': `import { createElement as h, useState } from 'react'; import { useAuth } from '/src/context/AuthContext.jsx'; export default function Dashboard() { const { user } = useAuth(); const [bornFor] = useState(user.id); return h('p', { 'data-testid': 'dashboard' }, 'Dashboard data for account ' + bornFor); }`,
  '/components/AIAvatar': `import { createElement as h, useEffect, useState } from 'react'; import { useAuth } from '/src/context/AuthContext.jsx';
    export default function AIAvatar() { const { user, identityMasked } = useAuth(); const [bornFor] = useState(user.id); const [late, setLate] = useState('');
      useEffect(() => () => { globalThis.__counts.avatarUnmounts++; }, []);
      useEffect(() => { if (identityMasked) globalThis.__counts.avatarMasked++; }, [identityMasked]);
      useEffect(() => { globalThis.__counts.late.push((value) => setLate(value)); }, []);
      return h('div', { 'data-testid': 'avatar' }, 'chat-for-' + bornFor, ' ', late); }`,
  '/pages/AuthPage': `import { createElement as h } from 'react'; import { useAuth } from '/src/context/AuthContext.jsx'; export default function AuthPage() { const { authMessage } = useAuth(); return h('p', { 'data-testid': 'auth-page' }, 'Please sign in. ' + authMessage); }`,
  '/components/Onboarding': `export default function Onboarding() { return null; }`,
  '/pages/Transactions': `export default function X() { return null; }`, '/pages/Liabilities': `export default function X() { return null; }`,
  '/pages/Portfolio': `export default function X() { return null; }`, '/pages/Goals': `export default function X() { return null; }`,
  '/pages/Subscriptions': `export default function X() { return null; }`, '/pages/Plans': `export default function X() { return null; }`, '/pages/Settings': `export default function X() { return null; }`,
};
const vite = await createServer({
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
  plugins: [{
    name: 'stand-ins', enforce: 'pre',
    resolveId(id, importer) { if (importer && /\/src\/App\.jsx$/.test(importer.replace(/\\/g, '/')) || /\/src\/components\/(TopNav|AIAvatar)/.test((importer ?? '').replace(/\\/g, '/'))) { for (const key of Object.keys(mocks)) if (id.endsWith(key)) return `\0mock:${key}`; } },
    load(id) { if (id.startsWith('\0mock:')) return mocks[id.slice(6)]; }
  }]
});
void stub;

// ── controllable network and storage ─────────────────────────────────────────────────────────────────────
const userA = { id: 1, email: 'a@example.com', displayName: 'Ana', reduceMotion: false, avatarVersion: null, onboardingState: 'completed' };
const userB = { id: 2, email: 'b@example.com', displayName: 'Bo', reduceMotion: false, avatarVersion: null, onboardingState: 'completed' };
let verifyCalls = 0, onVerify = async () => ({ status: 200, body: { user: userA } });
const respond = ({ status, body }) => ({ ok: status < 400, status, json: async () => body ?? {} });
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/auth/verify')) { verifyCalls++; const r = await onVerify(); if (r instanceof Error) throw r; return respond(r); }
  if (String(url).endsWith('/auth/logout')) return respond({ status: 200, body: {} });
  return respond({ status: 404, body: {} });
};
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
const EPOCH = 'finsphere:session-epoch';
const otherTabChanged = async () => act(async () => { const v = `epoch-${Math.random().toString(36).slice(2)}`; window.localStorage.setItem(EPOCH, v); window.dispatchEvent(new window.StorageEvent('storage', { key: EPOCH, newValue: v })); });
const returnToTab = async () => act(async () => { window.dispatchEvent(new window.Event('focus')); document.dispatchEvent(new window.Event('visibilitychange')); });

try {
  const { default: App } = await vite.ssrLoadModule('/src/App.jsx');
  const { AuthProvider, useAuth } = await vite.ssrLoadModule('/src/context/AuthContext.jsx');
  let api;
  const Probe = () => { api = useAuth(); return null; };
  const mount = async (first = { status: 200, body: { user: userA } }) => {
    if (root) await act(async () => root.unmount());
    for (const k of ['finance', 'avatarUnmounts', 'avatarMasked']) counts[k] = 0;
    counts.late.length = 0; verifyCalls = 0; visibility = 'visible'; window.localStorage.clear(); window.localStorage.setItem(EPOCH, 'initial-marker');
    onVerify = async () => first;
    root = createRoot(container);
    await act(async () => root.render(React.createElement(AuthProvider, null, React.createElement(App), React.createElement(Probe))));
    await settle();
  };

  await check('start: a verified session shows the app once', async () => {
    await mount();
    assert.match(visibleText(), /Dashboard data for account 1/);
    assert.equal(counts.finance, 1);
    assert.ok(!q('[data-testid=identity-check]'));
  });

  await check('another tab switched to account B: content is hidden while checking, then the tab becomes B with ALL previous state cleared', async () => {
    await mount();
    const held = deferred(); onVerify = () => held.promise;
    await otherTabChanged();
    assert.ok(q('[data-testid=identity-check]'), 'a checking notice is shown at once');
    assert.ok(!/account 1|chat-for-1/.test(visibleText()), `account A's content must not be visible while checking: "${visibleText()}"`);
    assert.ok(!/Ana/.test(visibleText()), 'A\'s name is not visible either');
    assert.ok(counts.avatarMasked >= 1, 'the assistant (and so any voice session) is told to stop while identity is unconfirmed');
    await act(async () => held.resolve({ status: 200, body: { user: userB } })); await settle();
    assert.ok(!q('[data-testid=identity-check]'));
    assert.match(visibleText(), /Dashboard data for account 2/);
    assert.ok(/chat-for-2/.test(visibleText()) && !/chat-for-1|account 1/.test(visibleText()), 'chat, dashboard and everything else belong to B');
    assert.equal(counts.finance, 2, 'the whole signed-in tree was rebuilt, not patched');
    assert.equal(counts.avatarUnmounts, 1, 'the assistant of A was unmounted (its voice session and timers are cleaned up)');
  });

  await check('another tab signed out: this tab leaves the signed-in screen and says why', async () => {
    await mount();
    onVerify = async () => ({ status: 401, body: { error: 'Invalid token' } });
    await otherTabChanged(); await settle();
    assert.ok(q('[data-testid=auth-page]') && !q('[data-testid=dashboard]'));
    assert.match(text(), /signed out|log in again/i);
    assert.ok(!/account 1|chat-for-1|Ana/.test(visibleText()));
  });

  await check('same account in the other tab (signed out and in again): masked briefly, then back, with nothing reset', async () => {
    await mount();
    const held = deferred(); onVerify = () => held.promise;
    await otherTabChanged();
    assert.ok(q('[data-testid=identity-check]'));
    await act(async () => held.resolve({ status: 200, body: { user: userA } })); await settle();
    assert.ok(!q('[data-testid=identity-check]'));
    assert.match(visibleText(), /chat-for-1/);
    assert.equal(counts.finance, 1, 'no remount for the same account');
    assert.equal(counts.avatarUnmounts, 0);
  });

  await check('failed re-validation (network): nothing of A is shown, the failure is explicit, and Retry recovers', async () => {
    await mount();
    onVerify = async () => new Error('network down');
    await otherTabChanged(); await settle();
    assert.ok(q('[data-testid=identity-check]'));
    assert.match(visibleText(), /could not check your session/i);
    assert.ok(!/account 1|chat-for-1|Ana/.test(visibleText()));
    const retry = [...container.querySelectorAll('button')].find((b) => /retry/i.test(b.textContent));
    assert.ok(retry, 'a Retry button');
    onVerify = async () => ({ status: 200, body: { user: userA } });
    await act(async () => retry.click()); await settle();
    assert.ok(!q('[data-testid=identity-check]'));
    assert.match(visibleText(), /chat-for-1/);
    assert.equal(counts.finance, 1);
  });

  await check('a server error is treated like a failed check, and Retry may reveal a different account', async () => {
    await mount();
    onVerify = async () => ({ status: 503, body: {} });
    await otherTabChanged(); await settle();
    assert.match(visibleText(), /could not check your session/i);
    onVerify = async () => ({ status: 200, body: { user: userB } });
    await act(async () => [...container.querySelectorAll('button')].find((b) => /retry/i.test(b.textContent)).click()); await settle();
    assert.match(visibleText(), /chat-for-2/);
    assert.ok(!/chat-for-1|account 1/.test(visibleText()));
    assert.equal(counts.finance, 2);
  });

  await check('returning to a tab when nothing changed anywhere: no blanking, no reset', async () => {
    await mount();
    await returnToTab();
    assert.ok(!q('[data-testid=identity-check]'), 'no mask for an unchanged browser');
    await settle();
    assert.match(visibleText(), /chat-for-1/);
    assert.equal(counts.finance, 1);
  });

  await check('returning to a tab after the marker changed (missed storage event): masked until confirmed', async () => {
    await mount();
    window.localStorage.setItem(EPOCH, 'changed-while-away');
    const held = deferred(); onVerify = () => held.promise;
    await returnToTab();
    assert.ok(q('[data-testid=identity-check]'));
    assert.ok(!/chat-for-1|account 1/.test(visibleText()));
    await act(async () => held.resolve({ status: 200, body: { user: userB } })); await settle();
    assert.match(visibleText(), /chat-for-2/);
  });

  await check('without usable localStorage every return is verified behind the mask', async () => {
    await mount();
    const real = dom.window.Storage.prototype.getItem;
    dom.window.Storage.prototype.getItem = () => { throw new Error('storage blocked'); };
    try {
      const held = deferred(); onVerify = () => held.promise;
      await returnToTab();
      assert.ok(q('[data-testid=identity-check]'));
      await act(async () => held.resolve({ status: 200, body: { user: userA } })); await settle();
      assert.ok(!q('[data-testid=identity-check]'));
      assert.match(visibleText(), /chat-for-1/);
    } finally { dom.window.Storage.prototype.getItem = real; }
  });

  await check('out-of-order answers: an older check can never overwrite a newer one', async () => {
    await mount();
    const first = deferred(); let call = 0;
    onVerify = () => { call++; return call === 1 ? first.promise : Promise.resolve({ status: 200, body: { user: userB } }); };
    await otherTabChanged();
    await otherTabChanged(); await settle();
    assert.match(visibleText(), /chat-for-2/, 'the newer answer (B) is applied');
    await act(async () => first.resolve({ status: 200, body: { user: userA } })); await settle();
    assert.match(visibleText(), /chat-for-2/);
    assert.ok(!/chat-for-1/.test(visibleText()), 'the older answer (A) arrived late and was ignored');
  });

  await check('a late reply started by the previous account cannot appear in the new account', async () => {
    await mount();
    const setLateA = counts.late[0];
    await otherTabChanged(); await settle();
    onVerify = async () => ({ status: 200, body: { user: userB } });
    await otherTabChanged(); await settle();
    assert.match(visibleText(), /chat-for-2/);
    await act(async () => setLateA('LATE-REPLY-FOR-A'));
    assert.ok(!/LATE-REPLY-FOR-A/.test(text()), 'the old assistant instance is gone; its late result has nowhere to land');
  });

  await check('profile changes made in another tab (same account) refresh quietly: no mask, no reset', async () => {
    await mount();
    const held = deferred(); onVerify = () => held.promise;
    await act(async () => { const v = 'profile-' + Math.random().toString(36).slice(2); window.localStorage.setItem('finsphere:profile-epoch', v); window.dispatchEvent(new window.StorageEvent('storage', { key: 'finsphere:profile-epoch', newValue: v })); });
    assert.ok(!q('[data-testid=identity-check]'), 'the screen stays visible while the quiet refresh runs');
    assert.match(visibleText(), /chat-for-1/);
    await act(async () => held.resolve({ status: 200, body: { user: { ...userA, displayName: 'Ana Renamed', onboardingState: 'skipped' } } })); await settle();
    assert.equal(q('[data-testid=display-name]').textContent, 'Ana Renamed');
    assert.equal(counts.finance, 1);
    assert.equal(counts.avatarMasked, 0, 'the assistant was never told to stop');
  });

  await check('a quiet refresh that fails does not blank the screen', async () => {
    await mount();
    onVerify = async () => new Error('offline');
    await act(async () => { const v = 'profile-' + Math.random().toString(36).slice(2); window.localStorage.setItem('finsphere:profile-epoch', v); window.dispatchEvent(new window.StorageEvent('storage', { key: 'finsphere:profile-epoch', newValue: v })); });
    await settle();
    assert.ok(!q('[data-testid=identity-check]'));
    assert.match(visibleText(), /chat-for-1/);
  });

  await check('a tab that was signed out notices a sign-in made in another tab', async () => {
    await mount({ status: 401, body: {} });
    assert.ok(q('[data-testid=auth-page]'));
    onVerify = async () => ({ status: 200, body: { user: userB } });
    await otherTabChanged(); await settle();
    assert.match(visibleText(), /Dashboard data for account 2/);
  });

  await check('signing in and out here tells other tabs with a random marker only (no user data)', async () => {
    await mount({ status: 401, body: {} });
    const seen = [];
    window.addEventListener('storage', () => {});
    const original = dom.window.Storage.prototype.setItem;
    dom.window.Storage.prototype.setItem = function (k, v) { seen.push([k, String(v)]); return original.call(this, k, v); };
    try {
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/auth/login')) return respond({ status: 200, body: { user: userA } });
        if (String(url).endsWith('/auth/logout')) return respond({ status: 200, body: {} });
        return respond({ status: 401, body: {} });
      };
      await act(async () => { await api.login('a@example.com', 'secret-password-1'); });
      await act(async () => { await api.logout(); });
    } finally { dom.window.Storage.prototype.setItem = original; }
    const marks = seen.filter(([k]) => k === EPOCH).map(([, v]) => v);
    assert.ok(marks.length >= 2, `a marker is written on sign-in and sign-out (${marks.length})`);
    assert.ok(!seen.some(([k]) => k === 'finsphere:profile-epoch'), 'signing in or out does not use the profile marker');
    assert.ok(marks.every((v) => /^[a-z0-9-]{8,}$/i.test(v)), 'only a random token');
    assert.ok(!seen.some(([, v]) => /a@example|secret-password|Ana|token/i.test(v)), 'nothing identifying is written');
    assert.equal(new Set(marks).size, marks.length, 'each change writes a fresh value so other tabs always notice');
  });

  await act(async () => root.unmount());
  console.log(`Session isolation UI: ${checks} checks passed`);
} finally {
  await vite.close();
  dom.window.close();
}
