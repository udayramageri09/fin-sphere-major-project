// Financial Copilot UI regression test (Issues #69, #71, #73 and #75).   Run: npm run test:copilot
//
// Renders the REAL AIAvatar, FinanceProvider and Goals page in jsdom and drives them like a user: typed messages,
// hint chips and simulated speech recognition. Only the parts a test environment cannot provide are replaced:
//   - AuthContext (no login),
//   - fetch (a stub backend that answers /api/chat with "ANSWER(<question>)" and records each request body),
//   - window.webkitSpeechRecognition (the test delivers transcripts through the same onresult callback),
//   - window.speechSynthesis / SpeechSynthesisUtterance (records what would be spoken; no audio),
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
const recognitions = [];
window.webkitSpeechRecognition = class {
  constructor() { lastRecognition = this; recognitions.push(this); this.aborted = false; }
  start() { this.onstart?.(); }
  stop() { this.onend?.(); }
  abort() { this.aborted = true; this.onend?.(); }
};
const say = (transcript, confidence) => lastRecognition.onresult({ results: [[{ transcript, confidence }]] });
const recognitionError = (error) => lastRecognition.onerror({ error });

// Simulated speech output: records what would be spoken; the test ends an utterance with synth.finish().
const synth = {
  spoken: [], current: null, cancels: 0,
  speak(u) { this.spoken.push(u.text); this.current = u; },
  cancel() { this.cancels += 1; this.current = null; },
  finish() { const u = this.current; this.current = null; u?.onend?.(); },
};
window.speechSynthesis = synth;
window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };

// ── Stub backend ──────────────────────────────────────────────────────────────────────────────────────────────────
const chatBodies = [];
let chatOrder = [];
let chatMode = 'ok';          // 'ok' | 'fail' (HTTP 500)
let chatGate = null;          // when set, replies wait until the test resolves it
let viewChanges = [];
// Scripted server behaviour for confirmed actions (Issue #73). The real rules are tested in server/tests/actions.test.mjs;
// here the server is a stub so the CLIENT's handling of proposals, confirmation and cancellation can be checked.
const scriptedChat = [];        // next /api/chat responses, consumed in order: { reply, action? }
const proposals = {};           // proposalId -> the stored result a confirmation returns
let confirmCalls = [];          // { id, body } for every confirm request
let cancelCalls = [];
let confirmMode = 'ok';         // 'ok' | 'exceeds' | 'expired' | 'network'
let manualTxMode = 'ok';        // 'ok' | 'invalid'
let proposalSeq = 0;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
function propose(kind, summary, display, result, { ttlMs = 180000 } = {}) {
  proposalSeq += 1;
  const id = `prop-${proposalSeq}`;
  proposals[id] = result;
  scriptedChat.push({ reply: summary, action: { proposalId: id, kind, status: 'pending', summary, display, expiresAt: iso(ttlMs) } });
  return id;
}
const lunchDisplay = (amount = '₹450') => [{ label: 'Type', value: 'Expense' }, { label: 'Amount', value: amount }, { label: 'Title', value: 'Lunch' }, { label: 'Date', value: '2026-10-08 (today)' }, { label: 'Category', value: 'General' }, { label: 'Classification', value: 'Unclassified' }];
const lunchTx = (id, amount = 450) => ({ kind: 'create_transaction', message: `Done. I added the ₹${amount} Lunch expense.`, transaction: { id, userId: 1, title: 'Lunch', amount: -amount, date: '2026-10-08', type: 'expense', category: 'General', classification: 'unknown' } });
const hdfcLiab = (outstanding) => ({ id: 'l1', userId: 1, name: 'HDFC Car Loan', type: 'vehicle_loan', outstandingAmount: outstanding, interestRate: 9.5, monthlyPayment: 8000, createdAt: '2026-09-01T00:00:00.000Z' });
const budgetRow = (month, category, amount) => ({ id: `bud-${month}-${category}`, userId: 1, month, category, categoryKey: category.toLowerCase(), amount, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
let budgetGets = [];
const goaGoal = (current) => ({ id: 'g1', userId: 1, title: 'Goa Trip', targetAmount: 50000, currentAmount: current, targetDate: '2026-12-01', createdAt: '2026-09-01T00:00:00.000Z' });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), method = opts.method ?? 'GET';
  const json = (status, b) => ({ status, ok: status >= 200 && status < 300, json: async () => b });
  let am;
  if ((am = /\/assistant\/actions\/([^/]+)\/(confirm|cancel)$/.exec(u)) && method === 'POST') {
    const id = decodeURIComponent(am[1]);
    if (am[2] === 'cancel') { cancelCalls.push({ id, body: opts.body }); return json(200, { status: 'cancelled', message: 'Cancelled. Nothing was saved.' }); }
    confirmCalls.push({ id, body: opts.body });
    if (confirmMode === 'network') throw new TypeError('fetch failed');
    if (confirmMode === 'exceeds') return json(400, { status: 'failed', error: 'Contribution would exceed the goal target (₹4,000 remaining)' });
    if (confirmMode === 'expired') return json(410, { status: 'expired', error: 'This request expired. Nothing was saved.' });
    return proposals[id] ? json(200, { status: 'executed', ...proposals[id] }) : json(404, { error: 'Action not found' });
  }
  if (/\/transactions$/.test(u) && method === 'POST') {
    if (manualTxMode === 'invalid') return json(400, { error: 'Title is required' });
    return json(201, { id: 'manual-1', ...JSON.parse(opts.body) });
  }
  if (/\/chat$/.test(u) && method === 'POST') {
    const body = JSON.parse(opts.body);
    chatBodies.push(body);
    chatOrder.push('chat-request');
    if (chatGate) await chatGate.promise;
    await new Promise((r) => setTimeout(r, 40));
    if (chatMode === 'fail') return json(500, { error: 'Could not answer right now' });
    chatOrder.push('chat-reply');
    if (scriptedChat.length) return json(200, scriptedChat.shift());
    return json(200, { reply: `ANSWER(${body.messages.at(-1).content})` });
  }
  if (/\/budgets\?month=/.test(u)) { budgetGets.push(decodeURIComponent(u.split('month=')[1])); return json(200, []); }
  if (/\/goals$/.test(u) && method === 'GET') return json(200, [goaGoal(20000)]);
  if (/\/liabilities$/.test(u) && method === 'GET') return json(200, [hdfcLiab(120000)]);
  if (/\/transactions$/.test(u) && method === 'GET') return json(200, []);
  if (/\/emergency-fund$/.test(u)) return json(200, { configured: false, currentAmount: null, targetAmount: null, createdAt: null, updatedAt: null });
  return json(200, []);
};

// ── Load the real components through Vite ─────────────────────────────────────────────────────────────────────────
const { createServer } = await import('vite');
const STUBS = {
  AuthContext: 'export const useAuth = () => ({ invalidateSession: () => {} });',
};
const HARNESS = `
import { useState, createElement as h } from 'react';
import { FinanceProvider, useFinance } from '/src/context/FinanceContext.jsx';
import AIAvatar from '/src/components/AIAvatar.jsx';
import Goals from '/src/pages/Goals.jsx';
export function Probe() {
  const f = useFinance();
  globalThis.__finance = f;
  return h('div', { id: 'probe', 'data-tx': String(f.transactions.length), 'data-tx-first': f.transactions[0]?.title ?? '', 'data-goal': String(f.goals.find((g) => g.id === 'g1')?.currentAmount ?? ''), 'data-liab': String(f.liabilities.find((l) => l.id === 'l1')?.outstandingAmount ?? '') });
}
export function App({ onView }) {
  const [view, setView] = useState('dashboard');
  globalThis.__copilotView = view;
  return h(FinanceProvider, { currentView: view, setCurrentView: (v) => { onView(v); setView(v); } },
    h('div', { id: 'page' }, view === 'goals' ? h(Goals) : h('div', { 'data-page': view }, view)),
    h(Probe),
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
  plugins: [{
    name: 'copilot-test-stubs',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'virtual:copilot-harness') return '\0copilot-harness';
      if (id.startsWith('.') && id.split('/').pop() === 'AuthContext') return '\0stub:AuthContext';
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
  // Waits (up to ms) for an asynchronous outcome instead of guessing a fixed sleep: under load a scroll that polls for its
  // target can take longer than a hard-coded delay.
  const waitFor = async (predicate, ms = 3000) => {
    const start = Date.now();
    while (!predicate() && Date.now() - start < ms) await act(async () => { await tick(25); });
    return predicate();
  };

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
  ok(await waitFor(() => scrolledTo.includes('budgets')), 'Q+A: scrolled to the budgets section', scrolledTo.join(','));
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
  ok(await waitFor(() => globalThis.__copilotView === 'goals' && scrolledTo.includes('emergency-fund')), 'pronoun "take me there" uses previous topic (emergency fund)', scrolledTo.join(','));

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

  // ── Financial Companion (Issue #71) ───────────────────────────────────────────────────────────────────────────
  const launcher = () => document.querySelector('.companion-launcher');
  const chatBtn = () => document.querySelector('.companion-chat-btn');
  const stage = () => document.getElementById('ai-voice-stage');
  const launcherState = () => document.querySelector('.ai-orb-button .fin-companion')?.getAttribute('data-state');
  const headerState = () => document.querySelector('.ai-chat-panel .fin-companion--header')?.getAttribute('data-state');
  const stageState = () => document.querySelector('.voice-stage .fin-companion--stage')?.getAttribute('data-state');
  const status = () => document.querySelector('[role="status"]')?.textContent;
  const panelOpen = () => document.querySelector('.ai-chat-panel').classList.contains('open');
  const userCaption = () => document.querySelector('.voice-caption--user')?.textContent ?? '';
  const replyCaption = () => document.querySelector('.voice-caption--reply')?.textContent ?? '';
  const click = (el, wait = 20) => act(async () => { el.click(); await tick(wait); });

  // 11. The orb is a real button for VOICE; text chat is a separate explicit control; no canvas / WebGL remains
  ok(launcher()?.tagName === 'BUTTON' && launcher().getAttribute('type') === 'button' && launcher().getAttribute('aria-controls') === 'ai-voice-stage',
    'COMPANION: orb is a <button type="button"> controlling the voice stage');
  ok(chatBtn()?.tagName === 'BUTTON' && chatBtn().getAttribute('aria-controls') === 'ai-chat-panel' && chatBtn().getAttribute('aria-label') === 'Open text chat'
    && document.getElementById('ai-chat-panel')?.classList.contains('ai-chat-panel'), 'COMPANION: explicit Chat control controls #ai-chat-panel');
  ok(document.querySelectorAll('canvas').length === 0 && !document.querySelector('.bot-avatar-3d-container'), 'COMPANION: no canvas / 3D container rendered');
  ok(document.querySelector('.fin-companion svg')?.getAttribute('aria-hidden') === 'true', 'COMPANION: orb SVG is aria-hidden');
  ok(launcher().querySelectorAll('svg').length === 1 && launcher().querySelector('svg').classList.contains('fc-svg')
    && !launcher().querySelector('.lucide, .companion-launcher-mic') && /^Talk to FinSphere/.test(launcher().getAttribute('aria-label')),
    'COMPANION: the orb shows only the companion (no microphone icon) and its label still says it starts voice');

  // 12. The Chat control opens the text panel (and aria-expanded follows it)
  await click(document.querySelector('.close-btn'));
  ok(chatBtn().getAttribute('aria-expanded') === 'false' && !panelOpen(), 'COMPANION: aria-expanded=false when the text panel is closed');
  await click(chatBtn());
  ok(chatBtn().getAttribute('aria-expanded') === 'true' && panelOpen() && !stage(), 'COMPANION: Chat control opens the text panel (no voice stage)');

  // 13. Idle once the last pulse has expired
  await act(async () => { await tick(2700); });
  ok(launcherState() === 'idle' && status() === 'Assistant ready' && /Assistant ready/.test(launcher().getAttribute('aria-label')), 'COMPANION: idle state, label and status', `${launcherState()} / ${status()}`);

  // 14. Header companion is visible while the panel is open and mirrors the launcher state
  ok(Boolean(document.querySelector('.ai-chat-panel.open .fin-companion--header')) && headerState() === launcherState(), 'COMPANION: header companion shown in the open panel');

  // 15. Typed chat: thinking while a reply is delayed, then insight when it arrives - and nothing is spoken
  const spokenBeforeTyped = synth.spoken.length;
  let release;
  chatGate = { promise: new Promise((r) => { release = r; }) };
  await type('How much did I spend this month?', 30);
  ok(launcherState() === 'thinking' && headerState() === 'thinking' && status() === 'Thinking', 'COMPANION: thinking while the request is in flight', `${launcherState()} / ${headerState()} / ${status()}`);
  ok(document.querySelector('.ai-chat-body')?.textContent.includes('Assistant is thinking'), 'COMPANION: thinking indicator has text for screen readers');
  await act(async () => { release(); chatGate = null; await tick(120); });
  ok(launcherState() === 'insight' && status() === 'New answer', 'COMPANION: insight pulse after a successful answer', `${launcherState()} / ${status()}`);
  ok(synth.spoken.length === spokenBeforeTyped, 'TEXT MODE: a typed answer is not spoken');
  await act(async () => { await tick(2700); });
  ok(launcherState() === 'idle', 'COMPANION: insight pulse expires back to idle', launcherState());

  // 16. Panel dictation (text mode): listening while the microphone is open, silent answer
  await startVoice();
  ok(launcherState() === 'listening' && headerState() === 'listening' && status() === 'Listening', 'COMPANION: listening while panel dictation is active', `${launcherState()} / ${status()}`);
  ok(document.querySelector('.voice-btn').getAttribute('aria-label') === 'Stop voice input' && document.querySelector('.voice-btn').getAttribute('aria-pressed') === 'true', 'COMPANION: mic button labelled and pressed while listening');
  await act(async () => { say('open goals'); await tick(100); });
  ok(launcherState() === 'navigating' && document.querySelector('.voice-btn').getAttribute('aria-label') === 'Ask by voice', 'COMPANION: listening ends; the dictated "open goals" plays the navigating sweep', launcherState());
  await act(async () => { await tick(700); });
  ok(launcherState() === 'idle', 'COMPANION: back to idle after the navigation sweep', launcherState());

  // 17. Error pulse when a typed request fails (no insight)
  chatMode = 'fail';
  await type('How is my budget?', 200);
  ok(launcherState() === 'error' && status() === 'Something went wrong', 'COMPANION: error pulse after a failed request', `${launcherState()} / ${status()}`);
  chatMode = 'ok';
  await act(async () => { await tick(2700); });
  ok(launcherState() === 'idle', 'COMPANION: error pulse expires back to idle', launcherState());

  // 18. A grounded Plans event (bot-speak) shows the bubble with an insight pulse; nothing "walks"
  await click(document.querySelector('.close-btn'));
  await act(async () => { window.dispatchEvent(new window.CustomEvent('bot-speak', { detail: { message: 'ML analysis complete!' } })); await tick(20); });
  ok(document.querySelector('.bot-speech-bubble')?.textContent === 'ML analysis complete!' && launcherState() === 'insight', 'COMPANION: Plans insight event -> bubble + insight pulse', launcherState());
  ok(!document.querySelector('.floating-mic-btn'), 'COMPANION: no separate floating microphone beside the orb');
  await act(async () => { await tick(2700); });

  // 19. Navigation micro-effect (text mode): explicit navigation plays a short "navigating" sweep, without delay
  viewChanges = [];
  await type('Open transactions', 50);
  ok(JSON.stringify(viewChanges) === '["transactions"]' && launcherState() === 'navigating' && status() === 'Opening', 'NAV EFFECT: "Open transactions" navigates at once with the navigating sweep', `${viewChanges.join(',')} / ${launcherState()}`);
  await act(async () => { await tick(700); });
  ok(launcherState() === 'idle', 'NAV EFFECT: the sweep settles back to idle within ~0.7 s', launcherState());
  viewChanges = [];
  await type('How is my budget? Open it.', 250);
  const navT = transcript().slice(-2);
  ok(navT[0] === 'B: ANSWER(How is my budget?)' && navT[1] === 'B: Opening Budgets.' && JSON.stringify(viewChanges) === '["goals"]' && launcherState() === 'navigating',
    'NAV EFFECT: question + action answers first, then sweeps and navigates', `${navT.join(' | ')} / ${launcherState()}`);
  ok(document.querySelector('.fin-companion--launcher .fc-sweep') !== null, 'NAV EFFECT: the orb has the directional sweep element');
  await act(async () => { await tick(700); });
  await click(document.querySelector('.close-btn'));
  await act(async () => { await tick(2700); });

  // ── Voice mode (Issue #71 refinement) ──────────────────────────────────────────────────────────────────────────
  // V1. The orb opens a VOICE session: expanded stage, listening, text panel stays closed
  let recCount = recognitions.length;
  await click(launcher());
  ok(Boolean(stage()) && stage().getAttribute('role') === 'dialog' && !panelOpen(), 'VOICE: orb opens the voice stage, not the text panel');
  ok(launcher().getAttribute('aria-expanded') === 'true' && document.querySelector('.ai-orb-button').classList.contains('docked'), 'VOICE: launcher reports expanded and steps aside');
  ok(Boolean(document.querySelector('.voice-stage .fin-companion--stage')), 'VOICE: enlarged stage companion rendered');
  ok(recognitions.length === recCount + 1 && stageState() === 'listening' && status() === 'Listening', 'VOICE: idle -> listening', `${stageState()} / ${status()}`);

  // V2. Recognised speech -> thinking, caption shows what was heard
  chatGate = { promise: new Promise((r) => { release = r; }) };
  await act(async () => { say('How much did I spend this month?'); await tick(30); });
  ok(stageState() === 'thinking' && status() === 'Thinking', 'VOICE: listening -> thinking after a transcript', stageState());
  ok(userCaption().includes('How much did I spend this month?') && userCaption().includes('You said'), 'VOICE: caption shows the recognised text (with screen-reader prefix)', userCaption());

  // V3. Reply -> speaking the SAME grounded reply, shown as a caption
  await act(async () => { release(); chatGate = null; await tick(120); });
  ok(stageState() === 'speaking' && status() === 'Speaking', 'VOICE: thinking -> speaking after the reply', `${stageState()} / ${status()}`);
  ok(replyCaption() === 'ANSWER(How much did I spend this month?)', 'VOICE: caption shows the assistant reply', replyCaption());
  ok(synth.spoken.at(-1) === 'ANSWER(How much did I spend this month?)', 'VOICE: speechSynthesis speaks the backend reply unchanged', synth.spoken.at(-1));
  ok(document.querySelector('.voice-caption--reply')?.getAttribute('aria-live') === 'polite', 'VOICE: reply caption is a polite live region');
  ok(!panelOpen(), 'VOICE: the text panel stays closed during voice');

  // V4. Speech finished -> listening again for a follow-up
  recCount = recognitions.length;
  await act(async () => { synth.finish(); await tick(20); });
  ok(stageState() === 'listening' && recognitions.length === recCount + 1, 'VOICE: speaking -> listening when speech ends', stageState());

  // V5. Follow-up uses the conversation history
  await act(async () => { say('Why?'); await tick(150); });
  const followUp = chatBodies.at(-1).messages;
  ok(followUp.at(-1).content === 'Why?' && followUp.some((m) => m.role === 'user' && m.content === 'How much did I spend this month?')
    && followUp.some((m) => m.role === 'assistant' && m.content === 'ANSWER(How much did I spend this month?)'), 'VOICE: follow-up question carries the earlier voice turn', JSON.stringify(followUp.slice(-3)));
  await act(async () => { synth.finish(); await tick(20); });

  // V6. Question + action by voice: answer (spoken) BEFORE navigation
  viewChanges = [];
  await act(async () => { say('how much debt do I have take me there'); await tick(150); });
  ok(stageState() === 'speaking' && viewChanges.length === 0 && synth.spoken.at(-1) === 'ANSWER(how much debt do I have)', 'VOICE Q+A: answer is spoken before any navigation', viewChanges.join(','));
  recCount = recognitions.length;
  await act(async () => { synth.finish(); await tick(30); });
  ok(JSON.stringify(viewChanges) === '["liabilities"]' && stageState() === 'navigating' && recognitions.length === recCount, 'VOICE Q+A: navigates after the answer with the navigating sweep', `${viewChanges.join(',')} / ${stageState()}`);
  await act(async () => { await tick(700); });
  ok(stageState() === 'listening' && recognitions.length === recCount + 1, 'VOICE Q+A: then listens again', stageState());

  // V7. Navigation-only by voice: immediate, captioned, not spoken, keeps listening
  const spokenBeforeNav = synth.spoken.length;
  await act(async () => { say('open goals'); await tick(60); });
  ok(viewChanges.at(-1) === 'goals' && replyCaption() === 'Opening Goals.' && synth.spoken.length === spokenBeforeNav && stageState() === 'navigating', 'VOICE: "open goals" navigates at once without speaking (navigating sweep)', `${viewChanges.join(',')} / ${replyCaption()} / ${stageState()}`);
  ok(document.querySelector('.voice-stage-state')?.textContent === 'Opening…', 'VOICE: stage label reads "Opening…" during the sweep');
  await act(async () => { await tick(700); });
  ok(stageState() === 'listening', 'VOICE: listening resumes after the navigation sweep', stageState());

  // V8. Ending the session cancels speech and stops recognition; nothing restarts afterwards
  await act(async () => { say('How is my budget?'); await tick(150); });
  ok(stageState() === 'speaking', 'VOICE: speaking before the session is ended', stageState());
  const staleUtterance = synth.current;
  const cancelsBefore = synth.cancels;
  await click(document.querySelector('.voice-stage-btn--end'));
  ok(!stage() && synth.cancels === cancelsBefore + 1 && launcher().getAttribute('aria-expanded') === 'false', 'VOICE: End cancels speech and closes the stage');
  recCount = recognitions.length;
  await act(async () => { staleUtterance?.onend?.(); await tick(50); });
  ok(recognitions.length === recCount && !stage(), 'VOICE: a late speech "end" after closing does not restart listening');
  await click(launcher());
  const liveRecognition = recognitions.at(-1);
  await click(document.querySelector('.voice-stage-btn--end'));
  ok(liveRecognition.aborted === true && !stage(), 'VOICE: End while listening stops recognition');

  // V9. Typed chat stays silent even after a voice session
  await click(chatBtn());
  const spokenBeforeChat = synth.spoken.length;
  await type('How much did I spend?', 150);
  ok(synth.spoken.length === spokenBeforeChat && transcript().at(-1) === 'B: ANSWER(How much did I spend?)', 'TEXT MODE: typed chat after voice is still not spoken');
  await click(document.querySelector('.close-btn'));

  // V10. No speechSynthesis: the reply is still shown and the session keeps listening
  window.speechSynthesis = undefined;
  await click(launcher());
  recCount = recognitions.length;
  await act(async () => { say('How much did I spend this month?'); await tick(150); });
  ok(replyCaption() === 'ANSWER(How much did I spend this month?)' && stageState() === 'listening' && recognitions.length === recCount + 1, 'VOICE: without speech output the reply is shown and listening resumes', stageState());
  window.speechSynthesis = synth;

  // V11. Recognition error -> visible error state, no restart loop; tapping the orb recovers
  await act(async () => { recognitionError('not-allowed'); await tick(20); });
  recCount = recognitions.length;
  await act(async () => { await tick(300); });
  ok(stageState() === 'error' && status() === 'Something went wrong' && /Microphone access is blocked/.test(replyCaption()) && recognitions.length === recCount, 'VOICE: recognition error shows an error and does not restart by itself', `${stageState()} / ${replyCaption()}`);
  await click(document.querySelector('.voice-stage-orb'));
  ok(stageState() === 'listening' && recognitions.length === recCount + 1, 'VOICE: tapping the orb after an error listens again');

  // V12. Request failure during voice -> error, no restart
  chatMode = 'fail';
  await act(async () => { say('How is my budget?'); await tick(150); });
  recCount = recognitions.length;
  await act(async () => { await tick(200); });
  ok(stageState() === 'error' && /Something went wrong/.test(replyCaption()) && recognitions.length === recCount, 'VOICE: failed request -> error, no automatic restart', `${stageState()} / ${replyCaption()}`);
  chatMode = 'ok';

  // V12b. Speech uses the voice-friendly rendering; the caption keeps the exact reply
  await click(document.querySelector('.voice-stage-orb'));
  await act(async () => { say('Is ₹24,320 at 12.5% a lot'); await tick(150); });
  ok(replyCaption() === 'ANSWER(Is ₹24,320 at 12.5% a lot)', 'VOICE: caption shows the exact reply text', replyCaption());
  ok(synth.spoken.at(-1) === 'ANSWER(Is twenty-four thousand three hundred twenty rupees at twelve point five percent a lot)', 'VOICE: speech uses the humanized rendering of the same reply', synth.spoken.at(-1));
  await act(async () => { synth.finish(); await tick(20); });

  // V13. Escape ends the voice session; Chat on the stage switches to text mode
  await act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); await tick(20); });
  ok(!stage(), 'VOICE: Escape ends the voice session');
  await click(launcher());
  await click(document.querySelector('.voice-stage-btn[aria-label="Switch to text chat"]'));
  ok(!stage() && panelOpen() && recognitions.at(-1).aborted === true, 'VOICE: stage Chat button switches to the text panel and stops listening');


  // ── Confirmed financial actions (Issue #73) ───────────────────────────────────────────────────────────────────────
  const probe = () => document.getElementById('probe');
  const txCount = () => Number(probe().getAttribute('data-tx'));
  const goalNow = () => Number(probe().getAttribute('data-goal'));
  const card = () => document.querySelector('.ai-chat-panel .action-card');
  const stageCard = () => document.querySelector('.voice-stage .action-card');
  const cardRows = () => [...(card() ?? stageCard() ?? document.createElement('div')).querySelectorAll('.action-card-row')].map((r) => r.textContent);
  const press = (selector, root = document) => click(root.querySelector(selector), 80);
  const settle = (ms = 2700) => act(async () => { await tick(ms); });
  const localToday = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
  const resetActions = () => { confirmCalls = []; cancelCalls = []; confirmMode = 'ok'; };

  await click(chatBtn());   // text mode
  resetActions();

  // A1. A proposal shows the exact preview and waits: nothing is written, the companion asks for attention
  const beforeA1 = chatBodies.length;
  const spokenA1 = synth.spoken.length;
  const p1 = propose('create_transaction', "I'll add a ₹450 lunch expense for today. Should I add it?", lunchDisplay(), lunchTx('t-1'));
  await type('Add ₹450 for lunch today', 120);
  ok(chatBodies.length === beforeA1 + 1 && chatBodies.at(-1).messages.at(-1).content === 'Add ₹450 for lunch today', 'ACTION: the request goes through the normal chat pipeline');
  ok(chatBodies.at(-1).localDate === localToday && /^\d{4}-\d{2}-\d{2}$/.test(chatBodies.at(-1).localDate), 'ACTION: the client sends its LOCAL date with the message', chatBodies.at(-1).localDate);
  ok(Boolean(card()) && cardRows().includes('Amount₹450') && cardRows().some((r) => r.startsWith('Date') && r.includes('(today)')), 'ACTION: the confirmation card shows the exact preview rows', cardRows().join(' | '));
  ok(transcript().at(-1) === "B: I'll add a ₹450 lunch expense for today. Should I add it?", 'ACTION: the concise proposal sentence is the reply', transcript().at(-1));
  ok(launcherState() === 'attention' && status() === 'Needs your attention', 'ACTION: companion shows attention while a confirmation is pending', `${launcherState()} / ${status()}`);
  ok(txCount() === 0 && confirmCalls.length === 0, 'ACTION: NOTHING is written before confirmation');
  ok(synth.spoken.length === spokenA1, 'ACTION: a typed proposal is not spoken');

  // A2. The Confirm button executes by proposal id only, updates shared state, and shows success
  await press('.action-card-btn--confirm', card());
  ok(confirmCalls.length === 1 && confirmCalls[0].id === p1 && confirmCalls[0].body === undefined, 'ACTION: Confirm sends only the proposal id (no financial payload)', JSON.stringify(confirmCalls));
  ok(txCount() === 1 && probe().getAttribute('data-tx-first') === 'Lunch', 'ACTION: the stored transaction is applied to shared state', `${txCount()} ${probe().getAttribute('data-tx-first')}`);
  ok(transcript().at(-1) === 'B: Done. I added the ₹450 Lunch expense.' && !card(), 'ACTION: success message shown and the card is gone', transcript().at(-1));
  ok(launcherState() === 'success' && status() === 'Done', 'ACTION: companion shows success after execution', `${launcherState()} / ${status()}`);
  await settle();

  // A3. The Cancel button cancels on the server and writes nothing
  const p2 = propose('create_transaction', "I'll add a ₹300 dinner expense for today. Should I add it?", lunchDisplay('₹300'), lunchTx('t-2', 300));
  await type('Add ₹300 for dinner today', 120);
  await press('.action-card-btn:not(.action-card-btn--confirm)', card());
  ok(cancelCalls.length === 1 && cancelCalls[0].id === p2 && cancelCalls[0].body === undefined && confirmCalls.length === 1, 'ACTION: Cancel calls the cancel endpoint by id only', JSON.stringify(cancelCalls));
  ok(txCount() === 1 && !card() && transcript().at(-1) === 'B: Okay, I cancelled that. Nothing was saved.', 'ACTION: cancelled: nothing written, card gone', transcript().at(-1));
  await settle();

  // A4. A typed "yes" confirms (and is not sent to the chat endpoint); a typed "no" cancels
  const p3 = propose('create_transaction', "I'll add a ₹450 lunch expense for today. Should I add it?", lunchDisplay(), lunchTx('t-3'));
  await type('Add ₹450 for lunch today', 120);
  const chatBefore = chatBodies.length;
  await type('yes', 120);
  ok(confirmCalls.length === 2 && confirmCalls.at(-1).id === p3 && chatBodies.length === chatBefore && txCount() === 2, 'ACTION: typed "yes" confirms through the endpoint, not the chat', `${confirmCalls.length} ${txCount()}`);
  await settle();
  const p4 = propose('create_transaction', "I'll add a ₹450 lunch expense for today. Should I add it?", lunchDisplay(), lunchTx('t-4'));
  await type('Add ₹450 for lunch today', 120);
  await type('no', 120);
  ok(cancelCalls.at(-1).id === p4 && txCount() === 2 && !card(), 'ACTION: typed "no" cancels; nothing written', `${txCount()}`);
  await settle();

  // A5. Not a confirmation: "yes but ..." and "yesterday" go to the server as ordinary messages
  const p5 = propose('create_transaction', "I'll add a ₹450 lunch expense for today. Should I add it?", lunchDisplay(), lunchTx('t-5'));
  await type('Add ₹450 for lunch today', 120);
  const n5 = confirmCalls.length;
  const p5b = propose('create_transaction', "I'll add a ₹600 lunch expense for today. Should I add it?", lunchDisplay('₹600'), lunchTx('t-5b', 600));
  await type('yes but make it 600', 120);
  ok(confirmCalls.length === n5 && chatBodies.at(-1).messages.at(-1).content === 'yes but make it 600', 'ACTION: "yes but make it 600" is NOT a confirmation', `${confirmCalls.length}`);
  ok(cardRows().includes('Amount₹600') && txCount() === 2, 'ACTION: an edit shows a NEW preview and still writes nothing', cardRows().join(' | '));
  // the edit created a new proposal: confirming now uses the NEW id, never the old one
  await press('.action-card-btn--confirm', card());
  ok(confirmCalls.at(-1).id === p5b && !confirmCalls.some((c) => c.id === p5), 'ACTION: after an edit only the new proposal can be confirmed', JSON.stringify(confirmCalls.map((c) => c.id)));
  ok(txCount() === 3, 'ACTION: edited proposal executed once');
  await settle();
  // "I said yes earlier" is not a confirmation either: it goes to the server (which treats it as unrelated)
  const p5c = propose('create_transaction', "I'll add a ₹450 lunch expense for today. Should I add it?", lunchDisplay(), lunchTx('t-5c'));
  await type('Add ₹450 for lunch today', 120);
  const n5c = confirmCalls.length;
  scriptedChat.push({ reply: 'I cancelled the ₹450 expense. Nothing was saved. Okay.', action: { proposalId: p5c, kind: 'create_transaction', status: 'cancelled' } });
  await type('I said yes earlier', 120);
  ok(confirmCalls.length === n5c && chatBodies.at(-1).messages.at(-1).content === 'I said yes earlier' && txCount() === 3, 'ACTION: "I said yes earlier" is not a confirmation', `${confirmCalls.length}`);
  await settle();

  // A6. An unrelated message: the server cancels the proposal; a later "yes" executes nothing
  const p6 = propose('create_transaction', "I'll add a ₹450 lunch expense for today. Should I add it?", lunchDisplay(), lunchTx('t-6'));
  await type('Add ₹450 for lunch today', 120);
  scriptedChat.push({ reply: 'I cancelled the ₹450 expense. Nothing was saved. You spent ₹9,500 this month.', action: { proposalId: p6, kind: 'create_transaction', status: 'cancelled' } });
  await type('How much did I spend this month?', 120);
  ok(!card() && /^B: I cancelled the ₹450 expense\. Nothing was saved\./.test(transcript().at(-1)), 'ACTION: an unrelated message cancels the proposal and says so', transcript().at(-1));
  const n6 = confirmCalls.length;
  await type('yes', 120);
  ok(confirmCalls.length === n6 && txCount() === 3 && chatBodies.at(-1).messages.at(-1).content === 'yes', 'ACTION: a later "yes" does not reach back to the cancelled proposal', `${confirmCalls.length}`);
  await settle();

  // A7. Clarification: a question is open, no card, and an answer like "Lunch" is NOT mistaken for a confirmation
  scriptedChat.push({ reply: 'What was the ₹450 expense for?', action: { proposalId: 'draft-1', kind: 'create_transaction', status: 'needs_clarification', summary: 'What was the ₹450 expense for?', display: [], expiresAt: iso(180000) } });
  await type('Add ₹450 expense', 120);
  ok(!card() && transcript().at(-1) === 'B: What was the ₹450 expense for?', 'ACTION: a clarifying question has no card', transcript().at(-1));
  const p7 = propose('create_transaction', "I'll add a ₹450 Lunch expense for today. Should I add it?", lunchDisplay(), lunchTx('t-7'));
  await type('Lunch', 120);
  ok(chatBodies.at(-1).messages.at(-1).content === 'Lunch' && Boolean(card()) && confirmCalls.at(-1).id !== p7, 'ACTION: the answer goes to the server and produces the proposal', transcript().at(-1));
  await press('.action-card-btn:not(.action-card-btn--confirm)', card());
  await settle();

  // A8. Server refusals: shown, the proposal closes, nothing changes; a network failure keeps it so the user can retry
  const gp = propose('contribute_to_goal', "I'll add ₹6,000 to your Goa Trip goal. Should I add it?",
    [{ label: 'Goal', value: 'Goa Trip' }, { label: 'Contribution', value: '₹6,000' }, { label: 'Current', value: '₹20,000' }, { label: 'After', value: '₹26,000' }, { label: 'Target', value: '₹50,000' }],
    { kind: 'contribute_to_goal', message: "Done. I added ₹6,000 to Goa Trip. It's now ₹26,000 of ₹50,000.", goal: goaGoal(26000), contribution: { id: 'c1', amount: 6000 } });
  await type('Add ₹6,000 to my Goa Trip goal', 120);
  ok(Boolean(card()) && cardRows().includes('GoalGoa Trip') && cardRows().includes('After₹26,000') && goalNow() === 20000, 'GOAL: the card previews goal, contribution, current, after and target; nothing written yet', cardRows().join(' | '));
  confirmMode = 'network';
  await press('.action-card-btn--confirm', card());
  ok(Boolean(card()) && txCount() === 3 && goalNow() === 20000, 'ACTION: a network failure keeps the proposal open for a retry', transcript().at(-1));
  ok(launcherState() === 'error', 'ACTION: companion shows error when the action fails', launcherState());
  confirmMode = 'exceeds';
  await press('.action-card-btn--confirm', card());
  ok(!card() && goalNow() === 20000 && /would exceed the goal target \(₹4,000 remaining\)/.test(transcript().at(-1)), 'ACTION: a server refusal is shown, closes the proposal, changes nothing', transcript().at(-1));
  await settle();
  void gp;

  // A9. Goal contribution applies the returned goal to shared state, exactly like the manual write
  confirmMode = 'ok';
  propose('contribute_to_goal', "I'll add ₹5,000 to your Goa Trip goal. Should I add it?",
    [{ label: 'Goal', value: 'Goa Trip' }, { label: 'Contribution', value: '₹5,000' }, { label: 'Current', value: '₹20,000' }, { label: 'After', value: '₹25,000' }, { label: 'Target', value: '₹50,000' }],
    { kind: 'contribute_to_goal', message: "Done. I added ₹5,000 to Goa Trip. It's now ₹25,000 of ₹50,000.", goal: goaGoal(25000), contribution: { id: 'c2', amount: 5000 } });
  await type('Add ₹5,000 to my Goa Trip goal', 120);
  await press('.action-card-btn--confirm', card());
  ok(goalNow() === 25000 && txCount() === 3 && transcript().at(-1) === "B: Done. I added ₹5,000 to Goa Trip. It's now ₹25,000 of ₹50,000.", 'GOAL: confirmed contribution updates the goal in shared state', `${goalNow()}`);
  await settle();

  // A10. Expired on the server: the card closes, nothing is written
  const pe = propose('create_transaction', "I'll add a ₹450 lunch expense for today. Should I add it?", lunchDisplay(), lunchTx('t-e'));
  await type('Add ₹450 for lunch today', 120);
  confirmMode = 'expired';
  await press('.action-card-btn--confirm', card());
  ok(!card() && txCount() === 3 && transcript().at(-1) === 'B: This request expired. Nothing was saved.', 'ACTION: an expired proposal is refused safely and the card closes', transcript().at(-1));
  void pe;
  confirmMode = 'ok';
  await settle();

  // A11. The client also forgets a proposal when its window closes
  propose('create_transaction', "I'll add a ₹450 lunch expense for today. Should I add it?", lunchDisplay(), lunchTx('t-x'), { ttlMs: 400 });
  await type('Add ₹450 for lunch today', 120);
  ok(Boolean(card()), 'ACTION: a short-lived proposal is shown');
  await act(async () => { await tick(600); });
  ok(!card() && transcript().at(-1) === 'B: That request expired, so nothing was saved.', 'ACTION: the card disappears when the window closes', transcript().at(-1));
  const nx = confirmCalls.length;
  await type('yes', 120);
  ok(confirmCalls.length === nx, 'ACTION: a "yes" after the window closed executes nothing');
  await settle();

  // A12. The manual transaction error is no longer swallowed
  manualTxMode = 'invalid';
  let manualError = null;
  const realConsoleError = console.error;
  console.error = () => {};   // the context logs the failure; it is expected here
  await act(async () => { try { await globalThis.__finance.addTransaction({ title: '', amount: 1, type: 'expense', date: '2026-10-08' }); } catch (e) { manualError = e.message; } });
  console.error = realConsoleError;
  ok(manualError === 'Title is required', 'REGRESSION: addTransaction passes the server\'s validation message through', String(manualError));
  manualTxMode = 'ok';

  // ── Voice parity ──────────────────────────────────────────────────────────────────────────────────────────────────
  await click(document.querySelector('.close-btn'));
  const spokenBeforeVoice = synth.spoken.length;
  const v1 = propose('create_transaction', "I'll add a ₹450 lunch expense for today. Should I add it?", lunchDisplay(), lunchTx('t-v1'));
  await click(launcher());
  await act(async () => { say('Add four fifty rupees lunch today'); await tick(150); });
  ok(stageState() === 'speaking' && synth.spoken.at(-1).startsWith("I'll add a four hundred fifty rupees lunch expense for today. Should I add it?"), 'VOICE ACTION: the proposal is spoken (amount in words)', synth.spoken.at(-1));
  ok(Boolean(stageCard()) && cardRows().includes('Amount₹450') && txCount() === 3, 'VOICE ACTION: the card is on the voice stage; nothing written', cardRows().join(' | '));
  await act(async () => { synth.finish(); await tick(30); });
  ok(stageState() === 'listening', 'VOICE ACTION: it listens for the confirmation', stageState());
  // doubtful recognition never confirms
  const nv = confirmCalls.length;
  await act(async () => { say('yes', 0.3); await tick(150); });
  ok(confirmCalls.length === nv && /didn't catch that clearly/.test(replyCaption()) && txCount() === 3, 'VOICE ACTION: a low-confidence "yes" asks again instead of executing', replyCaption());
  await act(async () => { synth.finish(); await tick(30); });
  await act(async () => { say('yes', 0.92); await tick(150); });
  ok(confirmCalls.length === nv + 1 && confirmCalls.at(-1).id === v1 && txCount() === 4, 'VOICE ACTION: a spoken "yes" confirms through the same endpoint', `${confirmCalls.length} ${txCount()}`);
  ok(replyCaption() === 'Done. I added the ₹450 Lunch expense.' && synth.spoken.at(-1) === 'Done. I added the four hundred fifty rupees Lunch expense.', 'VOICE ACTION: success is captioned and spoken', synth.spoken.at(-1));
  ok(stageState() === 'speaking' || launcherState() === 'speaking', 'VOICE ACTION: companion speaks the result');
  await act(async () => { synth.finish(); await tick(30); });

  // a spoken "no" cancels
  const v2 = propose('create_transaction', "I'll add a ₹450 lunch expense for today. Should I add it?", lunchDisplay(), lunchTx('t-v2'));
  await act(async () => { say('Add ₹450 for lunch today'); await tick(150); });
  await act(async () => { synth.finish(); await tick(30); });
  await act(async () => { say('no'); await tick(150); });
  ok(cancelCalls.at(-1).id === v2 && txCount() === 4 && replyCaption() === 'Okay, I cancelled that. Nothing was saved.', 'VOICE ACTION: a spoken "no" cancels; nothing written', replyCaption());
  await act(async () => { synth.finish(); await tick(30); });

  // the stage's Confirm button goes through the same path
  const v3 = propose('create_transaction', "I'll add a ₹450 lunch expense for today. Should I add it?", lunchDisplay(), lunchTx('t-v3'));
  await act(async () => { say('Add ₹450 for lunch today'); await tick(150); });
  await act(async () => { synth.finish(); await tick(30); });
  await press('.action-card-btn--confirm', stageCard());
  ok(confirmCalls.at(-1).id === v3 && txCount() === 5, 'VOICE ACTION: the stage Confirm button uses the same confirm path', `${txCount()}`);
  await act(async () => { synth.finish(); await tick(30); });

  // pending voice proposal + another question: server cancels it (voice and text have identical safety)
  const v4 = propose('create_transaction', "I'll add a ₹450 lunch expense for today. Should I add it?", lunchDisplay(), lunchTx('t-v4'));
  await act(async () => { say('Add ₹450 for lunch today'); await tick(150); });
  await act(async () => { synth.finish(); await tick(30); });
  scriptedChat.push({ reply: 'I cancelled the ₹450 expense. Nothing was saved. You spent ₹9,500.', action: { proposalId: v4, kind: 'create_transaction', status: 'cancelled' } });
  await act(async () => { say('how much did I spend'); await tick(150); });
  ok(!stageCard() && txCount() === 5 && replyCaption().startsWith('I cancelled the ₹450 expense.'), 'VOICE ACTION: an unrelated spoken question cancels the proposal', replyCaption());
  await act(async () => { synth.finish(); await tick(30); });
  ok(synth.spoken.length > spokenBeforeVoice, 'VOICE ACTION: voice replies were spoken');
  await click(document.querySelector('.voice-stage-btn--end'));
  ok(!stage() && !stageCard(), 'VOICE ACTION: ending the session closes the stage');


  // ── Issue #75: repayments and budgets (same pipeline, same safety) ───────────────────────────────────────────────────
  await click(chatBtn());   // text mode
  resetActions();
  const liabNow = () => Number(probe().getAttribute('data-liab'));
  const repayDisplay = (now, after, paidOff = false) => [
    { label: 'Liability', value: 'HDFC Car Loan (vehicle loan)' }, { label: 'Repayment', value: '₹5,000' },
    { label: 'Outstanding now', value: now }, { label: 'Outstanding after', value: after },
    ...(paidOff ? [{ label: 'Result', value: 'Paid off after this repayment' }] : []),
    { label: 'Note', value: 'Records a liability repayment only; no expense transaction will be added.' },
  ];
  const repaySummary = (amt, from, to) => `I'll record a ${amt} repayment on your HDFC Car Loan. Its outstanding balance will go from ${from} to ${to}. Should I record it?`;
  const repayResult = (amt, left) => ({ kind: 'record_liability_repayment', message: `Done. I recorded a ${amt} repayment on HDFC Car Loan. Its outstanding balance is now ${left}.`, liability: hdfcLiab(left === '₹1,15,000' ? 115000 : 114000), repayment: { id: 'rp-1', liabilityId: 'l1', amount: amt === '₹5,000' ? 5000 : 6000 } });

  // C1. A repayment card: previews the balance change and the "no transaction" disclosure; nothing is written
  const txBeforeRepay = txCount();
  const pr1 = propose('record_liability_repayment', repaySummary('₹5,000', '₹1,20,000', '₹1,15,000'), repayDisplay('₹1,20,000', '₹1,15,000'), repayResult('₹5,000', '₹1,15,000'));
  await type('Repay 5k on my HDFC Car Loan', 120);
  ok(Boolean(card()) && card().querySelector('.action-card-title').textContent === 'Record repayment', 'REPAYMENT: the card is titled "Record repayment"', card()?.textContent);
  ok(cardRows().includes('Outstanding now₹1,20,000') && cardRows().includes('Outstanding after₹1,15,000') && cardRows().some((r) => r.startsWith('Note') && r.includes('no expense transaction will be added')), 'REPAYMENT: preview shows the balance change and the no-transaction disclosure', cardRows().join(' | '));
  ok(liabNow() === 120000 && txCount() === txBeforeRepay && confirmCalls.length === 0, 'REPAYMENT: nothing is written before confirmation');
  ok(launcherState() === 'attention', 'REPAYMENT: companion shows attention while pending', launcherState());

  // C2. Confirm: by id only; the returned liability REPLACES the one in shared state; no transaction appears
  await press('.action-card-btn--confirm', card());
  ok(confirmCalls.length === 1 && confirmCalls[0].id === pr1 && confirmCalls[0].body === undefined, 'REPAYMENT: Confirm sends only the proposal id', JSON.stringify(confirmCalls));
  ok(liabNow() === 115000 && txCount() === txBeforeRepay, 'REPAYMENT: the liability in shared state is replaced with the server\'s row; no transaction is added', `${liabNow()} ${txCount()}`);
  ok(transcript().at(-1) === 'B: Done. I recorded a ₹5,000 repayment on HDFC Car Loan. Its outstanding balance is now ₹1,15,000.' && !card() && launcherState() === 'success', 'REPAYMENT: the ACTUAL resulting balance is reported; companion shows success', transcript().at(-1));
  await settle();

  // C3. Typed cancel and typed "record it"
  resetActions();
  const pr2 = propose('record_liability_repayment', repaySummary('₹5,000', '₹1,15,000', '₹1,10,000'), repayDisplay('₹1,15,000', '₹1,10,000'), repayResult('₹5,000', '₹1,15,000'));
  await type('Repay 5k on my HDFC Car Loan', 120);
  await type('no', 120);
  ok(cancelCalls.length === 1 && cancelCalls[0].id === pr2 && liabNow() === 115000 && !card(), 'REPAYMENT: typed "no" cancels; nothing written');
  await settle();
  const pr3 = propose('record_liability_repayment', repaySummary('₹5,000', '₹1,15,000', '₹1,10,000'), repayDisplay('₹1,15,000', '₹1,10,000'), { ...repayResult('₹5,000', '₹1,15,000'), liability: hdfcLiab(110000) });
  await type('Repay 5k on my HDFC Car Loan', 120);
  const chatBeforeRecord = chatBodies.length;
  await type('record it', 120);
  ok(confirmCalls.length === 1 && confirmCalls[0].id === pr3 && chatBodies.length === chatBeforeRecord && liabNow() === 110000, 'REPAYMENT: typed "record it" confirms (through the endpoint, not the chat)', `${confirmCalls.length} ${liabNow()}`);
  await settle();
  const prNo = propose('record_liability_repayment', repaySummary('₹5,000', '₹1,10,000', '₹1,05,000'), repayDisplay('₹1,10,000', '₹1,05,000'), repayResult('₹5,000', '₹1,15,000'));
  await type('Repay 5k on my HDFC Car Loan', 120);
  const nrec = confirmCalls.length;
  await type('record it later', 120);
  ok(confirmCalls.length === nrec && chatBodies.at(-1).messages.at(-1).content === 'record it later', 'REPAYMENT: "record it later" is NOT a confirmation (goes to the server)');
  void prNo;
  await settle();

  // C4. Edit -> a NEW proposal, only that one can be confirmed
  scriptedChat.length = 0;
  const pe0 = propose('record_liability_repayment', repaySummary('₹5,000', '₹1,10,000', '₹1,05,000'), repayDisplay('₹1,10,000', '₹1,05,000'), repayResult('₹5,000', '₹1,15,000'));
  await type('Repay 5k on my HDFC Car Loan', 120);
  const pe1 = propose('record_liability_repayment', repaySummary('₹6,000', '₹1,10,000', '₹1,04,000'), repayDisplay('₹1,10,000', '₹1,04,000').map((d) => (d.label === 'Repayment' ? { ...d, value: '₹6,000' } : d)), { ...repayResult('₹6,000', '₹1,14,000'), liability: hdfcLiab(104000) });
  await type('make it ₹6,000', 120);
  ok(cardRows().includes('Repayment₹6,000'), 'REPAYMENT EDIT: "make it ₹6,000" shows a new preview', cardRows().join(' | '));
  await press('.action-card-btn--confirm', card());
  ok(confirmCalls.at(-1).id === pe1 && !confirmCalls.some((c) => c.id === pe0) && liabNow() === 104000, 'REPAYMENT EDIT: only the new proposal is confirmed', JSON.stringify(confirmCalls.map((c) => c.id)));
  await settle();

  // C5. A refusal from the server (the amount no longer fits): shown, closes the proposal, changes nothing
  propose('record_liability_repayment', repaySummary('₹5,000', '₹1,04,000', '₹99,000'), repayDisplay('₹1,04,000', '₹99,000'), repayResult('₹5,000', '₹1,15,000'));
  await type('Repay 5k on my HDFC Car Loan', 120);
  confirmMode = 'exceeds';
  await press('.action-card-btn--confirm', card());
  ok(!card() && liabNow() === 104000 && /would exceed the goal target/.test(transcript().at(-1)), 'REPAYMENT: a server refusal is shown, nothing changes', transcript().at(-1));
  confirmMode = 'ok';
  await settle();

  // ── Budgets ──
  const budgetResult = (month, category, amount, created, message) => ({ kind: 'set_budget', message, budget: budgetRow(month, category, amount), created });
  await act(async () => { await globalThis.__finance.fetchBudgets('2026-10'); });
  budgetGets = [];
  const createRows = [{ label: 'Month', value: 'October 2026 (2026-10)' }, { label: 'Category', value: 'transport' }, { label: 'New limit', value: '₹4,500' }, { label: 'Status', value: 'New budget' }];
  const pb1 = propose('set_budget', "I'll create a transport budget of ₹4,500 for October 2026. Should I create it?", createRows,
    budgetResult('2026-10', 'transport', 4500, true, 'Done. I created the transport budget for October 2026: ₹4,500.'));
  await type('Set transport budget to ₹4,500', 120);
  ok(Boolean(card()) && card().querySelector('.action-card-title').textContent === 'Set budget' && cardRows().includes('StatusNew budget') && budgetGets.length === 0, 'BUDGET: the create card is titled "Set budget" and shows "New budget"; nothing fetched or written', cardRows().join(' | '));
  await press('.action-card-btn--confirm', card());
  ok(confirmCalls.at(-1).id === pb1 && confirmCalls.at(-1).body === undefined, 'BUDGET: Confirm sends only the proposal id');
  ok(budgetGets.length === 1 && budgetGets[0] === '2026-10', 'BUDGET: the month on screen is reloaded after the save (like the manual form)', JSON.stringify(budgetGets));
  ok(transcript().at(-1) === 'B: Done. I created the transport budget for October 2026: ₹4,500.' && launcherState() === 'success', 'BUDGET: success message and companion', transcript().at(-1));
  await settle();

  // a budget for ANOTHER month must not disturb the month on screen
  budgetGets = [];
  const nextRows = createRows.map((d) => (d.label === 'Month' ? { ...d, value: 'November 2026 (2026-11)' } : d));
  propose('set_budget', "I'll create a transport budget of ₹4,500 for November 2026. Should I create it?", nextRows,
    budgetResult('2026-11', 'transport', 4500, true, 'Done. I created the transport budget for November 2026: ₹4,500.'));
  await type('Set transport budget to 4500 for 2026-11', 120);
  await press('.action-card-btn--confirm', card());
  ok(budgetGets.length === 0 && globalThis.__finance.budgetsMonth === '2026-10', 'BUDGET: a different month does not reload or overwrite the visible month', `${JSON.stringify(budgetGets)} ${globalThis.__finance.budgetsMonth}`);
  await settle();

  // update card: discloses the current limit, spending, remaining, status
  const updRows = [{ label: 'Month', value: 'October 2026 (2026-10)' }, { label: 'Category', value: 'Food' }, { label: 'Label', value: 'Will change from “Food” to “food”' }, { label: 'Current limit', value: '₹6,000' }, { label: 'New limit', value: '₹8,000' }, { label: 'Spent so far', value: '₹2,500' }, { label: 'Remaining after', value: '₹5,500' }, { label: 'Status after', value: 'Under budget' }];
  budgetGets = [];
  const pb2 = propose('set_budget', "Your Food budget for October 2026 is ₹6,000. I'll change it to ₹8,000. Should I update it?", updRows,
    budgetResult('2026-10', 'food', 8000, false, 'Done. I changed the food budget for October 2026 from ₹6,000 to ₹8,000.'));
  await type('Set my food budget to ₹8,000 this month', 120);
  ok(cardRows().includes('Current limit₹6,000') && cardRows().includes('New limit₹8,000') && cardRows().includes('Spent so far₹2,500') && cardRows().includes('Remaining after₹5,500') && cardRows().includes('Status afterUnder budget') && cardRows().some((r) => r.startsWith('Label') && r.includes('“Food” to “food”')), 'BUDGET: the update card discloses current limit, spent, remaining, status and the label change', cardRows().join(' | '));
  ok(transcript().at(-1).startsWith("B: Your Food budget for October 2026 is ₹6,000. I'll change it to ₹8,000."), 'BUDGET: the summary states the CURRENT limit first', transcript().at(-1));
  await type('update it', 120);
  ok(confirmCalls.at(-1).id === pb2 && budgetGets.length === 1 && transcript().at(-1) === 'B: Done. I changed the food budget for October 2026 from ₹6,000 to ₹8,000.', 'BUDGET: typed "update it" confirms; the visible month reloads', `${budgetGets.length} ${transcript().at(-1)}`);
  await settle();

  // a stale budget (changed since the preview) is refused by the server; nothing changes, the card closes
  propose('set_budget', "I'll create a fuel budget of ₹3,000 for October 2026. Should I create it?", createRows.map((d) => (d.label === 'Category' ? { ...d, value: 'fuel' } : d)),
    budgetResult('2026-10', 'fuel', 3000, true, 'x'));
  await type('Set fuel budget to ₹3,000', 120);
  const gets = budgetGets.length;
  confirmMode = 'exceeds';
  await press('.action-card-btn--confirm', card());
  ok(!card() && budgetGets.length === gets && launcherState() === 'error', 'BUDGET: a refused (stale) budget closes the proposal and reloads nothing; companion shows error', launcherState());
  confirmMode = 'ok';
  await settle();

  // typed edit "for next month" -> a new proposal
  scriptedChat.length = 0;
  const pbe0 = propose('set_budget', "I'll create a transport budget of ₹4,500 for October 2026. Should I create it?", createRows, budgetResult('2026-10', 'transport', 4500, true, 'x'));
  await type('Set transport budget to ₹4,500', 120);
  const pbe1 = propose('set_budget', "I'll create a transport budget of ₹4,500 for November 2026. Should I create it?", nextRows, budgetResult('2026-11', 'transport', 4500, true, 'Done. I created the transport budget for November 2026: ₹4,500.'));
  await type('for next month', 120);
  ok(cardRows().includes('MonthNovember 2026 (2026-11)'), 'BUDGET EDIT: "for next month" shows a new preview', cardRows().join(' | '));
  await press('.action-card-btn--confirm', card());
  ok(confirmCalls.at(-1).id === pbe1 && !confirmCalls.some((c) => c.id === pbe0), 'BUDGET EDIT: only the new proposal is confirmed');
  await settle();

  // ── Voice: a spoken repayment, confirmed by a spoken "yes" ──
  await click(document.querySelector('.close-btn'));
  resetActions();
  const vSummary = "I'll record a ₹6,500 repayment on your Bike Loan. Its outstanding balance will go from ₹10,000 to ₹3,500. Should I record it?";
  const vRows = [{ label: 'Liability', value: 'Bike Loan (vehicle loan)' }, { label: 'Repayment', value: '₹6,500' }, { label: 'Outstanding now', value: '₹10,000' }, { label: 'Outstanding after', value: '₹3,500' }, { label: 'Note', value: 'Records a liability repayment only; no expense transaction will be added.' }];
  const pv1 = propose('record_liability_repayment', vSummary, vRows,
    { kind: 'record_liability_repayment', message: 'Done. I recorded a ₹6,500 repayment on HDFC Car Loan. Its outstanding balance is now ₹97,500.', liability: hdfcLiab(97500), repayment: { id: 'rp-v', liabilityId: 'l1', amount: 6500 } });
  const txVoice = txCount();
  await click(launcher());
  await act(async () => { say('I paid 6500 toward my bike loan'); await tick(150); });
  ok(stageState() === 'speaking' && synth.spoken.at(-1).startsWith("I'll record a six thousand five hundred rupees repayment on your Bike Loan."), 'VOICE REPAYMENT: the preview is spoken (amounts in words)', synth.spoken.at(-1));
  ok(Boolean(stageCard()) && stageCard().querySelector('.action-card-title').textContent === 'Record repayment' && liabNow() === 104000, 'VOICE REPAYMENT: the card is on the stage and nothing is written yet');
  await act(async () => { synth.finish(); await tick(30); });
  await act(async () => { say('yes', 0.93); await tick(150); });
  ok(confirmCalls.at(-1).id === pv1 && liabNow() === 97500 && txCount() === txVoice, 'VOICE REPAYMENT: a spoken "yes" confirms; the liability is replaced; no transaction', `${liabNow()} ${txCount()}`);
  ok(replyCaption() === 'Done. I recorded a ₹6,500 repayment on HDFC Car Loan. Its outstanding balance is now ₹97,500.' && /outstanding balance is now ninety-seven thousand five hundred rupees/.test(synth.spoken.at(-1)), 'VOICE REPAYMENT: the actual balance is captioned and spoken', synth.spoken.at(-1));
  await act(async () => { synth.finish(); await tick(30); });
  const pv2 = propose('record_liability_repayment', vSummary, vRows, { kind: 'record_liability_repayment', message: 'x', liability: hdfcLiab(1), repayment: {} });
  await act(async () => { say('I paid 6500 toward my bike loan'); await tick(150); });
  await act(async () => { synth.finish(); await tick(30); });
  await act(async () => { say('no'); await tick(150); });
  ok(cancelCalls.at(-1).id === pv2 && liabNow() === 97500 && replyCaption() === 'Okay, I cancelled that. Nothing was saved.', 'VOICE REPAYMENT: a spoken "no" cancels; nothing written', replyCaption());
  await act(async () => { synth.finish(); await tick(30); });
  // budget by voice: "set it" confirms
  const pv3 = propose('set_budget', "I'll create a transport budget of ₹4,500 for October 2026. Should I create it?", createRows, budgetResult('2026-10', 'transport', 4500, true, 'Done. I created the transport budget for October 2026: ₹4,500.'));
  await act(async () => { say('set transport budget to 4500'); await tick(150); });
  ok(Boolean(stageCard()) && stageCard().querySelector('.action-card-title').textContent === 'Set budget', 'VOICE BUDGET: the budget card is on the stage');
  await act(async () => { synth.finish(); await tick(30); });
  await act(async () => { say('set it', 0.9); await tick(150); });
  ok(confirmCalls.at(-1).id === pv3 && /^Done\. I created the transport budget/.test(replyCaption()), 'VOICE BUDGET: a spoken "set it" confirms', replyCaption());
  await act(async () => { synth.finish(); await tick(30); });
  await click(document.querySelector('.voice-stage-btn--end'));
  ok(!stage(), 'VOICE: the session ends cleanly');

  await act(async () => { root.unmount(); });
} finally {
  await vite.close();
}

console.log(`copilot UI tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
