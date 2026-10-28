import test from 'node:test';
import assert from 'node:assert/strict';

// A minimal localStorage shim so provider persistence can be tested without jsdom.
class FakeStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}
globalThis.window = { localStorage: new FakeStorage() };

const {
  PROVIDERS, DEFAULT_PROVIDER, providerStorageKey, loadStoredProvider, saveStoredProvider,
  createGroqProvider, createWebLLMProvider, isWebGpuAvailable, buildLocalMessages, LOCAL_MODEL, WEBLLM_STATUS
} = await import('../src/intelligence/providers/index.js');
const { buildIntelligenceContext } = await import('../src/intelligence/intelligenceContext.js');
const { buildChatHistory } = await import('../src/utils/chatHistory.js');

// ── 1. Groq provider contract ────────────────────────────────────────────────
test('GroqProvider calls /plan-chat with the given messages and returns the server reply', async () => {
  const calls = [];
  const guardedFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ reply: 'Focus on your emergency fund first.' }) };
  };
  const provider = createGroqProvider({ guardedFetch, apiUrl: 'https://api.example.test' });
  assert.equal(provider.name, 'groq');
  const result = await provider.generate([{ role: 'user', content: 'What should I focus on?' }], { some: 'context' });
  assert.equal(result.text, 'Focus on your emergency fund first.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/plan-chat');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { messages: [{ role: 'user', content: 'What should I focus on?' }] });
});

test('GroqProvider surfaces the server error message on failure', async () => {
  const guardedFetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'Groq is unavailable' }) });
  const provider = createGroqProvider({ guardedFetch, apiUrl: 'https://api.example.test' });
  await assert.rejects(() => provider.generate([{ role: 'user', content: 'hi' }]), /Groq is unavailable/);
});

// ── 2. WebLLM provider contract with a mocked engine ─────────────────────────
// Never a real engine: createEngine is injected, so no GPU/worker/model download happens here.
// Node 21+ defines its own read-only `navigator` global, so it must be redefined, not assigned.
function fakeGpuNavigator() { Object.defineProperty(globalThis, 'navigator', { value: { gpu: {} }, configurable: true }); }
function noGpuNavigator() { Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true }); }

test('WebLLMProvider initializes the injected engine with the model id and a progress callback', async () => {
  fakeGpuNavigator();
  const progressEvents = [];
  const fakeEngine = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }] }) } }, unload: async () => {} };
  let receivedModelId, receivedCallback;
  const createEngine = async (modelId, opts) => { receivedModelId = modelId; receivedCallback = opts.initProgressCallback; return fakeEngine; };
  const provider = createWebLLMProvider({ createEngine, modelId: LOCAL_MODEL });
  assert.equal(provider.name, 'local');
  assert.equal(provider.status, WEBLLM_STATUS.IDLE);
  const onProgress = (p) => progressEvents.push(p);
  await provider.init(onProgress);
  assert.equal(provider.status, WEBLLM_STATUS.READY);
  assert.equal(receivedModelId, LOCAL_MODEL);
  assert.equal(receivedCallback, onProgress);
});

test('WebLLMProvider.generate sends system context + conversation to the engine and returns its text', async () => {
  fakeGpuNavigator();
  let receivedMessages;
  const fakeEngine = {
    chat: { completions: { create: async ({ messages }) => { receivedMessages = messages; return { choices: [{ message: { content: 'Your savings rate looks healthy.' } }] }; } } },
    unload: async () => {}
  };
  const provider = createWebLLMProvider({ createEngine: async () => fakeEngine, modelId: LOCAL_MODEL });
  await provider.init();
  const context = { healthScore: { value: 72 } };
  const result = await provider.generate([{ role: 'user', content: 'How am I doing?' }], context);
  assert.equal(result.text, 'Your savings rate looks healthy.');
  assert.equal(receivedMessages[0].role, 'system');
  assert.ok(receivedMessages[0].content.includes('72'), 'the compact context is embedded in the system message');
  assert.deepEqual(receivedMessages[1], { role: 'user', content: 'How am I doing?' });
});

test('WebLLMProvider.generate never touches an HTTP fetch - Local mode makes no /plan-chat call', async () => {
  fakeGpuNavigator();
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('fetch should not be called in Local mode'); };
  const fakeEngine = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'local answer' } }] }) } }, unload: async () => {} };
  const provider = createWebLLMProvider({ createEngine: async () => fakeEngine, modelId: LOCAL_MODEL });
  await provider.init();
  const result = await provider.generate([{ role: 'user', content: 'hi' }], {});
  assert.equal(result.text, 'local answer');
  assert.equal(fetchCalled, false, 'no fetch was made');
  delete globalThis.fetch;
});

test('WebLLMProvider.generate refuses to run before init() succeeds', async () => {
  fakeGpuNavigator();
  const provider = createWebLLMProvider({ createEngine: async () => ({}), modelId: LOCAL_MODEL });
  await assert.rejects(() => provider.generate([{ role: 'user', content: 'hi' }]), /not ready/i);
});

test('WebLLMProvider.terminate unloads the engine and resets to idle', async () => {
  fakeGpuNavigator();
  let unloaded = false;
  const fakeEngine = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'x' } }] }) } }, unload: async () => { unloaded = true; } };
  const provider = createWebLLMProvider({ createEngine: async () => fakeEngine, modelId: LOCAL_MODEL });
  await provider.init();
  provider.terminate();
  assert.equal(unloaded, true);
  assert.equal(provider.status, WEBLLM_STATUS.IDLE);
  await assert.rejects(() => provider.generate([{ role: 'user', content: 'hi' }]), /not ready/i);
});

// ── 6. WebGPU unavailable state ───────────────────────────────────────────────
test('WebLLMProvider.init refuses, without calling createEngine, when WebGPU is unavailable', async () => {
  noGpuNavigator();
  assert.equal(isWebGpuAvailable(), false);
  let createEngineCalled = false;
  const provider = createWebLLMProvider({ createEngine: async () => { createEngineCalled = true; return {}; }, modelId: LOCAL_MODEL });
  await assert.rejects(() => provider.init(), (err) => err.code === 'WEBGPU_UNAVAILABLE');
  assert.equal(provider.status, WEBLLM_STATUS.ERROR);
  assert.equal(createEngineCalled, false, 'the model is never downloaded when WebGPU is unavailable');
});

// ── 7. WebLLM loading/error state ─────────────────────────────────────────────
test('WebLLMProvider surfaces a loading state, then an error state, when the engine fails to load', async () => {
  fakeGpuNavigator();
  let sawLoading = false;
  const provider = createWebLLMProvider({
    createEngine: async () => {
      sawLoading = provider.status === WEBLLM_STATUS.LOADING;
      throw new Error('model download failed');
    },
    modelId: LOCAL_MODEL
  });
  await assert.rejects(() => provider.init(), /model download failed/);
  assert.equal(sawLoading, true, 'status was LOADING while createEngine was in flight');
  assert.equal(provider.status, WEBLLM_STATUS.ERROR);
  assert.equal(provider.lastError.message, 'model download failed');
});

// ── 3 & 8. Provider selection + persistence ───────────────────────────────────
test('provider defaults to groq and persists per user id', () => {
  assert.equal(DEFAULT_PROVIDER, PROVIDERS.GROQ);
  assert.equal(loadStoredProvider(42), PROVIDERS.GROQ, 'no stored preference yet -> default');

  saveStoredProvider(42, PROVIDERS.LOCAL);
  assert.equal(loadStoredProvider(42), PROVIDERS.LOCAL, 'Local is restored for the same user');
  assert.equal(loadStoredProvider(99), PROVIDERS.GROQ, "a different user's default is unaffected");

  assert.equal(window.localStorage.getItem(providerStorageKey(42)), 'local');
  assert.ok(providerStorageKey(42).startsWith('finsphere:intelligence-provider:'));

  saveStoredProvider(42, PROVIDERS.GROQ);
  assert.equal(loadStoredProvider(42), PROVIDERS.GROQ, 'switching back to Fast persists too');
});

test('provider persistence never throws when storage is unavailable', () => {
  const realWindow = globalThis.window;
  globalThis.window = undefined;
  assert.doesNotThrow(() => saveStoredProvider(1, PROVIDERS.LOCAL));
  assert.equal(loadStoredProvider(1), PROVIDERS.GROQ);
  globalThis.window = realWindow;
});

// ── 9. Intelligence context is compact ────────────────────────────────────────
test('buildIntelligenceContext never includes the raw transaction array and stays small even with oversized inputs', () => {
  const hugeAnomalies = Array.from({ length: 5000 }, (_, i) => ({ title: `Anomaly ${i}`, amount: -i, reason: 'test', severity: 'low' }));
  const hugeCategories = Array.from({ length: 5000 }, (_, i) => ({ category: `Category ${i}`, net_spending: -i, share_pct: 0.01 }));
  const data = {
    // A raw transaction list should never appear in the output even if present on the input.
    transactions: Array.from({ length: 10000 }, (_, i) => ({ id: i, title: 'Raw transaction', amount: -i })),
    health: {
      composite_score: 72, grade: { grade: 'B', label: 'Good' },
      metadata: { monthly_income: 50000, avg_monthly_net_spending: 30000, period: { months: 6, first_month: '2026-01', last_month: '2026-06' }, ratios_used: 5, ratios_total: 6 },
      ratios: { savings_rate: { value: 20, benchmark: 'Good' } },
      breakdown: { spending_by_category: hugeCategories }
    },
    forecast: { insights: { income_momentum: 'stable', expense_momentum: 'rising', projected_savings_3m: 15000 } },
    anomalies: { total_flagged: hugeAnomalies.length, anomalies: hugeAnomalies },
    plan: { steps: [{ kind: 'risk', step_id: 'r1', title: 'High DTI', expected_outcome: 'Reduce debt load' }] },
    metadata: { errors: {} }
  };
  const context = buildIntelligenceContext(data, { forecastPeriodMonths: 6 });
  assert.equal(context.forecastPeriodMonths, 6);
  assert.equal(context.healthScore.value, 72);
  assert.ok(!('transactions' in context), 'the raw transaction array is never copied into the context');
  assert.ok(context.topSpendingCategories.length <= 5, 'categories are bounded to a small count regardless of input size');
  assert.ok(context.anomalySummary.examples.length <= 3, 'anomaly examples are bounded to a small count regardless of input size');
  assert.equal(context.anomalySummary.totalFlagged, 5000, 'the total count is kept even though examples are bounded');
  const serialized = JSON.stringify(context);
  assert.ok(serialized.length < 5000, `context should stay compact; was ${serialized.length} bytes`);
});

test('buildIntelligenceContext returns null before any analysis has run', () => {
  assert.equal(buildIntelligenceContext(null), null);
  assert.equal(buildIntelligenceContext(undefined), null);
});

// ── 10. Conversation history remains bounded ──────────────────────────────────
test('buildLocalMessages only adds one system message and never expands the given (already-bounded) history', () => {
  const history = buildChatHistory(
    Array.from({ length: 50 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` })),
    'final question'
  );
  assert.ok(history.length <= 12, 'buildChatHistory already bounds the turns sent to any provider');
  const localMessages = buildLocalMessages(history, { healthScore: { value: 50 } });
  assert.equal(localMessages.length, history.length + 1, 'exactly one system message is prepended');
  assert.equal(localMessages[0].role, 'system');
  assert.deepEqual(localMessages.slice(1), history, 'the bounded history itself is passed through unchanged');
});
