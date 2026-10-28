// WebLLM Web Worker entry point - the official architecture from @mlc-ai/web-llm 0.2.85:
// CreateWebWorkerMLCEngine (main thread) sends messages here, and WebWorkerMLCEngineHandler runs
// model loading and inference off the React main thread. This file does nothing else; all
// provider logic (status, context building, error handling) lives in ../providers/webllmProvider.js.
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
