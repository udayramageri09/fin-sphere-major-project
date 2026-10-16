// First-login setup guide state through the REAL server: only registration starts "pending"; accounts that already exist (or are created
// without registering) are "completed"; the state is durable (sessions, restarts, schema re-runs), strictly validated, per account,
// and never creates a financial record.
//
//   npm --prefix server run test:onboarding
//
// Creates and drops its own throwaway PostgreSQL database (`finsphere_onboarding_<pid>`); never touches the database named in DATABASE_URL.
// Mail delivery is blanked. All data is synthetic.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(SERVER_DIR, 'package.json'));
const pg = require('pg');
const dotenv = require('dotenv');
const bcrypt = require('bcrypt');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) pass++; else { fail++; console.log('FAIL:', name, extra); } };

const envFile = path.join(SERVER_DIR, '.env');
const baseUrl = process.env.DATABASE_URL ?? (fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)).DATABASE_URL : undefined);
if (!baseUrl) { console.error('DATABASE_URL is not set (environment or server/.env).'); process.exit(2); }
const urlFor = (db) => { const u = new URL(baseUrl); u.pathname = '/' + db; return u.toString(); };
const DB = `finsphere_onboarding_${process.pid}`;
const admin = new pg.Client({ connectionString: urlFor('postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);

const PORT = 5094, base = `http://localhost:${PORT}/api`;
let server = null, serverOut = '', exitCode = null, direct = null;
async function startServer() {
  exitCode = null;
  const env = { ...process.env, DATABASE_URL: urlFor(DB), PORT: String(PORT), JWT_SECRET: 'c'.repeat(40), GROQ_API_KEY: '', PASSWORD_RESET_DELIVERY: '', RESEND_API_KEY: '', PASSWORD_RESET_FROM: '', PASSWORD_RESET_URL: '' };
  for (const k of ['NODE_ENV', 'CORS_ORIGINS', 'TRUST_PROXY', 'FINSPHERE_TEST_UPLOAD_LIMIT']) delete env[k];
  server = spawn(process.execPath, ['server.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { serverOut += d; }); server.stderr.on('data', (d) => { serverOut += d; });
  server.on('exit', (code) => { exitCode = code ?? 'signal'; });
  for (let i = 0; i < 80; i++) { try { await fetch(`${base}/auth/verify`); return true; } catch { await sleep(250); } }
  return false;
}
async function stopServer() { if (server && exitCode === null) { server.kill(); for (let i = 0; i < 40 && exitCode === null; i++) await sleep(100); } }

const J = { 'content-type': 'application/json' };
const PASSWORD = 'Passw0rd-onb-1';
const register = (email) => fetch(`${base}/auth/register`, { method: 'POST', headers: J, body: JSON.stringify({ email, password: PASSWORD }) });
async function login(email, password = PASSWORD) {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ email, password }) });
  return { email, status: r.status, body: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const call = async (cookie, method, p, body) => {
  const r = await fetch(base + p, { method, headers: { ...J, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
};
const verify = async (u) => (await call(u.cookie, 'GET', '/auth/verify')).json?.user;
const patch = (u, body) => call(u.cookie, 'PATCH', '/auth/profile', body);
const dbState = async (email) => (await direct.query('SELECT onboarding_state s FROM users WHERE email = $1', [email])).rows[0]?.s;
const financeRows = async (email) => {
  let n = 0;
  for (const t of ['transactions', 'goals', 'liabilities', 'emergency_funds', 'budgets']) {
    n += (await direct.query(`SELECT count(*)::int n FROM ${t} x JOIN users u ON u.id = x.user_id WHERE u.email = $1`, [email])).rows[0].n;
  }
  return n;
};

async function run() {
  ok(await startServer(), 'server starts', serverOut);
  direct = new pg.Client({ connectionString: urlFor(DB) });
  await direct.connect();

  // ── a newly registered account is pending; nothing financial is created ──
  const emailA = 'onb-a@example.com', emailB = 'onb-b@example.com';
  ok((await register(emailA)).status === 200, 'A registers');
  ok((await register(emailB)).status === 200, 'B registers');
  const A = await login(emailA), B = await login(emailB);
  ok(A.body?.user?.onboardingState === 'pending', 'login returns the pending state for a new account', JSON.stringify(A.body));
  ok((await verify(A)).onboardingState === 'pending' && (await dbState(emailA)) === 'pending', 'verify and the database agree: pending');
  ok((await financeRows(emailA)) === 0 && (await financeRows(emailB)) === 0, 'registration creates no transaction, goal, liability, fund or budget');
  const keys = Object.keys(await verify(A)).sort();
  ok(JSON.stringify(keys) === JSON.stringify(['avatarVersion', 'displayName', 'email', 'id', 'onboardingState', 'reduceMotion']), 'the public profile only gained onboardingState', keys.join());

  // ── state changes ──
  ok((await call(null, 'PATCH', '/auth/profile', { onboardingState: 'skipped' })).status === 401, 'changing the state requires a session');
  let r = await patch(A, { onboardingState: 'skipped' });
  ok(r.status === 200 && r.json.user.onboardingState === 'skipped' && (await dbState(emailA)) === 'skipped', 'skip is saved');
  ok((await dbState(emailB)) === 'pending' && (await verify(B)).onboardingState === 'pending', 'another account is unaffected (isolation)');
  r = await patch(A, { onboardingState: 'pending' });
  ok(r.status === 200 && (await dbState(emailA)) === 'pending', 'the guide can be reopened (resume): pending again');
  r = await patch(A, { onboardingState: 'completed' });
  ok(r.status === 200 && r.json.user.onboardingState === 'completed', 'completed is saved');
  r = await patch(A, { displayName: 'Sam Example', onboardingState: 'skipped' });
  ok(r.status === 200 && r.json.user.displayName === 'Sam Example' && r.json.user.onboardingState === 'skipped', 'it can be saved together with the display name');
  r = await patch(A, { displayName: 'Sam Two' });
  ok(r.status === 200 && r.json.user.onboardingState === 'skipped', 'saving other profile fields leaves the state alone');
  r = await patch(B, { onboardingState: 'completed' });
  ok(r.status === 200 && (await dbState(emailB)) === 'completed' && (await dbState(emailA)) === 'skipped', 'B completing does not change A');

  // ── strict validation: nothing changes ──
  const before = await dbState(emailA);
  const bad = [{ onboardingState: 'done' }, { onboardingState: 'PENDING' }, { onboardingState: '' }, { onboardingState: null }, { onboardingState: 1 }, { onboardingState: true },
    { onboardingState: ['pending'] }, { onboardingState: { s: 'pending' } }, { onboardingState: 'pending', email: 'x@example.com' }, { onboardingState: 'pending', id: 1 }, {}, []];
  let allRefused = true, detail = '';
  for (const body of bad) { const x = await patch(A, body); if (x.status !== 400) { allRefused = false; detail += ` ${JSON.stringify(body)}->${x.status}`; } }
  ok(allRefused, 'every malformed or extra-field body is refused with 400', detail);
  ok((await dbState(emailA)) === before, 'a refused request changes nothing');
  ok((await financeRows(emailA)) === 0, 'no financial record appears at any point');

  // ── durability: new session, server restart ──
  const A2 = await login(emailA);
  ok((await verify(A2)).onboardingState === 'skipped', 'the state survives signing out and in again');
  await patch(B, { onboardingState: 'pending' });
  await stopServer();
  ok(await startServer(), 'server restarts (schema is applied again)', serverOut.slice(-200));
  const A3 = await login(emailA), B3 = await login(emailB);
  ok((await verify(A3)).onboardingState === 'skipped' && (await verify(B3)).onboardingState === 'pending', 'a restart changes no account\'s state (the migration is idempotent)');

  // ── accounts that did not register through the app are never "new" ──
  const hash = await bcrypt.hash('Passw0rd-legacy-1', 4);
  await direct.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', ['onb-legacy@example.com', hash]);
  ok((await dbState('onb-legacy@example.com')) === 'completed', 'a row created without registration defaults to completed');
  const L = await login('onb-legacy@example.com', 'Passw0rd-legacy-1');
  ok(L.status === 200 && (await verify(L)).onboardingState === 'completed', 'such an account (a returning user with an empty account) is not shown the guide');
  ok((await financeRows('onb-legacy@example.com')) === 0, 'and it is still empty');

  // ── upgrade of an existing database: the column appears, every existing account becomes completed ──
  await stopServer();
  await direct.query('ALTER TABLE users DROP COLUMN onboarding_state');
  ok(await startServer(), 'server starts against a database from before this feature', serverOut.slice(-200));
  const states = (await direct.query('SELECT email, onboarding_state s FROM users WHERE email LIKE $1', ['onb-%'])).rows;
  ok(states.length === 3 && states.every((x) => x.s === 'completed'), 'every existing account is completed after the upgrade (none is treated as new)', JSON.stringify(states));
  const col = (await direct.query("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'onboarding_state'")).rows[0];
  ok(col && col.is_nullable === 'NO' && /completed/.test(col.column_default), 'the column is NOT NULL with default completed');
  // …and registering afterwards still starts pending
  ok((await register('onb-c@example.com')).status === 200 && (await dbState('onb-c@example.com')) === 'pending', 'a registration after the upgrade starts pending');
  // the database itself refuses values outside the three states
  let refused = false;
  try { await direct.query("UPDATE users SET onboarding_state = 'banana' WHERE email = $1", [emailA]); } catch { refused = true; }
  ok(refused, 'the database refuses any other value');

  ok(exitCode === null, 'server still running');
  ok(!/onb-a@|onb-b@|onb-legacy@|onb-c@|Sam Example/.test(serverOut), 'the server log contains no email or name', serverOut.slice(-300));
}

try { await run(); } finally {
  await stopServer(); await direct?.end().catch(() => {}); await sleep(500);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); await admin.end().catch(() => {});
}
console.log(`onboarding state (real server) tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
