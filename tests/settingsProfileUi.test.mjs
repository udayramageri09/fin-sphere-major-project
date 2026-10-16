// Settings, profile photo, display name, preferences, navigation and the dashboard greeting.
//
//   npm run test:settings
//
// Part 1 renders the real components with a mocked auth context (every call is recorded).
// Part 2 renders the real AuthProvider with a stubbed fetch to check the actual requests, persistence, session expiry and account
// switching. No server, no database; every name, email and image is synthetic.
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

// ── environment: reduced-motion media query, object URLs, timers ─────────────────────────────────────────────────────────
let systemReduces = false;
const mediaListeners = new Set();
dom.window.matchMedia = (query) => ({
  matches: /reduce/.test(query) && systemReduces, media: query,
  addEventListener: (type, cb) => { if (type === 'change') mediaListeners.add(cb); },
  removeEventListener: (type, cb) => mediaListeners.delete(cb)
});
const setSystemReduces = async (value) => { systemReduces = value; await act(async () => { for (const cb of [...mediaListeners]) cb({ matches: value }); }); };
const objectUrls = { created: [], revoked: [] };
let urlCounter = 0;
URL.createObjectURL = (blob) => { const url = `blob:test/${++urlCounter}`; objectUrls.created.push({ url, blob }); return url; };
URL.revokeObjectURL = (url) => { objectUrls.revoked.push(url); };
const timers = { set: [], cleared: new Set() };
const nativeSetInterval = globalThis.setInterval, nativeClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms, ...a) => { const id = nativeSetInterval(fn, ms, ...a); timers.set.push({ id, ms }); return id; };
globalThis.clearInterval = (id) => { timers.cleared.add(id); return nativeClearInterval(id); };
const liveIntervals = () => timers.set.filter((t) => !timers.cleared.has(t.id) && t.ms <= 100).length;   // the taglines' short test intervals

// ── mocked auth for part 1 ───────────────────────────────────────────────────────────────────────────────────────────────
const calls = { updateProfile: [], uploadAvatar: [], removeAvatar: 0, logout: 0, recovery: [], onboarding: [] };
let auth, impl;
const resetAuth = (user = { id: 424242, email: 'secret.person@example.com', displayName: 'Alex', avatarVersion: null, reduceMotion: false }, extra = {}) => {
  for (const k of Object.keys(calls)) calls[k] = Array.isArray(calls[k]) ? [] : 0;
  impl = {
    updateProfile: async (patch) => ({ ...auth.user, ...patch }),
    uploadAvatar: async () => ({ ...auth.user, avatarVersion: 111 }),
    removeAvatar: async () => ({ ...auth.user, avatarVersion: null }),
    recovery: async () => 'If an account exists, a reset link will be sent.'
  };
  auth = {
    status: 'authenticated', user, avatarUrl: null,
    updateProfile: (patch) => { calls.updateProfile.push(patch); return impl.updateProfile(patch); },
    uploadAvatar: (blob) => { calls.uploadAvatar.push(blob); return impl.uploadAvatar(blob); },
    removeAvatar: () => { calls.removeAvatar++; return impl.removeAvatar(); },
    logout: () => { calls.logout++; },
    setOnboardingState: (state) => { calls.onboarding.push(state); return impl.onboarding ? impl.onboarding(state) : Promise.resolve({ ...auth.user, onboardingState: state }); },
    ...extra
  };
};
resetAuth();
globalThis.__auth = () => auth;
globalThis.__recovery = (...args) => { calls.recovery.push(args); return impl.recovery(...args); };

const vite = await createServer({
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
  plugins: [{
    name: 'settings-mocks', enforce: 'pre',
    resolveId(id) { if (id.endsWith('/context/AuthContext')) return '\0auth-mock'; },
    load(id) { if (id === '\0auth-mock') return 'export const useAuth=()=>globalThis.__auth(); export const passwordRecovery=(...a)=>globalThis.__recovery(...a);'; }
  }]
});

const container = document.createElement('div');
document.body.appendChild(container);
let root = createRoot(container);
const mount = async (element) => act(async () => root.render(element));
const remount = async () => { await act(async () => root.unmount()); root = createRoot(container); };
const q = (sel) => container.querySelector(sel);
const qa = (sel) => [...container.querySelectorAll(sel)];
const button = (re) => qa('button').find((b) => re.test(b.textContent.trim()) || re.test(b.getAttribute('aria-label') ?? ''));
const click = async (el) => { await act(async () => { el.click(); }); };
const flush = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const typeInto = (selector, value) => act(async () => {
  const input = q(selector);
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const submit = () => act(async () => { q('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
const chooseFile = async (file) => act(async () => {
  const input = q('[data-testid=avatar-input]');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
});
const file = (name, type, size = 2048) => { const f = new window.File([new Uint8Array(Math.min(size, 16))], name, { type }); if (size > 16) Object.defineProperty(f, 'size', { value: size }); return f; };
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const fakePrepare = (label = 'p') => async () => ({ blob: { size: 10, label }, previewUrl: `blob:preview/${label}` });
const text = () => container.textContent;

try {
  const { default: Avatar } = await vite.ssrLoadModule('/src/components/Avatar.jsx');
  const { initialsFor } = await vite.ssrLoadModule('/src/utils/avatarImage.js');
  const { default: TopNav } = await vite.ssrLoadModule('/src/components/TopNav.jsx');
  const { default: DashboardGreeting } = await vite.ssrLoadModule('/src/components/DashboardGreeting.jsx');
  const { default: RotatingTagline } = await vite.ssrLoadModule('/src/components/RotatingTagline.jsx');
  const { default: Settings } = await vite.ssrLoadModule('/src/pages/Settings.jsx');
  const { TAGLINES } = await vite.ssrLoadModule('/src/utils/taglines.js');

  // ═══ avatar ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  await check('initials come from the chosen name only (never an email), with an icon when there is nothing usable', () => {
    assert.equal(initialsFor('Alex Kim'), 'AK');
    assert.equal(initialsFor('alex'), 'A');
    assert.equal(initialsFor('  mary  ann  de souza '), 'MS');
    assert.equal(initialsFor('🌿 Nick'), 'N');
    assert.equal(initialsFor('Éva Öz'), 'ÉÖ');
    assert.equal(initialsFor('अनु शर्मा').length > 0, true);
    for (const empty of ['', '   ', null, undefined, '🌿', '***']) assert.equal(initialsFor(empty), '', String(empty));
  });

  await check('avatar: photo, initials and neutral icon fallbacks, circular with a border, decorative by default', async () => {
    await mount(React.createElement(Avatar, { size: 40, name: 'Alex Kim', src: 'blob:x/1' }));
    assert.equal(q('[data-avatar]').dataset.avatar, 'photo');
    assert.equal(q('img').getAttribute('src'), 'blob:x/1');
    assert.equal(q('img').getAttribute('alt'), '');
    assert.match(q('[data-avatar]').className, /rounded-full/);
    assert.match(q('[data-avatar]').className, /border/);
    assert.equal(q('[data-avatar]').getAttribute('aria-hidden'), 'true');
    assert.equal(q('[data-avatar]').style.width, '40px');
    await mount(React.createElement(Avatar, { size: 64, name: 'Alex Kim' }));
    assert.equal(q('[data-avatar]').dataset.avatar, 'initials');
    assert.equal(q('[data-avatar]').textContent, 'AK');
    await mount(React.createElement(Avatar, { size: 64, name: '' }));
    assert.equal(q('[data-avatar]').dataset.avatar, 'icon');
    assert.equal(q('[data-avatar]').textContent, '');
    assert.ok(q('svg'), 'a person icon');
    await mount(React.createElement(Avatar, { name: 'Alex', label: 'Your profile photo' }));
    assert.equal(q('[role=img]').getAttribute('aria-label'), 'Your profile photo');
  });

  // ═══ navigation: no email, working Settings entries ══════════════════════════════════════════════════════════════
  let view = null;
  const renderNav = async (currentView = 'dashboard') => mount(React.createElement(TopNav, { currentView, setCurrentView: (v) => { view = v; } }));

  await check('header: no "Signed in as", no email anywhere, the name is not printed either, and the avatar is compact', async () => {
    resetAuth();
    await renderNav();
    assert.ok(!/Signed in as/i.test(text()));
    assert.ok(!text().includes('secret.person@example.com') && !text().includes('@'), 'no email in the header');
    assert.ok(q('[data-testid=nav-avatar]'));
    assert.equal(q('[data-testid=nav-avatar] [data-avatar]').style.width, '32px');
    assert.equal(q('[data-testid=nav-avatar] [data-avatar]').dataset.avatar, 'initials');
  });

  await check('header: the rightmost avatar opens Settings; logout is inside Settings', async () => {
    view = null;
    const avatar = q('[data-testid=nav-avatar]');
    assert.equal(avatar.getAttribute('aria-label'), 'Profile and settings');
    assert.equal(qa('header button').at(-1), avatar);
    assert.equal(q('header button[aria-label="Log out"]'), null);
    await click(avatar);
    assert.equal(view, 'settings');
    await renderNav('settings');
    assert.equal(q('[data-testid=nav-avatar]').getAttribute('aria-current'), 'page');
  });

  await check('mobile: the drawer has a working Settings item, closes after use, and shows no email', async () => {
    await renderNav();
    assert.equal(q('[data-testid=drawer-settings]'), null, 'drawer closed');
    await click(q('button[aria-label="Open menu"]'));
    assert.equal(q('button[aria-label="Close menu"]').getAttribute('aria-expanded'), 'true');
    assert.ok(!text().includes('secret.person@example.com'), 'no email in the drawer');
    assert.ok(!/Signed in as/i.test(text()));
    assert.equal(qa('[data-testid=drawer-settings]')[0].parentElement.querySelector('button:last-of-type'), q('[data-testid=drawer-settings]'));
    assert.ok(!qa('button').some(b => b.textContent.trim() === 'Log out'));
    view = null;
    await click(q('[data-testid=drawer-settings]'));
    assert.equal(view, 'settings');
    assert.equal(q('[data-testid=drawer-settings]'), null, 'the drawer closes after choosing Settings');
  });

  await check('a signed-in account with no name and no photo gets a neutral icon in the header, never email initials', async () => {
    resetAuth({ id: 1, email: 'zed@example.com', displayName: '', avatarVersion: null, reduceMotion: false });
    await renderNav();
    assert.equal(q('[data-testid=nav-avatar] [data-avatar]').dataset.avatar, 'icon');
    assert.ok(!/ZE|Z/.test(q('[data-testid=nav-avatar]').textContent));
  });

  // ═══ dashboard greeting and the rotating line ═══════════════════════════════════════════════════════════════════
  await check('greeting: "Welcome back, {name}" without an avatar; just "Welcome back" without a name, never the email', async () => {
    resetAuth(); auth.avatarUrl = 'blob:x/me';
    await mount(React.createElement(DashboardGreeting));
    assert.equal(q('[data-testid=greeting]').textContent, 'Welcome back, Alex');
    assert.equal(q('[data-avatar]'), null, 'the greeting has no photograph');
    resetAuth({ id: 2, email: 'only.email@example.com', displayName: '', avatarVersion: null, reduceMotion: false });
    await mount(React.createElement(DashboardGreeting));
    assert.equal(q('[data-testid=greeting]').textContent, 'Welcome back');
    assert.ok(!text().includes('only.email') && !text().includes('@'));
    assert.equal(q('[data-avatar]'), null);
    resetAuth({ id: 3, email: 'a@example.com', displayName: '   ', avatarVersion: null, reduceMotion: false });
    await mount(React.createElement(DashboardGreeting));
    assert.equal(q('[data-testid=greeting]').textContent, 'Welcome back', 'a blank name counts as no name');
  });

  await check('greeting: a long or markup-like name wraps and is shown as plain text', async () => {
    resetAuth({ id: 4, email: 'a@example.com', displayName: '<img src=x onerror=alert(1)> ' + 'W'.repeat(60), avatarVersion: null, reduceMotion: false });
    await mount(React.createElement(DashboardGreeting));
    assert.equal(q('[data-testid=greeting] img'), null);
    assert.ok(q('[data-testid=greeting]').textContent.includes('<img src=x onerror=alert(1)>'));
    assert.match(q('[data-testid=greeting]').className, /overflow-wrap:anywhere/);
    assert.match(q('[data-testid=greeting]').parentElement.className, /min-w-0/);
  });

  await check('rotating line: only the supporting line changes, in a fixed-height box, with no live region and hidden from screen readers', async () => {
    const phrases = ['One.', 'Two.', 'Three.'];
    await mount(React.createElement(RotatingTagline, { phrases, intervalMs: 30 }));
    const box = q('[data-testid=tagline]');
    assert.match(box.className, /\bh-6\b/, 'reserved height');
    assert.match(box.className, /overflow-hidden/);
    assert.equal(box.querySelector('.sr-only').textContent, 'One.', 'screen readers get the first sentence once');
    assert.equal(box.querySelector('[aria-hidden=true]').textContent, 'One.');
    assert.equal(qa('[aria-live]').length, 0, 'no live region anywhere');
    const seen = new Set();
    for (let i = 0; i < 40 && seen.size < 3; i++) { await flush(60); seen.add(box.getAttribute('data-phrase-index')); }
    assert.ok(seen.size >= 2, `the line rotated through indexes: ${[...seen].join(',')}`);
    const shown = qa('[data-testid=tagline] [aria-hidden=true]').map((p) => p.textContent);
    assert.ok(shown.every((t) => phrases.includes(t)) && shown.some((t) => t !== 'One.' || seen.size > 1), 'only phrases from the list are shown');
    assert.equal(box.querySelector('.sr-only').textContent, 'One.', 'the text for screen readers never changes');
    const p = box.querySelector('[aria-hidden=true]');
    assert.match(p.className, /absolute/, 'phrases sit in a fixed box, so a change cannot move the page');
  });

  await check('the default phrases are neutral encouragement', () => {
    assert.deepEqual(TAGLINES, ['Make room for your next goal.', 'A little clarity for your day.', 'Your money, at a glance.', 'Small steps toward your plans.']);
    assert.ok(TAGLINES.every((t) => !/\d|₹|%|spent|saved|earned|score|debt|loss|profit/i.test(t)), 'no claims about money or performance');
  });

  await check('animation cleanup: unmounting stops the timer (no timer leaks)', async () => {
    await mount(React.createElement('div'));                 // clear whatever an earlier check left mounted
    const before = liveIntervals();
    await mount(React.createElement(RotatingTagline, { phrases: ['a', 'b'], intervalMs: 20 }));
    assert.equal(liveIntervals(), before + 1, 'one timer while mounted');
    await remount();
    assert.equal(liveIntervals(), before, 'the timer is cleared on unmount');
    const errors = [];
    const realError = console.error; console.error = (...a) => errors.push(a.join(' '));
    try { await new Promise((r) => setTimeout(r, 80)); } finally { console.error = realError; }
    assert.equal(errors.length, 0, 'no state updates after unmount');
    await mount(React.createElement('div'));
  });

  await check('reduced motion (device setting or Settings preference): one still sentence and no timer', async () => {
    const timersBefore = timers.set.length;
    await setSystemReduces(true);
    resetAuth();
    await mount(React.createElement(DashboardGreeting));
    assert.equal(q('[data-testid=tagline]').tagName, 'P');
    assert.equal(q('[data-testid=tagline]').textContent, TAGLINES[0]);
    assert.equal(q('[data-testid=tagline] [aria-hidden]'), null);
    assert.equal(timers.set.slice(timersBefore).filter((t) => t.ms === 5000).length, 0, 'no rotation timer was created');
    await setSystemReduces(false);
    await mount(React.createElement(DashboardGreeting));
    assert.ok(q('[data-testid=tagline] [aria-hidden=true]'), 'motion is back when the device no longer asks for less');
    resetAuth({ id: 424242, email: 'a@example.com', displayName: 'Alex', avatarVersion: null, reduceMotion: true });
    await mount(React.createElement(DashboardGreeting));
    assert.equal(q('[data-testid=tagline]').tagName, 'P', 'the saved preference alone also makes it still');
    assert.equal(q('[data-testid=tagline]').textContent, TAGLINES[0]);
    await setSystemReduces(true);
    resetAuth();                                                      // preference OFF, device ON: the device setting is always honoured
    await mount(React.createElement(DashboardGreeting));
    assert.equal(q('[data-testid=tagline]').tagName, 'P');
    await setSystemReduces(false);
  });

  // ═══ Settings: structure ═════════════════════════════════════════════════════════════════════════════════════════
  // Always a fresh page: whatever an earlier check left in the form (a draft, a staged photo) must not leak into the next one.
  const renderSettings = async (props = {}) => { await mount(React.createElement('div')); await mount(React.createElement(Settings, { prepareImage: fakePrepare('a'), ...props })); };

  await check('Setup guide: shows the stored state and reopens the guide once, with errors shown and no double submit', async () => {
    resetAuth({ id: 424242, email: 'secret.person@example.com', displayName: 'Alex', avatarVersion: null, reduceMotion: false, onboardingState: 'skipped' });
    await renderSettings();
    assert.equal(q('[data-testid=setup-status]').textContent, 'You skipped the setup guide.');
    const button = q('[data-testid=show-setup-guide]');
    assert.equal(button.textContent, 'Show the setup guide');
    await act(async () => { button.click(); button.click(); });
    assert.deepEqual(calls.onboarding, ['pending'], 'one request for pending, however many clicks');
    resetAuth({ id: 424242, email: 'secret.person@example.com', displayName: 'Alex', avatarVersion: null, reduceMotion: false, onboardingState: 'completed' });
    impl.onboarding = async () => { throw new Error('Could not save your changes. Please try again.'); };
    await renderSettings();
    assert.equal(q('[data-testid=setup-status]').textContent, 'You have used the setup guide.');
    await act(async () => { q('[data-testid=show-setup-guide]').click(); });
    assert.match(text(), /Could not save your changes/);
    assert.ok(!q('[data-testid=show-setup-guide]').disabled, 'the button is available again after a failure');
    resetAuth();
  });

  await check('settings has Profile, Account and security, Display sections; the email appears only here; no secrets or ids', async () => {
    resetAuth();
    await renderSettings();
    assert.deepEqual(qa('h2').map((h) => h.textContent), ['Profile', 'Account', 'Display', 'Setup guide']);
    assert.equal(q('[data-testid=account-email]').textContent, 'secret.person@example.com');
    assert.equal(qa('section').filter((s) => s.textContent.includes('secret.person@example.com')).length, 1, 'only the account section shows the email');
    assert.ok(!/Signed in as/i.test(text()));
    assert.ok(!text().includes('424242'), 'no internal user id');
    assert.ok(!/password hash|token|jwt/i.test(text()));
    assert.equal(q('input[type=email]'), null);
    assert.ok(![...qa('input')].some((i) => String(i.value).includes('@')), 'no input holds the email: it cannot be edited here');
    assert.match(text(), /Read-only/i);
    assert.match(text(), /Optional. How you appear/);
  });

  await check('profile form: labelled controls, hint, counter, Save/Cancel start disabled when nothing changed', async () => {
    assert.equal(q('label[for=settings-name]').textContent, 'Display name');
    assert.equal(q('#settings-name').value, 'Alex');
    assert.equal(q('#settings-name').getAttribute('aria-describedby'), 'settings-name-hint settings-name-count');
    assert.equal(q('#settings-name').maxLength, 80);
    assert.equal(q('[data-testid=name-count]').textContent, '4/80');
    assert.ok(q('[data-testid=save-profile]').disabled && q('[data-testid=cancel-profile]').disabled);
    assert.equal(q('[data-testid=unsaved]'), null);
    assert.equal(q('[data-testid=avatar-input]').getAttribute('aria-label'), 'Choose a profile photo (JPEG, PNG or WebP)');
    assert.equal(q('[data-testid=avatar-input]').getAttribute('accept'), 'image/jpeg,image/png,image/webp');
  });

  await check('display name: edit, save (once, even for a double submit), success message, and the draft matches what was saved', async () => {
    await typeInto('#settings-name', '  Nick  ');
    assert.ok(!q('[data-testid=save-profile]').disabled && !q('[data-testid=cancel-profile]').disabled);
    assert.ok(q('[data-testid=unsaved]'));
    const gate = deferred();
    impl.updateProfile = (patch) => gate.promise.then(() => ({ ...auth.user, displayName: patch.displayName }));
    await act(async () => { q('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); q('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.equal(calls.updateProfile.length, 1, 'one request for two submits');
    assert.equal(q('[data-testid=save-profile]').textContent, 'Saving…');
    assert.ok(q('[data-testid=save-profile]').disabled && q('#settings-name').disabled);
    await act(async () => gate.resolve());
    await flush();
    assert.deepEqual(calls.updateProfile, [{ displayName: 'Nick' }], 'trimmed');
    assert.equal(q('[data-testid=settings-status]').textContent, 'Profile saved.');
    assert.equal(q('#settings-name').value, 'Nick');
    assert.ok(q('[data-testid=save-profile]').disabled || true);
  });

  await check('cancel restores the last saved values and clears messages', async () => {
    resetAuth(); await renderSettings();
    await typeInto('#settings-name', 'Something else');
    await click(q('[data-testid=cancel-profile]'));
    assert.equal(q('#settings-name').value, 'Alex');
    assert.equal(q('[data-testid=unsaved]'), null);
    assert.ok(q('[data-testid=save-profile]').disabled);
    assert.equal(calls.updateProfile.length, 0, 'cancel saves nothing');
  });

  await check('clearing the name saves an empty name; a name that is only spaces counts as a change when one is saved', async () => {
    await typeInto('#settings-name', '');
    await submit(); await flush();
    assert.deepEqual(calls.updateProfile, [{ displayName: '' }]);
    resetAuth({ id: 9, email: 'a@example.com', displayName: '', avatarVersion: null, reduceMotion: false });
    await renderSettings();
    await typeInto('#settings-name', '   ');
    assert.ok(q('[data-testid=save-profile]').disabled, 'spaces over an empty name change nothing');
  });

  await check('a failed save shows a clear error, keeps the draft and can be retried', async () => {
    resetAuth(); await renderSettings();
    impl.updateProfile = async () => { throw new Error('Could not save your changes. Please try again.'); };
    await typeInto('#settings-name', 'Retry me');
    await submit(); await flush();
    assert.equal(q('[role=alert]').textContent, 'Could not save your changes. Please try again.');
    assert.equal(q('#settings-name').value, 'Retry me');
    assert.ok(!q('[data-testid=save-profile]').disabled);
    impl.updateProfile = async (patch) => ({ ...auth.user, displayName: patch.displayName });
    await submit(); await flush();
    assert.equal(q('[role=alert]'), null);
    assert.equal(q('[data-testid=settings-status]').textContent, 'Profile saved.');
  });

  await check('an expired session during a save is reported (the real provider returns the user to sign-in; see Part 2)', async () => {
    resetAuth(); await renderSettings();
    impl.updateProfile = async () => { throw new Error('Your session expired. Please log in again.'); };
    await typeInto('#settings-name', 'x');
    await submit(); await flush();
    assert.equal(q('[role=alert]').textContent, 'Your session expired. Please log in again.');
  });

  await check('the browser warns before closing with unsaved changes, and only then', async () => {
    resetAuth(); await renderSettings();
    const events = [];
    const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
    window.addEventListener = (t, ...r) => { if (t === 'beforeunload') events.push('add'); return add(t, ...r); };
    window.removeEventListener = (t, ...r) => { if (t === 'beforeunload') events.push('remove'); return remove(t, ...r); };
    try {
      await typeInto('#settings-name', 'edited');
      assert.ok(events.includes('add'));
      await click(q('[data-testid=cancel-profile]'));
      assert.ok(events.includes('remove'), 'removed again once clean');
    } finally { window.addEventListener = add; window.removeEventListener = remove; }
  });

  // ═══ Settings: photo ═══════════════════════════════════════════════════════════════════════════════════════════
  await check('photo: no photo shows initials and "Add photo"; choosing one shows a preview before saving, then saves it', async () => {
    resetAuth(); await renderSettings();
    assert.equal(q('[data-testid=settings-page] [role=img]').dataset.avatar, 'initials');
    assert.ok(button(/^Add photo/));
    assert.ok(!button(/Remove photo/));
    await chooseFile(file('me.webp', 'image/webp'));
    await flush();
    assert.equal(q('[role=img] img').getAttribute('src'), 'blob:preview/a', 'preview is shown');
    assert.match(text(), /This is a preview\. It is saved when you press Save\./);
    assert.equal(calls.uploadAvatar.length, 0, 'nothing is uploaded until Save');
    assert.ok(button(/Change photo/) && button(/Discard new photo/));
    assert.ok(!q('[data-testid=save-profile]').disabled && q('[data-testid=unsaved]'));
    await submit(); await flush();
    assert.equal(calls.uploadAvatar.length, 1);
    assert.deepEqual(calls.uploadAvatar[0], { size: 10, label: 'a' });
    assert.equal(calls.updateProfile.length, 0, 'the name was unchanged, so only the photo is sent');
    assert.equal(q('[data-testid=settings-status]').textContent, 'Profile saved.');
    assert.ok(objectUrls.revoked.includes('blob:preview/a'), 'the preview URL was released');
  });

  await check('photo: choosing a different file replaces the preview and releases the old one; Discard removes it without saving', async () => {
    resetAuth(); await renderSettings({ prepareImage: undefined });
    let n = 0;
    await renderSettings({ prepareImage: async () => ({ blob: { size: 5, n: ++n }, previewUrl: `blob:preview/n${n}` }) });
    await chooseFile(file('one.png', 'image/png')); await flush();
    await chooseFile(file('two.png', 'image/png')); await flush();
    assert.equal(q('[role=img] img').getAttribute('src'), 'blob:preview/n2');
    assert.ok(objectUrls.revoked.includes('blob:preview/n1'));
    await click(button(/Discard new photo/));
    assert.equal(q('[role=img] img'), null);
    assert.ok(objectUrls.revoked.includes('blob:preview/n2'));
    assert.ok(q('[data-testid=save-profile]').disabled, 'nothing left to save');
    assert.equal(calls.uploadAvatar.length, 0);
  });

  await check('photo: with a saved photo it says "Change photo", replacing uploads the new one, and Cancel keeps the saved one', async () => {
    resetAuth({ id: 424242, email: 'a@example.com', displayName: 'Alex', avatarVersion: 5, reduceMotion: false }, { avatarUrl: 'blob:saved/1' });
    await renderSettings();
    assert.equal(q('[role=img] img').getAttribute('src'), 'blob:saved/1');
    assert.ok(button(/^Change photo/) && button(/^Remove photo/));
    await chooseFile(file('new.jpg', 'image/jpeg')); await flush();
    assert.equal(q('[role=img] img').getAttribute('src'), 'blob:preview/a');
    await click(q('[data-testid=cancel-profile]'));
    assert.equal(q('[role=img] img').getAttribute('src'), 'blob:saved/1', 'Cancel restores the saved photo');
    assert.equal(calls.uploadAvatar.length, 0);
    await chooseFile(file('new.jpg', 'image/jpeg')); await flush();
    await submit(); await flush();
    assert.equal(calls.uploadAvatar.length, 1, 'replacement uploaded');
  });

  await check('photo: removal is staged, can be undone, and removes the saved photo only on Save', async () => {
    resetAuth({ id: 424242, email: 'a@example.com', displayName: 'Alex', avatarVersion: 5, reduceMotion: false }, { avatarUrl: 'blob:saved/1' });
    await renderSettings();
    await click(button(/^Remove photo/));
    assert.equal(q('[role=img]').dataset.avatar, 'initials', 'the preview falls back to initials');
    assert.match(text(), /Your photo will be removed when you save\./);
    assert.equal(calls.removeAvatar, 0);
    await click(button(/Keep current photo/));
    assert.equal(q('[role=img] img').getAttribute('src'), 'blob:saved/1');
    assert.ok(q('[data-testid=save-profile]').disabled);
    await click(button(/^Remove photo/));
    await submit(); await flush();
    assert.equal(calls.removeAvatar, 1);
    assert.equal(q('[data-testid=settings-status]').textContent, 'Profile saved.');
  });

  await check('photo: when two photos are chosen quickly, the newest wins even if the older one finishes later', async () => {
    resetAuth();
    const gates = [];
    await renderSettings({ prepareImage: (f) => new Promise((resolve) => gates.push(() => resolve({ blob: { name: f.name }, previewUrl: `blob:slow/${f.name}` }))) });
    await chooseFile(file('first.png', 'image/png'));
    await chooseFile(file('second.png', 'image/png'));
    assert.equal(gates.length, 2);
    await act(async () => gates[1]());                // the newest finishes first
    await flush();
    assert.equal(q('[role=img] img').getAttribute('src'), 'blob:slow/second.png');
    await act(async () => gates[0]());                // the older one finishes late
    await flush();
    assert.equal(q('[role=img] img').getAttribute('src'), 'blob:slow/second.png', 'the late result did not replace the newest choice');
    assert.ok(objectUrls.revoked.includes('blob:slow/first.png'), 'its preview URL was released');
  });

  await check('photo: unusable files get a clear message and never reach the preparer', async () => {
    let prepared = 0;
    resetAuth(); await renderSettings({ prepareImage: async () => { prepared++; return { blob: {}, previewUrl: 'blob:preview/z' }; } });
    for (const [f, message] of [
      [file('notes.txt', 'text/plain'), 'Choose a JPEG, PNG or WebP photo.'], [file('logo.svg', 'image/svg+xml'), 'Choose a JPEG, PNG or WebP photo.'],
      [file('anim.gif', 'image/gif'), 'Choose a JPEG, PNG or WebP photo.'], [file('x.exe', 'application/octet-stream'), 'Choose a JPEG, PNG or WebP photo.'],
      [file('huge.jpg', 'image/jpeg', 11 * 1024 * 1024), 'That photo is too large. Choose one under 10 MB.'], [file('empty.png', 'image/png', 0), 'That file is empty.']
    ]) {
      await chooseFile(f); await flush();
      assert.equal(q('[role=alert]').textContent, message, f.name);
    }
    assert.equal(prepared, 0);
    assert.ok(q('[data-testid=save-profile]').disabled, 'nothing staged');
  });

  await check('photo: a preparer failure is shown and nothing is staged; a later good file works and clears the message', async () => {
    resetAuth(); let fail = true;
    await renderSettings({ prepareImage: async () => { if (fail) throw new Error('We could not read that image. Try a different photo.'); return { blob: {}, previewUrl: 'blob:preview/ok' }; } });
    await chooseFile(file('broken.png', 'image/png')); await flush();
    assert.equal(q('[role=alert]').textContent, 'We could not read that image. Try a different photo.');
    assert.ok(q('[data-testid=save-profile]').disabled);
    fail = false;
    await chooseFile(file('good.png', 'image/png')); await flush();
    assert.equal(q('[role=alert]'), null);
    assert.equal(q('[role=img] img').getAttribute('src'), 'blob:preview/ok');
  });

  await check('photo upload failure keeps the preview and shows the server\'s message; photo saved but name failed is reported precisely', async () => {
    resetAuth(); await renderSettings();
    impl.uploadAvatar = async () => { throw new Error('This image file appears to be damaged. Choose a different photo.'); };
    await chooseFile(file('x.png', 'image/png')); await flush();
    await submit(); await flush();
    assert.equal(q('[role=alert]').textContent, 'This image file appears to be damaged. Choose a different photo.');
    assert.equal(q('[role=img] img').getAttribute('src'), 'blob:preview/a', 'the preview stays so the user can retry or discard');
    impl.uploadAvatar = async () => ({ ...auth.user, avatarVersion: 7 });
    impl.updateProfile = async () => { throw new Error('Could not save your changes. Please try again.'); };
    await typeInto('#settings-name', 'New name');
    await submit(); await flush();
    assert.match(q('[role=alert]').textContent, /^Photo saved\. But your name was not saved\. Could not save your changes/);
    assert.equal(q('#settings-name').value, 'New name', 'the name draft is kept');
    assert.equal(q('[role=img] img'), null, 'the staged photo was saved, so no longer staged');
  });

  await check('another account never inherits a draft: the profile form resets when the signed-in user changes', async () => {
    resetAuth({ id: 1, email: 'one@example.com', displayName: 'One', avatarVersion: null, reduceMotion: false });
    await renderSettings();
    await typeInto('#settings-name', 'Unsaved draft for one');
    await chooseFile(file('p.png', 'image/png')); await flush();
    resetAuth({ id: 2, email: 'two@example.com', displayName: 'Two', avatarVersion: null, reduceMotion: false });
    await mount(React.createElement(Settings, { prepareImage: fakePrepare('a') }));   // the SAME page re-rendered for another user
    assert.equal(q('#settings-name').value, 'Two');
    assert.equal(q('[role=img] img'), null);
    assert.equal(q('[data-testid=account-email]').textContent, 'two@example.com');
    assert.ok(!text().includes('Unsaved draft') && !text().includes('one@example.com'));
  });

  // ═══ Settings: account, display ═══════════════════════════════════════════════════════════════════════════════
  await check('account: the password-change entry point emails a reset link (existing flow), with accurate wording and clear results', async () => {
    resetAuth(); await renderSettings();
    assert.match(text(), /Get a password reset link by email/i);
    assert.equal(qa('input[type=password]').length, 0, 'no password fields are offered');
    assert.ok(!/current password/i.test(text()));
    const gate = deferred();
    impl.recovery = () => gate.promise;
    await act(async () => { q('[data-testid=send-reset]').click(); q('[data-testid=send-reset]').click(); });
    assert.equal(calls.recovery.length, 1, 'one request for a double click');
    assert.deepEqual(calls.recovery[0], ['forgot-password', { email: 'secret.person@example.com' }]);
    assert.ok(q('[data-testid=send-reset]').disabled);
    await act(async () => gate.resolve('If an account exists, a reset link will be sent.'));
    await flush();
    assert.equal(q('[data-testid=settings-status]').textContent, 'If an account exists, a reset link will be sent.');
    impl.recovery = async () => { throw new Error('Password recovery is temporarily unavailable. Please try again later.'); };
    await click(q('[data-testid=send-reset]')); await flush();
    assert.match(q('[role=alert]').textContent, /temporarily unavailable/);
  });

  await check('account: Log out signs out', async () => {
    resetAuth(); await renderSettings();
    await click(q('[data-testid=settings-logout]'));
    assert.equal(calls.logout, 1);
  });

  await check('display: the switch reflects the saved preference, saves at once, and reverts with a message if saving fails', async () => {
    resetAuth(); await renderSettings();
    const sw = () => q('[data-testid=reduce-motion]');
    assert.equal(sw().getAttribute('role'), 'switch');
    assert.equal(sw().getAttribute('aria-checked'), 'false');
    assert.equal(sw().getAttribute('aria-labelledby'), 'reduce-motion-label');
    assert.equal(document.getElementById('reduce-motion-label').textContent, 'Reduce dashboard animations');
    const gate = deferred();
    impl.updateProfile = (patch) => gate.promise.then(() => ({ ...auth.user, ...patch }));
    await act(async () => { sw().click(); sw().click(); });
    assert.deepEqual(calls.updateProfile, [{ reduceMotion: true }], 'one save for a double click, and only this field');
    assert.equal(sw().getAttribute('aria-checked'), 'true', 'shown at once');
    await act(async () => gate.resolve());
    await flush();
    impl.updateProfile = async () => { throw new Error('Could not save your changes. Please try again.'); };
    await click(sw()); await flush();
    assert.equal(sw().getAttribute('aria-checked'), 'false', 'reverted to the saved value');
    assert.equal(q('[role=alert]').textContent, 'Could not save your changes. Please try again.');
    resetAuth({ id: 1, email: 'a@example.com', displayName: 'A', avatarVersion: null, reduceMotion: true });
    await renderSettings();
    assert.equal(sw().getAttribute('aria-checked'), 'true', 'a saved preference shows on');
    await click(sw());
  });

  await check('display: when the device already reduces motion, Settings says so', async () => {
    resetAuth(); await renderSettings();
    assert.equal(q('[data-testid=system-reduces]'), null);
    await setSystemReduces(true);
    assert.match(q('[data-testid=system-reduces]').textContent, /Reduced motion is enabled/);
    await setSystemReduces(false);
  });

  await check('everything in Settings is keyboard operable: real buttons and inputs only, named controls, no positive tabindex', async () => {
    resetAuth(); await renderSettings();
    for (const el of qa('button, input, [role=switch]')) {
      const labelledBy = el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent;
      const name = el.getAttribute('aria-label') || labelledBy || el.textContent.trim() || (el.id && q(`label[for=${el.id}]`)?.textContent);
      assert.ok(name && name.length > 0, `unnamed control: ${el.outerHTML.slice(0, 80)}`);
      assert.ok(!(el.tabIndex > 0), 'no positive tabindex');
    }
    assert.ok(qa('section[aria-labelledby]').length === 4);
  });

  await check('no profile or photo content reaches the console during any of this', async () => {
    const lines = [];
    const real = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of Object.keys(real)) console[k] = (...a) => lines.push(a.join(' '));
    try {
      resetAuth(); await renderSettings();
      await typeInto('#settings-name', 'Private Person'); await submit(); await flush();
      await chooseFile(file('x.png', 'image/png')); await flush(); await submit(); await flush();
    } finally { Object.assign(console, real); }
    assert.equal(lines.join('\n').match(/Private Person|secret\.person|blob:/), null);
  });

  await remount();
  await vite.close();

  // ═══ Part 2: the real AuthProvider with a stubbed fetch ═════════════════════════════════════════════════════════════
  delete globalThis.__auth; delete globalThis.__recovery;
  const vite2 = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  const { AuthProvider, useAuth } = await vite2.ssrLoadModule('/src/context/AuthContext.jsx');
  const { default: RealSettings } = await vite2.ssrLoadModule('/src/pages/Settings.jsx');
  const { default: RealGreeting } = await vite2.ssrLoadModule('/src/components/DashboardGreeting.jsx');
  const { default: RealNav } = await vite2.ssrLoadModule('/src/components/TopNav.jsx');

  const requests = [];
  const accounts = {
    a: { id: 1, email: 'a@example.com', displayName: 'Alex', reduceMotion: false, avatarVersion: 100 },
    b: { id: 2, email: 'b@example.com', displayName: 'Blake', reduceMotion: true, avatarVersion: null }
  };
  let session = 'a', photoBytes = { a: 'PHOTO-A', b: null }, failNext = null, avatarDelay = null;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url).replace('http://localhost:5000/api', '');
    requests.push({ url: u, init });
    if (failNext) { const f = failNext; failNext = null; return f(); }
    if (u === '/auth/verify') return session ? json(200, { user: accounts[session] }) : json(401, { error: 'Invalid token' });
    if (u === '/auth/login') { const body = JSON.parse(init.body); session = body.email.startsWith('b') ? 'b' : 'a'; return json(200, { user: accounts[session] }); }
    if (u === '/auth/logout') { session = null; return json(200, {}); }
    if (u === '/auth/avatar' && (!init.method || init.method === 'GET')) {
      if (avatarDelay) await avatarDelay;
      const bytes = photoBytes[session];
      return bytes ? new Response(new Blob([bytes], { type: 'image/webp' }), { status: 200, headers: { 'content-type': 'image/webp' } }) : json(404, { error: 'No photo' });
    }
    if (u === '/auth/profile' && init.method === 'PATCH') { Object.assign(accounts[session], JSON.parse(init.body)); return json(200, { user: accounts[session] }); }
    if (u === '/auth/avatar' && init.method === 'PUT') { accounts[session].avatarVersion = (accounts[session].avatarVersion ?? 0) + 1; photoBytes[session] = 'PHOTO-NEW'; return json(200, { user: accounts[session] }); }
    if (u === '/auth/avatar' && init.method === 'DELETE') { accounts[session].avatarVersion = null; photoBytes[session] = null; return json(200, { user: accounts[session] }); }
    return json(404, { error: 'unexpected ' + u });
  };
  let ctx;
  const Probe = () => { ctx = useAuth(); return null; };
  const realNav = () => React.createElement(RealNav, { currentView: 'dashboard', setCurrentView: () => {} });
  const mountReal = async (...children) => { await act(async () => root.render(React.createElement(AuthProvider, null, React.createElement(Probe), realNav(), ...children))); await flush(5); };
  // The failure is caught INSIDE act() so React still applies the state updates the failing call made (such as ending the session).
  const rejectsInAct = async (fn, pattern) => {
    let caught;
    await act(async () => { try { await fn(); } catch (e) { caught = e; } });
    assert.ok(caught, 'expected the call to be rejected');
    assert.match(caught.message, pattern);
  };
  const reqs = (url, method) => requests.filter((r) => r.url === url && (r.init.method ?? 'GET') === method);

  await check('real provider: the session restores the profile, the photo is fetched with the cookie and shown, and a reload shows the same name', async () => {
    requests.length = 0;
    await mountReal(React.createElement(RealGreeting));
    assert.equal(ctx.user.displayName, 'Alex');
    assert.equal(document.querySelector('[data-testid=greeting]').textContent, 'Welcome back, Alex');
    const get = reqs('/auth/avatar', 'GET');
    assert.equal(get.length, 1);
    assert.equal(get[0].init.credentials, 'include');
    assert.equal(get[0].init.cache, 'no-store');
    assert.match(document.querySelector('[data-avatar] img').getAttribute('src'), /^blob:/);
    await act(async () => root.unmount()); root = createRoot(container);
    await mountReal(React.createElement(RealGreeting));
    assert.equal(document.querySelector('[data-testid=greeting]').textContent, 'Welcome back, Alex', 'persisted across a reload');
  });

  await check('real provider: updateProfile sends only the changed fields with the session cookie and updates the user', async () => {
    requests.length = 0;
    const saved = await act(async () => ctx.updateProfile({ displayName: 'Alexa' }));
    const patch = reqs('/auth/profile', 'PATCH')[0];
    assert.equal(patch.init.credentials, 'include');
    assert.equal(patch.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(patch.init.body), { displayName: 'Alexa' });
    assert.equal(ctx.user.displayName, 'Alexa');
    assert.equal(ctx.user.email, 'a@example.com');
    await act(async () => ctx.updateProfile({ reduceMotion: true }));
    assert.deepEqual(JSON.parse(reqs('/auth/profile', 'PATCH')[1].init.body), { reduceMotion: true });
    assert.equal(ctx.user.reduceMotion, true);
    assert.equal(ctx.user.displayName, 'Alexa');
    await act(async () => ctx.updateProfile({ reduceMotion: false }));
    void saved;
  });

  await check('real provider: uploadAvatar sends a multipart "avatar" file, the new version is refetched; removeAvatar clears the photo', async () => {
    requests.length = 0;
    await act(async () => { await ctx.uploadAvatar(new Blob(['x'], { type: 'image/webp' })); });
    await flush(5);
    const put = reqs('/auth/avatar', 'PUT')[0];
    assert.equal(put.init.credentials, 'include');
    assert.ok(put.init.body instanceof FormData && put.init.body.get('avatar') instanceof Blob);
    assert.ok(!Object.keys(put.init.headers ?? {}).some((k) => k.toLowerCase() === 'content-type'), 'no manual Content-Type: the browser sets the multipart boundary');
    assert.match(put.init.headers?.['X-FinSphere-User'] ?? '', /^[0-9]+$/, 'the upload names the account the tab is showing');
    assert.ok(reqs('/auth/avatar', 'GET').length >= 1, 'the new photo is fetched');
    assert.ok(ctx.avatarUrl && ctx.avatarUrl.startsWith('blob:'));
    const before = ctx.avatarUrl;
    await act(async () => { await ctx.removeAvatar(); });
    await flush(5);
    assert.equal(reqs('/auth/avatar', 'DELETE').length, 1);
    assert.equal(ctx.avatarUrl, null);
    assert.equal(ctx.user.avatarVersion, null);
    assert.ok(objectUrls.revoked.includes(before), 'the old photo URL was released');
  });

  await check('real provider: a 401 ends the session and the user is told; network and non-JSON failures give clear messages', async () => {
    await rejectsInAct(async () => { failNext = () => json(401, { error: 'Invalid or expired token' }); await ctx.updateProfile({ displayName: 'x' }); }, /Your session expired\. Please log in again\./);
    assert.equal(ctx.status, 'unauthenticated');
    assert.equal(ctx.user, null);
    session = 'a';
    await act(async () => { await ctx.login('a@example.com', 'pw'); });
    assert.equal(ctx.status, 'authenticated');
    await rejectsInAct(async () => { failNext = () => { throw new TypeError('Failed to fetch'); }; await ctx.updateProfile({ displayName: 'x' }); }, /Could not reach the server/);
    await rejectsInAct(async () => { failNext = () => new Response('<html>Bad gateway</html>', { status: 502 }); await ctx.uploadAvatar(new Blob(['x'])); }, /Could not save your changes\. Please try again\./);
    await rejectsInAct(async () => { failNext = () => json(400, { error: 'This image file appears to be damaged. Choose a different photo.' }); await ctx.uploadAvatar(new Blob(['x'])); }, /appears to be damaged/);
    assert.equal(ctx.status, 'authenticated', 'ordinary failures do not sign the user out');
  });

  await check('real provider: Settings under a 401 sends the user back to sign-in', async () => {
    await act(async () => root.unmount()); root = createRoot(container);
    session = 'a';
    await mountReal(React.createElement(RealSettings, { prepareImage: fakePrepare('r') }));
    await typeInto('#settings-name', 'Changed');
    failNext = () => json(401, { error: 'Invalid or expired token' });
    await submit(); await flush(5);
    assert.equal(ctx.status, 'unauthenticated');
  });

  await check('account switching: no stale name or photo from the previous user, ever, and no photo for a user without one', async () => {
    await act(async () => root.unmount()); root = createRoot(container);
    session = 'a'; photoBytes = { a: 'PHOTO-A', b: null }; accounts.a.avatarVersion = 100;
    let release;
    await mountReal(React.createElement(RealGreeting));
    const aUrl = ctx.avatarUrl;
    assert.ok(aUrl);
    await act(async () => { await ctx.logout(); });
    assert.equal(ctx.status, 'unauthenticated');
    assert.equal(ctx.avatarUrl, null, 'no photo after logout');
    assert.ok(objectUrls.revoked.includes(aUrl), 'the previous account\'s photo URL was released');
    avatarDelay = new Promise((r) => { release = r; });
    await act(async () => { await ctx.login('b@example.com', 'pw'); });
    assert.equal(ctx.user.displayName, 'Blake');
    assert.equal(ctx.avatarUrl, null, 'B has no photo and never sees A\'s');
    await act(async () => root.render(React.createElement(AuthProvider, null, React.createElement(Probe), realNav(), React.createElement(RealGreeting))));
    assert.equal(document.querySelector('[data-testid=greeting]').textContent, 'Welcome back, Blake');
    assert.equal(document.querySelector('[data-avatar]').dataset.avatar, 'initials');
    release(); avatarDelay = null;
    await flush(5);
    // slow photo fetch for the OLD account must not land on the new one
    await act(async () => { await ctx.logout(); });
    session = 'a'; accounts.a.avatarVersion = 100;
    await act(async () => { await ctx.login('a@example.com', 'pw'); });
    await flush(5);
    assert.ok(ctx.avatarUrl, 'A\'s own photo is back for A');
    assert.equal(ctx.user.displayName, 'Alexa');
  });

  await check('no profile or photo content is logged by the real provider', async () => {
    const lines = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    for (const k of Object.keys(real)) console[k] = (...a) => lines.push(a.join(' '));
    try {
      await act(async () => { await ctx.updateProfile({ displayName: 'Logged?' }); });
      await act(async () => { await ctx.uploadAvatar(new Blob(['PHOTO'])); }); await flush(5);
    } finally { Object.assign(console, real); }
    assert.equal(lines.join('\n').match(/Logged\?|PHOTO|a@example\.com/), null);
  });

  globalThis.fetch = realFetch;
  await act(async () => root.unmount());
  await vite2.close();
  console.log(`Settings, profile photo and greeting UI: ${pass} checks passed`);
} finally {
  globalThis.setInterval = nativeSetInterval; globalThis.clearInterval = nativeClearInterval;
  dom.window.close();
  delete globalThis.__auth; delete globalThis.__recovery;
}
