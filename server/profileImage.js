// profileImage.js - validates and sanitises a user's profile photo (pure: no database, no HTTP, no network).
//
// Accepts only JPEG, PNG and WebP, decided by the file's own bytes (never the file name or the browser's MIME type): SVG, GIF,
// animated WebP, HTML, executables and anything else are refused. The structure is checked end to end, the decoded dimensions are
// bounded, and the file is REWRITTEN without metadata: JPEG APPn/COM segments (EXIF, GPS, XMP, thumbnails), PNG ancillary chunks
// (text, EXIF, colour-profile blobs, time stamps) and WebP EXIF/XMP/ICC/animation chunks are dropped; the pixel data is copied
// byte for byte. (The browser also re-encodes the photo to a small WebP before upload; this server check does not depend on that.)
// The result is only ever shown back to its own owner.
import { Buffer } from 'node:buffer';

export const AVATAR_LIMITS = Object.freeze({
  maxUploadBytes: 512 * 1024,   // what the endpoint accepts
  maxStoredBytes: 256 * 1024,   // what is stored after sanitising (also a database CHECK)
  minSide: 32,
  maxSide: 1024
});

export class ProfileImageError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'ProfileImageError';
    this.code = code;
    this.status = status;
  }
}
const damaged = () => new ProfileImageError('damaged_image', 400, 'This image file appears to be damaged. Choose a different photo.');

// ── PNG ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let crcTable = null;
function crc32(buf, start, end) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);   // critical chunks plus transparency

function sanitizePng(buf) {
  const kept = [PNG_SIGNATURE];
  let pos = PNG_SIGNATURE.length, width = 0, height = 0, first = true, sawIdat = false, sawPlte = false, colorType = -1;
  for (;;) {
    if (pos + 12 > buf.length) throw damaged();
    const length = buf.readUInt32BE(pos);
    if (length > 0x7fffffff || pos + 12 + length > buf.length) throw damaged();
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw damaged();
    if (crc32(buf, pos + 4, pos + 8 + length) !== buf.readUInt32BE(pos + 8 + length)) throw damaged();
    const data = pos + 8;
    if (first) {
      if (type !== 'IHDR' || length !== 13) throw damaged();
      width = buf.readUInt32BE(data); height = buf.readUInt32BE(data + 4);
      colorType = buf[data + 9];
      if (!PNG_DEPTHS[colorType]?.includes(buf[data + 8]) || buf[data + 10] !== 0 || buf[data + 11] !== 0 || buf[data + 12] > 1) throw damaged();
      first = false;
    } else if (type === 'IHDR') throw damaged();
    if (type === 'PLTE') sawPlte = true;
    if (type === 'IDAT') sawIdat = true;
    if (PNG_KEEP.has(type)) kept.push(buf.subarray(pos, pos + 12 + length));
    pos += 12 + length;
    if (type === 'IEND') {
      if (length !== 0 || pos !== buf.length || !sawIdat || (colorType === 3 && !sawPlte)) throw damaged();
      return { contentType: 'image/png', data: Buffer.concat(kept), width, height };
    }
  }
}

// ── JPEG ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function sanitizeJpeg(buf) {
  const kept = [Buffer.from([0xff, 0xd8])];
  let pos = 2, dims = null;
  for (;;) {
    if (pos >= buf.length || buf[pos] !== 0xff) throw damaged();
    let p = pos;
    while (buf[p] === 0xff) p++;
    const marker = buf[p++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) throw damaged();
    if (p + 2 > buf.length) throw damaged();
    const length = buf.readUInt16BE(p);
    if (length < 2 || p + length > buf.length) throw damaged();
    const segment = Buffer.concat([Buffer.from([0xff, marker]), buf.subarray(p, p + length)]);
    if (JPEG_SOF.has(marker)) {
      if (dims || length < 8) throw damaged();
      const precision = buf[p + 2], comps = buf[p + 7];
      if (![8, 12].includes(precision) || ![1, 3, 4].includes(comps) || length < 8 + 3 * comps) throw damaged();
      dims = { height: buf.readUInt16BE(p + 3), width: buf.readUInt16BE(p + 5) };
    }
    if (marker === 0xda) {                                         // start of scan: the rest is pixel data, copied verbatim
      if (!dims) throw damaged();
      if (!(buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9)) throw damaged();
      kept.push(buf.subarray(pos));
      return { contentType: 'image/jpeg', data: Buffer.concat(kept), width: dims.width, height: dims.height };
    }
    // Drop every application segment (EXIF, GPS, XMP, thumbnails, ICC) and comments. Keep Adobe's tiny colour-transform tag.
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (marker === 0xfe || (isApp && !(marker === 0xee && length <= 16))) { pos = p + length; continue; }
    kept.push(segment);
    pos = p + length;
  }
}

// ── WebP ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function sanitizeWebp(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') throw damaged();
  if (buf.readUInt32LE(4) + 8 !== buf.length && buf.readUInt32LE(4) + 9 !== buf.length) throw damaged();   // declared size vs file (odd size is padded)
  let pos = 12, width = 0, height = 0, vp8x = null, hasAlpha = false, sawImage = false;
  const kept = [];
  // a kept chunk is copied whole and always padded to an even length, as RIFF requires
  const chunkOf = (at, size) => Buffer.concat([buf.subarray(at, at + 8 + size), Buffer.alloc(size & 1)]);
  while (pos < buf.length) {
    if (pos + 8 > buf.length) throw damaged();
    const fourcc = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const end = pos + 8 + size + (size & 1);
    if (pos + 8 + size > buf.length || end > buf.length + 1) throw damaged();
    const data = pos + 8;
    if (fourcc === 'VP8X') {
      if (size < 10 || kept.length !== 0 || vp8x) throw damaged();
      if (buf[data] & 0x02) throw new ProfileImageError('animated_image', 400, 'Animated images are not supported. Choose a still photo.');
      vp8x = { flagsAt: kept.length };
      width = 1 + (buf[data + 4] | (buf[data + 5] << 8) | (buf[data + 6] << 16));
      height = 1 + (buf[data + 7] | (buf[data + 8] << 8) | (buf[data + 9] << 16));
      kept.push(chunkOf(pos, size));
    } else if (fourcc === 'ALPH') {
      if (!vp8x || sawImage) throw damaged();
      hasAlpha = true;
      kept.push(chunkOf(pos, size));
    } else if (fourcc === 'VP8 ') {
      if (sawImage || size < 10 || (buf[data] & 1) !== 0 || buf[data + 3] !== 0x9d || buf[data + 4] !== 0x01 || buf[data + 5] !== 0x2a) throw damaged();
      sawImage = true;
      if (!vp8x) { width = buf.readUInt16LE(data + 6) & 0x3fff; height = buf.readUInt16LE(data + 8) & 0x3fff; }
      kept.push(chunkOf(pos, size));
    } else if (fourcc === 'VP8L') {
      if (sawImage || size < 5 || buf[data] !== 0x2f) throw damaged();
      sawImage = true;
      hasAlpha = hasAlpha || ((buf[data + 4] >> 4) & 1) === 1;
      const bits = buf.readUInt32LE(data + 1);
      if (!vp8x) { width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
      kept.push(chunkOf(pos, size));
    } else if (fourcc === 'ANIM' || fourcc === 'ANMF') {
      throw new ProfileImageError('animated_image', 400, 'Animated images are not supported. Choose a still photo.');
    }
    // every other chunk (EXIF, XMP, ICCP, unknown) is dropped
    pos = end;
  }
  if (!sawImage || !(width > 0 && height > 0)) throw damaged();
  if (vp8x) {   // keep only the alpha bit of the feature flags: no ICC, EXIF, XMP or animation
    const head = Buffer.from(kept[0]);
    head[8] = hasAlpha ? 0x10 : 0x00;
    head[9] = head[10] = head[11] = 0;
    kept[0] = head;
  }
  const body = Buffer.concat(kept);
  const out = Buffer.alloc(12 + body.length);
  out.write('RIFF', 0, 'latin1'); out.writeUInt32LE(4 + body.length, 4); out.write('WEBP', 8, 'latin1'); body.copy(out, 12);
  return { contentType: 'image/webp', data: out, width, height };
}

// buffer -> { contentType, data, width, height } (sanitised), or throws ProfileImageError. Limits are checked on the decoded size.
export function sanitizeProfileImage(buffer, limits = AVATAR_LIMITS) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ProfileImageError('empty_file', 400, 'The photo file is empty.');
  if (buffer.length > limits.maxUploadBytes) throw new ProfileImageError('too_large', 413, `Photo is too large (maximum ${Math.round(limits.maxUploadBytes / 1024)} KB).`);
  let out;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) out = sanitizePng(buffer);
  else if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) out = sanitizeJpeg(buffer);
  else if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') out = sanitizeWebp(buffer);
  else throw new ProfileImageError('unsupported_type', 415, 'Choose a JPEG, PNG or WebP photo.');
  if (!(out.width > 0 && out.height > 0)) throw damaged();
  if (out.width < limits.minSide || out.height < limits.minSide || out.width > limits.maxSide || out.height > limits.maxSide) {
    throw new ProfileImageError('bad_dimensions', 422, `The photo must be between ${limits.minSide} and ${limits.maxSide} pixels on each side.`);
  }
  if (out.data.length > limits.maxStoredBytes) throw new ProfileImageError('too_large', 413, `Photo is too large after processing (maximum ${Math.round(limits.maxStoredBytes / 1024)} KB).`);
  return out;
}
