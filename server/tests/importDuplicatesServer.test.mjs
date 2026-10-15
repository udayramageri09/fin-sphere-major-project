// Duplicate-aware import (backend Stage 1) through the REAL server: opt-in report mode, the locked atomic import, the confirm
// endpoint, user isolation, stale confirmations, tampering, concurrency and compatibility of the default import.
//
//   npm --prefix server run test:import-duplicates-server
//
// Same safety model as the other server suites: it creates and drops its own throwaway PostgreSQL database
// (`finsphere_dupimp_<pid>`) on the server named by DATABASE_URL and never touches the database named in DATABASE_URL. A local
// stub stands in for Groq (GROQ_API_BASE, always HTTP 500) so the statement parser falls back to the rule-based one, and so the test
// can prove the confirm endpoint never calls a language model. Everything is synthetic.
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
const XLSX = require('xlsx');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) pass++; else { fail++; console.log('FAIL:', name, extra); } };

const envFile = path.join(SERVER_DIR, '.env');
const baseUrl = process.env.DATABASE_URL ?? (fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)).DATABASE_URL : undefined);
if (!baseUrl) { console.error('DATABASE_URL is not set (environment or server/.env).'); process.exit(2); }
const urlFor = (db) => { const u = new URL(baseUrl); u.pathname = '/' + db; return u.toString(); };
const DB = `finsphere_dupimp_${process.pid}`;
const admin = new pg.Client({ connectionString: urlFor('postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);

const PORT = 5087, STUB_PORT = 5088;
const base = `http://localhost:${PORT}/api`;
let server = null, serverOut = '', exitCode = null, direct = null;
let stubHits = 0;
const stub = http.createServer((req, res) => { stubHits++; req.resume(); res.writeHead(500); res.end('{}'); });
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

async function startServer() {
  const env = {
    ...process.env, DATABASE_URL: urlFor(DB), PORT: String(PORT), JWT_SECRET: 'd'.repeat(40),
    GROQ_API_KEY: 'fake-groq-key-not-real', GROQ_API_BASE: `http://127.0.0.1:${STUB_PORT}`, FINSPHERE_TEST_UPLOAD_LIMIT: '100000',
    PASSWORD_RESET_DELIVERY: '', RESEND_API_KEY: '', PASSWORD_RESET_FROM: '', PASSWORD_RESET_URL: ''
  };
  for (const k of ['NODE_ENV', 'CORS_ORIGINS', 'TRUST_PROXY']) delete env[k];
  server = spawn(process.execPath, ['server.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  server.on('exit', (code) => { exitCode = code ?? 'signal'; });
  for (let i = 0; i < 80; i++) { try { await fetch(`${base}/auth/verify`); return true; } catch { await sleep(250); } }
  return false;
}
async function stopServer() { if (server && exitCode === null) { server.kill(); for (let i = 0; i < 40 && exitCode === null; i++) await sleep(100); } }

const PASSWORD = 'Passw0rd-dup-1';
const J = { 'content-type': 'application/json' };
async function makeUser(tag) {
  const email = `dup-${tag}@example.com`;
  await fetch(`${base}/auth/register`, { method: 'POST', headers: J, body: JSON.stringify({ email, password: PASSWORD }) });
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ email, password: PASSWORD }) });
  return { email, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const send = async (cookie, method, p, body, extraHeaders = {}) => {
  const r = await fetch(base + p, { method, headers: { ...J, ...(cookie ? { cookie } : {}), ...extraHeaders }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
};
const parse = (u, text, qs = '') => send(u.cookie, 'POST', `/transactions/parse-statement${qs}`, { text });
const confirm = (u, body) => send(u.cookie, 'POST', '/transactions/import-confirm', body);
const upload = async (u, name, buf, qs = '') => {
  const fd = new FormData(); fd.append('statementFile', new Blob([buf]), name);
  const r = await fetch(`${base}/transactions/parse-statement${qs}`, { method: 'POST', headers: { cookie: u.cookie }, body: fd });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json };
};
const dbRows = async (u) => (await direct.query(`SELECT seq, id, user_id, title, amount::float8 AS amount, to_char(date,'YYYY-MM-DD') AS date, type, category, classification, created_at FROM transactions WHERE user_id = (SELECT id FROM users WHERE email = $1) ORDER BY seq`, [u.email])).rows;
const count = async (u) => (await dbRows(u)).length;
const lines = (...l) => l.join('\n');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATEMENT = lines('05/03/2026 ZOMATO ORDER -120.50', '06/03/2026 SALARY ACME +50000.00', '07/03/2026 AMAZON PAY -1599.00');

async function run() {
  ok(await startServer(), 'server starts', serverOut);
  direct = new pg.Client({ connectionString: urlFor(DB) });
  await direct.connect();
  const [A, B, C, D, E, G] = [await makeUser('a'), await makeUser('b'), await makeUser('c'), await makeUser('d'), await makeUser('e'), await makeUser('g')];
  ok([A, B, C, D, E, G].every((u) => u.cookie.length > 10), 'six synthetic users sign in');

  // ═══ duplicate reporting is the DEFAULT; duplicates=allow is the explicit legacy behaviour ═══════════════════════
  let r = await parse(A, STATEMENT);
  ok(r.status === 200 && r.json.count === 3 && r.json.skipped === 0 && r.json.transactions.length === 3, 'default: a statement with no matches imports as always', r.text.slice(0, 200));
  ok(Object.keys(r.json).join() === 'success,count,skipped,transactions,notice' && r.json.notice === 'Parsed using local backup engine', 'default: the successful response shape is unchanged', Object.keys(r.json).join());
  ok(r.json.transactions.every((t) => UUID.test(t.id) && t.classification === 'unknown'), 'default: server ids, unclassified');
  r = await parse(A, STATEMENT);
  ok(r.status === 409 && r.json.code === 'DUPLICATES_FOUND' && r.json.summary.likely === 3 && (await count(A)) === 3, 'default: importing the same statement again is HELD BACK (409), nothing saved', `${r.status} ${r.text.slice(0, 160)}`);
  const explicit = await parse(A, STATEMENT, '?duplicates=report');
  ok(JSON.stringify(explicit.json) === JSON.stringify(r.json) && explicit.status === 409, 'default and explicit duplicates=report give the identical answer');
  r = await parse(A, STATEMENT, '?duplicates=allow');
  ok(r.status === 200 && r.json.count === 3 && Object.keys(r.json).join() === 'success,count,skipped,transactions,notice' && (await count(A)) === 6, 'duplicates=allow: the intentional legacy behaviour saves it again, same response shape', String(await count(A)));
  r = await parse(A, STATEMENT, '?duplicates=allow');
  ok(r.status === 200 && (await count(A)) === 9, 'duplicates=allow keeps working repeatedly (no check, no lock)');
  for (const qs of ['?duplicates=skip', '?duplicates=', '?duplicates=REPORT', '?duplicates=report&duplicates=allow']) {
    r = await parse(A, STATEMENT, qs);
    ok(r.status === 400, `invalid duplicates option ${qs} -> 400`, `${r.status} ${r.text.slice(0, 100)}`);
  }
  ok((await count(A)) === 9, 'a rejected option saves nothing');
  // every statement format goes through the protected path when the option is omitted
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Date', 'Narration', 'Withdrawal Amt.', 'Deposit Amt.'], ['2026-03-05', 'ZOMATO ORDER', 120.5, ''], ['2026-03-06', 'SALARY ACME', '', 50000]]), 'S');
  const xbuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const xlsBuf = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' });
  r = await upload(A, 'stmt.xlsx', xbuf);
  ok(r.status === 409 && r.json.code === 'DUPLICATES_FOUND' && r.json.summary.likely === 2, 'default: XLSX that matches saved rows is held back', `${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
  r = await upload(A, 'stmt.xls', xlsBuf);
  ok(r.status === 409 && r.json.summary.likely === 2, 'default: XLS likewise');
  r = await upload(A, 'stmt.txt', Buffer.from(STATEMENT));
  ok(r.status === 409 && r.json.summary.likely === 3, 'default: TXT likewise');
  r = await upload(A, 'stmt.csv', Buffer.from(lines('05/03/2026,ZOMATO ORDER,-120.50')));
  ok(r.status === 409 && r.json.summary.likely === 1, 'default: CSV likewise');
  ok((await count(A)) === 9, 'none of the held-back file imports saved anything');
  r = await upload(A, 'stmt.xlsx', xbuf, '?duplicates=allow');
  ok(r.status === 200 && r.json.count === 2, 'duplicates=allow: XLSX imports');
  r = await upload(A, 'stmt.csv', Buffer.from(lines('05/03/2026,CSV SHOP,-10.00')));
  ok(r.status === 200 && r.json.count === 1, 'default: a CSV with no matches imports normally');
  ok((await count(A)) === 12, 'database count after the legacy-allowed and new imports');

  // ═══ report mode: no match -> saved as usual; match -> nothing saved, preview ═════════════════════════════════
  const hitsBefore = stubHits;
  r = await parse(B, STATEMENT, '?duplicates=report');
  ok(r.status === 200 && r.json.count === 3 && r.json.transactions.length === 3 && Object.keys(r.json).join() === 'success,count,skipped,transactions,notice', 'report: a statement with no matches imports exactly like the default', r.text.slice(0, 200));
  ok(stubHits > hitsBefore, 'the statement parser (Groq stub) was used by the parse call');
  const bIds = (await dbRows(B)).map((x) => x.id);
  const bBefore = await dbRows(B);
  r = await parse(B, STATEMENT, '?duplicates=report');
  const preview = r.json;
  ok(r.status === 409 && preview.code === 'DUPLICATES_FOUND' && preview.success === false, 'report: importing it again -> 409 DUPLICATES_FOUND', r.text.slice(0, 200));
  ok(JSON.stringify(preview.summary) === JSON.stringify({ total: 3, new: 0, likely: 3, possible: 0 }), 'report: summary counts', JSON.stringify(preview.summary));
  ok((await count(B)) === 3, 'report: the conflict saved NOTHING');
  ok(preview.rows.length === 3 && preview.rows.map((x) => x.title).join('|') === 'ZOMATO ORDER|SALARY ACME|AMAZON PAY' && preview.rows.every((x, i) => x.index === i), 'report: candidate rows come back in statement order', JSON.stringify(preview.rows.map((x) => x.title)));
  ok(preview.rows.every((x) => x.duplicate?.tier === 'likely' && bIds.includes(x.duplicate.match.id)), 'report: every row matches one of the USER\'S OWN saved rows');
  ok(preview.rows.every((x) => !('id' in x) && !('userId' in x) && !('classification' in x)), 'report: preview rows carry no ids or owner');
  ok(/^[a-f0-9]{64}$/.test(preview.reviewDigest) && preview.maxRows === 500 && preview.skipped === 0 && !('transactions' in preview), 'report: digest, limit, skipped count, no saved transactions');
  const aIds = (await dbRows(A)).map((x) => x.id);
  ok(!JSON.stringify(preview).split('"').some((s) => aIds.includes(s)), 'report: nothing from another user (user A has the same statement saved nine times over)');

  // ═══ cross-user isolation ═════════════════════════════════════════════════════════════════════════════════════
  r = await parse(C, STATEMENT, '?duplicates=report');
  ok(r.status === 200 && r.json.count === 3, 'user C imports the same statement: A and B having it is invisible to C', r.text.slice(0, 120));

  // ═══ confirm: skip_duplicates, import_all, replay ══════════════════════════════════════════════════════════
  const rowsOf = (p) => p.rows.map(({ title, amount, date, type, category }) => ({ title, amount, date, type, category }));
  r = await confirm(B, { rows: rowsOf(preview), policy: 'skip_duplicates', reviewDigest: preview.reviewDigest });
  ok(r.status === 200 && r.json.count === 0 && r.json.skipped === 3 && r.json.duplicates.skippedLikely === 3 && r.json.transactions.length === 0, 'confirm skip_duplicates: the three likely duplicates are skipped and counted', r.text.slice(0, 200));
  ok((await count(B)) === 3, 'confirm skip_duplicates saved nothing new');
  r = await confirm(B, { rows: rowsOf(preview), policy: 'import_all', reviewDigest: preview.reviewDigest });
  ok(r.status === 200 && r.json.count === 3 && r.json.skipped === 0 && r.json.duplicates.likelyImportedAnyway === 3, 'confirm import_all: the user\'s explicit choice imports them', r.text.slice(0, 200));
  const afterAll = await dbRows(B);
  ok(afterAll.length === 6 && afterAll.slice(0, 3).every((x, i) => x.id === bBefore[i].id && x.title === bBefore[i].title && Number(x.amount) === Number(bBefore[i].amount) && String(x.created_at) === String(bBefore[i].created_at)), 'existing rows were not modified', JSON.stringify(afterAll.length));
  ok(r.json.transactions.every((t) => UUID.test(t.id) && t.userId === afterAll[0].user_id * 1 && t.classification === 'unknown'), 'saved rows: server ids, the session user as owner, unclassified');
  const again = await confirm(B, { rows: rowsOf(preview), policy: 'import_all', reviewDigest: preview.reviewDigest });
  ok(again.status === 409 && again.json.code === 'STALE_PREVIEW' && (await count(B)) === 6, 'replaying the same confirm (double click) -> 409 STALE_PREVIEW, nothing inserted', again.text.slice(0, 160));
  ok(again.json.rows?.length === 3 && /^[a-f0-9]{64}$/.test(again.json.reviewDigest) && again.json.reviewDigest !== preview.reviewDigest, 'a stale answer carries a fresh preview and digest');

  // ═══ possible matches are never skipped on date+amount+direction alone ═════════════════════════════════════
  await send(E.cookie, 'POST', '/transactions', { title: 'Food delivery', amount: 120.5, date: '2026-03-05', type: 'expense', category: 'Food' });
  const possibleStmt = lines('05/03/2026 ZOMATO ORDER -120.50', '08/03/2026 NEW SHOP -30.00');
  r = await parse(E, possibleStmt, '?duplicates=report');
  const pp = r.json;
  ok(r.status === 409 && pp.summary.likely === 0 && pp.summary.possible === 1 && pp.summary.new === 1 && pp.rows[0].duplicate.tier === 'possible' && pp.rows[1].duplicate === null, 'a differently worded row on the same date/amount/direction is reported as POSSIBLE (and still holds the import back)', r.text.slice(0, 240));
  ok((await count(E)) === 1, 'nothing saved while a possible match is pending');
  r = await confirm(E, { rows: rowsOf(pp), policy: 'skip_duplicates', reviewDigest: pp.reviewDigest });
  ok(r.status === 200 && r.json.count === 2 && r.json.skipped === 0 && r.json.duplicates.possibleImported === 1 && r.json.duplicates.skippedLikely === 0, 'skip_duplicates does NOT skip the possible match (it is imported and reported)', r.text.slice(0, 200));
  r = await parse(E, possibleStmt, '?duplicates=report');
  const pp2 = r.json;
  ok(r.status === 409 && pp2.summary.likely === 2, 'now both rows exist: both likely', JSON.stringify(pp2.summary));
  // an explicit user decision CAN omit a possible row
  await send(E.cookie, 'POST', '/transactions', { title: 'Tea stall', amount: 15, date: '2026-03-09', type: 'expense', category: 'Food' });
  r = await parse(E, lines('09/03/2026 CHAI POINT -15.00', '10/03/2026 BUS -25.00'), '?duplicates=report');
  const pp3 = r.json;
  ok(r.status === 409 && pp3.summary.possible === 1, 'second possible case');
  r = await confirm(E, { rows: rowsOf(pp3), policy: 'import_all', reviewDigest: pp3.reviewDigest, skipIndexes: [0] });
  ok(r.status === 200 && r.json.count === 1 && r.json.duplicates.skippedByUser === 1 && r.json.transactions[0].title === 'BUS', 'only the user\'s explicit skipIndexes omits a possible row', r.text.slice(0, 200));

  // ═══ multiset: repeated identical payments ═════════════════════════════════════════════════════════════════
  const two = lines('11/03/2026 COFFEE -50.00', '11/03/2026 COFFEE -50.00');
  r = await parse(D, two, '?duplicates=report');
  ok(r.status === 200 && r.json.count === 2, 'two identical payments in one statement are NOT duplicates of each other', r.text.slice(0, 160));
  r = await parse(D, two, '?duplicates=report');
  ok(r.status === 409 && r.json.summary.likely === 2 && r.json.summary.new === 0, 're-importing the pair flags both', JSON.stringify(r.json.summary));
  const three = lines('11/03/2026 COFFEE -50.00', '11/03/2026 COFFEE -50.00', '11/03/2026 COFFEE -50.00');
  r = await parse(D, three, '?duplicates=report');
  ok(r.status === 409 && r.json.summary.likely === 2 && r.json.summary.new === 1 && r.json.rows[2].duplicate === null, 'a third identical payment is new: only the two already present are flagged', JSON.stringify(r.json.summary));
  const p3 = r.json;
  r = await confirm(D, { rows: rowsOf(p3), policy: 'skip_duplicates', reviewDigest: p3.reviewDigest });
  ok(r.status === 200 && r.json.count === 1 && r.json.skipped === 2 && (await count(D)) === 3, 'skip_duplicates saves exactly the one new payment', r.text.slice(0, 160));

  // ═══ stale confirmations ═══════════════════════════════════════════════════════════════════════════════════
  r = await parse(D, lines('12/03/2026 RENT -18000.00'), '?duplicates=report');
  ok(r.status === 200, 'stale setup: row saved');
  r = await parse(D, lines('12/03/2026 RENT -18000.00', '13/03/2026 GYM -999.00'), '?duplicates=report');
  const s1 = r.json;
  ok(r.status === 409 && s1.summary.likely === 1, 'stale setup: preview');
  const matched = s1.rows[0].duplicate.match.id;
  await send(D.cookie, 'DELETE', `/transactions/${matched}`);
  const beforeStale = await count(D);
  r = await confirm(D, { rows: rowsOf(s1), policy: 'skip_duplicates', reviewDigest: s1.reviewDigest });
  ok(r.status === 409 && r.json.code === 'STALE_PREVIEW' && (await count(D)) === beforeStale, 'a matched row deleted after the preview -> stale, nothing inserted', r.text.slice(0, 160));
  ok(r.json.summary.likely === 0 && r.json.summary.new === 2, 'the fresh preview reflects the change', JSON.stringify(r.json.summary));
  r = await parse(D, lines('14/03/2026 BOOKS -400.00'), '?duplicates=report');
  ok(r.status === 200, 'stale setup 2: row saved');
  r = await parse(D, lines('14/03/2026 BOOKS -400.00', '15/03/2026 MOVIE -300.00'), '?duplicates=report');
  const s2 = r.json;
  await send(D.cookie, 'POST', '/transactions', { title: 'Books', amount: 400, date: '2026-03-14', type: 'expense', category: 'General' });   // a second matching row appears
  const beforeStale2 = await count(D);
  r = await confirm(D, { rows: rowsOf(s2), policy: 'import_all', reviewDigest: s2.reviewDigest });
  ok(r.status === 409 && r.json.code === 'STALE_PREVIEW' && (await count(D)) === beforeStale2, 'a new matching row after the preview -> stale (even for import_all), nothing inserted');

  // ═══ tampering ═════════════════════════════════════════════════════════════════════════════════════════════
  r = await parse(B, lines('20/03/2026 FUEL -500.00', '21/03/2026 FRESH ITEM -77.00'), '?duplicates=report');
  ok(r.status === 200, 'tamper setup: saved');
  r = await parse(B, lines('20/03/2026 FUEL -500.00', '21/03/2026 FRESH ITEM -77.00', '22/03/2026 NEVER SEEN -12.00'), '?duplicates=report');
  const t = r.json;
  ok(r.status === 409 && t.summary.likely === 2 && t.summary.new === 1, 'tamper setup: preview', JSON.stringify(t.summary));
  const good = rowsOf(t);
  const before = await count(B);
  r = await confirm(B, { rows: good.map((x, i) => (i === 2 ? { ...x, amount: -1.00 } : x)), policy: 'skip_duplicates', reviewDigest: t.reviewDigest });
  ok(r.status === 409 && r.json.code === 'STALE_PREVIEW' && (await count(B)) === before, 'an edited row (amount) no longer matches the reviewed digest -> 409, nothing inserted');
  r = await confirm(B, { rows: good.slice(0, 2), policy: 'skip_duplicates', reviewDigest: t.reviewDigest });
  ok(r.status === 409 && (await count(B)) === before, 'a row removed from the reviewed set -> 409');
  const forged = good.map((x) => ({ ...x, id: 'client-chosen-id', userId: 1, user_id: 1, classification: 'income', duplicate: null, isDuplicate: false, tier: null }));
  r = await confirm(B, { rows: forged, policy: 'skip_duplicates', reviewDigest: t.reviewDigest, userId: 1, duplicates: [], match: null });
  ok(r.status === 200 && r.json.count === 1 && r.json.skipped === 2 && r.json.duplicates.skippedLikely === 2, 'client-supplied "not a duplicate" flags are ignored: the server still skips the two real duplicates', r.text.slice(0, 220));
  const inserted = (await dbRows(B)).slice(before);
  ok(inserted.length === 1 && inserted[0].title === 'NEVER SEEN' && inserted[0].id !== 'client-chosen-id' && UUID.test(inserted[0].id), 'client-chosen id is ignored: a server UUID is stored');
  ok(inserted[0].user_id === (await dbRows(B))[0].user_id && inserted[0].classification === 'unknown', 'client userId / classification ignored: owned by the session user, unclassified');
  r = await confirm(C, { rows: good, policy: 'import_all', reviewDigest: t.reviewDigest });
  ok(r.status === 409 && r.json.code === 'STALE_PREVIEW', 'another user cannot use this digest (it is bound to the user)', r.text.slice(0, 120));
  ok(!JSON.stringify(r.json).includes('"id"') || r.json.rows.every((x) => x.duplicate === null), 'and learns nothing about the owner\'s rows (user C sees only matches among C\'s own rows)');
  const validBase = { rows: good, policy: 'skip_duplicates', reviewDigest: t.reviewDigest };
  const bad = [
    ['missing digest', { ...validBase, reviewDigest: undefined }], ['malformed digest', { ...validBase, reviewDigest: 'abc' }],
    ['uppercase digest', { ...validBase, reviewDigest: t.reviewDigest.toUpperCase() }], ['unknown policy', { ...validBase, policy: 'skip' }],
    ['empty rows', { ...validBase, rows: [] }], ['rows not an array', { ...validBase, rows: 'x' }],
    ['501 rows', { ...validBase, rows: Array(501).fill(good[0]) }],
    ['an invalid row', { ...validBase, rows: [good[0], { ...good[1], amount: 'abc' }] }],
    ['skipIndexes out of range', { ...validBase, skipIndexes: [9] }], ['array body', [1, 2]]
  ];
  for (const [name, body] of bad) {
    r = await confirm(B, body);
    ok(r.status === 400 && (await count(B)) === before + 1, `confirm rejects: ${name} -> 400, nothing inserted`, `${r.status} ${r.text.slice(0, 100)}`);
  }
  r = await confirm(B, { ...validBase, rows: [good[0], { ...good[1], amount: 'abc' }] });
  ok(/^Row 2:/.test(r.json.error), 'an invalid row is named by position', r.text);
  r = await confirm(B, { rows: [{ title: 'x', amount: -1, date: '2026-03-01', type: 'expense' }], policy: 'import_all', reviewDigest: 'f'.repeat(64) });
  ok(r.status === 409, 'a made-up digest is simply stale');

  // ═══ authentication and body size ═════════════════════════════════════════════════════════════════════════════
  const countAll = async () => Number((await direct.query('SELECT count(*) n FROM transactions')).rows[0].n);
  const allBefore = await countAll();
  r = await send(null, 'POST', '/transactions/import-confirm', validBase);
  ok(r.status === 401, 'confirm without a session -> 401');
  r = await send('token=forged', 'POST', '/transactions/import-confirm', validBase);
  ok(r.status === 401, 'confirm with a forged session -> 401');
  const huge = JSON.stringify({ rows: good, policy: 'import_all', reviewDigest: t.reviewDigest, pad: 'x'.repeat(300 * 1024) });
  r = await send(null, 'POST', '/transactions/import-confirm', huge);
  ok(r.status === 401, 'an unauthenticated 300 KB body is refused as unauthenticated (it is not parsed first)', String(r.status));
  r = await send(B.cookie, 'POST', '/transactions/import-confirm', huge);
  ok(r.status === 413, 'an authenticated body over 256 KB -> 413', String(r.status));
  r = await send(null, 'POST', '/auth/login', JSON.stringify({ email: 'x@example.com', password: 'y'.repeat(150 * 1024) }));
  ok(r.status === 413, 'every other route keeps the 100 KB body limit (login with 150 KB -> 413)', String(r.status));
  ok((await countAll()) === allBefore, 'none of the refused requests wrote anything');

  // ═══ row cap and a 500-row import ══════════════════════════════════════════════════════════════════════════
  const many = (n, start = 1) => Array.from({ length: n }, (_, i) => `01/04/2026 ITEM ${start + i} -${(start + i) % 900 + 1}.${String((start + i) % 100).padStart(2, '0')}`);
  r = await parse(D, many(501).join('\n'), '?duplicates=report');
  ok(r.status === 413 && /at most 500/.test(r.json.error), 'report mode: 501 parsed rows -> 413 with the limit named', r.text.slice(0, 160));
  const dBeforeBig = await count(D);
  ok(dBeforeBig === (await count(D)), 'the cap refused before saving');
  await send(G.cookie, 'POST', '/transactions', { title: 'ITEM 1', amount: 2.01, date: '2026-04-01', type: 'expense', category: 'General' });
  r = await parse(G, many(500).join('\n'), '?duplicates=report');
  ok(r.status === 409 && r.json.rows?.length === 500 && r.json.summary.likely === 1, 'report mode: exactly 500 rows is accepted (one matches an existing row)', `${r.status} ${r.text.slice(0, 160)}`);
  const big = r.json;
  r = await confirm(G, { rows: rowsOf(big), policy: 'skip_duplicates', reviewDigest: big.reviewDigest });
  ok(r.status === 200 && r.json.count === 499 && r.json.skipped === 1 && (await count(G)) === 500, 'a 500-row confirm fits the body limit and saves the 499 new rows atomically', `${r.status} ${r.text.slice(0, 160)}`);
  const gRows = await dbRows(G);
  ok(gRows.length === 500, 'all rows saved (1 existing + 499)');

  // ═══ concurrency ═══════════════════════════════════════════════════════════════════════════════════════════
  const concurrent = lines('25/03/2026 PARALLEL ONE -111.00', '25/03/2026 PARALLEL TWO -222.00', '26/03/2026 PARALLEL THREE +333.00');
  const results = await Promise.all(Array.from({ length: 6 }, () => parse(C, concurrent, '?duplicates=report')));
  const wins = results.filter((x) => x.status === 200), conflicts = results.filter((x) => x.status === 409);
  const cRows = (await dbRows(C)).filter((x) => /PARALLEL/.test(x.title));
  ok(wins.length === 1 && conflicts.length === 5 && cRows.length === 3, 'six simultaneous report-mode imports of one statement: exactly one saves, five are held back', `${wins.length}/${conflicts.length}, rows=${cRows.length}`);
  ok(conflicts.every((x) => x.json.summary.likely === 3), 'every held-back one saw the winner\'s rows as likely duplicates');
  // a preview, then six simultaneous confirms with the same digest
  r = await parse(C, lines('27/03/2026 RACE ROW -10.00', '28/03/2026 RACE ROW TWO -20.00'), '?duplicates=report');
  ok(r.status === 200, 'race setup saved');
  r = await parse(C, lines('27/03/2026 RACE ROW -10.00', '28/03/2026 RACE ROW TWO -20.00', '29/03/2026 RACE NEW -30.00'), '?duplicates=report');
  const race = r.json;
  const c0 = await count(C);
  const confirms = await Promise.all(Array.from({ length: 6 }, () => confirm(C, { rows: rowsOf(race), policy: 'skip_duplicates', reviewDigest: race.reviewDigest })));
  ok(confirms.filter((x) => x.status === 200).length === 1 && confirms.filter((x) => x.status === 409).length === 5 && (await count(C)) === c0 + 1, 'six simultaneous confirms with one digest: exactly one inserts (once), five are stale', confirms.map((x) => x.status).join());
  r = await parse(C, lines('30/03/2026 MIXED A -1.00'), '?duplicates=report');
  const mixed = await Promise.all([parse(C, lines('31/03/2026 MIXED B -2.00'), '?duplicates=report'), parse(E, lines('31/03/2026 MIXED B -2.00'), '?duplicates=report')]);
  ok(mixed.every((x) => x.status === 200), 'imports of different users never block or flag each other');

  // ═══ compatibility of ordering, Excel and OCR-derived text in report mode ═══════════════════════════════════════
  const ordered = lines('02/04/2026 ORDER FIRST -1.50', '03/04/2026 ORDER SECOND -2.50', '04/04/2026 ORDER THIRD -3.50');
  await parse(A, ordered);                          // default path (user A)
  await parse(G, ordered, '?duplicates=report');    // report path (user G)
  const list = async (u) => (await send(u.cookie, 'GET', '/transactions')).json.filter((x) => /^ORDER /.test(x.title)).map((x) => x.title).join('|');
  ok((await list(A)) === (await list(G)) && (await list(A)) === 'ORDER FIRST|ORDER SECOND|ORDER THIRD', 'the listing order of imported rows is identical in default and report mode', `${await list(A)} / ${await list(G)}`);
  r = await upload(D, 'stmt.xlsx', xbuf, '?duplicates=report');
  ok(r.status === 200 && r.json.count === 2, 'report mode: XLSX with no matches imports');
  r = await upload(D, 'stmt.xlsx', xbuf, '?duplicates=report');
  ok(r.status === 409 && r.json.summary.likely === 2, 'report mode: the same XLSX again is held back', JSON.stringify(r.json?.summary));
  const ocrText = lines('05/03/2026 OCR SHOP -45.00', '06/03/2026 OCR PAYROLL +9000.00');   // what the image OCR returns, pasted into the editor
  ok((await parse(D, ocrText, '?duplicates=report')).status === 200 && (await parse(D, ocrText, '?duplicates=report')).status === 409, 'OCR-derived text behaves exactly like pasted text');
  r = await parse(D, lines('06/04/2026 SIGNLESS 10.00'), '?duplicates=report');
  ok(r.status === 400 && /No valid transactions found/.test(r.json.error), 'report mode keeps the unsigned-row behaviour (nothing guessed, same error)', r.text.slice(0, 160));

  // ═══ policy / exclusion matrix: likely, possible, new rows with skip_duplicates, import_all and skipIndexes ═════════
  let caseNo = 0;
  async function matrixCase() {            // fresh dates per case, so cases never interfere: 0 likely, 1 possible, 2 new, 3 new
    const d = String(10 + ++caseNo);
    await send(C.cookie, 'POST', '/transactions', { title: 'ALPHA', amount: 10, date: `2026-07-${d}`, type: 'expense', category: 'General' });
    await send(C.cookie, 'POST', '/transactions', { title: 'Some other name', amount: 20, date: `2026-07-${d}`, type: 'expense', category: 'General' });
    const res = await parse(C, lines(`${d}/07/2026 ALPHA -10.00`, `${d}/07/2026 BETA -20.00`, `${d}/07/2026 GAMMA -30.00`, `${d}/07/2026 DELTA -40.00`));
    return res.json;
  }
  const savedTitles = (res) => res.json.transactions.map((t) => t.title).join(',');
  let mp = await matrixCase();
  ok(mp.summary && mp.summary.likely === 1 && mp.summary.possible === 1 && mp.summary.new === 2 && mp.rows[0].duplicate.tier === 'likely' && mp.rows[1].duplicate.tier === 'possible', 'matrix setup: row 0 likely, row 1 possible, rows 2 and 3 new', JSON.stringify(mp.summary));
  r = await confirm(C, { rows: rowsOf(mp), policy: 'skip_duplicates', reviewDigest: mp.reviewDigest, skipIndexes: [3] });
  ok(r.status === 200 && savedTitles(r) === 'BETA,GAMMA' && r.json.duplicates.skippedLikely === 1 && r.json.duplicates.skippedByUser === 1 && r.json.duplicates.possibleImported === 1, 'skip_duplicates + exclusion: skips the likely row, imports the possible row, honours the explicit exclusion', r.text.slice(0, 260));
  mp = await matrixCase();
  r = await confirm(C, { rows: rowsOf(mp), policy: 'import_all', reviewDigest: mp.reviewDigest, skipIndexes: [0] });
  ok(r.status === 200 && savedTitles(r) === 'BETA,GAMMA,DELTA' && r.json.duplicates.skippedByUser === 1 && r.json.duplicates.likelyImportedAnyway === 0, 'import_all + skipIndexes: only the explicitly excluded row is left out (even a likely one)', r.text.slice(0, 260));
  mp = await matrixCase();
  r = await confirm(C, { rows: rowsOf(mp), policy: 'import_all', reviewDigest: mp.reviewDigest, skipIndexes: [1, 2] });
  ok(r.status === 200 && savedTitles(r) === 'ALPHA,DELTA' && r.json.duplicates.likelyImportedAnyway === 1 && r.json.duplicates.skippedByUser === 2 && r.json.duplicates.possibleImported === 0, 'import_all: a likely row is imported only because the user said so; excluded possible/new rows are not', r.text.slice(0, 260));
  mp = await matrixCase();
  r = await confirm(C, { rows: rowsOf(mp), policy: 'skip_duplicates', reviewDigest: mp.reviewDigest, skipIndexes: [1] });
  ok(r.status === 200 && savedTitles(r) === 'GAMMA,DELTA' && r.json.duplicates.skippedLikely === 1 && r.json.duplicates.skippedByUser === 1, 'skip_duplicates + an excluded possible row: only an EXPLICIT exclusion omits a possible match', r.text.slice(0, 260));
  mp = await matrixCase();
  r = await confirm(C, { rows: rowsOf(mp), policy: 'skip_duplicates', reviewDigest: mp.reviewDigest });
  ok(r.status === 200 && savedTitles(r) === 'BETA,GAMMA,DELTA', 'skip_duplicates alone never skips the possible match', r.text.slice(0, 200));
  // a digest cannot be carried over to different rows
  mp = await matrixCase();
  const other = await matrixCase();
  r = await confirm(C, { rows: rowsOf(other), policy: 'import_all', reviewDigest: mp.reviewDigest });
  ok(r.status === 409 && r.json.code === 'STALE_PREVIEW', 'a digest issued for one set of rows is refused for another');
  const swapped = rowsOf(mp).reverse();
  r = await confirm(C, { rows: swapped, policy: 'import_all', reviewDigest: mp.reviewDigest });
  ok(r.status === 409, 'the same rows in a different order are refused too');

  // ═══ the match bound fails CLOSED ═══════════════════════════════════════════════════════════════════════════════
  const H = await makeUser('h');
  const hid = (await direct.query('SELECT id FROM users WHERE email = $1', [H.email])).rows[0].id;
  await direct.query(`INSERT INTO transactions (id, user_id, title, amount, type, date, category, classification)
                      SELECT md5(i::text), $1, 'CAPROW', -9.99, 'expense', '2026-05-01', 'General', 'unknown' FROM generate_series(1, 5001) AS i`, [hid]);
  const capStmt = lines('01/05/2026 CAPROW -9.99', '02/05/2026 OTHER ROW -1.00');
  r = await parse(H, capStmt);
  ok(r.status === 422 && r.json.code === 'MATCH_LIMIT_EXCEEDED' && r.json.success === false && /Nothing was imported/.test(r.json.error), 'more than 5,000 matches: the default import FAILS CLOSED (422), it is not treated as duplicate-free', `${r.status} ${r.text.slice(0, 200)}`);
  ok((await count(H)) === 5001, 'and nothing was saved');
  r = await parse(H, capStmt, '?duplicates=report');
  ok(r.status === 422 && r.json.code === 'MATCH_LIMIT_EXCEEDED', 'explicit report mode fails closed the same way');
  r = await confirm(H, { rows: [{ title: 'CAPROW', amount: -9.99, date: '2026-05-01', type: 'expense', category: 'General' }], policy: 'import_all', reviewDigest: 'a'.repeat(64) });
  ok(r.status === 422 && r.json.code === 'MATCH_LIMIT_EXCEEDED' && (await count(H)) === 5001, 'confirm fails closed too (an incomplete check never reaches the digest comparison or the insert)');
  r = await parse(H, lines('02/05/2026 OTHER ROW -1.00'));
  ok(r.status === 200 && r.json.count === 1, 'a statement that does not touch the over-bound date/amount is unaffected');
  ok((await parse(B, lines('01/05/2026 CAPROW -9.99'))).status === 200, 'another user is unaffected (matching is per user)');
  r = await parse(H, capStmt, '?duplicates=allow');
  ok(r.status === 200 && r.json.count === 2, 'explicit duplicates=allow is the deliberate way around it');
  await direct.query(`DELETE FROM transactions WHERE id IN (SELECT id FROM transactions WHERE user_id = $1 AND title = 'CAPROW' ORDER BY seq LIMIT 2)`, [hid]);
  ok(Number((await direct.query(`SELECT count(*) n FROM transactions WHERE user_id = $1 AND title = 'CAPROW'`, [hid])).rows[0].n) === 5000, 'bound setup: exactly 5,000 matching rows');
  r = await parse(H, lines('01/05/2026 CAPROW -9.99'));
  ok(r.status === 409 && r.json.code === 'DUPLICATES_FOUND' && r.json.summary.likely === 1, 'exactly at the bound the answer is complete and the duplicate is reported', `${r.status} ${r.text.slice(0, 160)}`);

  // ═══ atomic: a failure while saving rolls the WHOLE import back and releases the lock ═══════════════════════════
  await direct.query(`CREATE FUNCTION test_explode() RETURNS trigger AS $$ BEGIN IF NEW.title = 'EXPLODE' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await direct.query(`CREATE TRIGGER test_explode_trg BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION test_explode()`);
  const boom = lines('10/04/2026 KEEP ONE -1.00', '11/04/2026 EXPLODE -2.00', '12/04/2026 KEEP TWO -3.00');
  const cBefore = await count(C);
  r = await parse(C, boom);
  ok(r.status === 500 && r.json.error === 'Could not save transactions' && (await count(C)) === cBefore, 'a failure part-way through the insert saves NOTHING (all rows rolled back), with a generic error', `${r.status} ${r.text.slice(0, 120)}`);
  r = await parse(C, lines('13/04/2026 AFTER BOOM -4.00'));
  ok(r.status === 200 && r.json.count === 1, 'the per-user lock was released: the next import for the same user proceeds at once');
  await send(C.cookie, 'POST', '/transactions', { title: 'MATCHME', amount: 5, date: '2026-04-14', type: 'expense', category: 'General' });
  r = await parse(C, lines('14/04/2026 MATCHME -5.00', '15/04/2026 EXPLODE -2.00', '16/04/2026 FINE -3.00'));
  const boomPreview = r.json;
  ok(r.status === 409 && boomPreview.summary.likely === 1, 'confirm-path setup: a preview with one likely duplicate');
  const cBefore2 = await count(C);
  r = await confirm(C, { rows: rowsOf(boomPreview), policy: 'import_all', reviewDigest: boomPreview.reviewDigest });
  ok(r.status === 500 && (await count(C)) === cBefore2, 'the confirm path is atomic too: a failure leaves nothing saved');
  await direct.query('DROP TRIGGER test_explode_trg ON transactions');
  await direct.query('DROP FUNCTION test_explode()');
  r = await confirm(C, { rows: rowsOf(boomPreview), policy: 'import_all', reviewDigest: boomPreview.reviewDigest });
  ok(r.status === 200 && r.json.count === 3 && (await count(C)) === cBefore2 + 3, 'after the fault is gone the same reviewed digest still works: the failed attempt changed nothing', `${r.status} ${r.text.slice(0, 160)}`);

  // ═══ lock contention: a stuck import cannot hang another one, and fails without saving ════════════════════════════
  const did = (await direct.query('SELECT id FROM users WHERE email = $1', [D.email])).rows[0].id;
  const locker = new pg.Client({ connectionString: urlFor(DB) });
  await locker.connect();
  await locker.query('BEGIN');
  await locker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`finsphere:import:${did}`]);   // an import for D "in progress"
  const dBeforeLock = await count(D);
  const t0 = Date.now();
  r = await parse(D, lines('20/08/2026 LOCKED OUT -1.00'));
  const waited = Date.now() - t0;
  ok(r.status === 503 && r.json.code === 'IMPORT_BUSY' && /Nothing was imported/.test(r.json.error) && waited >= 9000 && waited < 19000, 'a held import lock makes the next import wait at most ~10 s, then answer 503 IMPORT_BUSY', `${r.status} after ${waited} ms ${r.text.slice(0, 120)}`);
  ok((await count(D)) === dBeforeLock, 'and nothing was saved');
  const t1 = Date.now();
  r = await parse(E, lines('20/08/2026 NOT BLOCKED -1.00'));
  ok(r.status === 200 && Date.now() - t1 < 4000, 'another user is not held up by that lock');
  await locker.query('COMMIT');
  await locker.end();
  r = await parse(D, lines('20/08/2026 LOCKED OUT -1.00'));
  ok(r.status === 200 && r.json.count === 1, 'once the lock is released the same import succeeds');

  // ═══ no model call on confirm, no schema change, rate limit ═════════════════════════════════════════════════════
  const hitsNow = stubHits;
  await confirm(B, validBase);
  await confirm(D, { rows: good, policy: 'import_all', reviewDigest: 'a'.repeat(64) });
  ok(stubHits === hitsNow, 'confirm never calls Groq (the stub saw no request)');
  const idx = (await direct.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'transactions' ORDER BY 1`)).rows.map((x) => x.indexname);
  ok(idx.join() === 'transactions_pkey,transactions_user_id_idx,transactions_user_seq_idx', 'the transactions table has no new index', idx.join());
  const uniq = (await direct.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'transactions'::regclass AND contype IN ('u')`)).rows;
  ok(uniq.length === 0, 'no unique constraint on transactions (identical rows stay legal)');
  const tables = (await direct.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0].n;
  ok(tables > 0, 'database reachable');
  let limited = 0;
  for (let i = 0; i < 24; i++) { const x = await confirm(G, []); if (x.status === 429) limited++; }
  ok(limited >= 1, 'confirm is rate limited per user (20 per minute)', String(limited));
  ok(exitCode === null && !/Error|Unhandled|ECONN/.test(serverOut.replace(/Groq API Error during parsing: status 500\r?\n/g, '')), 'server healthy, no errors logged', serverOut.slice(-300));
  ok(!/ZOMATO|SALARY ACME|AMAZON PAY|PARALLEL|COFFEE/.test(serverOut), 'statement text is not in the server log');
}

try {
  await run();
} finally {
  await stopServer();
  stub.close();
  await direct?.end().catch(() => {});
  await sleep(500);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await admin.end().catch(() => {});
}
console.log(`duplicate import (real server) tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
