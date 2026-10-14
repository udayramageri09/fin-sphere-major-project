import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const requests = [];
globalThis.__recoveryRequest = async (endpoint, body) => { requests.push({ endpoint, body }); return endpoint === 'reset-password' ? 'Password reset successfully. Please log in.' : 'If an account exists, a reset link will be sent.'; };
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', plugins: [{
  name: 'auth-test', enforce: 'pre',
  resolveId(id) { if (id.endsWith('/context/AuthContext')) return '\0auth-test'; },
  load(id) { if (id === '\0auth-test') return 'export const useAuth=()=>({login:async()=>{},register:async()=>{},clearAuthMessage:()=>{}}); export const passwordRecovery=(...args)=>globalThis.__recoveryRequest(...args);'; }
}] });
const root = createRoot(document.getElementById('root'));
const click = async (text) => { await act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === text).click()); };
const fill = async (id, value) => {
  await act(async () => {
    const input = document.getElementById(id);
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
};
const submit = async () => { await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))); };
try {
  const { default: AuthPage } = await vite.ssrLoadModule('/src/pages/AuthPage.jsx');
  await act(async () => root.render(React.createElement(AuthPage)));
  await click('Forgot password?');
  assert.equal(document.getElementById('auth-password'), null);
  await fill('auth-email', 'user@example.com'); await submit();
  assert.deepEqual(requests[0], { endpoint: 'forgot-password', body: { email: 'user@example.com' } });
  assert.match(document.querySelector('[role=status]').textContent, /If an account exists/);
  await act(async () => root.render(React.createElement(AuthPage, { key: 'reset', resetToken: 'a'.repeat(64) })));
  assert.equal(document.getElementById('auth-email'), null);
  await fill('auth-password', 'new-password'); await fill('auth-confirm-password', 'different'); await submit();
  assert.match(document.body.textContent, /Passwords do not match/); assert.equal(requests.length, 1);
  await fill('auth-confirm-password', 'new-password'); await submit();
  assert.equal(requests[1].endpoint, 'reset-password'); assert.equal(requests[1].body.token, 'a'.repeat(64));
  assert.match(document.querySelector('[role=status]').textContent, /log in/i);
  assert.equal(document.getElementById('auth-password').value, '');
  console.log('Password recovery UI: forgot request, confirmation mismatch, successful reset and return to login passed');
} finally { await act(async () => root.unmount()); await vite.close(); dom.window.close(); delete globalThis.__recoveryRequest; }
