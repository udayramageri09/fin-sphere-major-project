// PUT and PATCH /api/transactions/:id (the user's category correction) through the REAL server: it changes ONLY the category of ONE owned
// transaction, persists, is owner-scoped, refuses everything else, and flows into the budget figures that read the same label.
//
//   npm --prefix server run test:category
//
// Creates and drops its own throwaway PostgreSQL database (`finsphere_edit_<pid>`); never touches the database named in DATABASE_URL.
// Mail delivery is blanked. All data is synthetic.
import { spawn } from 'node:child_process';
import net from 'node:net';
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
const DB = `finsphere_edit_${process.pid}`;
if (!/^finsphere_edit_\d+$/.test(DB)) throw Error('Unsafe test database name');
const admin = new pg.Client({ connectionString: urlFor('postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);

const PORT = await new Promise((resolve, reject) => { const probe = net.createServer(); probe.on('error', reject); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); }), base = `http://localhost:${PORT}/api`;
let server = null, serverOut = '', exitCode = null, direct = null;
async function startServer() {
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
async function makeUser(tag) {
  const email = `cat-${tag}@example.com`;
  await fetch(`${base}/auth/register`, { method: 'POST', headers: J, body: JSON.stringify({ email, password: 'Passw0rd-cat-1' }) });
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ email, password: 'Passw0rd-cat-1' }) });
  return { email, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const call = async (cookie, method, p, body) => {
  const r = await fetch(base + p, { method, headers: { ...J, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
};
const list = async (u) => (await call(u.cookie, 'GET', '/transactions')).json;
const rowFor = (rows, id) => rows.find((t) => t.id === id);

async function run() {
  ok(await startServer(), 'server starts', serverOut);
  direct = new pg.Client({ connectionString: urlFor(DB) });
  await direct.connect();
  const A = await makeUser('a'), B = await makeUser('b');
  const add = async (u, body) => (await call(u.cookie, 'POST', '/transactions', body)).json;
  const t1 = await add(A, { title: 'ZOMATO ORDER', amount: -250, date: '2026-10-05', type: 'expense', category: 'General', classification: 'expense' });
  const t2 = await add(A, { title: 'Refund shop', amount: 100, date: '2026-10-06', type: 'income', category: 'Shopping', classification: 'refund' });
  const twinA = await add(A, { title: 'Coffee', amount: -50, date: '2026-10-07', type: 'expense', category: 'Food' });
  const twinB = await add(A, { title: 'Coffee', amount: -50, date: '2026-10-07', type: 'expense', category: 'Food' });
  const b1 = await add(B, { title: 'ZOMATO ORDER', amount: -300, date: '2026-10-05', type: 'expense', category: 'General' });
  ok([t1, t2, twinA, twinB, b1].every((t) => t?.id), 'synthetic transactions created');

  // authentication
  ok((await call(null, 'PATCH', `/transactions/${t1.id}`, { category: 'Food' })).status === 401, 'PATCH requires a session');
  ok((await call('token=forged', 'PATCH', `/transactions/${t1.id}`, { category: 'Food' })).status === 401, 'PATCH rejects a forged session');

  // a correction changes the category and nothing else, and persists
  const before = rowFor(await list(A), t1.id);
  let r = await call(A.cookie, 'PATCH', `/transactions/${t1.id}`, { category: '  Food  ' });
  ok(r.status === 200 && r.json.category === 'Food', 'the category is changed and trimmed', r.text);
  const after = rowFor(await list(A), t1.id);
  ok(after.category === 'Food' && ['id', 'userId', 'title', 'amount', 'date', 'type', 'classification'].every((k) => after[k] === before[k]), 'title, amount, date, type, classification, id and owner are untouched', JSON.stringify({ before, after }));
  ok(JSON.stringify(r.json) === JSON.stringify(after), 'the response is the updated transaction (same shape as the list)');
  r = await call(A.cookie, 'PATCH', `/transactions/${t1.id}`, { category: 'Others' });
  ok(r.json.category === 'Others', 'a user can choose "Others"');
  r = await call(A.cookie, 'PATCH', `/transactions/${t2.id}`, { category: 'Food' });
  ok(r.status === 200 && rowFor(await list(A), t2.id).classification === 'refund', 'a refund keeps its classification when its category changes');
  ok((await direct.query('SELECT category FROM transactions WHERE id = $1', [t1.id])).rows[0].category === 'Others', 'the change is stored in the database');

  // everything else is refused, and refused requests change nothing
  const snapshot = JSON.stringify(await list(A));
  for (const body of [null, [], {}, 'x', { category: '' }, { category: '   ' }, { category: 'x'.repeat(61) }, { category: 'a\nb' }, { category: 'a‮b' }, { category: 5 }, { category: null },
    { category: 'Food', amount: -1 }, { category: 'Food', classification: 'income' }, { category: 'Food', title: 'x' }, { category: 'Food', date: '2020-01-01' }, { category: 'Food', type: 'income' },
    { category: 'Food', userId: 2 }, { category: 'Food', id: 'zz' }, { amount: -1 }, { classification: 'income' }, { title: 'x' }]) {
    ok((await call(A.cookie, 'PATCH', `/transactions/${t1.id}`, body)).status === 400, `refused: ${JSON.stringify(body)?.slice(0, 50)}`);
  }
  ok(JSON.stringify(await list(A)) === snapshot, 'none of the refused requests changed anything');
  r = await call(A.cookie, 'PATCH', `/transactions/${t1.id}`, { category: 'x'.repeat(60) });
  ok(r.status === 200, 'exactly 60 characters is accepted');
  await call(A.cookie, 'PATCH', `/transactions/${t1.id}`, { category: 'Others' });

  // ownership
  r = await call(B.cookie, 'PATCH', `/transactions/${t1.id}`, { category: 'Hacked' });
  ok(r.status === 404, 'another user\'s transaction answers 404, like a missing one');
  ok(rowFor(await list(A), t1.id).category === 'Others', 'the owner\'s row is unchanged');
  ok((await call(A.cookie, 'PATCH', '/transactions/not-a-real-id', { category: 'Food' })).status === 404, 'an unknown id answers 404');
  ok((await call(A.cookie, 'PATCH', `/transactions/${b1.id}`, { category: 'Hacked' })).status === 404 && rowFor(await list(B), b1.id).category === 'General', 'A cannot change B\'s row either');
  ok(!(await list(B)).some((t) => t.category === 'Others' || t.category === 'Hacked'), 'B sees none of A\'s changes');

  // identical-looking transactions stay separate records: one change affects one row
  r = await call(A.cookie, 'PATCH', `/transactions/${twinA.id}`, { category: 'Entertainment' });
  const rows = await list(A);
  ok(r.status === 200 && rowFor(rows, twinA.id).category === 'Entertainment' && rowFor(rows, twinB.id).category === 'Food', 'two identical-looking transactions are still two records; only the targeted one changed');

  // legacy repeated ids (the table allows them): exactly one owned row changes, and never another user's
  await direct.query(`INSERT INTO transactions (id, user_id, title, amount, type, date, category, classification)
    SELECT '777', u.id, 'LEGACY ' || n, -10, 'expense', '2026-10-10', 'General', 'unknown' FROM users u, generate_series(1, 2) n WHERE u.email IN ($1, $2)`, [A.email, B.email]);
  r = await call(A.cookie, 'PATCH', '/transactions/777', { category: 'Bills' });
  const legacy = (await direct.query(`SELECT t.category, u.email FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.id = '777' ORDER BY u.email, t.seq`)).rows;
  ok(r.status === 200 && legacy.filter((x) => x.category === 'Bills').length === 1 && legacy.filter((x) => x.category === 'Bills')[0].email === A.email, 'a repeated legacy id changes exactly one of the owner\'s rows and none of another user\'s', JSON.stringify(legacy));

  // the same label feeds the budget figures
  const month = '2026-10';
  await call(A.cookie, 'PUT', '/budgets', { month, category: 'Dining out', amount: 1000 });
  const budgetBefore = (await call(A.cookie, 'GET', `/budgets?month=${month}`)).json.find((b) => b.category.toLowerCase() === 'dining out');
  await call(A.cookie, 'PATCH', `/transactions/${twinB.id}`, { category: 'Dining out' });
  const budgetAfter = (await call(A.cookie, 'GET', `/budgets?month=${month}`)).json.find((b) => b.category.toLowerCase() === 'dining out');
  ok(budgetBefore && budgetAfter && budgetAfter.actualSpent - budgetBefore.actualSpent === 50, 'budget spending follows the corrected category', `${budgetBefore?.actualSpent} -> ${budgetAfter?.actualSpent}`);


  const fields = { title: 'Edited purchase', amount: '125.55', type: 'expense', category: 'Custom craft', classification: 'expense', date: '2026-10-07' };
  ok((await call(null, 'PUT', '/transactions/' + t1.id, fields)).status === 401, 'full edit requires authentication');
  ok((await call(A.cookie, 'PUT', '/transactions/' + b1.id, fields)).status === 404, 'full edit cannot touch another account');
  ok((await call(A.cookie, 'PUT', '/transactions/not-found', fields)).status === 404, 'full edit missing row');
  const baseline = JSON.stringify(await list(A));
  for (const change of [{ amount: 0 }, { amount: '1e3' }, { amount: 'NaN' }, { date: '2026-02-30' }, { title: '' }, { type: 'other' }, { classification: 'income' }, { userId: 77 }, { id: 'changed' }, { category: 'x'.repeat(61) }, { category: 'bad\nlabel' }]) {
    ok((await call(A.cookie, 'PUT', '/transactions/' + t1.id, { ...fields, ...change })).status === 400, 'full edit rejects invalid input ' + Object.keys(change)[0]);
  }
  ok(JSON.stringify(await list(A)) === baseline, 'invalid full edits do not mutate any rows');
  r = await call(A.cookie, 'PUT', '/transactions/' + twinA.id, fields);
  ok(r.status === 200 && r.json.amount === -125.55 && r.json.title === fields.title && r.json.category === fields.category, 'full edit persists complete validated fields');
  ok(rowFor(await list(A), twinA.id)?.amount === -125.55 && rowFor(await list(A), twinB.id)?.amount === -50, 'full edit changes only its target');
  ok(r.json.id === twinA.id && r.json.userId === twinA.userId, 'full edit preserves id and owner');
  r = await call(A.cookie, 'PUT', '/transactions/' + twinA.id, { ...fields, type: 'income', classification: 'refund' });
  ok(r.status === 200 && r.json.amount === 125.55 && r.json.classification === 'refund', 'direction change is normalized with explicit refund classification');
  await call(A.cookie, 'PUT', '/transactions/777', fields);
  const editedLegacy = (await direct.query("SELECT user_id, title FROM transactions WHERE id='777'")).rows;
  ok(editedLegacy.filter(row => row.title === fields.title).length === 1, 'full edit with repeated legacy id changes exactly one owned row');
  ok(exitCode === null, 'server still running');
  ok(!/Hacked|Entertainment|Dining out|ZOMATO/.test(serverOut), 'the server log contains no transaction or category text', serverOut.slice(-300));
}

try { await run(); } finally {
  await stopServer(); await direct?.end().catch(() => {}); await sleep(500);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); await admin.end().catch(() => {});
}
console.log(`transaction editing (real server) tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
