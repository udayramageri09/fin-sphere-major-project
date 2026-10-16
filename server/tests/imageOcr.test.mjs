// Image OCR (Stage 1): unit and in-process HTTP tests. The engine is a mock except in the last test, so these run without
// PostgreSQL and without starting server.js. (End-to-end through the real server, auth, rate limit and database:
// imageOcrServer.test.mjs.)
//
//   npm --prefix server run test:image-ocr
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import { inspectImage, cleanOcrText, createOcrService, createTesseractEngine, createOcrStatementImageHandlers, OcrError, OCR_LIMITS } from '../imageOcr.js';
import { STATEMENT_PNG, STATEMENT_JPG, BLANK_PNG } from './ocrFixtures.mjs';

// ── image builders ───────────────────────────────────────────────────────────────────────────────────────────────
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length);
  return out;
}
// A structurally valid PNG of the claimed size (the pixel data is not a real image: only structure and size are inspected).
function fakePng(width, height) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])), chunk('IEND', Buffer.alloc(0))]);
}
// A structurally valid JPEG header + scan of the claimed size.
function fakeJpeg(width, height) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 63, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0]), sof, sos, Buffer.from([0x12, 0x34]), Buffer.from([0xff, 0xd9])]);
}
const rejects = (fn, code, status) => assert.throws(fn, (e) => e instanceof OcrError && e.code === code && (status === undefined || e.status === status), `expected ${code}`);

// ── inspectImage ─────────────────────────────────────────────────────────────────────────────────────────────────
test('accepts real PNG and JPEG files and reports the decoded dimensions', () => {
  assert.deepEqual(inspectImage(STATEMENT_PNG), { format: 'png', width: 900, height: 200 });
  assert.deepEqual(inspectImage(STATEMENT_JPG), { format: 'jpeg', width: 900, height: 200 });
  assert.deepEqual(inspectImage(fakePng(1200, 1600)), { format: 'png', width: 1200, height: 1600 });
  assert.deepEqual(inspectImage(fakeJpeg(1200, 1600)), { format: 'jpeg', width: 1200, height: 1600 });
});

test('the signature decides the type: spoofed and non-image files are refused', () => {
  for (const [name, buf] of [
    ['windows executable', Buffer.from('MZ\x90\x00\x03\x00\x00\x00'.padEnd(64, '\0'), 'latin1')],
    ['PDF', Buffer.from('%PDF-1.7\n1 0 obj\n')],
    ['GIF', Buffer.from('GIF89a' + '\0'.repeat(40), 'latin1')],
    ['plain text', Buffer.from('date,amount\n2026-03-05,120\n')],
    ['HTML', Buffer.from('<html><script>alert(1)</script></html>')],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"></svg>')],
    ['truncated PNG signature', STATEMENT_PNG.subarray(0, 7)],
    ['two-byte JPEG prefix', Buffer.from([0xff, 0xd8])]
  ]) rejects(() => inspectImage(buf), 'unsupported_type', 415);
  rejects(() => inspectImage(Buffer.alloc(0)), 'empty_file', 400);
});

test('malformed PNG files are rejected', () => {
  const png = Buffer.from(STATEMENT_PNG);
  rejects(() => inspectImage(png.subarray(0, png.length - 5)), 'malformed_image', 400);          // cut off
  rejects(() => inspectImage(png.subarray(0, 40)), 'malformed_image', 400);
  const badCrc = Buffer.from(png); badCrc[29] ^= 0xff; rejects(() => inspectImage(badCrc), 'malformed_image', 400);   // IHDR checksum
  rejects(() => inspectImage(Buffer.concat([png, Buffer.from('trailing data')])), 'malformed_image', 400);
  const header = Buffer.concat([png.subarray(0, 8), chunk('IEND', Buffer.alloc(0))]);                  // no IHDR
  rejects(() => inspectImage(header), 'malformed_image', 400);
  const noData = Buffer.concat([png.subarray(0, 8), chunk('IHDR', Buffer.from([0, 0, 1, 0, 0, 0, 1, 0, 8, 0, 0, 0, 0])), chunk('IEND', Buffer.alloc(0))]);
  rejects(() => inspectImage(noData), 'malformed_image', 400);                                            // no IDAT
  const badDepth = Buffer.from([0, 0, 1, 0, 0, 0, 1, 0, 7, 0, 0, 0, 0]);
  rejects(() => inspectImage(Buffer.concat([png.subarray(0, 8), chunk('IHDR', badDepth), chunk('IDAT', Buffer.from([1])), chunk('IEND', Buffer.alloc(0))])), 'malformed_image', 400);
  const lying = Buffer.from(png); lying.writeUInt32BE(0x7fffff00, 8); rejects(() => inspectImage(lying), 'malformed_image', 400);   // chunk length beyond the file
});

test('malformed JPEG files are rejected', () => {
  const jpg = STATEMENT_JPG;
  rejects(() => inspectImage(jpg.subarray(0, jpg.length - 2)), 'malformed_image', 400);                   // no end-of-image
  rejects(() => inspectImage(jpg.subarray(0, 200)), 'malformed_image', 400);
  rejects(() => inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), 'malformed_image', 400);             // no image data
  rejects(() => inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0, 0, 0, 0])), 'malformed_image', 400);   // segment longer than the file
  rejects(() => inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0, 0, 0xff, 0xd9])), 'malformed_image', 400);  // scan before any frame header
  const garbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('this is not a jpeg at all, just text')]);
  rejects(() => inspectImage(garbage), 'malformed_image', 400);
});

test('decoded dimensions are enforced (too small, too large, too many pixels)', () => {
  rejects(() => inspectImage(fakePng(50, 50)), 'image_too_small', 422);
  rejects(() => inspectImage(fakeJpeg(99, 400)), 'image_too_small', 422);
  rejects(() => inspectImage(fakePng(8001, 200)), 'image_too_large', 422);
  rejects(() => inspectImage(fakeJpeg(200, 9000)), 'image_too_large', 422);
  rejects(() => inspectImage(fakePng(5000, 5000)), 'image_too_large', 422);                                  // 25 MP
  rejects(() => inspectImage(fakePng(0, 500)), 'malformed_image', 400);
  const bomb = fakePng(0x7fffffff, 0x7fffffff);                                                              // decompression-bomb header
  rejects(() => inspectImage(bomb), 'image_too_large', 422);
  assert.equal(inspectImage(fakePng(4000, 5000)).width, 4000);                                               // exactly 20 MP is allowed
});

// ── text clean-up ────────────────────────────────────────────────────────────────────────────────────────────────
test('cleanOcrText normalises line endings, strips control characters, collapses blank runs and caps the length', () => {
  assert.equal(cleanOcrText('a  \r\nb\u0000\u0007\r\n\r\n\r\n\r\nc\t\n').text, 'a\nb\n\nc');
  const capped = cleanOcrText('x'.repeat(50), 10);
  assert.deepEqual(capped, { text: 'x'.repeat(10), truncated: true });
  assert.equal(cleanOcrText(undefined).text, '');
});

// ── service ──────────────────────────────────────────────────────────────────────────────────────────────────────
const fast = { ...OCR_LIMITS, timeoutMs: 200 };
const engineReturning = (result) => ({ calls: 0, async recognize() { this.calls++; return result; } });

test('returns cleaned text, confidence and format; warns on low confidence, no numbers, low resolution', async () => {
  const ok = createOcrService({ engine: engineReturning({ text: '05/03/2026 ZOMATO 120.50\r\n', confidence: 91.4 }) });
  const out = await ok.extractText(STATEMENT_PNG);
  assert.equal(out.text, '05/03/2026 ZOMATO 120.50');
  assert.equal(out.confidence, 91);
  assert.deepEqual(out.warnings, []);
  const weak = createOcrService({ engine: engineReturning({ text: 'hello world', confidence: 30 }) });
  const w = await weak.extractText(fakePng(500, 300));
  assert.equal(w.warnings.length, 3);
  assert.match(w.warnings.join('|'), /Low recognition confidence \(30%\)/);
  assert.match(w.warnings.join('|'), /No numbers were found/);
  assert.match(w.warnings.join('|'), /resolution is low/);
  const long = await createOcrService({ engine: engineReturning({ text: '1 '.repeat(15000) }), limits: OCR_LIMITS }).extractText(STATEMENT_PNG);
  assert.equal(long.text.length <= OCR_LIMITS.maxTextChars, true);
  assert.match(long.warnings.join('|'), /cut off/);
});

test('rejected images never reach the engine', async () => {
  const engine = engineReturning({ text: 'x1' });
  const svc = createOcrService({ engine });
  await assert.rejects(svc.extractText(Buffer.from('%PDF-1.4')), { code: 'unsupported_type' });
  await assert.rejects(svc.extractText(STATEMENT_PNG.subarray(0, 100)), { code: 'malformed_image' });
  await assert.rejects(svc.extractText(fakePng(9000, 9000)), { code: 'image_too_large' });
  await assert.rejects(svc.extractText(STATEMENT_PNG, { declaredFormat: 'jpeg' }), { code: 'type_mismatch', status: 415 });   // a .jpg that is a PNG
  await assert.rejects(svc.extractText(STATEMENT_JPG, { declaredFormat: 'png' }), { code: 'type_mismatch' });
  assert.equal(engine.calls, 0);
});

test('empty and unreadable results give clear errors; engine failures are generic and release the slot', async () => {
  await assert.rejects(createOcrService({ engine: engineReturning({ text: '   \n\u0000 ' }) }).extractText(BLANK_PNG), { code: 'no_text', status: 422 });
  await assert.rejects(createOcrService({ engine: engineReturning(undefined) }).extractText(BLANK_PNG), { code: 'no_text' });
  const failing = createOcrService({ engine: { async recognize() { throw new Error('SECRET internal detail 12345'); } } });
  await assert.rejects(failing.extractText(STATEMENT_PNG), (e) => e.code === 'ocr_failed' && e.status === 500 && !/SECRET|12345/.test(e.message));
  assert.deepEqual(failing.stats(), { running: 0, queued: 0 });
  const sync = createOcrService({ engine: { recognize() { throw new TypeError('sync failure'); } } });
  await assert.rejects(sync.extractText(STATEMENT_PNG), { code: 'ocr_failed' });
  assert.deepEqual(sync.stats(), { running: 0, queued: 0 });
});

test('a job that exceeds the timeout is aborted, reported as 504 and its slot is freed', async () => {
  let signal;
  const svc = createOcrService({ engine: { recognize(_b, opts) { signal = opts.signal; return new Promise(() => {}); } }, limits: fast });   // never settles
  await assert.rejects(svc.extractText(STATEMENT_PNG), { code: 'timeout', status: 504 });
  assert.equal(signal.aborted, true, 'the engine was told to stop (so it can terminate its worker)');
  assert.deepEqual(svc.stats(), { running: 0, queued: 0 });
});

test('the engine is always signalled when a job ends, so it can release resources', async () => {
  let signal;
  const svc = createOcrService({ engine: { async recognize(_b, opts) { signal = opts.signal; return { text: 'a1' }; } } });
  await svc.extractText(STATEMENT_PNG);
  assert.equal(signal.aborted, true);
});

test('concurrency is bounded, extra jobs queue, and a full queue answers 503', async () => {
  let active = 0, peak = 0;
  const gates = [];
  const engine = { async recognize() { active++; peak = Math.max(peak, active); await new Promise((r) => gates.push(r)); active--; return { text: 'ok 1' }; } };
  const limits = { ...OCR_LIMITS, maxConcurrent: 2, maxQueued: 2, timeoutMs: 5000 };
  const svc = createOcrService({ engine, limits });
  const jobs = Array.from({ length: 4 }, () => svc.extractText(STATEMENT_PNG));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(svc.stats(), { running: 2, queued: 2 });
  assert.equal(active, 2, 'only two run at once');
  await assert.rejects(svc.extractText(STATEMENT_PNG), { code: 'busy', status: 503 });          // queue is full
  while (jobs.length && (gates.length || svc.stats().running)) { gates.splice(0).forEach((g) => g()); await new Promise((r) => setTimeout(r, 20)); if (svc.stats().running === 0 && svc.stats().queued === 0) break; }
  const results = await Promise.all(jobs);
  assert.equal(results.length, 4);
  assert.equal(peak, 2, 'never more than two at once');
  assert.deepEqual(svc.stats(), { running: 0, queued: 0 });
});

test('a queued job that waits too long is refused rather than waiting forever', async () => {
  const svc = createOcrService({ engine: { recognize: () => new Promise(() => {}) }, limits: { ...fast, maxConcurrent: 1, maxQueued: 1, timeoutMs: 100 } });
  const first = svc.extractText(STATEMENT_PNG).catch((e) => e);
  const second = svc.extractText(STATEMENT_PNG).catch((e) => e);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.code, 'timeout');
  assert.ok(['busy', 'timeout'].includes(b.code));
  assert.deepEqual(svc.stats(), { running: 0, queued: 0 });
});

// ── HTTP, in process ─────────────────────────────────────────────────────────────────────────────────────────────
async function withApp(engine, fn, { limits } = {}) {
  const ocr = createOcrService({ engine, limits });
  const app = express();
  const authenticate = (req, res, next) => (req.headers.cookie === 'token=good' ? (req.user = { id: 1 }, next()) : res.status(401).json({ error: 'Unauthorized' }));
  app.post('/api/transactions/ocr-statement-image', authenticate, ...createOcrStatementImageHandlers({ ocr }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/transactions/ocr-statement-image`;
  try { return await fn(url, ocr); } finally { await new Promise((r) => server.close(r)); }
}
const send = (url, { name = 'a.png', buf = STATEMENT_PNG, field = 'statementImage', cookie = 'token=good', mime = 'image/png' } = {}) => {
  const fd = new FormData();
  if (buf) fd.append(field, new Blob([buf], { type: mime }), name);
  return fetch(url, { method: 'POST', headers: cookie ? { cookie } : {}, body: fd });
};

test('HTTP: requires authentication and never runs OCR for an unauthenticated request', async () => {
  const engine = engineReturning({ text: 'a1' });
  await withApp(engine, async (url) => {
    assert.equal((await send(url, { cookie: null })).status, 401);
    assert.equal((await send(url, { cookie: 'token=bad' })).status, 401);
    assert.equal(engine.calls, 0);
  });
});

test('HTTP: success returns text, confidence and warnings only, with no-store caching', async () => {
  const engine = engineReturning({ text: '05/03/2026 ZOMATO 120.50', confidence: 88 });
  await withApp(engine, async (url) => {
    for (const [name, buf, mime] of [['s.png', STATEMENT_PNG, 'image/png'], ['s.jpg', STATEMENT_JPG, 'image/jpeg'], ['S.JPEG', STATEMENT_JPG, 'image/jpeg']]) {
      const r = await send(url, { name, buf, mime });
      assert.equal(r.status, 200, name);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      const body = await r.json();
      assert.deepEqual(Object.keys(body).sort(), ['confidence', 'success', 'text', 'warnings']);
      assert.equal(body.text, '05/03/2026 ZOMATO 120.50');
      assert.equal(body.success, true);
    }
    assert.equal(engine.calls, 3);
  });
});

test('HTTP: spoofed, wrong-extension and malformed uploads are refused before OCR', async () => {
  const engine = engineReturning({ text: 'a1' });
  await withApp(engine, async (url) => {
    let r = await send(url, { name: 'evil.exe', buf: Buffer.from('MZ' + '\0'.repeat(100), 'latin1'), mime: 'application/octet-stream' });
    assert.equal(r.status, 415);
    r = await send(url, { name: 'statement.pdf', buf: Buffer.from('%PDF-1.4 ...'), mime: 'application/pdf' });
    assert.equal(r.status, 415, 'PDF is not accepted');
    r = await send(url, { name: 'photo.gif', buf: Buffer.from('GIF89a' + '\0'.repeat(50), 'latin1'), mime: 'image/gif' });
    assert.equal(r.status, 415);
    r = await send(url, { name: 'fake.png', buf: Buffer.from('MZ' + '\0'.repeat(100), 'latin1'), mime: 'image/png' });           // right name and MIME, wrong bytes
    assert.equal(r.status, 415);
    r = await send(url, { name: 'fake.jpg', buf: Buffer.from('<html>not an image</html>'), mime: 'image/jpeg' });
    assert.equal(r.status, 415);
    r = await send(url, { name: 'png-as.jpg', buf: STATEMENT_PNG, mime: 'image/jpeg' });                                       // real PNG named .jpg
    assert.equal(r.status, 415);
    assert.match((await r.json()).error, /does not match/);
    r = await send(url, { name: 'cut.png', buf: STATEMENT_PNG.subarray(0, 4000) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /damaged or incomplete/);
    r = await send(url, { name: 'big.png', buf: fakePng(9000, 9000) });
    assert.equal(r.status, 422);
    r = await send(url, { name: 'tiny.png', buf: fakePng(20, 20) });
    assert.equal(r.status, 422);
    r = await send(url, { name: 'empty.png', buf: Buffer.alloc(0) });
    assert.equal(r.status, 400);
    assert.equal(engine.calls, 0, 'OCR never ran for any of them');
  });
});

test('HTTP: size limit (5 MB) and bad request shapes', async () => {
  const engine = engineReturning({ text: 'a1' });
  await withApp(engine, async (url) => {
    const big = Buffer.concat([STATEMENT_PNG, Buffer.alloc(5 * 1024 * 1024)]);
    assert.equal((await send(url, { name: 'big.png', buf: big })).status, 413);
    const justUnder = Buffer.alloc(5 * 1024 * 1024 - 10, 1);      // within the limit, but not an image
    assert.equal((await send(url, { name: 'x.png', buf: justUnder })).status, 415);
    assert.equal((await send(url, { buf: null })).status, 400, 'no file');
    assert.equal((await send(url, { field: 'statementFile' })).status, 400, 'the statement-import field name is not accepted here');
    const two = new FormData(); two.append('statementImage', new Blob([STATEMENT_PNG]), 'a.png'); two.append('statementImage', new Blob([STATEMENT_PNG]), 'b.png');
    assert.equal((await fetch(url, { method: 'POST', headers: { cookie: 'token=good' }, body: two })).status, 400, 'one file only');
    const json = await fetch(url, { method: 'POST', headers: { cookie: 'token=good', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(json.status, 400);
    assert.equal(engine.calls, 0);
  });
});

test('HTTP: OCR failure, no text, timeout and busy have clear, safe errors', async () => {
  const cases = [
    [{ async recognize() { throw new Error('secret engine detail'); } }, 500, /Could not read text/],
    [engineReturning({ text: '  ' }), 422, /No readable text/],
    [{ recognize: () => new Promise(() => {}) }, 504, /took too long/]
  ];
  for (const [engine, status, pattern] of cases) {
    await withApp(engine, async (url) => {
      const r = await send(url);
      const body = await r.json();
      assert.equal(r.status, status);
      assert.match(body.error, pattern);
      assert.equal(JSON.stringify(body).includes('secret'), false);
      assert.equal('text' in body, false);
    }, { limits: { ...OCR_LIMITS, timeoutMs: 150 } });
  }
  await withApp({ recognize: () => new Promise(() => {}) }, async (url) => {
    const pending = [send(url), send(url), send(url)];
    await new Promise((r) => setTimeout(r, 50));
    const r = await send(url);
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('retry-after'), '10');
    await Promise.all(pending);
  }, { limits: { ...OCR_LIMITS, timeoutMs: 400, maxConcurrent: 1, maxQueued: 2 } });
});

test('the OCR path makes no external call, writes no log output and does not persist the image or text', async () => {
  const realFetch = globalThis.fetch;
  const logged = [];
  const originals = {};
  const external = [];
  const TEXT = 'ACME SALARY 98765.43 CONFIDENTIAL-MARKER';
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) { originals[level] = console[level]; console[level] = (...a) => logged.push(a.join(' ')); }
  try {
    await withApp(engineReturning({ text: TEXT, confidence: 90 }), async (url) => {
      // Only requests to the test server itself are allowed; anything else (Groq, any API) is recorded and fails.
      globalThis.fetch = async (input, init) => {
        if (String(input).startsWith('http://127.0.0.1')) return realFetch(input, init);
        external.push(String(input)); throw new Error('external call');
      };
      assert.equal((await send(url)).status, 200);
      assert.equal((await send(url, { buf: Buffer.from('MZ'), name: 'x.png' })).status, 415);
    });
  } finally { globalThis.fetch = realFetch; Object.assign(console, originals); }
  assert.deepEqual(external, []);
  assert.equal(logged.join('\n').includes('CONFIDENTIAL-MARKER'), false);
  assert.deepEqual(logged, [], 'nothing is logged on success or on a refused upload');
  const source = readFileSync(fileURLToPath(new URL('../imageOcr.js', import.meta.url)), 'utf8');
  assert.equal(/from ['"]\.\/db|from ['"]pg['"]|node:fs|groq|api\.groq|fetch\(/i.test(source), false, 'the module imports no database, filesystem or network client');
  assert.equal(/createTransaction/.test(source), false);
});

test('an unexpected handler failure answers 500 with a fixed message and logs no detail', async () => {
  const lines = [];
  const orig = console.error; console.error = (...a) => lines.push(a.join(' '));
  try {
    const ocr = { async extractText() { throw new Error('boom SENSITIVE-TEXT'); } };
    const app = express();
    app.post('/x', (req, res, next) => { req.user = { id: 1 }; next(); }, ...createOcrStatementImageHandlers({ ocr }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const r = await send(`http://127.0.0.1:${server.address().port}/x`);
      assert.equal(r.status, 500);
      assert.equal(JSON.stringify(await r.json()).includes('SENSITIVE'), false);
    } finally { await new Promise((r) => server.close(r)); }
  } finally { console.error = orig; }
  assert.equal(lines.some((l) => l.includes('SENSITIVE')), false);
});

// ── the real engine (Tesseract.js, local) ────────────────────────────────────────────────────────────────────────
test('the real Tesseract engine reads a statement image offline, and terminates its worker', async () => {
  let created = 0, terminated = 0, networkCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { networkCalls++; return realFetch(...a); };
  try {
    const engine = createTesseractEngine({
      loadTesseract: async () => {
        const mod = await import('tesseract.js');
        const createWorker = mod.createWorker ?? mod.default.createWorker;
        return { createWorker: async (...args) => { created++; const w = await createWorker(...args); const t = w.terminate.bind(w); w.terminate = async () => { terminated++; return t(); }; return w; } };
      }
    });
    const svc = createOcrService({ engine, limits: { ...OCR_LIMITS, timeoutMs: 60_000 } });
    for (const buf of [STATEMENT_PNG, STATEMENT_JPG]) {
      const out = await svc.extractText(buf);
      assert.match(out.text, /ZOMATO/);
      assert.match(out.text, /50000\.00/);
      assert.match(out.text, /05\/03\/2026/);
      assert.ok(out.confidence > 70, `confidence ${out.confidence}`);
    }
    await assert.rejects(svc.extractText(BLANK_PNG), { code: 'no_text' });
    assert.equal(created, 3);
    assert.equal(terminated, 3, 'every worker was terminated, including for the blank page');
    assert.equal(networkCalls, 0, 'language data comes from disk: no download');
  } finally { globalThis.fetch = realFetch; }
});

test('a real engine job that times out terminates its worker', async () => {
  let terminated = 0;
  const engine = createTesseractEngine({
    loadTesseract: async () => {
      const mod = await import('tesseract.js');
      const createWorker = mod.createWorker ?? mod.default.createWorker;
      return { createWorker: async (...args) => { const w = await createWorker(...args); const t = w.terminate.bind(w); w.terminate = async () => { terminated++; return t(); }; return w; } };
    }
  });
  const svc = createOcrService({ engine, limits: { ...OCR_LIMITS, timeoutMs: 1 } });   // 1 ms: certain to expire
  await assert.rejects(svc.extractText(STATEMENT_PNG), { code: 'timeout' });
  for (let i = 0; i < 100 && terminated === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(terminated, 1, 'the worker was terminated after the timeout');
});

// keep the http import used for the raw-socket sanity check below
test('the route only accepts POST', async () => {
  await withApp(engineReturning({ text: 'a1' }), async (url) => {
    const status = await new Promise((resolve) => http.get(url, (res) => { res.resume(); resolve(res.statusCode); }));
    assert.equal(status, 404);
  });
});
