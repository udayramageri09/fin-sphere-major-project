// X-FinSphere-User on the assistant routes, through the REAL server: a tab that names the account it is showing is refused (409,
// account_changed) when the session belongs to someone else, before anything is read, proposed, confirmed or cancelled.
//
//   npm --prefix server run test:account-guard
//
// Creates and drops its own throwaway PostgreSQL database (`finsphere_guard_<pid>`); never touches the database named in DATABASE_URL.
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

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) pass++; else { fail++; console.log('FAIL:', name, extra); } };

const envFile = path.join(SERVER_DIR, '.env');
const baseUrl = process.env.DATABASE_URL ?? (fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)).DATABASE_URL : undefined);
if (!baseUrl) { console.error('DATABASE_URL is not set (environment or server/.env).'); process.exit(2); }
const urlFor = (db) => { const u = new URL(baseUrl); u.pathname = '/' + db; return u.toString(); };
const DB = `finsphere_guard_${process.pid}`;
const admin = new pg.Client({ connectionString: urlFor('postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);

const PORT = 5097, base = `http://localhost:${PORT}/api`;
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
const PASSWORD = 'Passw0rd-guard-1';
async function makeUser(tag) {
  const email = `guard-${tag}@example.com`;
  await fetch(`${base}/auth/register`, { method: 'POST', headers: J, body: JSON.stringify({ email, password: PASSWORD }) });
  await direct.query("UPDATE users SET onboarding_state = 'completed' WHERE email = $1", [email]);
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ email, password: PASSWORD }) });
  const body = await r.json();
  return { email, id: String(body.user.id), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const call = async (u, method, p, body, headers = {}) => {
  const r = await fetch(base + p, { method, headers: { ...(body === undefined ? {} : J), ...(u ? { cookie: u.cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
};
const today = new Date(), pad = (n) => String(n).padStart(2, '0');
const localDate = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
const chat = (u, text, headers) => call(u, 'POST', '/chat', { messages: [{ role: 'user', content: text }], localDate }, headers);
const txCount = async (like) => (await direct.query('SELECT count(*)::int n FROM transactions WHERE title ILIKE $1', [like])).rows[0].n;
const proposals = async () => (await direct.query('SELECT status, count(*)::int n FROM assistant_action_proposals GROUP BY status ORDER BY status')).rows.map((r) => `${r.status}:${r.n}`).join(',');

async function run() {
  ok(await startServer(), 'server starts', serverOut);
  direct = new pg.Client({ connectionString: urlFor(DB) });
  await direct.connect();
  const A = await makeUser('a'), B = await makeUser('b');
  const mine = { 'X-FinSphere-User': A.id }, theirs = { 'X-FinSphere-User': B.id };

  // chat
  const own = await chat(A, 'How am I doing this month?', mine);
  ok(own.status === 200 && typeof own.json?.reply === 'string', 'a tab naming its own account is served', `${own.status}`);
  const none = await chat(A, 'How am I doing this month?');
  ok(none.status === 200, 'no header at all still works (optional, backward compatible)', `${none.status}`);
  const before = await proposals();
  const stale = await chat(A, 'add ₹10 for guardtest', theirs);
  ok(stale.status === 409 && stale.json?.code === 'account_changed' && !('reply' in (stale.json ?? {})), 'a tab naming a different account is refused with 409 account_changed and no reply', `${stale.status} ${stale.text.slice(0, 120)}`);
  ok((await proposals()) === before && (await txCount('%guardtest%')) === 0, 'the refused request created no proposal and no transaction');
  for (const bad of ['abc', '', '0', '-1', `${A.id}0`]) {
    const r = await chat(A, 'hello', { 'X-FinSphere-User': bad });
    ok(r.status === 409, `a header that is not exactly the session's id (${JSON.stringify(bad)}) is refused`, `${r.status}`);
  }
  ok((await chat(null, 'hello', mine)).status === 401, 'without a session the answer is 401, not 409');

  // confirm and cancel
  const made = await chat(A, 'add ₹10 for guardtest', mine);
  const proposalId = made.json?.action?.proposalId;
  ok(made.status === 200 && made.json?.action?.status === 'pending' && !!proposalId, 'a matching tab can create a proposal');
  const badConfirm = await call(A, 'POST', `/assistant/actions/${encodeURIComponent(proposalId)}/confirm`, {}, theirs);
  ok(badConfirm.status === 409 && badConfirm.json?.code === 'account_changed', 'confirming from a stale tab is refused', `${badConfirm.status}`);
  ok((await txCount('%guardtest%')) === 0 && /pending:1/.test(await proposals()), 'the refused confirm wrote nothing and left the proposal pending');
  const badCancel = await call(A, 'POST', `/assistant/actions/${encodeURIComponent(proposalId)}/cancel`, {}, theirs);
  ok(badCancel.status === 409 && /pending:1/.test(await proposals()), 'cancelling from a stale tab is refused and the proposal is untouched', `${badCancel.status}`);
  const noHeaderOther = await call(B, 'POST', `/assistant/actions/${encodeURIComponent(proposalId)}/confirm`, {});
  ok(noHeaderOther.status >= 400 && (await txCount('%guardtest%')) === 0, 'another account still cannot confirm it even without the header (ownership check unchanged)', `${noHeaderOther.status}`);
  const good = await call(A, 'POST', `/assistant/actions/${encodeURIComponent(proposalId)}/confirm`, {}, mine);
  ok(good.status === 200 && (await txCount('%guardtest%')) === 1, 'the matching tab confirms: exactly one transaction', `${good.status}`);
  const replay = await call(A, 'POST', `/assistant/actions/${encodeURIComponent(proposalId)}/confirm`, {}, mine);
  ok(replay.status === 200 && replay.json?.replay === true && (await txCount('%guardtest%')) === 1, 'a repeated confirm is a replay with no second write');
  const second = await chat(A, 'add ₹20 for guardcancel', mine);
  const cancelOk = await call(A, 'POST', `/assistant/actions/${encodeURIComponent(second.json.action.proposalId)}/cancel`, {}, mine);
  ok(cancelOk.status === 200 && (await txCount('%guardcancel%')) === 0, 'the matching tab can cancel');

  // scope: every authenticated route honours it
  const txStale = await call(A, 'GET', '/transactions', undefined, theirs);
  ok(txStale.status === 409 && txStale.json?.code === 'account_changed', 'reading transactions from a stale tab is refused', `${txStale.status}`);
  const txOwn = await call(A, 'GET', '/transactions', undefined, mine);
  ok(txOwn.status === 200 && Array.isArray(txOwn.json), 'and works for the matching tab');
  const writeStale = await call(A, 'POST', '/transactions', { title: 'stalewrite', amount: -9, date: localDate, type: 'expense', category: 'General' }, theirs);
  ok(writeStale.status === 409 && (await txCount('%stalewrite%')) === 0, 'a manual write from a stale tab is refused and writes nothing', `${writeStale.status}`);
  const writeOwn = await call(A, 'POST', '/transactions', { title: 'stalewrite', amount: -9, date: localDate, type: 'expense', category: 'General' }, mine);
  ok(writeOwn.status === 201 && (await txCount('%stalewrite%')) === 1, 'the matching tab can write');
  const profStale = await call(A, 'PATCH', '/auth/profile', { displayName: 'Stale Name' }, theirs);
  ok(profStale.status === 409 && (await direct.query("SELECT display_name d FROM users WHERE email = $1", [A.email])).rows[0].d !== 'Stale Name', 'a profile change from a stale tab is refused and nothing changes', `${profStale.status}`);
  // holdings, analysis and plan chat: refused before any protected work or mutation
  const holding = { name: 'GUARDHOLD', assetClass: 'Stocks', investedPaise: 100000, currentPaise: 120000, valuedOn: localDate };
  const holdCount = async () => (await direct.query("SELECT count(*)::int n FROM investment_holdings WHERE name = 'GUARDHOLD'")).rows[0].n;
  const holdRead = await call(A, 'GET', '/holdings', undefined, theirs);
  ok(holdRead.status === 409 && holdRead.json?.code === 'account_changed' && !Array.isArray(holdRead.json), 'reading holdings from a stale tab is refused (no data returned)', `${holdRead.status}`);
  const holdWriteStale = await call(A, 'POST', '/holdings', holding, theirs);
  ok(holdWriteStale.status === 409 && (await holdCount()) === 0, 'creating a holding from a stale tab is refused and writes nothing', `${holdWriteStale.status}`);
  const holdWriteOwn = await call(A, 'POST', '/holdings', holding, mine);
  ok(holdWriteOwn.status === 201 && (await holdCount()) === 1, 'the matching tab can create a holding');
  const holdId = holdWriteOwn.json?.id;
  const holdPutStale = await call(A, 'PUT', `/holdings/${holdId}`, { ...holding, currentPaise: 999900 }, theirs);
  ok(holdPutStale.status === 409 && (await direct.query('SELECT current_paise::text c FROM investment_holdings WHERE id = $1', [holdId])).rows[0].c === '120000', 'editing a holding from a stale tab is refused and changes nothing', `${holdPutStale.status}`);
  const holdDelStale = await call(A, 'DELETE', `/holdings/${holdId}`, undefined, theirs);
  ok(holdDelStale.status === 409 && (await holdCount()) === 1, 'deleting a holding from a stale tab is refused and deletes nothing', `${holdDelStale.status}`);
  const analyzeStale = await call(A, 'GET', '/ml/analyze', undefined, theirs);
  ok(analyzeStale.status === 409 && analyzeStale.json?.code === 'account_changed', 'running the analysis from a stale tab is refused before the analytics service is contacted', `${analyzeStale.status}`);
  const planChatStale = await call(A, 'POST', '/plan-chat', { messages: [{ role: 'user', content: 'why is my score low?' }] }, theirs);
  ok(planChatStale.status === 409 && planChatStale.json?.code === 'account_changed' && !('reply' in (planChatStale.json ?? {})), 'asking the plan advisor from a stale tab is refused with no reply', `${planChatStale.status}`);
  const holdOtherAccount = await call(B, 'GET', '/holdings', undefined, theirs);
  ok(holdOtherAccount.status === 200 && Array.isArray(holdOtherAccount.json) && holdOtherAccount.json.length === 0, 'account B (matching header) sees none of account A\'s holdings');
  const holdDelOwn = await call(A, 'DELETE', `/holdings/${holdId}`, undefined, mine);
  ok(holdDelOwn.status === 204 && (await holdCount()) === 0, 'the matching tab can delete its holding');
  const verifyStale = await call(A, 'GET', '/auth/verify', undefined, theirs);
  ok(verifyStale.status === 200, '/auth/verify (identity check) is never refused: it is how a stale tab learns the truth', `${verifyStale.status}`);
  // sweep: every other authenticated route (goals, liabilities, budgets, emergency fund, imports, OCR, photo, edits) refuses a stale tab
  // before doing anything. A request that WOULD be rejected for another reason (bad body, unknown id) still answers 409 first.
  const rowTotals = async () => JSON.stringify((await direct.query(`SELECT (SELECT count(*) FROM transactions) t, (SELECT count(*) FROM goals) g, (SELECT count(*) FROM liabilities) l, (SELECT count(*) FROM budgets) b, (SELECT count(*) FROM investment_holdings) h, (SELECT count(*) FROM user_avatars) a`)).rows[0]);
  const totalsBefore = await rowTotals();
  const sweep = [
    ['GET', '/goals'], ['POST', '/goals', { name: 'x' }], ['DELETE', '/goals/1'], ['POST', '/goals/1/contributions', { amount: 5 }], ['GET', '/goals/1/contributions'],
    ['GET', '/liabilities'], ['POST', '/liabilities', { name: 'x' }], ['DELETE', '/liabilities/1'], ['POST', '/liabilities/1/repayments', { amount: 5 }], ['GET', '/liabilities/1/repayments'],
    ['GET', '/budgets'], ['PUT', '/budgets', { category: 'Food', limit: 5 }], ['DELETE', '/budgets/1'], ['GET', '/emergency-fund'], ['PUT', '/emergency-fund', { currentAmount: 5 }],
    ['DELETE', '/transactions/1'], ['PATCH', '/transactions/1', { category: 'Food' }], ['PUT', '/transactions/1', { title: 'x' }],
    ['POST', '/transactions/parse-statement', {}], ['POST', '/transactions/import-confirm', { rows: [], policy: 'skip_duplicates', reviewDigest: 'x', skipIndexes: [] }], ['POST', '/transactions/ocr-statement-image', {}],
    ['GET', '/auth/avatar'], ['PUT', '/auth/avatar', {}], ['DELETE', '/auth/avatar']
  ];
  for (const [method, p, body] of sweep) {
    const r = await call(A, method, p, body, theirs);
    ok(r.status === 409 && r.json?.code === 'account_changed', `${method} ${p} from a stale tab is refused with 409 account_changed`, `${r.status} ${r.text.slice(0, 80)}`);
  }
  ok((await rowTotals()) === totalsBefore, 'none of those refused requests changed a row or a stored photo');
  const logoutStale = await call(A, 'POST', '/auth/logout', undefined, theirs);
  ok(logoutStale.status === 200, 'sign-out is intentionally exempt (it only ends the browser session, reads and writes no financial data)', `${logoutStale.status}`);
  ok(!/guard-a@|guard-b@|guardtest/.test(serverOut), 'the server log contains no email or request text', serverOut.slice(-200));
  ok(exitCode === null, 'server still running');
}

try { await run(); } finally {
  await stopServer(); await direct?.end().catch(() => {}); await sleep(500);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); await admin.end().catch(() => {});
}
console.log(`assistant account guard (real server) tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
