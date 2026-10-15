// Groq request-shape tests (Issue #81).
//
//   npm --prefix server run test:groq        (or: node server/tests/groq.test.mjs)
//
// Starts the real server.js against a throwaway PostgreSQL database (`finsphere_groq_<pid>`), with GROQ_API_BASE pointing at a
// STUB Groq endpoint started here (so no request ever leaves the machine and no real key is used), and ML_SERVICE_URL at a stub
// analytics service. The stub records every outbound request body, which is what these tests check. Nothing touches the
// database named in DATABASE_URL.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DEFAULT_ACTION_MODEL, DEFAULT_CHAT_MODEL, DEFAULT_PARSE_MODEL, getActionModel, getChatModel, getParseModel, groqApiBase, groqChatUrl, modelRequestFields,
} from '../groqModels.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(SERVER_DIR, 'package.json'));
const pg = require('pg');
const dotenv = require('dotenv');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) pass++; else { fail++; console.log('FAIL:', name, extra); } };

// ── pure units ──────────────────────────────────────────────────────────────────────────────────────────────────────
ok(DEFAULT_CHAT_MODEL === 'openai/gpt-oss-120b' && DEFAULT_PARSE_MODEL === 'openai/gpt-oss-20b' && DEFAULT_ACTION_MODEL === 'openai/gpt-oss-120b', 'defaults: chat 120b, parse 20b, action 120b');
ok(getChatModel({}) === DEFAULT_CHAT_MODEL && getParseModel({}) === DEFAULT_PARSE_MODEL && getActionModel({}) === DEFAULT_ACTION_MODEL, 'models: defaults with no environment');
ok(getChatModel({ GROQ_CHAT_MODEL: '  my-chat  ' }) === 'my-chat' && getParseModel({ GROQ_PARSE_MODEL: 'my-parse' }) === 'my-parse' && getActionModel({ GROQ_ACTION_MODEL: 'my-action' }) === 'my-action', 'models: overrides, trimmed');
ok(getChatModel({ GROQ_CHAT_MODEL: '   ' }) === DEFAULT_CHAT_MODEL && getChatModel({ GROQ_CHAT_MODEL: '' }) === DEFAULT_CHAT_MODEL, 'models: a blank override means the default');
ok(JSON.stringify(modelRequestFields('openai/gpt-oss-120b')) === '{"reasoning_effort":"low"}' && JSON.stringify(modelRequestFields('openai/gpt-oss-20b')) === '{"reasoning_effort":"low"}', 'fields: GPT-OSS gets reasoning_effort low');
ok(['llama-3.3-70b-versatile', 'qwen/qwen3.8-27b', 'my-model', '', undefined, null].every((m) => Object.keys(modelRequestFields(m)).length === 0), 'fields: any other model gets nothing');
ok(JSON.stringify(Object.keys(modelRequestFields('openai/gpt-oss-120b'))) === '["reasoning_effort"]', 'fields: never response_format / max_tokens / temperature');
ok(groqChatUrl({}) === 'https://api.groq.com/openai/v1/chat/completions', 'url: the default is the real Groq API');
ok(groqChatUrl({ GROQ_API_BASE: 'http://127.0.0.1:9/v1/' }) === 'http://127.0.0.1:9/v1/chat/completions', 'url: GROQ_API_BASE override, trailing slash tolerated');
ok(groqApiBase({ GROQ_API_BASE: 'file:///etc/passwd' }) === 'https://api.groq.com/openai/v1' && groqApiBase({ GROQ_API_BASE: 'javascript:1' }) === 'https://api.groq.com/openai/v1', 'url: only http(s) is accepted');

// ── servers ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const envFile = path.join(SERVER_DIR, '.env');
const baseUrl = process.env.DATABASE_URL ?? (fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)).DATABASE_URL : undefined);
if (!baseUrl) { console.error('DATABASE_URL is not set (environment or server/.env).'); process.exit(2); }
const urlFor = (db) => { const u = new URL(baseUrl); u.pathname = '/' + db; return u.toString(); };
const DB = `finsphere_groq_${process.pid}`;
const admin = new pg.Client({ connectionString: urlFor('postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);

const PORT = 5081, GROQ_PORT = 5082, ML_PORT = 5083;
const base = `http://localhost:${PORT}/api`;
const SECRET_STATEMENT = 'ZEBRA-STATEMENT-MARKER-4242';
const SECRET_REASONING = 'SECRET-REASONING-TRACE';

const groq = { mode: 'ok', requests: [] };
const groqServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    groq.requests.push({ url: req.url, auth: req.headers.authorization, body: parsed });
    const system = parsed.messages?.[0]?.content ?? '';
    const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (groq.mode === '404') return send(404, { error: { code: 'model_not_found', message: 'The model does not exist' } });
    if (groq.mode === '429') return send(429, { error: { code: 'rate_limit_exceeded', message: 'slow down' } });
    if (groq.mode === 'leak') return send(400, { error: { code: 'json_validate_failed', message: `echo: ${SECRET_STATEMENT}`, failed_generation: `[{"title":"${SECRET_STATEMENT}"}]` } });
    if (groq.mode === 'malformed') return send(200, { choices: [{ message: { content: '   ' }, finish_reason: 'length' }] });
    if (groq.mode === 'nochoices') return send(200, {});
    let content;
    if (parsed.response_format) {
      content = JSON.stringify({ intent: 'create_liability', amount: { text: '5 lakh' }, direction: null, title: null, target: { text: 'loan from sbi' }, date: null, month: null, rate: null, payment: null, term: null, missing: [], ambiguous: [] });
    } else if (/expert financial tool/.test(system)) {
      content = JSON.stringify([{ title: 'Salary', amount: 60000, date: '2026-09-01', type: 'income', category: 'Salary' }, { title: 'Rent', amount: -18000, date: '2026-09-03', type: 'expense', category: 'Rent' }]);
    } else if (/Plan Advisor/.test(system)) {
      content = 'GROQ-PLAN-REPLY';
    } else {
      content = 'GROQ-CHAT-REPLY';
    }
    send(200, { choices: [{ message: { content, reasoning: SECRET_REASONING }, finish_reason: 'stop' }], usage: { completion_tokens: 100 } });
  });
});
const mlServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      health: { composite_score: 71.5, grade: { grade: 'B' }, ratios: { savings_rate: { value: 25 } }, strengths: [], weaknesses: [] },
      forecast: { insights: { income_momentum: 'stable', expense_momentum: 'stable', projected_savings_3m: 1000 } },
      anomalies: { total_flagged: 0, anomalies: [] }, clusters: { clusters: [], insights: {} },
      plan: { plan_summary: 'STUB-PLAN-SUMMARY', step_count: 1, steps: [{ priority: 'high', title: 'Step', description: 'd' }], forecast_caveats: [] },
      metadata: { transaction_count: 1, errors: null },
    }));
  });
});
await new Promise((resolve) => groqServer.listen(GROQ_PORT, '127.0.0.1', resolve));
await new Promise((resolve) => mlServer.listen(ML_PORT, '127.0.0.1', resolve));

let server = null, serverOut = '', exitCode = null;
async function startServer(extraEnv = {}) {
  serverOut = ''; exitCode = null;
  const env = {
    ...process.env, DATABASE_URL: urlFor(DB), PORT: String(PORT), JWT_SECRET: 'g'.repeat(40), GROQ_API_KEY: 'test-key-not-real',
    GROQ_API_BASE: `http://127.0.0.1:${GROQ_PORT}/v1`, ML_SERVICE_URL: `http://127.0.0.1:${ML_PORT}`,
  };
  for (const k of ['NODE_ENV', 'CORS_ORIGINS', 'TRUST_PROXY', 'FINSPHERE_TEST_UPLOAD_LIMIT', 'GROQ_CHAT_MODEL', 'GROQ_PARSE_MODEL', 'GROQ_ACTION_MODEL', 'ASSISTANT_ACTION_LLM']) delete env[k];
  Object.assign(env, extraEnv);
  server = spawn(process.execPath, ['server.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  server.on('exit', (code) => { exitCode = code ?? 'signal'; });
  for (let i = 0; i < 80; i++) { try { await fetch(`${base}/auth/verify`); return true; } catch { await sleep(250); } }
  return false;
}
async function stopServer() {
  if (server && exitCode === null) { server.kill(); for (let i = 0; i < 40 && exitCode === null; i++) await sleep(100); }
}
async function call(cookie, method, p, body) {
  const r = await fetch(base + p, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}
let userSeq = 0;
async function newUser() {
  userSeq += 1;
  const email = `groq-${process.pid}-${userSeq}@example.com`;
  const password = 'groq-test-password-1';
  await call(null, 'POST', '/auth/register', { email, password });
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const today = new Date().toISOString().slice(0, 10);
const ask = (cookie, text) => call(cookie, 'POST', '/chat', { messages: [{ role: 'user', content: text }], localDate: today });
const planChat = (cookie) => call(cookie, 'POST', '/plan-chat', { messages: [{ role: 'user', content: 'Why is this my top action?' }] });
// These tests are about the model request, and they deliberately import the same statement again and again, so they ask for the
// explicit legacy behaviour (no duplicate check). The duplicate protection itself is tested in importDuplicatesServer.test.mjs.
const parse = (cookie, text) => call(cookie, 'POST', '/transactions/parse-statement?duplicates=allow', { text });
const lastBody = () => groq.requests.at(-1)?.body;
const reset = () => { groq.requests.length = 0; groq.mode = 'ok'; };
const STATEMENT = `01/09/2026 Salary credit 60000.00 CR\n03/09/2026 Rent payment 18000.00 DR\n05/09/2026 ${SECRET_STATEMENT} 450.00 DR`;

async function run() {
  ok(await startServer(), 'server starts (defaults)', serverOut);
  const A = await newUser();
  await call(A, 'POST', '/transactions', { title: 'Lunch', amount: 450, type: 'expense', date: today });

  // ═══ /api/chat ═══════════════════════════════════════════════════════════════════════════════════════════════════
  reset();
  let r = await ask(A, 'How am I doing this month?');
  let b = lastBody();
  ok(groq.requests.length === 1 && groq.requests[0].url === '/v1/chat/completions', 'chat: one request to the configured base', String(groq.requests.length));
  ok(groq.requests[0].auth === 'Bearer test-key-not-real', 'chat: the key is sent as a bearer token');
  ok(b.model === 'openai/gpt-oss-120b', '1. chat uses openai/gpt-oss-120b by default', b.model);
  ok(b.reasoning_effort === 'low', '2. chat includes reasoning_effort: low');
  ok(b.temperature === 0.4 && b.max_tokens === 500, '3. chat keeps temperature 0.4 and max_tokens 500', `${b.temperature} ${b.max_tokens}`);
  ok(!('response_format' in b), '4. chat has no response_format');
  ok(b.messages[0].role === 'system' && b.messages.at(-1).content === 'How am I doing this month?' && !('tools' in b), 'chat: system prompt + the conversation, no tools');
  ok(r.status === 200 && r.json.reply === 'GROQ-CHAT-REPLY', 'chat: the provider reply is used', r.text.slice(0, 120));
  ok(!r.text.includes(SECRET_REASONING), 'chat: the reasoning trace is never returned');

  // ═══ /api/plan-chat ══════════════════════════════════════════════════════════════════════════════════════════════
  reset();
  r = await call(A, 'GET', '/ml/analyze');
  ok(r.status === 200 && groq.requests.length === 0, 'analyze: makes no Groq request');
  r = await planChat(A);
  b = lastBody();
  ok(groq.requests.length === 1 && b.model === 'openai/gpt-oss-120b', '5. plan-chat uses openai/gpt-oss-120b', b?.model);
  ok(b.reasoning_effort === 'low', '6. plan-chat includes reasoning_effort: low');
  ok(b.temperature === 0.4 && b.max_tokens === 600, '7. plan-chat keeps temperature 0.4 and max_tokens 600', `${b.temperature} ${b.max_tokens}`);
  ok(!('response_format' in b), 'plan-chat has no response_format');
  ok(/Plan Advisor/.test(b.messages[0].content) && /RULE-BASED/.test(b.messages[0].content), 'plan-chat: the server-built prompt is unchanged');
  ok(r.json.reply === 'GROQ-PLAN-REPLY' && !r.text.includes(SECRET_REASONING), 'plan-chat: the provider reply is used and no reasoning is returned', r.text.slice(0, 120));

  // ═══ statement parsing ═══════════════════════════════════════════════════════════════════════════════════════════
  reset();
  r = await parse(A, STATEMENT);
  b = lastBody();
  ok(groq.requests.length === 1 && b.model === 'openai/gpt-oss-20b', '8. statement parsing uses openai/gpt-oss-20b', b?.model);
  ok(b.reasoning_effort === 'low', '9. statement parsing includes reasoning_effort: low');
  ok(!('response_format' in b) && !('max_tokens' in b), '10. statement parsing has NO response_format and NO max_tokens', Object.keys(b).join());
  ok(b.temperature === 0.1, 'statement parsing keeps temperature 0.1');
  ok(b.messages.at(-1).content === STATEMENT && /expert financial tool/.test(b.messages[0].content), 'statement parsing: the prompt and the statement are sent unchanged');
  ok(r.status === 200 && r.json.success === true && r.json.count === 2, 'statement parsing: the provider rows are saved', r.text.slice(0, 160));
  const saved = (await call(A, 'GET', '/transactions')).json.filter((t) => ['Salary', 'Rent'].includes(t.title));
  ok(saved.length === 2 && saved.every((t) => t.classification === 'unknown'), 'statement parsing: saved rows are classified "unknown"', JSON.stringify(saved.map((t) => t.classification)));

  // ═══ the action extractor is unchanged ═══════════════════════════════════════════════════════════════════════════
  reset();
  r = await ask(A, 'took a 5 lakh loan from sbi last year');
  b = lastBody();
  ok(groq.requests.length === 1 && b.model === 'openai/gpt-oss-120b' && b.reasoning_effort === 'low' && b.temperature === 0 && b.max_tokens === 250 && b.response_format?.type === 'json_object', '16. extractor request: gpt-oss-120b, low effort, temperature 0, 250 tokens, json_object', JSON.stringify(b && { ...b, messages: undefined }));
  ok(b.messages.length === 2 && !('tools' in b), '16. extractor sends only the system prompt and the one message');
  ok(r.json.action?.kind === 'create_liability' && r.json.action.status === 'needs_clarification', '16. extractor result still becomes a draft that asks for the type, nothing is written', r.text.slice(0, 160));
  ok((await call(A, 'GET', '/liabilities')).json.length === 0, '16. no liability is created without confirmation');
  await call(A, 'POST', `/assistant/actions/${r.json.action.proposalId}/cancel`);

  // ═══ provider failures fall back cleanly ═════════════════════════════════════════════════════════════════════════
  for (const mode of ['404', '429', 'malformed', 'nochoices']) {
    reset(); groq.mode = mode;
    r = await ask(A, 'How am I doing this month?');
    ok(r.status === 200 && typeof r.json.reply === 'string' && r.json.reply.length > 0 && r.json.reply !== 'GROQ-CHAT-REPLY', `14. chat: provider ${mode} -> deterministic fallback`, r.text.slice(0, 100));
    r = await planChat(A);
    ok(r.status === 200 && r.json.reply.startsWith('STUB-PLAN-SUMMARY'), `14. plan-chat: provider ${mode} -> plan summary fallback`, r.text.slice(0, 100));
    r = await parse(A, STATEMENT);
    ok(r.status !== 500 && r.json !== null, `14. statement parsing: provider ${mode} -> no 500, rule-based parser answers`, `${r.status} ${r.text.slice(0, 100)}`);
  }
  reset(); groq.mode = '404';
  r = await ask(A, 'took a 5 lakh loan from sbi last year');
  ok(r.status === 200 && !r.json.action, '14. extractor: provider 404 -> no action, normal answer', r.text.slice(0, 100));

  // ═══ statement content never reaches the log ═════════════════════════════════════════════════════════════════════
  reset(); groq.mode = 'leak';
  serverOut = '';
  r = await parse(A, STATEMENT);
  await sleep(300);
  ok(r.status !== 500, '15. a provider error on a statement is not a 500', String(r.status));
  ok(!serverOut.includes(SECRET_STATEMENT) && !serverOut.includes('failed_generation') && !serverOut.includes('json_validate_failed') && !serverOut.includes('echo:'), '15. statement text and the provider error body are NOT logged', serverOut.slice(-400));
  ok(/Groq API Error during parsing: status 400/.test(serverOut), '15. only the status is logged', serverOut.slice(-300));
  ok(!serverOut.includes('test-key-not-real'), 'the key is never logged');
  reset(); groq.mode = 'nochoices';
  serverOut = '';
  await parse(A, STATEMENT);
  await sleep(300);
  ok(!serverOut.includes(SECRET_STATEMENT) && !/\n\s+at \S+ \(/.test(serverOut), '15. a malformed provider reply logs no stack trace and no statement text (an error NAME is fine)', serverOut.slice(-300));

  ok(exitCode === null, 'server still running', serverOut.slice(-300));

  // ═══ overrides ═══════════════════════════════════════════════════════════════════════════════════════════════════
  await stopServer();
  ok(await startServer({ GROQ_CHAT_MODEL: 'my-chat-model', GROQ_PARSE_MODEL: 'my-parse-model', GROQ_ACTION_MODEL: 'my-action-model' }), 'server restarts with model overrides', serverOut);
  const B = await newUser();
  reset();
  await ask(B, 'How am I doing this month?');
  b = lastBody();
  ok(b.model === 'my-chat-model', '11. GROQ_CHAT_MODEL override works for chat', b?.model);
  ok(!('reasoning_effort' in b) && b.temperature === 0.4 && b.max_tokens === 500, '13. a non-GPT-OSS chat model gets NO reasoning_effort (other fields unchanged)', JSON.stringify({ ...b, messages: undefined }));
  await call(B, 'GET', '/ml/analyze');
  reset();
  await planChat(B);
  b = lastBody();
  ok(b.model === 'my-chat-model' && !('reasoning_effort' in b), '11. GROQ_CHAT_MODEL override also applies to plan-chat (no reasoning field)', JSON.stringify({ ...b, messages: undefined }));
  reset();
  await parse(B, STATEMENT);
  b = lastBody();
  ok(b.model === 'my-parse-model', '12. GROQ_PARSE_MODEL override works', b?.model);
  ok(!('reasoning_effort' in b) && !('response_format' in b) && !('max_tokens' in b) && b.temperature === 0.1, '13. a non-GPT-OSS parse model gets NO reasoning_effort (and still no response_format / max_tokens)', JSON.stringify({ ...b, messages: undefined }));
  reset();
  await ask(B, 'took a 5 lakh loan from sbi last year');
  b = lastBody();
  ok(b.model === 'my-action-model' && !('reasoning_effort' in b) && b.max_tokens === 250 && b.response_format?.type === 'json_object', '16. GROQ_ACTION_MODEL override still works for the extractor', JSON.stringify({ ...b, messages: undefined }));

  await stopServer();
  ok(await startServer({ GROQ_CHAT_MODEL: 'openai/gpt-oss-20b' }), 'server restarts with a GPT-OSS chat override', serverOut);
  const C = await newUser();
  reset();
  await ask(C, 'How am I doing this month?');
  b = lastBody();
  ok(b.model === 'openai/gpt-oss-20b' && b.reasoning_effort === 'low', '11. a GPT-OSS override keeps reasoning_effort: low', JSON.stringify({ ...b, messages: undefined }));

  // no key: nothing is sent at all
  await stopServer();
  ok(await startServer({ GROQ_API_KEY: '' }), 'server restarts without a key', serverOut);
  const D = await newUser();
  reset();
  r = await ask(D, 'How am I doing this month?');
  await parse(D, STATEMENT);
  ok(groq.requests.length === 0 && r.status === 200, 'without a key no Groq request is made');
}

try {
  await run();
} finally {
  await stopServer();
  groqServer.close();
  mlServer.close();
  await sleep(500);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await admin.end().catch(() => {});
}
console.log(`groq tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
