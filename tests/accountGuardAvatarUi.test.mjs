// The profile photo read: the REAL AuthProvider names the account the tab is showing when it downloads the photo, so a tab whose
// session now belongs to someone else never labels that other account's photo as its own, and a refusal re-checks the session.
// Stubbed network; synthetic data.
//
//   npm run test:account-guard-avatar
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
let verifyAs = 7;           // whose profile /auth/verify returns (the account this tab ends up showing)
let cookieOwner = 7;        // whose session the cookie holds when the photo is requested
const shownUser = 7;
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, clone() { return json(status, body); } });
globalThis.URL.createObjectURL = () => 'blob:test/photo';
globalThis.URL.revokeObjectURL = () => {};
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  requests.push({ url: u, headers: { ...(opts.headers ?? {}) } });
  if (/\/auth\/verify$/.test(u)) return json(200, { user: { id: verifyAs, email: 'x@example.com', displayName: 'X', avatarVersion: 3, onboardingState: 'completed', reduceMotion: false } });
  if (/\/auth\/avatar$/.test(u)) {
    const claimed = opts.headers?.['X-FinSphere-User'];
    if (claimed !== undefined && claimed !== String(cookieOwner)) return json(409, { code: 'account_changed', error: 'Your account changed in another tab. Nothing was done.' });
    return { status: 200, ok: true, blob: async () => ({ size: 3 }), json: async () => ({}), clone() { return this; } };
  }
  return json(200, {});
};

const vite = await createServer({
  configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] }, esbuild: { jsx: 'automatic' }
});
const root = createRoot(document.getElementById('root'));
try {
  const { AuthProvider, useAuth } = await vite.ssrLoadModule('/src/context/AuthContext.jsx');
  const Probe = () => { globalThis.__a = useAuth(); return null; };
  const mount = async () => { await act(async () => root.render(React.createElement(AuthProvider, null, React.createElement(Probe)))); await act(async () => { await new Promise((r) => setTimeout(r, 80)); }); };

  await check('same account: the photo request names the account and the photo is shown', async () => {
    requests.length = 0; verifyAs = 7; cookieOwner = 7;
    await mount();
    const photo = requests.find((r) => /\/auth\/avatar$/.test(r.url));
    assert.ok(photo, 'the photo was requested');
    assert.equal(photo.headers['X-FinSphere-User'], String(shownUser));
    assert.equal(globalThis.__a.avatarUrl, 'blob:test/photo');
  });

  await check('session changed to another account: the photo request is refused, another account photo is not shown, and the session is re-checked', async () => {
    // The tab verified as account 7; by the time the photo is requested the cookie belongs to account 8 (changed in another tab).
    await act(async () => root.render(null));
    requests.length = 0; verifyAs = 7; cookieOwner = 8;
    await mount();
    const photo = requests.find((r) => /\/auth\/avatar$/.test(r.url));
    assert.ok(photo, 'the photo was requested');
    assert.equal(photo.headers['X-FinSphere-User'], '7', 'the request names the account the tab shows');
    assert.equal(globalThis.__a.avatarUrl, null, 'the other account photo is not shown as this account photo');
    assert.ok(requests.filter((r) => /\/auth\/verify$/.test(r.url)).length >= 2, 'the refusal asked the server whose session this is');
    cookieOwner = 7;
  });

  await act(async () => root.unmount());
  console.log(`Account guard avatar UI: ${checks} checks passed`);
} finally {
  await vite.close();
  dom.window.close();
}
