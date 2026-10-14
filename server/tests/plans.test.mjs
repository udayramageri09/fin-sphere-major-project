// Plans / Financial Intelligence trust-boundary tests (Issue #80).
//
//   npm --prefix server run test:plans        (or: node server/tests/plans.test.mjs)
//
// Same safety model as chat.test.mjs: it creates and drops its own throwaway PostgreSQL database (`finsphere_plans_<pid>`)
// on the server named by DATABASE_URL, starts the real server.js with NO language-model key, and points ML_SERVICE_URL at
// a STUB analytics service started here, so the test sees exactly what Express sends to FastAPI and controls what comes
// back. Nothing touches the database named in DATABASE_URL.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSnapshotStore, sanitizeAnalysis, SNAPSHOT_TTL_MS, SNAPSHOT_MAX_ENTRIES } from '../planSnapshot.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(SERVER_DIR, 'package.json'));
const pg = require('pg');
const dotenv = require('dotenv');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) pass++; else { fail++; console.log('FAIL:', name, extra); } };

// ── pure units: the snapshot store and the sanitiser (no server needed) ────────────────────────────────────────────
{
  let clock = 1_000_000;
  const store = createSnapshotStore({ ttlMs: 1000, maxEntries: 3, now: () => clock });
  ok(SNAPSHOT_TTL_MS === 30 * 60 * 1000 && SNAPSHOT_MAX_ENTRIES === 1000, 'snapshot: defaults are 30 minutes and about 1000 users');
  ok(store.get(1) === null, 'snapshot: nothing stored -> null');
  store.set(1, { a: 1 });
  store.set(2, { a: 2 });
  ok(store.get(1).data.a === 1 && store.get(2).data.a === 2, 'snapshot: each user gets their own entry');
  ok(store.get('1').data.a === 1, 'snapshot: the key is the user id, however it is typed');
  ok(store.get(3) === null, 'snapshot: another user id never sees an entry');
  clock += 999;
  ok(store.get(1) !== null, 'snapshot: valid just before the TTL');
  clock += 1;
  ok(store.get(1) === null && store.get(2) === null, 'snapshot: expired at the TTL (reading did not extend it)');
  ok(store.size === 0, 'snapshot: an expired entry is dropped');
  store.set(1, 'a'); store.set(2, 'b'); store.set(3, 'c');
  store.get(1);                                   // 1 becomes the most recently used
  store.set(4, 'd');                              // over capacity: evicts the least recently used (2)
  ok(store.size === 3 && store.get(2) === null && store.get(1)?.data === 'a' && store.get(3)?.data === 'c' && store.get(4)?.data === 'd', 'snapshot: bounded; the least recently used user is evicted first');
  store.set(1, 'a2');
  ok(store.get(1).data === 'a2' && store.size === 3, 'snapshot: setting again replaces, never grows');
  ok(store.delete(1) === true && store.get(1) === null, 'snapshot: delete');

  const raw = {
    health: { composite_score: 70 },
    clusters: { clusters: [1], labeled_transactions: [{ title: 'Secret lunch' }], insights: {} },
    metadata: { transaction_count: 3, errors: { forecast: "ValueError: could not parse 'Secret lunch'", plan: 'KeyError: x' } },
  };
  const clean = sanitizeAnalysis(raw);
  ok(!('labeled_transactions' in clean.clusters) && clean.clusters.clusters.length === 1, 'sanitize: per-transaction cluster labels are removed');
  ok(JSON.stringify(clean.metadata.errors) === '{"forecast":true,"plan":true}', 'sanitize: errors become section-presence booleans', JSON.stringify(clean.metadata.errors));
  ok(!JSON.stringify(clean).includes('Secret lunch') && !JSON.stringify(clean).includes('ValueError'), 'sanitize: no transaction text or exception text survives');
  ok('labeled_transactions' in raw.clusters && typeof raw.metadata.errors.forecast === 'string', 'sanitize: the input is not mutated');
  ok(sanitizeAnalysis({ metadata: { errors: null } }).metadata.errors === null && sanitizeAnalysis({ metadata: {} }).metadata.errors === null, 'sanitize: no errors -> null');
  ok(sanitizeAnalysis(null) && typeof sanitizeAnalysis('x') === 'object', 'sanitize: odd input never throws');
}

// ── the server, with a stub analytics service ───────────────────────────────────────────────────────────────────────
const envFile = path.join(SERVER_DIR, '.env');
const baseUrl = process.env.DATABASE_URL ?? (fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)).DATABASE_URL : undefined);
if (!baseUrl) { console.error('DATABASE_URL is not set (environment or server/.env).'); process.exit(2); }
const urlFor = (db) => { const u = new URL(baseUrl); u.pathname = '/' + db; return u.toString(); };
const DB = `finsphere_plans_${process.pid}`;
const admin = new pg.Client({ connectionString: urlFor('postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);

const PORT = 5077;
const ML_PORT = 5078;
const base = `http://localhost:${PORT}/api`;
let server = null, serverOut = '', exitCode = null;

const stub = { mode: 'ok', requests: [] };
const stubServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {};
    stub.requests.push(parsed);
    if (stub.mode === 'error') { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('SECRET-UPSTREAM-TEXT: could not process "Lunch at Nobu" 450'); }
    const first = parsed.transactions?.[0]?.title ?? 'none';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      health: { composite_score: 71.5, grade: { grade: 'B' }, ratios: { savings_rate: { value: 25 } }, strengths: [], weaknesses: [] },
      forecast: { insights: { income_momentum: 'stable', expense_momentum: 'stable', projected_savings_3m: 1000 } },
      anomalies: { total_flagged: 0, anomalies: [] },
      clusters: { clusters: [{ id: 0, label: 'Small', pct_of_total: 100 }], insights: {}, labeled_transactions: parsed.transactions.map((t) => ({ title: t.title, cluster_id: 0 })) },
      plan: { plan_summary: `SUMMARY-${first}`, step_count: 2, steps: [{ priority: 'high', title: 'Step', description: 'd' }], forecast_caveats: [] },
      metadata: { transaction_count: parsed.transactions.length, models_run: ['x'], errors: { forecast: `ValueError: bad value in ${first}` } },
    }));
  });
});
await new Promise((resolve) => stubServer.listen(ML_PORT, '127.0.0.1', resolve));

async function startServer() {
  const env = { ...process.env, DATABASE_URL: urlFor(DB), PORT: String(PORT), JWT_SECRET: 'p'.repeat(40), GROQ_API_KEY: '', ML_SERVICE_URL: `http://127.0.0.1:${ML_PORT}` };
  for (const k of ['NODE_ENV', 'CORS_ORIGINS', 'TRUST_PROXY', 'FINSPHERE_TEST_UPLOAD_LIMIT']) delete env[k];
  server = spawn(process.execPath, ['server.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  server.on('exit', (code) => { exitCode = code ?? 'signal'; });
  for (let i = 0; i < 80; i++) { try { await fetch(`${base}/auth/verify`); return true; } catch { await sleep(250); } }
  return false;
}

async function call(cookie, method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json: parsed, text };
}
async function user(email) {
  const password = 'plans-test-password-1';
  await call(null, 'POST', '/auth/register', { email, password });
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const today = new Date().toISOString().slice(0, 10);
const msg = [{ role: 'user', content: 'Why is this my top action?' }];
const planChat = (cookie, extra = {}) => call(cookie, 'POST', '/plan-chat', { messages: msg, ...extra });

async function run() {
  ok(await startServer(), 'server starts', serverOut);

  // authentication is still required
  let r = await call(null, 'GET', '/ml/analyze');
  ok(r.status === 401, 'analyze: unauthenticated -> 401', String(r.status));
  r = await call(null, 'POST', '/plan-chat', { messages: msg });
  ok(r.status === 401, 'plan-chat: unauthenticated -> 401', String(r.status));

  const A = await user('plans-a@example.com');
  const B = await user('plans-b@example.com');

  // before any analysis there is nothing to narrate
  r = await planChat(A);
  ok(r.status === 200 && r.json.reply === 'Run the analysis first.', 'plan-chat: no snapshot -> "Run the analysis first." (HTTP 200)', r.text);

  // A's data
  await call(A, 'POST', '/transactions', { title: 'A-lunch', amount: 450, type: 'expense', date: today });
  await call(A, 'POST', '/transactions', { title: 'A-salary', amount: 50000, type: 'income', date: today });
  await call(A, 'POST', '/liabilities', { name: 'A-loan', type: 'personal_loan', outstandingAmount: 100000, interestRate: 9, monthlyPayment: 2500 });
  await call(A, 'POST', '/liabilities', { name: 'A-paid-off', type: 'other', outstandingAmount: 1, interestRate: 0, monthlyPayment: 700 });
  await call(A, 'PUT', '/emergency-fund', { currentAmount: 12345 });
  await call(B, 'POST', '/transactions', { title: 'B-coffee', amount: 120, type: 'expense', date: today });

  // a) caller-owned data only, with the same payload semantics as before
  stub.requests.length = 0;
  r = await call(A, 'GET', '/ml/analyze');
  ok(r.status === 200 && stub.requests.length === 1, 'analyze: A -> one analytics request', String(r.status));
  const sent = stub.requests[0];
  const titles = sent.transactions.map((t) => t.title).sort();
  ok(titles.join() === 'A-lunch,A-salary', 'analyze: only the caller\'s transactions are sent', titles.join());
  ok(sent.monthly_debt_payments === 3200, 'analyze: monthly debt payments are the caller\'s active liabilities (exact sum)', String(sent.monthly_debt_payments));
  ok(sent.emergency_fund === 12345 && sent.n_forecast_months === 3, 'analyze: the caller\'s emergency fund, 3 forecast months');
  ok(!JSON.stringify(sent).includes('B-coffee'), 'analyze: another user\'s transaction is never sent');

  // b) what the client receives
  ok(!('labeled_transactions' in (r.json.clusters ?? {})) && r.json.clusters.clusters.length === 1, 'analyze: clusters.labeled_transactions is removed');
  ok(JSON.stringify(r.json.metadata.errors) === '{"forecast":true}', 'analyze: metadata.errors is section-presence booleans', JSON.stringify(r.json.metadata.errors));
  ok(!r.text.includes('ValueError') && !r.text.includes('A-lunch'.concat(' ').concat('ValueError')), 'analyze: no raw exception text reaches the client');
  ok(r.json.plan.plan_summary === 'SUMMARY-A-salary' && r.json.health.composite_score === 71.5, 'analyze: the rest of the analysis is passed through unchanged');

  // c) upstream failure: nothing upstream is returned or logged
  stub.mode = 'error';
  serverOut = '';
  r = await call(B, 'GET', '/ml/analyze');
  ok(r.status === 502 && r.json.error === 'ML service returned an error' && !('detail' in r.json), 'analyze: an upstream error -> 502 with a generic message', r.text);
  ok(!r.text.includes('SECRET-UPSTREAM-TEXT') && !r.text.includes('Nobu') && !r.text.includes('B-coffee'), 'analyze: upstream body is never returned');
  await sleep(200);
  ok(!serverOut.includes('SECRET-UPSTREAM-TEXT') && !serverOut.includes('Nobu') && !serverOut.includes('B-coffee') && /HTTP 500/.test(serverOut), 'analyze: the server log holds the status only', serverOut.slice(-200));
  r = await planChat(B);
  ok(r.json.reply === 'Run the analysis first.', 'plan-chat: a FAILED analysis stores no snapshot', r.text);
  stub.mode = 'ok';

  // d) plan-chat narrates the SERVER snapshot; a forged client context is ignored
  r = await planChat(A);
  ok(r.status === 200 && r.json.reply.startsWith('SUMMARY-A-salary') && /The analysis identified 2 action items/.test(r.json.reply), 'plan-chat: A is answered from A\'s server snapshot', r.text);
  ok(!/ML models identified/.test(r.json.reply), 'plan-chat: the fallback no longer calls rule output "ML"');
  r = await planChat(A, { mlContext: { plan: { plan_summary: 'FORGED-SUMMARY', step_count: 99, steps: [] }, health: { composite_score: 99 } } });
  ok(r.status === 200 && r.json.reply.startsWith('SUMMARY-A-salary') && !r.text.includes('FORGED') && !r.text.includes('99 action'), 'plan-chat: a forged mlContext changes nothing', r.text);
  r = await planChat(B, { mlContext: { plan: { plan_summary: "A's SUMMARY-A-salary" } } });
  ok(r.json.reply === 'Run the analysis first.' && !r.text.includes('A-lunch'), 'plan-chat: user A\'s snapshot is never visible to user B (a client context cannot lend it either)', r.text);
  r = await call(B, 'GET', '/ml/analyze');
  ok(r.status === 200 && r.json.plan.plan_summary === 'SUMMARY-B-coffee', 'analyze: B gets B\'s own analysis', r.text.slice(0, 120));
  r = await planChat(B);
  ok(r.json.reply.startsWith('SUMMARY-B-coffee') && !r.text.includes('A-lunch'), 'plan-chat: B is answered from B\'s snapshot', r.text);
  r = await planChat(A);
  ok(r.json.reply.startsWith('SUMMARY-A-salary'), 'plan-chat: A\'s snapshot is unaffected by B', r.text);

  // e) legacy shape checks stay
  r = await call(A, 'POST', '/plan-chat', { messages: msg, mlContext: 'x' });
  ok(r.status === 400, 'plan-chat: a non-object mlContext is still refused', String(r.status));
  r = await call(A, 'POST', '/plan-chat', { messages: [], mlContext: {} });
  ok(r.status === 400, 'plan-chat: invalid messages are still refused');

  // f) the prompt wording (the Groq call itself is not exercised here): rules vs ML, no K-means
  const source = fs.readFileSync(path.join(SERVER_DIR, 'server.js'), 'utf8');
  const promptStart = source.indexOf('const systemPrompt = `You are the FinFlow AI Plan Advisor');
  const prompt = source.slice(promptStart, source.indexOf('const fullMessages', promptStart));
  ok(prompt.includes('SPENDING CLUSTERS (Agglomerative, Ward)') && !/K-?MEANS/i.test(prompt), 'prompt: clusters are labelled Agglomerative (Ward), never K-means');
  ok(/RULE-BASED, not machine learning/.test(prompt) && /FORECAST \(ML/.test(prompt) && /ANOMALIES \(ML/.test(prompt) && /PLAN \(deterministic rules/.test(prompt), 'prompt: rule-based and ML sections are distinguished');
  const handler = source.slice(source.indexOf("app.post('/api/plan-chat'"));
  ok(/Evidence:/.test(handler) && /evidenceLine\(s\.evidence\)/.test(handler), 'prompt: structured evidence is included for each step');
  ok(!/produced by our ML models|from our ML pipeline|ML model outputs/.test(prompt), 'prompt: no claim that every output is ML');
  ok(!/const \{ messages, mlContext \} = req\.body/.test(source), 'plan-chat: the handler does not read the client mlContext as its data');

  ok(exitCode === null, 'server still running', serverOut.slice(-300));
}

try {
  await run();
} finally {
  if (server && exitCode === null) server.kill();
  stubServer.close();
  await sleep(500);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await admin.end().catch(() => {});
}
console.log(`plans tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
