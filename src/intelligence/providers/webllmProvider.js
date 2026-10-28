// WebLLMProvider - generates Advisor replies entirely on-device via a Web Worker running
// @mlc-ai/web-llm (pinned to 0.2.85 - https://webllm.mlc.ai/docs/user/api_reference.html; do not
// silently upgrade to a newer major/minor API). Once the model is loaded, no network call is made
// for inference: nothing about the conversation, or the compact analysis context, leaves this
// device in Local mode.
//
// `createEngine` is injected so this module's own logic (status machine, WebGPU gating, message
// shaping, error handling) can be unit tested with a fake engine - never a real GPU, worker or
// model download inside a test. createBrowserWebLLMEngine (below) is the real factory, used only
// outside tests.

export const WEBLLM_STATUS = { IDLE: 'idle', LOADING: 'loading', READY: 'ready', ERROR: 'error' };

export function isWebGpuAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

// system instructions + the compact FinSphere analysis context, then the bounded conversation
// turns already built by the caller (see src/utils/chatHistory.js - the same bound Groq uses).
// The model's job is to explain and discuss these already-computed figures, never to recalculate
// or invent one.
export function buildLocalMessages(messages, context) {
  const system = {
    role: 'system',
    content: [
      "You are FinSphere's on-device financial advisor.",
      'Only explain and discuss the figures already given to you below - never invent, recompute, or guess a number.',
      'If something is not in the context, say it is not available rather than estimating it.',
      'Be concise and practical.',
      '',
      'FinSphere analysis (already computed, do not recalculate):',
      JSON.stringify(context ?? {})
    ].join('\n')
  };
  return [system, ...(messages || [])];
}

export function createWebLLMProvider({ createEngine, modelId }) {
  let engine = null;
  let status = WEBLLM_STATUS.IDLE;
  let lastError = null;

  async function init(onProgress) {
    if (status === WEBLLM_STATUS.READY) return;
    if (!isWebGpuAvailable()) {
      const error = new Error("Local AI isn't available on this device.");
      error.code = 'WEBGPU_UNAVAILABLE';
      status = WEBLLM_STATUS.ERROR;
      lastError = error;
      throw error;
    }
    status = WEBLLM_STATUS.LOADING;
    lastError = null;
    try {
      engine = await createEngine(modelId, { initProgressCallback: onProgress });
      status = WEBLLM_STATUS.READY;
    } catch (err) {
      status = WEBLLM_STATUS.ERROR;
      lastError = err instanceof Error ? err : new Error(String(err));
      engine = null;
      throw lastError;
    }
  }

  async function generate(messages, context) {
    if (status !== WEBLLM_STATUS.READY || !engine) {
      throw new Error('Local AI is not ready yet.');
    }
    const completion = await engine.chat.completions.create({
      messages: buildLocalMessages(messages, context),
      stream: false
    });
    const text = completion?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Local AI did not return a response.');
    return { text };
  }

  function terminate() {
    try { engine?.unload?.(); } catch { /* ignored */ }
    engine = null;
    status = WEBLLM_STATUS.IDLE;
  }

  return {
    name: 'local',
    get status() { return status; },
    get lastError() { return lastError; },
    init,
    generate,
    terminate
  };
}

// The real browser factory: a dedicated module Worker running webllm/worker.js (the official
// WebLLM worker architecture), talked to via @mlc-ai/web-llm's own CreateWebWorkerMLCEngine.
// Dynamically imported so nothing here loads the package, spins up a worker, or touches the GPU
// until a caller actually invokes it (i.e. only when the user selects Local).
export async function createBrowserWebLLMEngine(modelId, { initProgressCallback } = {}) {
  const { CreateWebWorkerMLCEngine } = await import('@mlc-ai/web-llm');
  const worker = new Worker(new URL('../webllm/worker.js', import.meta.url), { type: 'module' });
  return CreateWebWorkerMLCEngine(worker, modelId, { initProgressCallback });
}

// Single constant so the model can be swapped later without rewriting this provider. Chosen from
// @mlc-ai/web-llm 0.2.85's own prebuiltAppConfig.model_list: the smallest available instruct
// model (SmolLM2, 360M parameters, ~376MB VRAM at q4f16_1) rather than an 8B+ model, since this
// is a first implementation meant to load quickly and run on modest hardware.
export const LOCAL_MODEL = 'SmolLM2-360M-Instruct-q4f16_1-MLC';
