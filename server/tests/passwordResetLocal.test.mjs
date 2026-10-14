// Password reset, development-only local delivery: end-to-end over HTTP (Forgot Password without a verified Resend domain).
//
//   npm --prefix server run test:password-reset-local
//
// Same safety model as chat.test.mjs: it creates and drops its own throwaway PostgreSQL database (`finsphere_resetlocal_<pid>`)
// on the server named by DATABASE_URL, starts the real server.js against it, and never touches the database named in
// DATABASE_URL. No email is ever sent: Resend is never configured here (or, in one run, configured with a fake key to prove it
// is not used). Reset tokens are read ONLY through the localhost capture endpoint, and the tests also prove they never reach
// the server log.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(SERVER_DIR, 'package.json'));
const pg = require('pg');
const dotenv = require('dotenv');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) pass++; else { fail++; console.log('FAIL:', name, extra); } };

const envFile = path.join(SERVER_DIR, '.env');
const baseUrl = process.env.DATABASE_URL ?? (fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)).DATABASE_URL : undefined);
if (!baseUrl) { console.error('DATABASE_URL is not set (environment or server/.env).'); process.exit(2); }
const urlFor = (db) => { const u = new URL(baseUrl); u.pathname = '/' + db; return u.toString(); };
const DB = `finsphere_resetlocal_${process.pid}`;
const admin = new pg.Client({ connectionString: urlFor('postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
let direct = null;

const PORT = 5084;
const base = `http://localhost:${PORT}/api`;
let server = null, serverOut = '', exitCode = null;

function launch(extraEnv = {}, { removeEnv = [] } = {}) {
  serverOut = ''; exitCode = null;
  // The developer's server/.env may hold REAL Resend settings, and dotenv only fills variables that are not already set, so the
  // reset settings are set to empty strings here (not deleted): this test must never reach Resend.
  const env = {
    ...process.env, DATABASE_URL: urlFor(DB), PORT: String(PORT), JWT_SECRET: 'r'.repeat(40), GROQ_API_KEY: '',
    PASSWORD_RESET_DELIVERY: '', RESEND_API_KEY: '', PASSWORD_RESET_FROM: '', PASSWORD_RESET_URL: '',
  };
  for (const k of ['NODE_ENV', 'CORS_ORIGINS', 'TRUST_PROXY', 'FINSPHERE_TEST_UPLOAD_LIMIT', ...removeEnv]) delete env[k];
  Object.assign(env, extraEnv);
  server = spawn(process.execPath, ['server.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  server.on('exit', (code) => { exitCode = code ?? 'signal'; });
}
async function startServer(extraEnv, opts) {
  launch(extraEnv, opts);
  for (let i = 0; i < 80; i++) { try { await fetch(`${base}/auth/verify`); return true; } catch { await sleep(250); } }
  return false;
}
async function stopServer() {
  if (server && exitCode === null) { server.kill(); for (let i = 0; i < 40 && exitCode === null; i++) await sleep(100); }
}
async function call(cookie, method, p, body) {
  const r = await fetch(base + p, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}
// A request with a chosen Host header (fetch forbids setting it).
const withHost = (host, p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: `/api${p}`, headers: { Host: host } }, (res) => {
    let data = ''; res.on('data', (d) => { data += d; }); res.on('end', () => resolve({ status: res.statusCode, text: data }));
  });
  req.on('error', reject); req.end();
});
const loginCookie = async (email, password) => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
const register = (email, password) => call(null, 'POST', '/auth/register', { email, password });
const mails = async (email) => (await call(null, 'GET', `/dev/password-reset-mail${email ? `?email=${encodeURIComponent(email)}` : ''}`));
const waitForMail = async (email, ms = 3000) => { const t0 = Date.now(); for (;;) { const r = await mails(email); if (r.json?.mails?.length || Date.now() - t0 > ms) return r; await sleep(100); } };
const tokenOf = (mail) => /#reset=([a-f0-9]{64})$/.exec(mail.link)?.[1];

async function run() {
  direct = new pg.Client({ connectionString: urlFor(DB) });

  // ═══ default configuration: no capture, no silent fallback ═══════════════════════════════════════════════════
  ok(await startServer(), 'server starts with the default (Resend) delivery', serverOut);
  await direct.connect();
  await register('default-mode@example.com', 'old-password-1');
  let r = await call(null, 'POST', '/auth/forgot-password', { email: 'default-mode@example.com' });
  ok(r.status === 503 && /temporarily unavailable/.test(r.json.error), 'default: Resend not configured -> 503, as before (NOT a fall back to local capture)', r.text);
  r = await mails();
  ok(r.status === 404, 'default: the local-mail route does not exist', String(r.status));
  r = await call(null, 'DELETE', '/dev/password-reset-mail');
  ok(r.status === 404, 'default: nor does its DELETE', String(r.status));
  ok(!/CAPTURED LOCALLY/.test(serverOut), 'default: no local-capture warning');
  await stopServer();

  // an explicit "resend" with no settings behaves the same
  ok(await startServer({ PASSWORD_RESET_DELIVERY: 'resend' }), 'server starts with PASSWORD_RESET_DELIVERY=resend', serverOut);
  r = await call(null, 'POST', '/auth/forgot-password', { email: 'default-mode@example.com' });
  ok(r.status === 503 && (await mails()).status === 404, 'resend: still 503 and still no capture route');
  await stopServer();

  // ═══ production refuses local delivery ═══════════════════════════════════════════════════════════════════════
  launch({ NODE_ENV: 'production', PASSWORD_RESET_DELIVERY: 'local', CORS_ORIGINS: 'https://app.example.com', DATABASE_SSL: 'false' });
  for (let i = 0; i < 100 && exitCode === null; i++) await sleep(100);
  ok(exitCode !== null && exitCode !== 0, 'production + local: the server refuses to start', `exit=${exitCode}`);
  ok(/not allowed when NODE_ENV=production/.test(serverOut), 'production + local: the reason is stated', serverOut.slice(-300));
  let listening = true; try { await fetch(`${base}/auth/verify`, { signal: AbortSignal.timeout(1500) }); } catch { listening = false; }
  ok(!listening, 'production + local: nothing is listening');
  await stopServer();

  // ═══ local mode ══════════════════════════════════════════════════════════════════════════════════════════════
  // RESEND settings are present (and fake) to prove they are not used in local mode.
  ok(await startServer({ PASSWORD_RESET_DELIVERY: 'local', RESEND_API_KEY: 'fake-resend-key-not-real', PASSWORD_RESET_FROM: 'FinSphere <noreply@example.invalid>' }), 'server starts in local delivery mode', serverOut);
  ok(/CAPTURED LOCALLY/.test(serverOut), 'local: a startup warning says mail is captured, not sent');
  const OLD = 'old-password-1', NEW = 'new-password-2';
  await register('person@example.com', OLD);
  const before = await loginCookie('person@example.com', OLD);
  ok(before.status === 200 && before.cookie, 'a session exists before the reset');
  ok((await call(before.cookie, 'GET', '/auth/verify')).status === 200, 'the old session is valid before the reset');

  const known = await call(null, 'POST', '/auth/forgot-password', { email: 'Person@Example.com' });
  const unknown = await call(null, 'POST', '/auth/forgot-password', { email: 'nobody@example.com' });
  ok(known.status === 202 && unknown.status === 202 && known.text === unknown.text, 'local: known and unknown accounts get the identical generic 202 response', `${known.text} | ${unknown.text}`);
  let cap = await waitForMail('person@example.com');
  ok(cap.status === 200 && cap.json.mails.length === 1, 'local: the email to the known account is captured', cap.text.slice(0, 200));
  const mail = cap.json.mails[0];
  ok(mail.to === 'person@example.com' && mail.subject === 'Reset your FinSphere password' && /^http:\/\/localhost:5173\/#reset=[a-f0-9]{64}$/.test(mail.link) && mail.text.includes(mail.link), 'local: the captured mail has the recipient, subject and a fragment link to the frontend', JSON.stringify({ ...mail, text: undefined, link: mail.link.replace(/[a-f0-9]{64}/, '<token>') }));
  await sleep(300);
  ok((await mails('nobody@example.com')).json.mails.length === 0 && (await mails()).json.mails.length === 1, 'local: an unknown account produces no mail at all');
  ok(Object.keys(cap.json).join() === 'mails' && !JSON.stringify(cap.json).includes('fake-resend-key') && !JSON.stringify(cap.json).includes(OLD), 'local: the endpoint exposes only captured mail (no keys, no passwords)');
  ok(cap.headers.get('cache-control') === 'no-store', 'local: the response is not cacheable');

  const token = tokenOf(mail);
  const digest = (await direct.query("SELECT reset_token_hash, reset_token_expires_at FROM users WHERE email = 'person@example.com'")).rows[0];
  ok(token && digest.reset_token_hash && digest.reset_token_hash !== token && /^[a-f0-9]{64}$/.test(digest.reset_token_hash), 'local: only a 64-hex digest of the token is stored, never the token', '');
  const ttl = (new Date(digest.reset_token_expires_at).getTime() - Date.now()) / 1000;
  ok(ttl > 14 * 60 && ttl <= 15 * 60 + 5, 'local: the token still expires in 15 minutes', String(ttl));
  ok(!(await direct.query('SELECT 1 FROM users WHERE reset_token_hash = $1', [token])).rows.length, 'local: the raw token is not in the database');

  // not leaked
  await sleep(200);
  ok(!serverOut.includes(token) && !serverOut.includes('#reset=') && !serverOut.includes('reset=') && !serverOut.includes('person@example.com'), 'local: the token, the link and the address never reach the server log', serverOut.slice(-300));
  ok(!/Password recovery operation failed/.test(serverOut), 'local: Resend was not called (a call with the fake key would have failed and logged)', serverOut.slice(-200));

  // Host / loopback guards
  r = await withHost('evil.example', '/dev/password-reset-mail');
  ok(r.status === 404 && !r.text.includes('reset='), 'local: a non-localhost Host header (DNS rebinding) gets 404 and no mail', `${r.status}`);
  r = await withHost('localhost.evil.example:5084', '/dev/password-reset-mail');
  ok(r.status === 404, 'local: a look-alike Host header gets 404');

  // the link works exactly once, and it revokes sessions
  r = await call(null, 'POST', '/auth/reset-password', { token, password: NEW });
  ok(r.status === 200 && /log in/.test(r.json.message) && !('token' in r.json), 'local: the captured link resets the password (no automatic login)', r.text);
  r = await call(null, 'POST', '/auth/reset-password', { token, password: 'another-password-3' });
  ok(r.status === 400, 'local: the token is one-time (replay rejected)', r.text);
  ok((await loginCookie('person@example.com', NEW)).status === 200 && (await loginCookie('person@example.com', OLD)).status === 401, 'local: the new password works and the old one does not');
  ok((await call(before.cookie, 'GET', '/auth/verify')).status === 401, 'local: sessions from before the reset are revoked (session_version)');

  // a new request replaces the previous token
  await direct.query("UPDATE users SET reset_requested_at = now() - interval '2 minutes' WHERE email = 'person@example.com'");
  await call(null, 'DELETE', '/dev/password-reset-mail');
  await call(null, 'POST', '/auth/forgot-password', { email: 'person@example.com' });
  const first = tokenOf((await waitForMail('person@example.com')).json.mails[0]);
  await direct.query("UPDATE users SET reset_requested_at = now() - interval '2 minutes' WHERE email = 'person@example.com'");
  await call(null, 'POST', '/auth/forgot-password', { email: 'person@example.com' });
  let second;
  for (let i = 0; i < 30; i++) { const l = (await mails('person@example.com')).json.mails; if (l.length >= 2) { second = tokenOf(l[0]); break; } await sleep(100); }
  ok(first && second && first !== second, 'local: a second request issues a different token', '');
  r = await call(null, 'POST', '/auth/reset-password', { token: first, password: 'third-password-4' });
  ok(r.status === 400, 'local: the previous token no longer works', r.text);
  r = await call(null, 'POST', '/auth/reset-password', { token: second, password: 'third-password-4' });
  ok(r.status === 200, 'local: the newest token works', r.text);

  // the cooldown still applies (it is enforced by the database, not by the delivery mode)
  await call(null, 'DELETE', '/dev/password-reset-mail');
  await call(null, 'POST', '/auth/forgot-password', { email: 'person@example.com' });
  await sleep(500);
  ok((await mails('person@example.com')).json.mails.length === 0, 'local: the one-minute account cooldown still applies (no second mail)');

  ok((await call(null, 'DELETE', '/dev/password-reset-mail')).json.cleared === 0, 'local: DELETE clears the captured mail');
  ok(!serverOut.includes(first) && !serverOut.includes(second) && !serverOut.includes('reset='), 'local: still no token or link in the log after the whole flow', serverOut.slice(-200));
  ok(exitCode === null, 'server still running', serverOut.slice(-300));
}

try {
  await run();
} finally {
  await stopServer();
  await direct?.end().catch(() => {});
  await sleep(500);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await admin.end().catch(() => {});
}
console.log(`password reset (local delivery) tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
