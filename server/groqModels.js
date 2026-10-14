// groqModels.js - which Groq model each feature uses, and the request fields that depend on the model (Issue #81).
//
// This module owns ONLY model selection and model-specific request fields. Everything call-site specific (temperature,
// max_tokens, response_format, prompts, schema validation, provenance) stays where it is.
//
// Defaults are "the default configured model", not a promise about Groq's catalogue: every one can be overridden with an
// environment variable, so a retired model is a configuration change rather than a code change.
//   GROQ_CHAT_MODEL    /api/chat and /api/plan-chat            default openai/gpt-oss-120b
//   GROQ_PARSE_MODEL   statement parsing                        default openai/gpt-oss-20b
//   GROQ_ACTION_MODEL  structured assistant-action extraction   default openai/gpt-oss-120b
//   GROQ_API_BASE      optional; the API base URL (a local stub in tests)   default https://api.groq.com/openai/v1

export const DEFAULT_CHAT_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_PARSE_MODEL = 'openai/gpt-oss-20b';
export const DEFAULT_ACTION_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_GROQ_API_BASE = 'https://api.groq.com/openai/v1';

const pick = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);

export const getChatModel = (env = {}) => pick(env.GROQ_CHAT_MODEL, DEFAULT_CHAT_MODEL);
export const getParseModel = (env = {}) => pick(env.GROQ_PARSE_MODEL, DEFAULT_PARSE_MODEL);
export const getActionModel = (env = {}) => pick(env.GROQ_ACTION_MODEL, DEFAULT_ACTION_MODEL);

// Base URL for every Groq endpoint. Only an http(s) URL is accepted; anything else falls back to the default.
export function groqApiBase(env = {}) {
  const raw = pick(env.GROQ_API_BASE, DEFAULT_GROQ_API_BASE);
  return /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : DEFAULT_GROQ_API_BASE;
}
export const groqChatUrl = (env = {}) => `${groqApiBase(env)}/chat/completions`;

// Model-specific request fields. A GPT-OSS model reasons before it answers and the reasoning counts against max_tokens:
// at its default effort the extractor's ~250-token cap is used up and the JSON is cut off, which Groq reports as HTTP 400
// (json_validate_failed). "low" effort keeps every call comfortably inside its cap. The reasoning text comes back in a
// separate `message.reasoning` field, which no call site reads. Other models get no extra fields.
// Deliberately NOT here: response_format, max_tokens and temperature (they differ per call site).
export function modelRequestFields(model) {
  return /^openai\/gpt-oss-/i.test(String(model ?? '')) ? { reasoning_effort: 'low' } : {};
}
