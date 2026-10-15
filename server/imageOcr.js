// imageOcr.js - Stage 1 of image statement upload: turn a JPG/JPEG/PNG into TEXT. Nothing else.
//
// This module never touches the database, never calls an AI service and never writes a file. It returns extracted text and
// warnings; saving transactions is a separate, later step that reuses the existing text pipeline after the user has
// reviewed the text. The uploaded bytes and the extracted text are never logged.
//
// Layers (each testable on its own):
//   inspectImage(buffer)           pure: real signature + structure + decoded dimensions, rejects malformed files
//   createOcrService({engine,...}) bounded concurrency + queue + per-job timeout + text clean-up/warnings; the engine is injected
//   createTesseractEngine(...)     the real engine: one short-lived Tesseract.js worker per job, language data read from disk
//   createOcrStatementImageHandlers({ocr})  the multer upload middleware and the route handler (mounted by server.js)
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { createRequire } from 'node:module';
import multer from 'multer';

export const OCR_LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,   // same ceiling as statement uploads
  minSide: 100,                // smaller than this cannot hold readable statement text
  maxSide: 8000,
  maxPixels: 20_000_000,       // ~20 MP: a decoded RGBA copy is ~80 MB, which bounds memory with concurrency 2
  lowResolutionWidth: 800,
  maxTextChars: 20_000,
  timeoutMs: 30_000,
  maxConcurrent: 2,
  maxQueued: 3,
  lowConfidence: 70
});

// An error whose message is safe to show to the user (fixed text, never the image or the extracted text).
export class OcrError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'OcrError';
    this.code = code;
    this.status = status;
  }
}

// ── Image inspection ─────────────────────────────────────────────────────────────────────────────────────────────
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const malformed = (what) => new OcrError('malformed_image', 400, `The image file is damaged or incomplete (${what}). Please upload a valid JPG or PNG.`);

let crcTable = null;
function crc32(buf, start, end) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

function inspectPng(buf) {
  let pos = PNG_SIGNATURE.length;
  let width = 0, height = 0, sawPlte = false, sawIdat = false, colorType = -1, first = true;
  for (;;) {
    if (pos + 12 > buf.length) throw malformed('truncated');
    const length = buf.readUInt32BE(pos);
    if (length > 0x7fffffff || pos + 12 + length > buf.length) throw malformed('truncated chunk');
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw malformed('invalid chunk');
    if (crc32(buf, pos + 4, pos + 8 + length) !== buf.readUInt32BE(pos + 8 + length)) throw malformed('checksum mismatch');
    const data = pos + 8;
    if (first) {
      if (type !== 'IHDR' || length !== 13) throw malformed('missing header');
      width = buf.readUInt32BE(data);
      height = buf.readUInt32BE(data + 4);
      const depth = buf[data + 8];
      colorType = buf[data + 9];
      if (!PNG_DEPTHS[colorType]?.includes(depth) || buf[data + 10] !== 0 || buf[data + 11] !== 0 || buf[data + 12] > 1) throw malformed('invalid header');
      first = false;
    } else if (type === 'IHDR') {
      throw malformed('duplicate header');
    } else if (type === 'PLTE') {
      sawPlte = true;
    } else if (type === 'IDAT') {
      sawIdat = true;
    } else if (type === 'IEND') {
      if (length !== 0 || pos + 12 !== buf.length) throw malformed('data after the end of the image');
      if (!sawIdat || (colorType === 3 && !sawPlte)) throw malformed('missing image data');
      return { format: 'png', width, height };
    }
    pos += 12 + length;
  }
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function inspectJpeg(buf) {
  let pos = 2;
  let dims = null;
  for (;;) {
    if (pos >= buf.length) throw malformed('truncated');
    if (buf[pos] !== 0xff) throw malformed('invalid segment');
    while (buf[pos] === 0xff) pos++;           // fill bytes
    const marker = buf[pos++];
    if (marker === undefined) throw malformed('truncated');
    if (marker === 0x00 || marker === 0xd8) throw malformed('invalid segment');
    if (marker === 0xd9) throw malformed('no image data');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;   // markers without a length
    if (pos + 2 > buf.length) throw malformed('truncated');
    const length = buf.readUInt16BE(pos);
    if (length < 2 || pos + length > buf.length) throw malformed('truncated segment');
    if (JPEG_SOF.has(marker)) {
      if (dims) throw malformed('duplicate frame header');
      if (length < 8) throw malformed('invalid frame header');
      const precision = buf[pos + 2];
      const components = buf[pos + 7];
      if (![8, 12].includes(precision) || ![1, 3, 4].includes(components) || length < 8 + 3 * components) throw malformed('invalid frame header');
      dims = { format: 'jpeg', height: buf.readUInt16BE(pos + 3), width: buf.readUInt16BE(pos + 5) };
    } else if (marker === 0xda) {                                           // start of scan: entropy-coded data follows
      if (!dims) throw malformed('missing frame header');
      if (!(buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9)) throw malformed('missing end of image');
      return dims;
    }
    pos += length;
  }
}

// Returns { format: 'jpeg' | 'png', width, height } for a well-formed image, otherwise throws an OcrError. The format comes from
// the file's own bytes, never from the file name or the client's declared type.
export function inspectImage(buffer, limits = OCR_LIMITS) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new OcrError('empty_file', 400, 'The uploaded file is empty.');
  let info;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) info = inspectPng(buffer);
  else if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) info = inspectJpeg(buffer);
  else throw new OcrError('unsupported_type', 415, 'Unsupported image. Upload a JPG, JPEG or PNG image.');
  const { width, height } = info;
  if (!(width > 0 && height > 0)) throw malformed('invalid size');
  if (width < limits.minSide || height < limits.minSide) {
    throw new OcrError('image_too_small', 422, `The image is too small to read (minimum ${limits.minSide}x${limits.minSide} pixels).`);
  }
  if (width > limits.maxSide || height > limits.maxSide || width * height > limits.maxPixels) {
    throw new OcrError('image_too_large', 422, `The image dimensions are too large (maximum ${limits.maxSide} pixels per side and ${limits.maxPixels / 1_000_000} megapixels). Please reduce the image size.`);
  }
  return info;
}

// ── Text clean-up ────────────────────────────────────────────────────────────────────────────────────────────────
export function cleanOcrText(raw, maxChars = OCR_LIMITS.maxTextChars) {
  let text = String(raw ?? '')
    // eslint-disable-next-line no-control-regex -- strips control characters (keeping \n and \t) from engine output
    .replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n').map((line) => line.replace(/[ \t]+$/g, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  let truncated = false;
  if (text.length > maxChars) { text = text.slice(0, maxChars).trimEnd(); truncated = true; }
  return { text, truncated };
}

// ── Service: bounded concurrency, queue, timeout ─────────────────────────────────────────────────────────────────
// engine: { recognize(buffer, { signal }) -> Promise<{ text, confidence? }> }. It must stop its work (and release what it
// holds) when `signal` aborts; the service additionally stops waiting for it, so a stuck engine cannot hold a request.
export function createOcrService({ engine, limits = OCR_LIMITS } = {}) {
  if (!engine || typeof engine.recognize !== 'function') throw new Error('createOcrService needs an engine');
  let running = 0;
  const waiting = [];

  const acquire = () => {
    if (running < limits.maxConcurrent) { running++; return Promise.resolve(); }
    if (waiting.length >= limits.maxQueued) return Promise.reject(new OcrError('busy', 503, 'Text recognition is busy. Please try again in a moment.'));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(entry), 1);
        reject(new OcrError('busy', 503, 'Text recognition is busy. Please try again in a moment.'));
      }, limits.timeoutMs);
      waiting.push(entry);
    });
  };
  const release = () => {
    const next = waiting.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }   // the slot passes straight to the next job
    else running--;
  };

  async function runEngine(buffer) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new OcrError('timeout', 504, 'Reading the image took too long. Try a smaller or clearer image.'));
      }, limits.timeoutMs);
    });
    const job = Promise.resolve().then(() => engine.recognize(buffer, { signal: controller.signal }));
    job.catch(() => {});   // if the timeout wins, a late failure of the abandoned job is not an unhandled rejection
    try {
      return await Promise.race([job, timeout]);
    } finally {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();   // lets the engine release anything it still holds
    }
  }

  return {
    stats: () => ({ running, queued: waiting.length }),
    // declaredFormat ('jpeg' | 'png' | undefined) is what the file name claimed; it must agree with the file's real bytes.
    async extractText(buffer, { declaredFormat } = {}) {
      const info = inspectImage(buffer, limits);
      if (declaredFormat && declaredFormat !== info.format) {
        throw new OcrError('type_mismatch', 415, 'The file extension does not match the image content. Upload a genuine JPG or PNG.');
      }
      await acquire();
      let result;
      try {
        result = await runEngine(buffer);
      } catch (err) {
        if (err instanceof OcrError) throw err;
        throw new OcrError('ocr_failed', 500, 'Could not read text from this image. Please try again with a clearer image.');
      } finally {
        release();
      }
      const { text, truncated } = cleanOcrText(result?.text, limits.maxTextChars);
      if (!text) throw new OcrError('no_text', 422, 'No readable text was found in this image. Use a sharper, well-lit, straight-on image of the statement.');
      const confidence = Number.isFinite(result?.confidence) ? Math.max(0, Math.min(100, Math.round(result.confidence))) : null;
      const warnings = [];
      if (confidence !== null && confidence < limits.lowConfidence) warnings.push(`Low recognition confidence (${confidence}%). Check every amount and date carefully.`);
      if (!/\d/.test(text)) warnings.push('No numbers were found. This may not be a transaction statement.');
      if (info.width < limits.lowResolutionWidth) warnings.push('The image resolution is low, so some characters may be misread.');
      if (truncated) warnings.push(`The text was cut off at ${limits.maxTextChars.toLocaleString('en-US')} characters.`);
      return { text, confidence, warnings, width: info.width, height: info.height, format: info.format };
    }
  };
}

// ── Real engine: Tesseract.js (WASM, runs locally; no network) ───────────────────────────────────────────────────
// One short-lived worker per job: nothing carries over between users, and `terminate()` in `finally` always frees the worker
// thread and its WASM memory, including after a timeout. Language data is read from the installed @tesseract.js-data/eng
// package, so nothing is downloaded at run time, and cacheMethod 'none' stops Tesseract.js writing a cache file anywhere.
function defaultLangPath() {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
}

export function createTesseractEngine({ langPath, loadTesseract = () => import('tesseract.js') } = {}) {
  return {
    async recognize(buffer, { signal } = {}) {
      const mod = await loadTesseract();
      const createWorker = mod.createWorker ?? mod.default?.createWorker;
      let worker = null;
      let terminated = false;
      const stop = async () => {
        if (!worker || terminated) return;
        terminated = true;
        try { await worker.terminate(); } catch { /* already gone */ }
      };
      const onAbort = () => { stop(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        worker = await createWorker('eng', 1, { langPath: langPath ?? defaultLangPath(), gzip: true, cacheMethod: 'none' });
        if (signal?.aborted) throw new Error('aborted');
        const { data } = await worker.recognize(buffer);
        return { text: data?.text ?? '', confidence: data?.confidence };
      } finally {
        signal?.removeEventListener('abort', onAbort);
        await stop();
      }
    }
  };
}

// ── HTTP: upload middleware + handler ────────────────────────────────────────────────────────────────────────────
const EXTENSION_FORMAT = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png' };
const formatOfName = (name) => EXTENSION_FORMAT[path.extname(String(name ?? '')).toLowerCase()];

// Separate from the statement upload (which keeps its own allow-list). Memory storage only: the image is never written to disk.
export function createImageUpload(limits = OCR_LIMITS) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: limits.maxBytes, files: 1, fields: 2, parts: 3 },
    fileFilter: (req, file, cb) => {
      if (formatOfName(file.originalname)) return cb(null, true);
      const err = new Error('Unsupported file type');
      err.code = 'UNSUPPORTED_FILE_TYPE';
      cb(err);
    }
  });
}

// Mount as: app.post(route, authenticate, limiter, ...createOcrStatementImageHandlers({ ocr }))
export function createOcrStatementImageHandlers({ ocr, upload = createImageUpload() }) {
  const receive = (req, res, next) => {
    upload.single('statementImage')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Image too large. Maximum allowed size is 5 MB.' });
      if (err.code === 'UNSUPPORTED_FILE_TYPE') return res.status(415).json({ error: 'Unsupported image type. Upload a .jpg, .jpeg or .png image.' });
      return res.status(400).json({ error: 'Invalid upload. Send one image in the "statementImage" field.' });
    });
  };
  const handle = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.file) return res.status(400).json({ error: 'No image provided. Send one image in the "statementImage" field.' });
    try {
      const out = await ocr.extractText(req.file.buffer, { declaredFormat: formatOfName(req.file.originalname) });
      return res.json({ success: true, text: out.text, confidence: out.confidence, warnings: out.warnings });
    } catch (err) {
      if (err instanceof OcrError) {
        if (err.status === 503) res.set('Retry-After', '10');
        return res.status(err.status).json({ error: err.message });
      }
      console.error('Image OCR failed unexpectedly');   // fixed text only: no error detail, image or extracted text
      return res.status(500).json({ error: 'Could not read text from this image.' });
    } finally {
      req.file.buffer = null;
    }
  };
  return [receive, handle];
}
