// Financial Copilot UI regression test (Issue #69).   Run: npm run test:copilot
//
// Renders the REAL AIAvatar, FinanceProvider and Goals page in jsdom and drives them like a user: typed messages,
// hint chips and simulated speech recognition. Only the parts a test environment cannot provide are replaced:
//   - AuthContext (no login), the 3D canvas (@react-three/fiber, @react-three/drei, AnimatedAvatar),
//   - fetch (a stub backend that answers /api/chat with "ANSWER(<question>)" and records each request body),
//   - window.webkitSpeechRecognition (the test delivers transcripts through the same onresult callback),
//   - scrollIntoView / scrollTo (recorded instead of scrolled).
// The components are loaded with Vite (already a dev dependency) in SSR mode, so the production JSX is used as is.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── DOM globals (must exist before React DOM loads) ─────────────────────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (!(k in globalThis)) { try { Object.defineProperty(globalThis, k, { get: () => dom.window[k], configurable: true }); } catch { /* not copyable */ } }
}
for (const k of ['window', 'document', 'navigator']) {
  try { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); } catch { /* not copyable */ }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let scrolledTo = [];
window.scrollTo = () => {};
window.scrollBy = () => {};
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { scrolledTo.push(this.getAttribute('data-avatar-target')); };

// Simulated speech recognition: say() delivers a transcript exactly as the browser's onresult would.
let lastRecognition = null;
window.webkitSpeechRecognition = class {
  constructor() { lastRecognition = this; }
  start() { this.onstart?.(); }
  stop() { this.onend?.(); }
};
const say = (transcript) => lastRecognition.onresult({ results: [[{ transcript }]] });

// ── Stub backend ──────────────────────────────────────────────────────────────────────────────────────────────────
const chatBodies = [];
let chatOrder = [];
let viewChanges = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), method = opts.method ?? 'GET';
  const json = (status, b) => ({ status, ok: status >= 200 && status < 300, json: async () => b });
  if (/\/chat$/.test(u) && method === 'POST') {
    const body = JSON.parse(opts.body);
    chatBodies.push(body);
    chatOrder.push('chat-request');
    await new Promise((r) => setTimeout(r, 40));
    chatOrder.push('chat-reply');
    return json(200, { reply: `ANSWER(${body.messages.at(-1).content})` });
  }
  if (/\/budgets\?month=/.test(u)) return json(200, []);
  if (/\/(transactions|goals|liabilities)$/.test(u) && method === 'GET') return json(200, []);
  if (/\/emergency-fund$/.test(u)) return json(200, { configured: false, currentAmount: null, targetAmount: null, createdAt: null, updatedAt: null });
  return json(200, []);
};

// ── Load the real components through Vite ─────────────────────────────────────────────────────────────────────────
const { createServer } = await import('vite');
const STUBS = {
  '@react-three/fiber': 'export const Canvas = () => null;',
  '@react-three/drei': 'export const Environment = () => null, ContactShadows = () => null, Html = () => null; export const useProgress = () => ({ progress: 100 });',
  AnimatedAvatar: 'export const AnimatedAvatar = () => null;',
  AuthContext: 'export const useAuth = () => ({ invalidateSession: () => {} });',
};
const HARNESS = `
import { useState, createElement as h } from 'react';
import { FinanceProvider } from '/src/context/FinanceContext.jsx';
import AIAvatar from '/src/components/AIAvatar.jsx';
import Goals from '/src/pages/Goals.jsx';
export function App({ onView }) {
  const [view, setView] = useState('dashboard');
  globalThis.__copilotView = view;
  return h(FinanceProvider, { currentView: view, setCurrentView: (v) => { onView(v); setView(v); } },
    h('div', { id: 'page' }, view === 'goals' ? h(Goals) : h('div', { 'data-page': view }, view)),
    h(AIAvatar));
}`;
const vite = await createServer({
  root: REPO,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  esbuild: { jsx: 'automatic' },
  // Not externalized, so the stub plugin below (not the real WebGL libraries) answers these imports.
  ssr: { noExternal: ['@react-three/fiber', '@react-three/drei'] },
  plugins: [{
    name: 'copilot-test-stubs',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'virtual:copilot-harness') return '\0copilot-harness';
      if (id in STUBS) return `\0stub:${id}`;
      const base = id.split('/').pop();
      if ((base === 'AnimatedAvatar' || base === 'AuthContext') && id.startsWith('.')) return `\0stub:${base}`;
      return null;
    },
    load(id) {
      if (id === '\0copilot-harness') return HARNESS;
      if (id.startsWith('\0stub:')) return STUBS[id.slice('\0stub:'.length)];
      return null;
    },
  }],
});

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) pass++; else { fail++; console.log('FAIL:', name, extra); } };

try {
  const { App } = await vite.ssrLoadModule('virtual:copilot-harness');
  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  const { act } = React;

  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(React.createElement(App, { onView: (v) => viewChanges.push(v) })); await tick(50); });

  const transcript = () => [...document.querySelectorAll('.ai-chat-body .chat-message')]
    .map((m) => `${m.classList.contains('user') ? 'U' : 'B'}: ${m.textContent.trim()}`);
  const input = () => document.querySelector('.ai-chat-input input');
  async function type(text, wait = 150) {
    await act(async () => {
      const el = input();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, text);
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      document.querySelector('.ai-chat-input').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await tick(wait);
    });
  }
  const startVoice = () => act(async () => { document.querySelector('.voice-btn').click(); await tick(10); });
  const reset = () => { viewChanges = []; scrolledTo = []; chatOrder = []; };

  // Welcome text and hint chips
  ok(transcript()[0].includes('How much did I spend this month?') && !/credit score/i.test(transcript()[0]), 'welcome text is grounded, no credit-score example', transcript()[0]);
  const hints = [...document.querySelectorAll('.hint-chip')].map((x) => x.textContent);
  ok(JSON.stringify(hints) === JSON.stringify(['How am I doing this month?', 'How much did I spend?', 'How is my budget?', 'Open transactions']), 'hint chips', hints.join('|'));

  // 1. Question -> answer, no navigation
  reset();
  await type('How much did I spend this month?');
  ok(viewChanges.length === 0, 'Q: no navigation', viewChanges.join(','));
  ok(chatBodies.length === 1 && chatBodies[0].messages.at(-1).content === 'How much did I spend this month?', 'Q: sent to /api/chat');
  ok(transcript().at(-1) === 'B: ANSWER(How much did I spend this month?)', 'Q: answer shown', transcript().at(-1));
  ok(!chatBodies[0].messages.some((m) => m.content.includes("I'm your FinSphere assistant")), 'welcome text is not sent as history');

  // 2. "remaining" contains "main": must not open the Dashboard
  reset();
  await type('What is my remaining budget?');
  ok(viewChanges.length === 0 && transcript().at(-1).startsWith('B: ANSWER('), '"remaining budget": answered, no Dashboard redirect', viewChanges.join(','));

  // 3. "high" contains "hi": no greeting, no Liabilities redirect
  reset();
  await type('Why is my debt high?');
  ok(viewChanges.length === 0 && transcript().at(-1) === 'B: ANSWER(Why is my debt high?)', '"debt high": answered, no Liabilities redirect');

  // 4. Explicit navigation -> navigates, recorded in the transcript, no chat request
  reset();
  const before = chatBodies.length;
  await type('Open transactions');
  ok(JSON.stringify(viewChanges) === '["transactions"]', 'ACTION: navigates to Transactions', viewChanges.join(','));
  ok(chatBodies.length === before, 'ACTION: no chat request');
  ok(transcript().slice(-2).join(' | ') === 'U: Open transactions | B: Opening Transactions.', 'ACTION: recorded in transcript', transcript().slice(-2).join(' | '));

  // 5. Question + action: answer first, then the Budgets section of Goals
  reset();
  await type('How is my budget? Open it.', 250);
  ok(chatBodies.at(-1).messages.at(-1).content === 'How is my budget?', 'Q+A: only the question is sent', chatBodies.at(-1).messages.at(-1).content);
  ok(JSON.stringify(viewChanges) === '["goals"]', 'Q+A: navigated to Goals after answering', viewChanges.join(','));
  ok(scrolledTo.includes('budgets'), 'Q+A: scrolled to the budgets section', scrolledTo.join(','));
  const t5 = transcript().slice(-3);
  ok(t5[0] === 'U: How is my budget? Open it.' && t5[1] === 'B: ANSWER(How is my budget?)' && t5[2] === 'B: Opening Budgets.', 'Q+A: answer appears before the navigation note', t5.join(' | '));
  ok(chatOrder.join(',') === 'chat-request,chat-reply', 'Q+A: chat completed before navigation');

  // 6. History: follow-ups carry earlier turns; bounded to 12 user/assistant turns, content within the cap
  reset();
  await type('Why?');
  const hist = chatBodies.at(-1).messages;
  ok(hist.length <= 12 && hist.every((m) => ['user', 'assistant'].includes(m.role) && Object.keys(m).length === 2 && m.content.length <= 2000), 'history bounded and clean', JSON.stringify(hist).slice(0, 200));
  ok(hist.some((m) => m.role === 'user' && m.content === 'How is my budget? Open it.') && hist.some((m) => m.content === 'Opening Budgets.'), 'history includes the previous question and the navigation note');
  for (let i = 0; i < 8; i++) await type(`question ${i}?`, 60);
  ok(chatBodies.at(-1).messages.length === 12 && chatBodies.at(-1).messages.at(-1).content === 'question 7?', 'history capped at 12 turns', String(chatBodies.at(-1).messages.length));

  // 7. Pronoun resolved from the previous user topic
  reset();
  await type('How is my emergency fund?');
  await type('Take me there', 250);
  ok(globalThis.__copilotView === 'goals' && scrolledTo.includes('emergency-fund'), 'pronoun "take me there" uses previous topic (emergency fund)', scrolledTo.join(','));

  // 8. Unresolvable pronoun goes to the assistant, no navigation
  reset();
  await type('Show me.');
  ok(viewChanges.length === 0 && chatBodies.at(-1).messages.at(-1).content === 'Show me.', 'ambiguous "Show me." -> assistant, no guess');

  // 9. Voice uses the same pipeline (no separate command path)
  reset();
  await startVoice();
  const n0 = chatBodies.length;
  await act(async () => { say('how much did I spend this month'); await tick(150); });
  ok(chatBodies.length === n0 + 1 && viewChanges.length === 0, 'VOICE question: answered, no navigation');
  await startVoice();
  await act(async () => { say('how much debt do I have take me there'); await tick(250); });
  ok(chatBodies.at(-1).messages.at(-1).content === 'how much debt do I have' && viewChanges.at(-1) === 'liabilities', 'VOICE question+action: answered then Liabilities', viewChanges.join(','));
  await startVoice();
  const n1 = chatBodies.length;
  await act(async () => { say('open goals'); await tick(100); });
  ok(chatBodies.length === n1 && viewChanges.at(-1) === 'goals', 'VOICE action: navigates without a chat call');

  // 10. A hint chip goes through the same pipeline
  reset();
  await act(async () => { [...document.querySelectorAll('.hint-chip')].at(-1).click(); await tick(100); });
  ok(viewChanges.at(-1) === 'transactions', 'hint "Open transactions" navigates');

  await act(async () => { root.unmount(); });
} finally {
  await vite.close();
}

console.log(`copilot UI tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
