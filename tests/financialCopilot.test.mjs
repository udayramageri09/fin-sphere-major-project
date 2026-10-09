// Financial Copilot UI regression test (Issues #69 and #71).   Run: npm run test:copilot
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
const say = (transcript) => lastRecognition.onresult({ results: [[{ transcript }]] });
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
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), method = opts.method ?? 'GET';
  const json = (status, b) => ({ status, ok: status >= 200 && status < 300, json: async () => b });
  if (/\/chat$/.test(u) && method === 'POST') {
    const body = JSON.parse(opts.body);
    chatBodies.push(body);
    chatOrder.push('chat-request');
    if (chatGate) await chatGate.promise;
    await new Promise((r) => setTimeout(r, 40));
    if (chatMode === 'fail') return json(500, { error: 'Could not answer right now' });
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

  await act(async () => { root.unmount(); });
} finally {
  await vite.close();
}

console.log(`copilot UI tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
