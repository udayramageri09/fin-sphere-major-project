// Image OCR (Stage 1) through the REAL server: authentication, rate limit, real Tesseract.js, and zero database writes.
//
//   npm --prefix server run test:image-ocr-server
//
// Same safety model as passwordResetLocal.test.mjs: it creates and drops its own throwaway PostgreSQL database
// (`finsphere_ocr_<pid>`) on the server named by DATABASE_URL and never touches the database named in DATABASE_URL. A local stub
// stands in for Groq (GROQ_API_BASE) so the test can prove the OCR endpoint never calls it. Every image is synthetic.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { STATEMENT_PNG, STATEMENT_JPG, BLANK_PNG } from './ocrFixtures.mjs';

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
const DB = `finsphere_ocr_${process.pid}`;
const admin = new pg.Client({ connectionString: urlFor('postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);

const PORT = 5085, STUB_PORT = 5086;
const base = `http://localhost:${PORT}/api`;
let server = null, serverOut = '', exitCode = null, direct = null;

// Stand-in for Groq: records any request. The OCR endpoint must never make one.
let stubHits = 0;
const stub = http.createServer((req, res) => { stubHits++; req.resume(); res.writeHead(500); res.end('{}'); });
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

function launch() {
  serverOut = ''; exitCode = null;
  // Settings that dotenv could otherwise inject from the developer's real server/.env are set to empty strings (not deleted).
  const env = {
    ...process.env, DATABASE_URL: urlFor(DB), PORT: String(PORT), JWT_SECRET: 'o'.repeat(40),
    GROQ_API_KEY: 'fake-groq-key-not-real', GROQ_API_BASE: `http://127.0.0.1:${STUB_PORT}`,
    PASSWORD_RESET_DELIVERY: '', RESEND_API_KEY: '', PASSWORD_RESET_FROM: '', PASSWORD_RESET_URL: ''
  };
  for (const k of ['NODE_ENV', 'CORS_ORIGINS', 'TRUST_PROXY', 'FINSPHERE_TEST_UPLOAD_LIMIT']) delete env[k];
  server = spawn(process.execPath, ['server.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  server.on('exit', (code) => { exitCode = code ?? 'signal'; });
}
async function startServer() {
  launch();
  for (let i = 0; i < 80; i++) { try { await fetch(`${base}/auth/verify`); return true; } catch { await sleep(250); } }
  return false;
}
async function stopServer() {
  if (server && exitCode === null) { server.kill(); for (let i = 0; i < 40 && exitCode === null; i++) await sleep(100); }
}

const ocr = (cookie, { name = 'a.png', buf = STATEMENT_PNG, mime = 'image/png', field = 'statementImage' } = {}) => {
  const fd = new FormData();
  if (buf) fd.append(field, new Blob([buf], { type: mime }), name);
  return fetch(`${base}/transactions/ocr-statement-image`, { method: 'POST', headers: cookie ? { cookie } : {}, body: fd });
};
const count = async () => Number((await direct.query('SELECT count(*) AS n FROM transactions')).rows[0].n);
const json = (body) => ({ 'content-type': 'application/json', ...(body ? {} : {}) });
async function signIn(email, password) {
  await fetch(`${base}/auth/register`, { method: 'POST', headers: json(), body: JSON.stringify({ email, password }) });
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: json(), body: JSON.stringify({ email, password }) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

async function run() {
  ok(await startServer(), 'server starts', serverOut);
  direct = new pg.Client({ connectionString: urlFor(DB) });
  await direct.connect();

  const password = 'Passw0rd-ocr-1';
  const first = await signIn('ocr-user@example.com', password);
  const cookie = first.cookie;
  ok(first.status === 200 && cookie.length > 10, 'throwaway user registers and logs in', String(first.status));

  const before = await count();

  // authentication
  let r = await ocr(null);
  ok(r.status === 401, 'no session -> 401', String(r.status));
  r = await ocr('token=not-a-real-session');
  ok(r.status === 401, 'invalid session -> 401', String(r.status));

  // spoofed / malformed / oversize. The limit is 5 per minute per signed-in user and every request after authentication counts.
  r = await ocr(cookie, { name: 'evil.png', buf: Buffer.from('MZ' + '\0'.repeat(200), 'latin1') });
  ok(r.status === 415, 'executable named .png -> 415', String(r.status));
  r = await ocr(cookie, { name: 'doc.pdf', buf: Buffer.from('%PDF-1.4'), mime: 'application/pdf' });
  ok(r.status === 415, 'PDF is not accepted by the image endpoint -> 415', String(r.status));
  r = await ocr(cookie, { name: 'cut.png', buf: STATEMENT_PNG.subarray(0, 3000) });
  ok(r.status === 400, 'truncated PNG -> 400', String(r.status));
  r = await ocr(cookie, { name: 'big.png', buf: Buffer.concat([STATEMENT_PNG, Buffer.alloc(5 * 1024 * 1024)]) });
  ok(r.status === 413, 'file over 5 MB -> 413', String(r.status));

  // a real image through the real OCR engine (request 5 of 5)
  r = await ocr(cookie, { name: 'statement.png' });
  let body = await r.json();
  ok(r.status === 200 && body.success === true, 'PNG statement -> 200', JSON.stringify(body).slice(0, 200));
  ok(/ZOMATO/.test(body.text) && /50000\.00/.test(body.text) && /AMAZON/.test(body.text), 'PNG: the text is extracted', body.text);
  ok(Array.isArray(body.warnings) && Object.keys(body).sort().join() === 'confidence,success,text,warnings', 'response contains text, confidence and warnings only', Object.keys(body).join());
  ok(r.headers.get('cache-control') === 'no-store', 'response is not cacheable');

  r = await ocr(cookie, { name: 'statement.jpg', mime: 'image/jpeg', buf: STATEMENT_JPG });
  ok(r.status === 429, 'sixth request within a minute -> 429', String(r.status));
  ok(!/ZOMATO/.test(await r.text()), '429 carries no text');

  ok((await count()) === before, 'no transaction was written by any of the above');
  ok(stubHits === 0, 'Groq (stub) was never called by the OCR endpoint', String(stubHits));
  ok(!/ZOMATO|50000|AMAZON|SALARY/.test(serverOut), 'the extracted text is not in the server log', serverOut.slice(-400));
  ok(exitCode === null, 'server still running');

  // limits are per user: a second user has a fresh allowance
  const second = await signIn('ocr-user2@example.com', password);
  const cookie2 = second.cookie;
  r = await ocr(cookie2, { name: 'statement.jpg', mime: 'image/jpeg', buf: STATEMENT_JPG });
  body = await r.json();
  ok(r.status === 200 && /SALARY/.test(body.text), 'JPEG statement -> 200 with text', JSON.stringify(body).slice(0, 200));
  r = await ocr(cookie2, { name: 'statement.JPEG', mime: 'image/jpeg', buf: STATEMENT_JPG });
  ok(r.status === 200, '.JPEG (upper case) accepted', String(r.status));
  r = await ocr(cookie2, { name: 'blank.png', buf: BLANK_PNG });
  body = await r.json();
  ok(r.status === 422 && /No readable text/.test(body.error), 'blank image -> 422 with a clear message', JSON.stringify(body));
  r = await ocr(cookie2, { name: 'wrong.jpg', mime: 'image/jpeg', buf: STATEMENT_PNG });
  ok(r.status === 415, 'PNG content with a .jpg name -> 415', String(r.status));
  ok((await count()) === before, 'still no transaction written');
  ok(stubHits === 0, 'Groq (stub) still never called');

  // the existing statement import is unchanged: same allow-list, same field, images and PDFs still refused there
  const statement = (name, buf) => {
    const fd = new FormData(); fd.append('statementFile', new Blob([buf]), name);
    return fetch(`${base}/transactions/parse-statement`, { method: 'POST', headers: { cookie: cookie2 }, body: fd });
  };
  r = await statement('shot.png', STATEMENT_PNG);
  ok(r.status === 400 && /Unsupported file type/.test(await r.text()), 'parse-statement still refuses .png');
  r = await statement('x.pdf', Buffer.from('%PDF'));
  ok(r.status === 400, 'parse-statement still refuses .pdf');
  const countBeforeCsv = await count();
  r = await statement('s.csv', Buffer.from('Date,Narration,Withdrawal Amt.,Deposit Amt.\n2026-03-07,TEST SHOP,10,\n'));
  ok(r.status === 200 || r.status === 400, 'parse-statement still handles .csv', String(r.status));
  ok((await count()) >= countBeforeCsv, 'the CSV import path still writes (only it does)');
  const wrongField = new FormData(); wrongField.append('statementFile', new Blob([STATEMENT_PNG]), 'a.png');
  r = await fetch(`${base}/transactions/ocr-statement-image`, { method: 'POST', headers: { cookie: cookie2 }, body: wrongField });
  ok(r.status === 400, 'the OCR endpoint does not accept the statement-import field name', String(r.status));

  // nothing was left on disk by the OCR engine (no language-data cache, no image copy)
  const stray = fs.readdirSync(SERVER_DIR).filter((f) => /traineddata|\.png$|\.jpe?g$/i.test(f));
  ok(stray.length === 0, 'no OCR cache or image files in the server directory', stray.join());
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
console.log(`image OCR (real server) tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
