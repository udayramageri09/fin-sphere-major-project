// Real API + PostgreSQL + a real spawned AA simulator instance: PAN -> accounts -> consent ->
// FI request -> connect, UPI connect -> sync, cross-account isolation, and idempotency.
// Creates only finsphere_finconn_<pid>; never connects to the faculty demo database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serverDir = path.join(repo, 'server');
const aaSimulatorDir = path.join(repo, 'aa_simulator');
const require = createRequire(path.join(serverDir, 'package.json'));
const { Client } = require('pg');
const dotenv = require('dotenv');
const baseUrl = process.env.DATABASE_URL ?? dotenv.parse(fs.readFileSync(path.join(serverDir, '.env'))).DATABASE_URL;
const urlFor = (db) => { const u = new URL(baseUrl); u.pathname = '/' + db; return u.toString(); };
const db = `finsphere_finconn_${process.pid}`;
assert.match(db, /^finsphere_finconn_\d+$/);
const admin = new Client({ connectionString: urlFor('postgres') });
await admin.connect();
await admin.query(`CREATE DATABASE ${db}`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finsphere-finconn-'));
for (const entry of fs.readdirSync(serverDir)) if (entry.endsWith('.js') || entry === 'package.json') fs.copyFileSync(path.join(serverDir, entry), path.join(dir, entry));
fs.cpSync(path.join(serverDir, 'db'), path.join(dir, 'db'), { recursive: true });
fs.symlinkSync(path.join(serverDir, 'node_modules'), path.join(dir, 'node_modules'), 'junction');

const port = 5199, base = `http://localhost:${port}/api`;
const simPort = 7199, simBase = `http://localhost:${simPort}`;
let child, sim, logs = '', simLogs = '';
const env = {
  ...process.env, DATABASE_URL: urlFor(db), DATABASE_SSL: 'false', PORT: String(port), JWT_SECRET: 'f'.repeat(40),
  GROQ_API_KEY: '', PASSWORD_RESET_DELIVERY: '', RESEND_API_KEY: '', PASSWORD_RESET_FROM: '', PASSWORD_RESET_URL: '',
  CORS_ORIGINS: 'http://localhost:5299', AA_SIMULATOR_URL: simBase
};
for (const k of ['NODE_ENV', 'TRUST_PROXY', 'FINSPHERE_TEST_UPLOAD_LIMIT']) delete env[k];

async function waitFor(url, logsRef) {
  for (let i = 0; i < 80; i++) { try { await fetch(url); return; } catch { await sleep(250); } }
  throw new Error(logsRef());
}
async function start() {
  sim = spawn(process.execPath, ['server.js'], { cwd: aaSimulatorDir, env: { ...process.env, PORT: String(simPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  sim.stdout.on('data', (d) => { simLogs += d; }); sim.stderr.on('data', (d) => { simLogs += d; });
  await waitFor(`${simBase}/health`, () => simLogs);

  child = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
  await waitFor(`${base}/auth/verify`, () => logs);
}
async function stopProc(p) { if (p && p.exitCode === null) { p.kill(); await new Promise((r) => p.once('exit', r)); } }

const call = async (cookie, method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null, cookie: r.headers.get('set-cookie')?.split(';')[0] };
};

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const DEMO_PAN = 'DEMO-PAN-001';

try {
  await start();
  const account = async (tag) => {
    const body = { email: `finconn-${tag}@example.com`, password: 'Finconn-test-pass-123!' };
    check((await call(null, 'POST', '/auth/register', body)).status === 200, `register ${tag}`);
    return (await call(null, 'POST', '/auth/login', body)).cookie;
  };
  const a = await account('a'), b = await account('b');
  check(!!a && !!b, 'sessions issued');

  // ── Auth is required ─────────────────────────────────────────────────────
  check((await call(null, 'GET', '/aa/accounts')).status === 401, 'anonymous AA read rejected');
  check((await call(null, 'POST', '/upi/apps/gpay/connect')).status === 401, 'anonymous UPI write rejected');

  // ── PAN gates discovery ──────────────────────────────────────────────────
  check((await call(a, 'GET', '/aa/accounts')).status === 409, 'accounts blocked before PAN verification');
  const badPan = await call(a, 'POST', '/aa/pan/verify', { pan: 'nonsense' });
  check(badPan.status === 400, 'invalid PAN format rejected');
  const pan = await call(a, 'POST', '/aa/pan/verify', { pan: DEMO_PAN });
  check(pan.status === 200 && pan.data.panStatus === 'VERIFIED', 'demo PAN verifies through the real API');
  check(!JSON.stringify(pan.data).includes(DEMO_PAN), 'the raw PAN is never echoed back by the real API either');

  // ── Account discovery (normalized shape) ─────────────────────────────────
  const accounts = await call(a, 'GET', '/aa/accounts');
  check(accounts.status === 200 && accounts.data.accounts.length === 10, '10 normalized accounts discovered');
  const sample = accounts.data.accounts[0];
  check('institution' in sample && 'accountId' in sample && 'accountType' in sample && 'maskedAccountNumber' in sample && 'balance' in sample, 'accounts use the normalized FinSphere-facing field names');

  // ── Consent + isolation ───────────────────────────────────────────────────
  const selected = accounts.data.accounts.slice(0, 4).map((acc) => acc.accountId);
  const consent = await call(a, 'POST', '/aa/consents', { accountIds: selected });
  check(consent.status === 201 && consent.data.status === 'PENDING', 'consent created PENDING');

  check((await call(b, 'GET', '/aa/consents/' + consent.data.consentId)).status === 404, "another user's session cannot read this consent");
  check((await call(b, 'POST', `/aa/consents/${consent.data.consentId}/approve`)).status === 404, "another user's session cannot approve this consent");

  const approved = await call(a, 'POST', `/aa/consents/${consent.data.consentId}/approve`);
  check(approved.status === 200 && approved.data.status === 'ACTIVE', 'owner can approve their own consent');
  check((await call(a, 'POST', `/aa/consents/${consent.data.consentId}/approve`)).status === 409, 'cannot approve twice');

  // ── FI request + connect (normalization into the real transactions table) ─
  const fi = await call(a, 'POST', '/aa/fi-requests', { consentId: consent.data.consentId });
  check(fi.status === 201 && fi.data.status === 'READY', 'FI request created and READY');
  check((await call(b, 'GET', `/aa/fi-requests/${fi.data.fiRequestId}/data`)).status === 404, "another user's session cannot read this FI data");

  const beforeCount = (await call(a, 'GET', '/transactions')).data.length;
  check(beforeCount === 0, 'account a starts with no transactions');
  const connected = await call(a, 'POST', `/aa/fi-requests/${fi.data.fiRequestId}/connect`);
  check(connected.status === 200 && connected.data.transactionsAdded === 4 * 4, 'connecting inserts one normalized transaction per selected-account row (4 accounts x 4 rows)');
  const afterCount = (await call(a, 'GET', '/transactions')).data;
  check(afterCount.length === 16, 'the real transactions table now holds the normalized AA transactions');
  check(afterCount.every((t) => t.classification === 'unknown'), 'AA-sourced transactions are classification "unknown", exactly like a statement import');
  check(afterCount.some((t) => t.type === 'income') && afterCount.some((t) => t.type === 'expense'), 'both CREDIT and DEBIT rows normalized to income/expense');

  const reconnected = await call(a, 'POST', `/aa/fi-requests/${fi.data.fiRequestId}/connect`);
  check(reconnected.data.alreadyConnected === true && reconnected.data.transactionsAdded === 0, 'reconnecting is idempotent, no duplicate transactions');
  check((await call(a, 'GET', '/transactions')).data.length === 16, 'transaction count unchanged after a repeat connect');

  check((await call(b, 'GET', '/transactions')).data.length === 0, "account b's transactions are unaffected by account a's AA connection");

  // ── Overview status ───────────────────────────────────────────────────────
  const status = await call(a, 'GET', '/aa/status');
  check(status.status === 200 && status.data.panVerified === true && status.data.financialDataConnected === true, 'status summary reflects PAN + connection state');

  // ── UPI simulator ──────────────────────────────────────────────────────────
  const apps = await call(a, 'GET', '/upi/apps');
  check(apps.status === 200 && apps.data.apps.length === 4 && apps.data.apps.every((app) => app.connected === false), 'all 4 UPI apps start disconnected');

  check((await call(a, 'POST', '/upi/apps/unknown-app/connect')).status === 404, 'connecting an unknown UPI app is a 404');
  const gpay = await call(a, 'POST', '/upi/apps/gpay/connect');
  check(gpay.status === 200 && gpay.data.connected === true, 'gpay connects');
  await call(a, 'POST', '/upi/apps/phonepe/connect');

  const upiTx = await call(a, 'GET', '/upi/transactions');
  check(upiTx.status === 200 && upiTx.data.transactions.length === 12, 'connected apps contribute their transactions (2 apps x 6)');
  check(upiTx.data.transactions.every((t) => t.source === 'UPI_SIMULATOR'), 'every UPI transaction is tagged with its synthetic source');

  const summary = await call(a, 'GET', '/upi/summary');
  check(summary.data.connectedApps === 2 && summary.data.transactions === 12, 'UPI summary matches connected apps and transaction count');
  check(summary.data.totalSpent > 0, 'UPI summary computes a real total spent');

  const beforeSync = (await call(a, 'GET', '/transactions')).data.length;
  const sync = await call(a, 'POST', '/upi/sync');
  check(sync.status === 200 && sync.data.transactionsAdded === 12, 'sync normalizes every connected UPI transaction into the real table');
  check((await call(a, 'GET', '/transactions')).data.length === beforeSync + 12, 'transaction count grows by exactly the synced UPI rows');
  const resync = await call(a, 'POST', '/upi/sync');
  check(resync.data.transactionsAdded === 0, 'resyncing is idempotent');
  check((await call(a, 'GET', '/transactions')).data.length === beforeSync + 12, 'no duplicate UPI transactions after resync');

  const disconnect = await call(a, 'POST', '/upi/apps/gpay/disconnect');
  check(disconnect.data.connected === false, 'gpay disconnects');
  check((await call(a, 'GET', '/upi/transactions')).data.transactions.length === 6, 'disconnecting an app removes it from the live transaction list');

  // ── UPI isolation between accounts ────────────────────────────────────────
  const bApps = await call(b, 'GET', '/upi/apps');
  check(bApps.data.apps.every((app) => app.connected === false), "account b's UPI state is untouched by account a's connections");

  console.log(`Financial connections (AA + UPI): ${checks} checks passed`);
} finally {
  await stopProc(child);
  await stopProc(sim);
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.end();
  fs.rmSync(dir, { recursive: true, force: true });
}
