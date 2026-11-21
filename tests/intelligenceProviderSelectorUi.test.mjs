// Financial Intelligence - Fast/Local provider selector UI test.   Run: npm run test:provider-selector
//
// Renders the REAL Plans page (and FinanceProvider) in jsdom via Vite SSR, like plansIntelligence.test.mjs.
// Only AuthContext, fetch, and the WebLLM browser-engine factory are replaced: everything else (the real
// providers/index.js barrel, the real GroqProvider, the real WebLLMProvider state machine, the real
// intelligenceContext builder) runs as shipped. The engine factory is faked because jsdom cannot run a real
// Worker or download a real model - that logic is already covered without any DOM in
// tests/intelligenceProviders.test.mjs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (!(k in globalThis)) { try { Object.defineProperty(globalThis, k, { get: () => dom.window[k], configurable: true }); } catch { /* not copyable */ } }
}
for (const k of ['window', 'document', 'navigator']) {
  try { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); } catch { /* not copyable */ }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.CustomEvent = window.CustomEvent;
window.scrollTo = () => {};
window.scrollBy = () => {};
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

// A minimal-but-complete analysis so `data` becomes truthy and the Advisor unlocks.
const analysis = () => ({
  health: {
    composite_score: 62.4, grade: { grade: 'C', label: 'Fair', emoji: '🟠' },
    ratios: { savings_rate: { value: 18.2, unit: '%', score: 58, status: 'fair', benchmark: 'Ideal: ≥30%', description: 'x', weight_pct: 29.4 } },
    unavailable_ratios: [], unavailable_reasons: {}, strengths: [], weaknesses: [], recommendations: [],
    metadata: { monthly_income: 52000, avg_monthly_net_spending: 42500, period: { months: 5, first_month: '2026-05', last_month: '2026-09' }, ratios_used: 1, ratios_total: 6 },
    breakdown: { basis: 'x', spending_by_category: [{ category: 'Rent', net_spending: 100000, share_pct: 47.1 }], other_net_spending: 0, categories_total: 100000 }
  },
  forecast: {
    historical: [], forecast: { months: ['Oct 2026', 'Nov 2026', 'Dec 2026'], income: { predictions: [52000, 52000, 52000], r2: 0.2, model: 'linear_regression' }, expenses: { predictions: [44000, 45000, 46000], r2: 0.2, model: 'linear_regression' }, net: [8000, 7000, 6000] },
    insights: { income_momentum: 'stable', expense_momentum: 'rising', projected_savings_3m: 21000 }
  },
  anomalies: { total_flagged: 0, anomalies: [], contamination_rate: 0.1 },
  clusters: { clusters: [], model_metrics: {}, insights: {} },
  plan: { plan_title: 'Plan', plan_summary: 'summary', steps: [], step_count: 0, forecast_caveats: [] },
  metadata: { transaction_count: 10, models_run: [], rule_engines_run: [], elapsed_ms: 1, errors: null }
});

let planChatBodies = [];
const json = (status, b) => ({ status, ok: status >= 200 && status < 300, json: async () => b });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method ?? 'GET').toUpperCase();
  if (/\/ml\/analyze(?:\?|$)/.test(u)) return json(200, analysis());
  if (/\/plan-chat$/.test(u) && method === 'POST') { planChatBodies.push(JSON.parse(opts.body)); return json(200, { reply: 'REPLY(fast)' }); }
  if (/\/transactions$/.test(u) && method === 'GET') return json(200, [{ id: 't1', title: 'Salary', amount: 52000, date: '2026-09-01', type: 'income', category: 'Salary' }]);
  if (/\/emergency-fund$/.test(u)) return json(200, { configured: false, currentAmount: null, targetAmount: null, createdAt: null, updatedAt: null });
  return json(200, []);
};

const { createServer } = await import('vite');

// Only createBrowserWebLLMEngine is faked (jsdom has no real Worker/WebGPU); PROVIDERS,
// loadStoredProvider/saveStoredProvider, createGroqProvider and createWebLLMProvider are the
// REAL exports from the REAL files, so this test exercises Plans.jsx's actual integration code.
const PROVIDERS_STUB = `
export { createGroqProvider } from '/src/intelligence/providers/groqProvider.js';
export { createWebLLMProvider, isWebGpuAvailable, buildLocalMessages, LOCAL_MODEL, WEBLLM_STATUS } from '/src/intelligence/providers/webllmProvider.js';
export const PROVIDERS = { GROQ: 'groq', LOCAL: 'local' };
export const DEFAULT_PROVIDER = PROVIDERS.GROQ;
const KEY_PREFIX = 'finsphere:intelligence-provider:';
export const providerStorageKey = (userId) => \`\${KEY_PREFIX}\${userId}\`;
export function loadStoredProvider(userId) {
  if (userId == null) return DEFAULT_PROVIDER;
  try { const v = window.localStorage.getItem(providerStorageKey(userId)); return v === PROVIDERS.LOCAL ? PROVIDERS.LOCAL : DEFAULT_PROVIDER; } catch { return DEFAULT_PROVIDER; }
}
export function saveStoredProvider(userId, provider) {
  if (userId == null) return;
  try { window.localStorage.setItem(providerStorageKey(userId), provider === PROVIDERS.LOCAL ? PROVIDERS.LOCAL : PROVIDERS.GROQ); } catch { /* ignored */ }
}
export async function createBrowserWebLLMEngine(modelId, opts) {
  return globalThis.__fakeCreateEngine(modelId, opts);
}
`;
const STUBS = {
  AuthContext: 'export const useAuth = () => ({ invalidateSession: () => {}, user: { id: 7 } });',
  'providers/index.js': PROVIDERS_STUB
};
const HARNESS = `
import { useState, createElement as h } from 'react';
import { FinanceProvider } from '/src/context/FinanceContext.jsx';
import Plans from '/src/pages/Plans.jsx';
export function App() {
  const [view, setView] = useState('plans');
  return h(FinanceProvider, { currentView: view, setCurrentView: setView }, h('div', { 'data-view': view }, h(Plans)));
}`;

const vite = await createServer({
  root: REPO, configFile: false, logLevel: 'error', appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  esbuild: { jsx: 'automatic' },
  plugins: [{
    name: 'provider-selector-test-stubs',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'virtual:selector-harness') return '\0selector-harness';
      if (id.startsWith('.') && id.split('/').pop() === 'AuthContext') return '\0stub:AuthContext';
      if (id.endsWith('/intelligence/providers/index.js')) return '\0stub:providers/index.js';
      return null;
    },
    load(id) {
      if (id === '\0selector-harness') return HARNESS;
      if (id.startsWith('\0stub:')) return STUBS[id.slice('\0stub:'.length)];
      return null;
    }
  }]
});

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) pass++; else { fail++; console.log('FAIL:', name, extra); } };

try {
  const { App } = await vite.ssrLoadModule('virtual:selector-harness');
  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (predicate, ms = 3000) => {
    const start = Date.now();
    while (!predicate() && Date.now() - start < ms) await act(async () => { await tick(25); });
    return predicate();
  };
  const click = (el) => act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick(10); });
  const buttonWithText = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(text));

  const root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(React.createElement(App)); await tick(80); });
  await waitFor(() => document.querySelector('.ai-provider-selector'));

  // ── Provider selector renders, Fast selected by default ───────────────────
  const fastBtn = buttonWithText('Fast');
  const localBtn = buttonWithText('Local');
  ok(document.querySelector('.ai-provider-label')?.textContent === 'AI processing', 'selector: compact "AI processing" label is shown');
  ok(!!fastBtn && !!localBtn, 'selector: both Fast and Local buttons render');
  ok(fastBtn.getAttribute('aria-pressed') === 'true' && localBtn.getAttribute('aria-pressed') === 'false', 'selector: Fast is selected by default');
  ok(document.querySelector('.ai-provider-subtext').textContent === 'Faster responses', 'selector: Fast subtext is shown, with no vendor name');

  // ── Fast mode still calls /plan-chat ───────────────────────────────────────
  const chip = () => [...document.querySelectorAll('.quick-prompt-chip')].find((c) => c.textContent === 'What should I do first?');
  await waitFor(() => chip() && !chip().disabled);
  await click(chip());
  await waitFor(() => planChatBodies.length === 1);
  ok(planChatBodies.length === 1, 'Fast: selecting a quick prompt calls /plan-chat');
  ok(document.querySelector('.plan-chat-body').textContent.includes('REPLY(fast)'), 'Fast: the Groq reply is rendered');

  // ── WebGPU unavailable ──────────────────────────────────────────────────────
  delete window.navigator.gpu;
  await click(localBtn);
  await waitFor(() => document.querySelector('.ai-provider-error'));
  ok(document.querySelector('.ai-provider-error p').textContent === "Local AI isn't available on this device.", 'Local: WebGPU-unavailable message is shown');
  const useFastBtn = buttonWithText('Use Fast AI');
  ok(!!useFastBtn, 'Local: a "Use Fast AI" fallback button is offered');
  ok(planChatBodies.length === 1, 'Local: the unavailable state never silently falls back to Groq on its own');
  await click(useFastBtn);
  await waitFor(() => buttonWithText('Fast').getAttribute('aria-pressed') === 'true');
  ok(buttonWithText('Fast').getAttribute('aria-pressed') === 'true', 'Local: "Use Fast AI" switches the selector back to Fast');

  // ── WebGPU available: loading state, then ready, then a local response ─────
  window.navigator.gpu = {};
  let resolveEngine;
  const engineReady = new Promise((resolve) => { resolveEngine = resolve; });
  let receivedModelId, receivedMessages;
  globalThis.__fakeCreateEngine = async (modelId, opts) => {
    receivedModelId = modelId;
    opts.initProgressCallback({ progress: 0.5, text: 'halfway' });
    await engineReady;
    return {
      chat: { completions: { create: async ({ messages }) => { receivedMessages = messages; return { choices: [{ message: { content: 'Local reply here' } }] }; } } },
      unload: async () => {}
    };
  };
  await click(buttonWithText('Local'));
  await waitFor(() => document.querySelector('.ai-provider-status')?.textContent.includes('Setting up Local AI'));
  ok(document.querySelector('.ai-provider-status').textContent.includes('50%'), 'Local: a loading percentage from initProgressCallback is shown', document.querySelector('.ai-provider-status').textContent);
  ok(typeof receivedModelId === 'string' && receivedModelId.length > 0, 'Local: a real, non-empty model id was requested (but never rendered - see the implementation-leak sweep below)');

  await act(async () => { resolveEngine(); await tick(30); });
  await waitFor(() => document.querySelector('.ai-provider-status')?.textContent.includes('Local AI ready'));
  ok(document.querySelector('.ai-provider-status').textContent.startsWith('Local AI ready'), 'Local: "Local AI ready" is shown once loaded');
  ok(!/All your financial data is processed locally/.test(document.body.textContent), 'Local: the overstated "all data processed locally" claim is never made');
  for (const term of ['WebLLM', 'web-llm', 'SmolLM', 'mlc-ai', 'q4f16', receivedModelId]) {
    ok(!document.body.textContent.includes(term), `Local: implementation detail "${term}" is never rendered in the UI`);
  }

  const chatInput = document.querySelector('[aria-label="Ask the advisor about this analysis"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(chatInput, 'What should I focus on first?');
    chatInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const planChatCountBeforeLocal = planChatBodies.length;
  await click(document.querySelector('.plan-send-btn'));
  await waitFor(() => document.querySelector('.plan-chat-body').textContent.includes('Local reply here'));
  ok(document.querySelector('.plan-chat-body').textContent.includes('Local reply here'), 'Local: the on-device reply is rendered through the same chat UI');
  ok(planChatBodies.length === planChatCountBeforeLocal, 'Local: sending a message in Local mode makes no /plan-chat call');
  ok(receivedMessages[0].role === 'system' && receivedMessages.at(-1).content === 'What should I focus on first?', 'Local: the engine received a system context message plus the real question');

  console.log(`Fast/Local provider selector UI: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await vite.close();
}
