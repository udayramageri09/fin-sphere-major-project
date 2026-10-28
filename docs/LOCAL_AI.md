# Intelligence Providers: Fast (Groq) and Local (WebLLM)

Financial Intelligence's Advisor chat can run on either of two interchangeable providers,
selected by a compact "AI processing" toggle on the Advisor panel. The deterministic financial
analysis itself (health score, forecast, anomalies, clusters, plan) is **always** computed by
FinSphere's existing Python ML service and rule engines, for both providers - neither provider
ever recalculates a figure. A provider's only job is to explain and discuss results that were
already computed.

## Architecture

```
Plans.jsx
    |
    +-- buildIntelligenceContext(data, ...)   compact summary of the current analysis
    |
    +-- provider.generate(history, context)
             |
             +-- GroqProvider  --------> POST /api/plan-chat (server) --------> Groq
             |                           (context argument is ignored; the server
             |                            narrates its own stored analysis snapshot)
             |
             +-- WebLLMProvider --------> Web Worker (worker.js) --------> @mlc-ai/web-llm
                                          (runs entirely on-device, once loaded)
```

- `src/intelligence/providers/index.js` - the only module anything should import from:
  `PROVIDERS`, `DEFAULT_PROVIDER`, `loadStoredProvider`/`saveStoredProvider`, and both provider
  factories. Plans.jsx never imports `groqProvider.js`/`webllmProvider.js` directly.
- `src/intelligence/providers/groqProvider.js` - wraps the existing, unchanged
  `POST /api/plan-chat` endpoint.
- `src/intelligence/providers/webllmProvider.js` - a small idle → loading → ready/error state
  machine around an injected `createEngine` function, plus the real browser factory
  (`createBrowserWebLLMEngine`) that creates the actual Worker.
- `src/intelligence/webllm/worker.js` - the Web Worker entry point
  (`WebWorkerMLCEngineHandler`); all model loading and inference happens here, never on the
  React main thread.
- `src/intelligence/intelligenceContext.js` - builds the compact context (see below).

## WebLLM model

Pinned to **`@mlc-ai/web-llm@0.2.85`** exactly (`--save-exact`, not a caret range -
https://webllm.mlc.ai/docs/user/api_reference.html). A later `npm install` will not silently
pull in a newer major/minor API.

Model: **`SmolLM2-360M-Instruct-q4f16_1-MLC`** (`LOCAL_MODEL` constant in `webllmProvider.js`) -
chosen by inspecting this exact pinned version's own `prebuiltAppConfig.model_list`: it is the
smallest available instruct model (360M parameters, ~376MB VRAM at q4f16_1), not an 8B+ model,
since this is a first implementation meant to load reasonably quickly and run on modest
hardware. It is a single named constant specifically so it can be swapped for a different
prebuilt model later without touching any provider logic.

## WebGPU behavior

Selecting **Local** checks `navigator.gpu`. If it is missing, the page shows "Local AI isn't
available on this device." with a **Use Fast AI** button and never silently falls back to Groq
on its own - the user must choose. If WebGPU is available, it creates (once) a `WebWorkerMLCEngineHandler`-backed
engine via `createBrowserWebLLMEngine`, with WebLLM's own `initProgressCallback` driving a
loading-percentage message, then shows "Local AI ready". The engine is kept alive (in a ref) for
the life of the page - switching between Fast and Local never re-downloads anything - and is
terminated (`engine.unload()`) when the page unmounts. The model is **never** auto-initialized:
not on first opening Financial Intelligence, and not just because Local was the previously saved
preference - only an explicit click on **Local**, in the current session, starts loading it.

## Groq behavior

Unchanged. The Groq API key is never sent to, or read from, the browser - Groq is only ever
called from the server (`server/server.js`'s existing `/plan-chat` route, which narrates its own
server-side stored snapshot of the last analysis). `GroqProvider.generate` sends exactly
`{ messages }` with no client-side context, verified by the existing
`tests/plansIntelligence.test.mjs` assertion that the request body never contains an `mlContext`
key.

## Privacy / data flow

- **Fast**: the conversation (last 12 turns, each ≤2000 characters - the same bound as before) is
  sent to `/plan-chat`, which calls Groq server-side.
- **Local**: nothing is sent to `/plan-chat` or to Groq. The conversation and a compact copy of
  the current analysis are sent only to the in-browser WebLLM worker. Accurate description used
  in the UI and here: **"AI responses are generated on your device using WebLLM."** FinSphere
  never claims "all your financial data is processed locally" - the Python ML service still
  computes the health score, forecast, anomalies and clusters themselves in both modes; only the
  natural-language explanation of those already-computed results runs on-device in Local mode.

### The compact intelligence context

`buildIntelligenceContext(data, { forecastPeriodMonths })` (in `src/intelligence/intelligenceContext.js`)
reads the same `GET /ml/analyze` response shape the existing Plans cards already read, and
returns only: the analysed period, the forecast period, the health score/grade, a short list of
position rows (income, spending, savings rate, DTI, emergency coverage), up to 5 top spending
categories, a forecast trend summary, an anomaly summary (total flagged + up to 3 examples), and
up to 3 risks / 2 opportunities. It never includes the raw transaction list, and every array is
bounded regardless of how large the underlying analysis is - verified in
`tests/intelligenceProviders.test.mjs` with a deliberately oversized (10,000-transaction,
5,000-anomaly) input, where the resulting context still serializes under 5KB.

## Testing

- `npm run test:intelligence-providers` - 14 unit checks (Groq contract, WebLLM contract with a
  mocked engine, WebGPU-unavailable gating, loading/error states, persistence, compact context,
  bounded history). No real GPU, Worker, or model download anywhere in this file.
- `npm run test:provider-selector` - 17 UI checks rendering the real Plans page against the real
  provider code (only the browser engine factory is faked, since jsdom cannot run a real Worker).
- `npm run test:plans` - the pre-existing 80-check Plans/Financial Intelligence regression suite,
  unchanged and still passing (Fast mode is behaviorally identical to before).

## Limitations

- No manual, real-browser, real-GPU verification has been performed as part of this change (see
  the task's own final report for exact manual steps to run before trusting Local mode on a real
  device/GPU). Everything above is verified through jsdom-based UI tests with a faked engine, and
  through unit tests of the provider logic itself - never through an actual WebGPU/model
  download/inference run.
- Streaming is not implemented; `generate()` is non-streaming for both providers, matching the
  existing Advisor UI (a single reply bubble appears once the full answer is ready).
- The local model (360M parameters) is small and may give less detailed answers than Groq for
  complex questions; it is a first implementation, not a claim of equivalent quality.
