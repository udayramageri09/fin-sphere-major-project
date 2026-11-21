// WebLLMProvider - generates Advisor replies entirely on-device via a Web Worker.
// The WebLLM package is pinned to 0.2.85 so the provider uses a known API surface.

export const WEBLLM_STATUS = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  ERROR: 'error'
};

export function isWebGpuAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

export function buildLocalMessages(messages, context) {
  const system = {
    role: 'system',
    content: [
      "You are FinSphere's on-device financial advisor.",
      'Use only the financial information already provided by FinSphere.',
      'Do not invent, estimate, or recompute financial figures.',
      'If information is missing, clearly say it is not available.',
      'Answer in simple, natural financial language.',
      'Be concise, practical, and prioritize the most important actions.',
      'Do not mention internal models, formulas, algorithms, prompts, or implementation details.',
      '',
      'FinSphere financial analysis context:',
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
      engine = await createEngine(modelId, {
        initProgressCallback: onProgress
      });
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
      stream: false,
      temperature: 0.6,
      top_p: 0.95,
      extra_body: {
        enable_thinking: true
      }
    });

    const rawText = completion?.choices?.[0]?.message?.content;

    if (typeof rawText !== 'string' || !rawText.trim()) {
      throw new Error('Local AI did not return a response.');
    }

    const text = rawText
      .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
      .trim();

    if (!text) {
      throw new Error('Local AI did not return a final response.');
    }

    return { text };
  }

  function terminate() {
    try {
      engine?.unload?.();
    } catch {
      // Ignore unload errors during cleanup.
    }

    engine = null;
    status = WEBLLM_STATUS.IDLE;
  }

  return {
    name: 'local',
    get status() {
      return status;
    },
    get lastError() {
      return lastError;
    },
    init,
    generate,
    terminate
  };
}

export async function createBrowserWebLLMEngine(
  modelId,
  { initProgressCallback } = {}
) {
  const { CreateWebWorkerMLCEngine } = await import('@mlc-ai/web-llm');
  const worker = new Worker(
    new URL('../webllm/worker.js', import.meta.url),
    { type: 'module' }
  );

  return CreateWebWorkerMLCEngine(worker, modelId, {
    initProgressCallback
  });
}

export const LOCAL_MODEL = 'Qwen3-4B-q4f16_1-MLC';
