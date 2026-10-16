// Profile, preferences and profile photo through the REAL server: authentication, validation, persistence, user isolation, content
// sniffing, metadata stripping, limits and the idempotent schema.
//
//   npm --prefix server run test:profile
//
// Same safety model as the other server suites: it creates and drops its own throwaway PostgreSQL database
// (`finsphere_profile_<pid>`) on the server named by DATABASE_URL and never touches the database named in DATABASE_URL. Mail delivery
// settings are blanked so no email can be sent. Every name and image is synthetic.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { sanitizeProfileImage } from '../profileImage.js';
import * as F from './avatarFixtures.mjs';

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
const DB = `finsphere_profile_${process.pid}`;
const admin = new pg.Client({ connectionString: urlFor('postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);

const PORT = 5089;
const base = `http://localhost:${PORT}/api`;
let server = null, serverOut = '', exitCode = null, direct = null;

async function startServer() {
  serverOut = ''; exitCode = null;
  const env = {
    ...process.env, DATABASE_URL: urlFor(DB), PORT: String(PORT), JWT_SECRET: 'p'.repeat(40), GROQ_API_KEY: '',
    PASSWORD_RESET_DELIVERY: '', RESEND_API_KEY: '', PASSWORD_RESET_FROM: '', PASSWORD_RESET_URL: ''   // no email can be sent from this process
  };
  for (const k of ['NODE_ENV', 'CORS_ORIGINS', 'TRUST_PROXY', 'FINSPHERE_TEST_UPLOAD_LIMIT']) delete env[k];
  server = spawn(process.execPath, ['server.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  server.on('exit', (code) => { exitCode = code ?? 'signal'; });
  for (let i = 0; i < 80; i++) { try { await fetch(`${base}/auth/verify`); return true; } catch { await sleep(250); } }
  return false;
}
async function stopServer() { if (server && exitCode === null) { server.kill(); for (let i = 0; i < 40 && exitCode === null; i++) await sleep(100); } }

const J = { 'content-type': 'application/json' };
const PASSWORD = 'Passw0rd-profile-1';
async function makeUser(tag) {
  const email = `profile-${tag}@example.com`;
  await fetch(`${base}/auth/register`, { method: 'POST', headers: J, body: JSON.stringify({ email, password: PASSWORD }) });
  return { email, cookie: await login(email) };
}
async function login(email) {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ email, password: PASSWORD }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const call = async (cookie, method, p, body) => {
  const r = await fetch(base + p, { method, headers: { ...J, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, headers: r.headers };
};
const verify = async (cookie) => (await call(cookie, 'GET', '/auth/verify')).json?.user;
const putAvatar = async (cookie, buf, { name = 'photo.png', type = 'image/png', field = 'avatar', extra = {}, files = 1 } = {}) => {
  const fd = new FormData();
  for (let i = 0; i < files; i++) fd.append(field, new Blob([buf], { type }), name);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const r = await fetch(`${base}/auth/avatar`, { method: 'PUT', headers: cookie ? { cookie } : {}, body: fd });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
};
const getAvatar = async (cookie) => {
  const r = await fetch(`${base}/auth/avatar`, { headers: cookie ? { cookie } : {} });
  return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), nosniff: r.headers.get('x-content-type-options'), body: Buffer.from(await r.arrayBuffer()) };
};
const dbAvatar = async (email) => (await direct.query('SELECT a.* FROM user_avatars a JOIN users u ON u.id = a.user_id WHERE u.email = $1', [email])).rows[0];

async function run() {
  ok(await startServer(), 'server starts', serverOut);
  direct = new pg.Client({ connectionString: urlFor(DB) });
  await direct.connect();
  const A = await makeUser('a'), B = await makeUser('b');
  ok(A.cookie.length > 10 && B.cookie.length > 10, 'two synthetic users sign in');

  // ═══ legacy accounts: safe defaults ═══════════════════════════════════════════════════════════════════════════
  let u = await verify(A.cookie);
  ok(u.displayName === '' && u.reduceMotion === false && u.avatarVersion === null && u.email === A.email, 'a new/legacy account has an empty name, no photo and the default preference', JSON.stringify(u));
  ok(!JSON.stringify(u).match(/password|hash|token|secret/i), 'the profile carries no credential fields');
  ok((await getAvatar(A.cookie)).status === 404, 'no photo yet: 404');

  // ═══ authentication on every endpoint ═══════════════════════════════════════════════════════════════════════
  ok((await call(null, 'PATCH', '/auth/profile', { displayName: 'x' })).status === 401, 'PATCH profile requires a session');
  ok((await call('token=forged', 'PATCH', '/auth/profile', { displayName: 'x' })).status === 401, 'PATCH profile rejects a forged session');
  ok((await getAvatar(null)).status === 401 && (await getAvatar('token=forged')).status === 401, 'GET avatar requires a session');
  ok((await putAvatar(null, F.PNG_ALPHA)).status === 401 && (await putAvatar('token=forged', F.PNG_ALPHA)).status === 401, 'PUT avatar requires a session');
  ok((await call(null, 'DELETE', '/auth/avatar')).status === 401, 'DELETE avatar requires a session');

  // ═══ display name and preference: edit, persistence, clearing, partial updates, validation ═════════════════════
  let r = await call(A.cookie, 'PATCH', '/auth/profile', { displayName: '  Nick 🌿  ' });
  ok(r.status === 200 && r.json.user.displayName === 'Nick 🌿', 'a nickname is trimmed and saved', r.text);
  ok((await verify(A.cookie)).displayName === 'Nick 🌿', 'it survives session verification (reload)');
  r = await call(A.cookie, 'PATCH', '/auth/profile', { reduceMotion: true });
  ok(r.status === 200 && r.json.user.reduceMotion === true && r.json.user.displayName === 'Nick 🌿', 'the preference changes without touching the name');
  r = await call(A.cookie, 'PATCH', '/auth/profile', { displayName: 'Nick 2' });
  ok(r.json.user.displayName === 'Nick 2' && r.json.user.reduceMotion === true, 'the name changes without touching the preference');
  const relog = await login(A.email);
  ok((await verify(relog)).displayName === 'Nick 2' && (await verify(relog)).reduceMotion === true, 'name and preference are there after a fresh sign-in');
  const loginBody = (await call(null, 'POST', '/auth/login', { email: A.email, password: PASSWORD })).json;
  ok(loginBody.user.displayName === 'Nick 2' && loginBody.user.reduceMotion === true && loginBody.user.avatarVersion === null && !('passwordHash' in loginBody.user), 'login returns the same public profile, without credentials', JSON.stringify(loginBody));
  r = await call(A.cookie, 'PATCH', '/auth/profile', { displayName: '' });
  ok(r.json.user.displayName === '', 'the name can be cleared');
  r = await call(A.cookie, 'PATCH', '/auth/profile', { reduceMotion: false });
  ok(r.json.user.reduceMotion === false, 'the preference can be switched off');
  for (const body of [null, [], {}, 'x', { displayName: 1 }, { displayName: 'x'.repeat(81) }, { displayName: 'a\nb' }, { displayName: 'a‮b' }, { reduceMotion: 'yes' }, { reduceMotion: 1 },
    { displayName: 'x', userId: 2 }, { displayName: 'x', email: 'other@example.com' }, { displayName: 'x', avatarVersion: 5 }, { password: 'abc' }, { id: 2 }]) {
    ok((await call(A.cookie, 'PATCH', '/auth/profile', body)).status === 400, `invalid or extra profile fields are rejected: ${JSON.stringify(body)?.slice(0, 50)}`);
  }
  ok((await verify(A.cookie)).email === A.email && (await verify(A.cookie)).displayName === '', 'rejected requests changed nothing, and the email stays as it was');
  r = await call(A.cookie, 'PATCH', '/auth/profile', { displayName: '<b>x</b> & "y"' });
  ok(r.json.user.displayName === '<b>x</b> & "y"', 'markup in a name is stored as plain text (the UI escapes it)');
  await call(A.cookie, 'PATCH', '/auth/profile', { displayName: 'Alex' });

  // ═══ photo: accepted formats, served back sanitised, owner only ═══════════════════════════════════════════════
  for (const [label, buf, type, expectType] of [['JPEG with EXIF/GPS', F.JPEG_WITH_EXIF, 'image/jpeg', 'image/jpeg'], ['PNG with text chunks', F.PNG_WITH_TEXT, 'image/png', 'image/png'],
    ['WebP with EXIF', F.WEBP_LOSSY_EXIF, 'image/webp', 'image/webp'], ['PNG with alpha', F.PNG_ALPHA, 'image/png', 'image/png'], ['lossless WebP', F.WEBP_LOSSLESS, 'image/webp', 'image/webp']]) {
    r = await putAvatar(A.cookie, buf, { name: `x.${expectType.split('/')[1]}`, type });
    ok(r.status === 200 && typeof r.json.user.avatarVersion === 'number', `upload accepted: ${label}`, r.text.slice(0, 150));
    const got = await getAvatar(A.cookie);
    const expected = sanitizeProfileImage(buf).data;
    ok(got.status === 200 && got.type === expectType && got.body.equals(expected), `served bytes are the sanitised image: ${label}`);
    ok(!F.MARKERS.some((m) => got.body.includes(Buffer.from(m))), `no metadata marker is served back: ${label}`);
    const row = await dbAvatar(A.email);
    ok(row && row.data.equals(expected) && !F.MARKERS.some((m) => row.data.includes(Buffer.from(m))) && row.width === 200 && row.content_type === expectType, `what is stored is the sanitised image: ${label}`);
  }
  const last = await getAvatar(A.cookie);
  ok(last.cache === 'private, no-store' && last.nosniff === 'nosniff', 'the photo response is not cacheable and not sniffable', `${last.cache} ${last.nosniff}`);
  const vBefore = (await verify(A.cookie)).avatarVersion;
  await sleep(15);
  r = await putAvatar(A.cookie, F.JPEG_PLAIN, { name: 'new.jpg', type: 'image/jpeg' });
  ok(r.json.user.avatarVersion > vBefore, 'replacing the photo changes avatarVersion (so clients refetch)');
  ok((await getAvatar(A.cookie)).type === 'image/jpeg' && (await direct.query(`SELECT count(*)::int n FROM user_avatars WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [A.email])).rows[0].n === 1, 'replacement keeps exactly one stored photo per user');
  ok((await verify(relog)).avatarVersion === r.json.user.avatarVersion, 'another session of the same user sees the photo version');

  // ═══ refused uploads leave the existing photo untouched (spread over two users: 10 uploads per minute per user) ═════
  const D = await makeUser('d'), E = await makeUser('e');
  await putAvatar(D.cookie, F.JPEG_PLAIN, { type: 'image/jpeg' }); await putAvatar(E.cookie, F.JPEG_PLAIN, { type: 'image/jpeg' });
  const keepD = (await getAvatar(D.cookie)).body, keepE = (await getAvatar(E.cookie)).body;
  ok(keepD.length > 0 && keepE.length > 0, 'two more users have a photo to protect');
  const refusals = [
    ['GIF', F.GIF, 'image/gif', 415], ['SVG named .png with an image/png type', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/png', 415],
    ['HTML', Buffer.from('<html><script>x()</script></html>'), 'image/jpeg', 415], ['executable', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300)]), 'image/png', 415],
    ['plain text', Buffer.from('not an image'), 'image/png', 415], ['PDF', Buffer.from('%PDF-1.7'), 'application/pdf', 415], ['animated WebP', F.WEBP_ANIMATED, 'image/webp', 400],
    ['truncated PNG', F.PNG_WITH_TEXT.subarray(0, 300), 'image/png', 400], ['truncated JPEG', F.JPEG_PLAIN.subarray(0, 500), 'image/jpeg', 400],
    ['too small (20x20)', F.SMALL_PNG, 'image/png', 422], ['empty file', Buffer.alloc(0), 'image/png', 400]
  ];
  for (const [i, [label, buf, type, status]] of refusals.entries()) {
    r = await putAvatar(i < 8 ? D.cookie : E.cookie, buf, { type });
    ok(r.status === status && typeof r.json?.error === 'string' && r.json.error.length > 0, `refused: ${label} -> ${status}`, `${r.status} ${r.text.slice(0, 120)}`);
  }
  r = await putAvatar(E.cookie, Buffer.concat([F.PNG_ALPHA, Buffer.alloc(600 * 1024)]));
  ok(r.status === 413, 'refused: over 512 KB -> 413', String(r.status));
  r = await putAvatar(E.cookie, F.PNG_ALPHA, { field: 'statementFile' });
  ok(r.status === 400, 'refused: wrong form field name');
  r = await putAvatar(E.cookie, F.PNG_ALPHA, { files: 2 });
  ok(r.status === 400, 'refused: more than one file');
  r = await putAvatar(E.cookie, F.PNG_ALPHA, { extra: { userId: '2' } });
  ok(r.status === 400, 'refused: an extra form field (such as a user id)');
  ok((await getAvatar(D.cookie)).body.equals(keepD) && (await getAvatar(E.cookie)).body.equals(keepE), 'none of the refused uploads changed a stored photo');
  r = await fetch(`${base}/auth/avatar`, { method: 'PUT', headers: { cookie: A.cookie, ...J }, body: '{}' });
  ok(r.status === 400, 'refused: a JSON body instead of a file');
  const keep = (await getAvatar(A.cookie)).body;

  // ═══ user isolation ═════════════════════════════════════════════════════════════════════════════════════════
  ok((await getAvatar(B.cookie)).status === 404 && (await verify(B.cookie)).avatarVersion === null && (await verify(B.cookie)).displayName === '', 'user B has no photo and no name: A\'s data is not visible to B');
  r = await putAvatar(B.cookie, F.PNG_ALPHA, { type: 'image/png' });
  const bPhoto = await getAvatar(B.cookie);
  ok(r.status === 200 && bPhoto.type === 'image/png' && !bPhoto.body.equals(keep), 'B uploads a different photo');
  ok((await getAvatar(A.cookie)).body.equals(keep), 'B\'s upload did not change A\'s photo');
  await call(B.cookie, 'PATCH', '/auth/profile', { displayName: 'Blake', reduceMotion: true });
  ok((await verify(A.cookie)).displayName === 'Alex' && (await verify(A.cookie)).reduceMotion === false, 'B\'s name and preference did not change A\'s');
  r = await call(B.cookie, 'DELETE', '/auth/avatar');
  ok(r.status === 200 && r.json.user.avatarVersion === null && (await getAvatar(B.cookie)).status === 404 && (await getAvatar(A.cookie)).status === 200, 'B removing its photo does not remove A\'s');
  ok((await call(B.cookie, 'DELETE', '/auth/avatar')).status === 200, 'removing a photo that is not there is harmless (idempotent)');
  ok(Number((await direct.query('SELECT count(*) n FROM user_avatars')).rows[0].n) === 3, 'the database holds exactly one photo each for A, D and E');
  r = await call(A.cookie, 'GET', '/auth/avatar?userId=2');
  ok(r.status === 200 || r.status === 404, 'a user-id query parameter is ignored: the route has no way to name another user');
  const asB = await getAvatar(B.cookie);
  ok(asB.status === 404, 'and B still cannot get A\'s photo that way');

  // ═══ persistence across restarts (and the schema is idempotent) ════════════════════════════════════════════════
  const before = await verify(A.cookie);
  await stopServer();
  ok(await startServer(), 'the server restarts on the same database (schema applied again)', serverOut.slice(-300));
  const A2 = await login(A.email);
  const after = await verify(A2);
  ok(after.displayName === 'Alex' && after.avatarVersion === before.avatarVersion && after.reduceMotion === before.reduceMotion, 'name, photo version and preference survive a restart and a new sign-in', JSON.stringify(after));
  ok((await getAvatar(A2)).body.equals(keep), 'the photo itself survived');

  // ═══ rate limit and logs ════════════════════════════════════════════════════════════════════════════════════
  const C = await makeUser('c');
  let limited = 0;
  for (let i = 0; i < 12; i++) { const x = await putAvatar(C.cookie, Buffer.from('nope'), { type: 'image/png' }); if (x.status === 429) limited++; }
  ok(limited >= 1, 'photo uploads are rate limited per user', String(limited));
  ok(exitCode === null, 'server still running');
  ok(!/Alex|Blake|Nick|PRIVATE-|profile-a@|profile-b@/.test(serverOut), 'the server log contains no names, emails or image content', serverOut.slice(-300));
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
console.log(`profile and photo (real server) tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
