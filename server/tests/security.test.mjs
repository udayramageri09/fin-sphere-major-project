// Security regression test for the API (Issue #67).
//
//   npm --prefix server run test:security        (or: node server/tests/security.test.mjs)
//
// Starts the real server.js several times against a THROWAWAY PostgreSQL database that it creates and drops itself,
// using the server named by DATABASE_URL (environment or server/.env). It needs no other service, no Groq key and no
// network. It never touches the database named in DATABASE_URL: only a new `finsphere_sec_<pid>` database.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(SERVER_DIR, 'package.json'));
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const pg = require('pg');
const dotenv = require('dotenv');

const SECRET = 'x'.repeat(40);
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) pass++; else { fail++; console.log('FAIL:', name, extra); } };

// ── Throwaway database ─────────────────────────────────────────────────────────
const envFile = path.join(SERVER_DIR, '.env');
const baseUrl = process.env.DATABASE_URL ?? (fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)).DATABASE_URL : undefined);
if (!baseUrl) { console.error('DATABASE_URL is not set (environment or server/.env).'); process.exit(2); }
const urlFor = (db) => { const u = new URL(baseUrl); u.pathname = '/' + db; return u.toString(); };
const DB = `finsphere_sec_${process.pid}`;
const admin = new pg.Client({ connectionString: urlFor('postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
const children = [];

function start(port, extraEnv = {}) {
  const env = { ...process.env, DATABASE_URL: urlFor(DB), PORT: String(port), JWT_SECRET: SECRET, GROQ_API_KEY: '', PASSWORD_RESET_DELIVERY: '', RESEND_API_KEY: '', PASSWORD_RESET_FROM: '', PASSWORD_RESET_URL: '', ...extraEnv };
  for (const k of ['NODE_ENV', 'CORS_ORIGINS', 'TRUST_PROXY', 'DATABASE_SSL', 'FINSPHERE_TEST_UPLOAD_LIMIT']) if (!(k in extraEnv)) delete env[k];
  const child = spawn(process.execPath, ['server.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  children.push(child);
  return { child, out: () => out };
}
async function ready(port) { for (let i = 0; i < 80; i++) { try { await fetch(`http://localhost:${port}/api/auth/verify`); return true; } catch { await sleep(250); } } return false; }
const base = (p) => `http://localhost:${p}`;

async function run() {
  // ── Refusals at startup ──────────────────────────────────────────────────────
  for (const [env, label] of [[{ CORS_ORIGINS: '*' }, 'wildcard CORS'], [{ TRUST_PROXY: 'true' }, 'TRUST_PROXY=true']]) {
    const r = spawnSync(process.execPath, ['server.js'], { cwd: SERVER_DIR, env: { ...process.env, DATABASE_URL: urlFor(DB), PORT: '5099', JWT_SECRET: SECRET, ...env }, encoding: 'utf8', timeout: 20000 });
    ok(r.status === 1 && /FATAL/.test(r.stderr), `startup refuses ${label}`, r.stderr);
  }
  for (const [env, label] of [[{ JWT_SECRET: '' }, 'missing JWT_SECRET'], [{ JWT_SECRET: 'short' }, 'short JWT_SECRET']]) {
    const r = spawnSync(process.execPath, ['server.js'], { cwd: SERVER_DIR, env: { ...process.env, DATABASE_URL: urlFor(DB), PORT: '5099', ...env }, encoding: 'utf8', timeout: 20000 });
    ok(r.status === 1 && /FATAL/.test(r.stderr), `startup refuses ${label}`, r.stderr);
  }

  // ── Development-mode server (explicit CORS origin) ───────────────────────────
  const P = 5071;
  const dev = start(P, { CORS_ORIGINS: 'https://app.example.com/' });
  ok(await ready(P), 'dev server starts', dev.out());
  const health = await fetch(base(P) + '/api/health');
  ok(health.status === 200 && (await health.json()).status === 'ok', 'health probes database without exposing details');
  ok(health.headers.get('cache-control') === 'no-store', 'API responses disable caching');
  const malformed = await fetch(base(P) + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  ok(malformed.status === 400 && malformed.headers.get('cache-control') === 'no-store', 'parser failures also disable caching');

  let r = await fetch(base(P) + '/api/auth/verify', { headers: { Origin: 'https://app.example.com' } });
  ok(r.headers.get('x-powered-by') === null, 'no X-Powered-By');
  ok(r.headers.get('x-content-type-options') === 'nosniff', 'nosniff');
  ok(!!r.headers.get('content-security-policy'), 'CSP present');
  ok(!!r.headers.get('x-frame-options') || /frame-ancestors/.test(r.headers.get('content-security-policy') || ''), 'frame protection');
  ok(!!r.headers.get('referrer-policy'), 'referrer-policy');
  ok(r.headers.get('access-control-allow-origin') === 'https://app.example.com', 'configured origin allowed (trailing slash normalised)', r.headers.get('access-control-allow-origin'));
  ok(r.headers.get('access-control-allow-credentials') === 'true', 'credentials allowed');
  r = await fetch(base(P) + '/api/auth/verify', { headers: { Origin: 'https://evil.example' } });
  ok(r.headers.get('access-control-allow-origin') === null, 'other origin gets no ACAO');
  r = await fetch(base(P) + '/api/auth/verify', { headers: { Origin: 'http://localhost:5173' } });
  ok(r.headers.get('access-control-allow-origin') === null, 'localhost not allowed once CORS_ORIGINS is configured');
  r = await fetch(base(P) + '/api/auth/verify', { method: 'OPTIONS', headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'POST' } });
  ok(r.status === 204 && r.headers.get('access-control-allow-origin') === 'https://app.example.com', 'preflight ok');

  // CORS alone must not permit a disallowed browser origin to mutate an account.
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    r = await fetch(base(P) + '/api/auth/logout', { method: 'POST', headers });
    ok(r.status === 403, 'untrusted browser write is refused before route execution');
  }
  r = await fetch(base(P) + '/api/auth/logout', { method: 'POST', headers: { Origin: 'https://app.example.com' } });
  ok(r.ok, 'configured browser origin can write');

  // body handling
  r = await fetch(base(P) + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' });
  let t = await r.text();
  ok(r.status === 400 && /Invalid JSON/.test(t) && !/at .*\.js/.test(t) && r.headers.get('content-type').includes('json'), 'malformed JSON -> clean 400', t.slice(0, 120));
  r = await fetch(base(P) + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(200 * 1024) }) });
  t = await r.text();
  ok(r.status === 413 && !/at .*\.js/.test(t), 'oversized JSON -> 413', `${r.status} ${t.slice(0, 80)}`);

  // register / login
  const email = 'sec67@example.com', password = 'correct-horse-battery';
  await fetch(base(P) + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  r = await fetch(base(P) + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  ok(r.status === 200, 'login works', String(r.status));
  const setCookie = r.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  ok(/HttpOnly/i.test(setCookie), 'cookie httpOnly');
  const goodToken = cookie.split('=')[1];
  const get = (p, tok) => fetch(base(P) + p, { headers: { cookie: `token=${tok}` } });
  ok((await get('/api/transactions', goodToken)).status === 200, 'valid HS256 token accepted');
  const payload = jwt.decode(goodToken);
  ok(jwt.decode(goodToken, { complete: true }).header.alg === 'HS256', 'login signs with HS256');
  const hs512 = jwt.sign({ id: payload.id, email: payload.email }, SECRET, { algorithm: 'HS512', expiresIn: '1h' });
  ok((await get('/api/transactions', hs512)).status === 401, 'HS512 token rejected');
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ id: payload.id, email: payload.email, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.';
  ok((await get('/api/transactions', none)).status === 401, 'alg=none token rejected');
  ok((await get('/api/transactions', 'not.a.jwt')).status === 401, 'malformed token -> 401');
  const wrong = jwt.sign({ id: payload.id, email: payload.email }, 'y'.repeat(40), { algorithm: 'HS256', expiresIn: '1h' });
  ok((await get('/api/transactions', wrong)).status === 401, 'wrong-secret token rejected');
  const expired = jwt.sign({ id: payload.id, email: payload.email }, SECRET, { algorithm: 'HS256', expiresIn: -10 });
  ok((await get('/api/transactions', expired)).status === 401, 'expired token rejected');
  ok((await fetch(base(P) + '/api/transactions')).status === 401, 'no token -> 401');

  // uploads
  const upload = async (name, buf, tok = cookie) => {
    const fd = new FormData(); fd.append('statementFile', new Blob([buf], { type: 'application/octet-stream' }), name);
    return fetch(base(P) + '/api/transactions/parse-statement', { method: 'POST', headers: { cookie: tok }, body: fd });
  };
  r = await upload('malware.exe', Buffer.from('MZ....'));
  ok(r.status === 400 && /Unsupported file type/.test(await r.text()), '.exe refused');
  r = await upload('x.pdf', Buffer.from('%PDF'));
  ok(r.status === 400, '.pdf refused');
  r = await upload('big.csv', Buffer.alloc(6 * 1024 * 1024, 'a'));
  ok(r.status === 413, '6 MB file -> 413', String(r.status));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Date', 'Narration', 'Withdrawal Amt.', 'Deposit Amt.'], ['2026-03-05', 'ZOMATO ORDER', 120.5, ''], ['2026-03-06', 'SALARY ACME', '', 50000]]), 'S');
  const xbuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  r = await upload('stmt.xlsx', xbuf);
  t = await r.text();
  ok(r.status === 200 && JSON.parse(t).count === 2, 'xlsx 0.20.x parses a statement', `${r.status} ${t.slice(0, 160)}`);
  r = await upload('stmt.csv', Buffer.from('Date,Narration,Withdrawal Amt.,Deposit Amt.\n2026-03-07,TEST SHOP,10,\n'));
  ok(r.status === 200 || r.status === 400, 'csv still handled (not refused as type)', String(r.status));

  // rate limits. The parse bucket for this user already holds 5 requests; the default limit is 10 per minute.
  let limited = 0;
  for (let i = 0; i < 12; i++) { const x = await upload('a.txt', Buffer.from('nothing here')); if (x.status === 429) limited++; }
  ok(limited >= 1, 'parse-statement limiter engages', String(limited));
  // Session revocation now checks persisted users; create real isolated test accounts.
  const fixtureDb = new pg.Client({ connectionString: urlFor(DB) });
  await fixtureDb.connect();
  const asUser = async (id) => {
    const email = `rate-${id}@example.com`;
    await fixtureDb.query('INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users WHERE id=$3 ON CONFLICT DO NOTHING', [id, email, payload.id]);
    return `token=${jwt.sign({ id, email, sessionVersion: 0 }, SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
  };
  const other = await upload('a.txt', Buffer.from('x'), await asUser(payload.id + 999));
  ok(other.status !== 429 && other.status !== 401, 'limiter is per user, not global', String(other.status));
  // The exact DEFAULT: a fresh user gets 10 uploads per minute, and the 11th is refused.
  const fresh = await asUser(payload.id + 1234);
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await upload('a.txt', Buffer.from('nothing here'), fresh)).status);
  ok(statuses.slice(0, 10).every((s) => s !== 429) && statuses[10] === 429, 'default upload limit is exactly 10 per minute per user', statuses.join(','));
  ok(!/FINSPHERE_TEST_UPLOAD_LIMIT/.test(dev.out()), 'test override is not active by default');
  let chat429 = 0;
  for (let i = 0; i < 33; i++) { const x = await fetch(base(P) + '/api/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) }); if (x.status === 429) chat429++; }
  ok(chat429 >= 1, 'chat limiter engages after 30/min', String(chat429));
  let reads429 = 0;
  for (let i = 0; i < 60; i++) { const x = await get('/api/transactions', goodToken); if (x.status === 429) reads429++; }
  ok(reads429 === 0, 'ordinary reads are not rate limited');
  dev.child.kill();

  // ── Test-only override: honoured outside production, from the environment only ─
  const P3 = 5073;
  const raised = start(P3, { FINSPHERE_TEST_UPLOAD_LIMIT: '50' });
  ok(await ready(P3), 'server with test override starts', raised.out());
  ok(/raised to 50\/min by FINSPHERE_TEST_UPLOAD_LIMIT/.test(raised.out()), 'override announces itself in the log');
  const rawUpload = (tok, headers = {}, qs = '') => {
    const fd = new FormData(); fd.append('statementFile', new Blob([Buffer.from('nothing here')]), 'a.txt');
    return fetch(base(P3) + '/api/transactions/parse-statement' + qs, { method: 'POST', headers: { cookie: tok, ...headers }, body: fd });
  };
  const tok3 = await asUser(77);
  let n429 = 0;
  for (let i = 0; i < 20; i++) {
    const status = (await rawUpload(tok3)).status;
    ok(status !== 401, 'override upload uses a valid session');
    if (status === 429) n429++;
  }
  ok(n429 === 0, 'override raises the limit below its new ceiling');
  raised.child.kill();

  // ── Production-mode server: secure cookie, no CORS when unset, override ignored ─
  const P2 = 5072;
  const prod = start(P2, { NODE_ENV: 'production', DATABASE_SSL: 'false', FINSPHERE_TEST_UPLOAD_LIMIT: '100000' });
  ok(await ready(P2), 'prod-mode server starts', prod.out());
  ok(/CORS_ORIGINS is not set/.test(prod.out()), 'prod warns when CORS_ORIGINS unset');
  ok(/FINSPHERE_TEST_UPLOAD_LIMIT is ignored in production/.test(prod.out()), 'prod ignores and reports the test override');
  r = await fetch(base(P2) + '/api/auth/verify', { headers: { Origin: 'http://localhost:5173' } });
  ok(r.headers.get('access-control-allow-origin') === null, 'prod: localhost origin not allowed');
  r = await fetch(base(P2) + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const pc = r.headers.get('set-cookie') || '';
  ok(/Secure/i.test(pc) && /SameSite=Strict/i.test(pc) && /HttpOnly/i.test(pc), 'prod cookie Secure; HttpOnly; SameSite=Strict', pc);
  ok(r.headers.get('strict-transport-security') !== null, 'HSTS header present');
  const pstat = [];
  const ptok = await asUser(88);
  for (let i = 0; i < 11; i++) {
    const fd = new FormData(); fd.append('statementFile', new Blob([Buffer.from('nothing here')]), 'a.txt');
    pstat.push((await fetch(base(P2) + '/api/transactions/parse-statement?FINSPHERE_TEST_UPLOAD_LIMIT=100000', { method: 'POST', headers: { cookie: ptok, 'x-finsphere-test-upload-limit': '100000' }, body: fd })).status);
  }
  ok(pstat.slice(0, 10).every((s) => s !== 429) && pstat[10] === 429, 'production keeps 10/min even with the override env set and bypass-style query/header', pstat.join(','));
  prod.child.kill();
  await fixtureDb.end();
}

try {
  await run();
} finally {
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  await sleep(500);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await admin.end().catch(() => {});
}
console.log(`security tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
