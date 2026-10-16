// Profile photo validation and metadata stripping: pure unit tests (no database, no HTTP).
//
//   npm --prefix server run test:profile-image
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeProfileImage, ProfileImageError, AVATAR_LIMITS } from '../profileImage.js';
import * as F from './avatarFixtures.mjs';

const refuses = (buf, code, status) => assert.throws(() => sanitizeProfileImage(buf), (e) => e instanceof ProfileImageError && e.code === code && (status === undefined || e.status === status), `expected ${code}`);
const pngChunks = (buf) => { const out = []; let pos = 8; while (pos < buf.length) { const len = buf.readUInt32BE(pos); out.push(buf.toString('latin1', pos + 4, pos + 8)); pos += 12 + len; } return out; };
const jpegMarkers = (buf) => { const out = []; let pos = 2; for (;;) { const m = buf[pos + 1]; out.push(m); if (m === 0xda) return out; pos += 2 + buf.readUInt16BE(pos + 2); } };
const webpChunks = (buf) => { const out = []; let pos = 12; while (pos < buf.length) { const size = buf.readUInt32LE(pos + 4); out.push(buf.toString('latin1', pos, pos + 4)); pos += 8 + size + (size & 1); } return out; };
const hasMarker = (buf) => F.MARKERS.some((m) => buf.includes(Buffer.from(m)));

test('accepts JPEG, PNG (with alpha) and WebP (lossy and lossless) and reports type and decoded size', () => {
  for (const [name, buf, type] of [['jpeg', F.JPEG_WITH_EXIF, 'image/jpeg'], ['jpeg plain', F.JPEG_PLAIN, 'image/jpeg'], ['png', F.PNG_WITH_TEXT, 'image/png'],
    ['png alpha', F.PNG_ALPHA, 'image/png'], ['webp lossy', F.WEBP_LOSSY_EXIF, 'image/webp'], ['webp lossless', F.WEBP_LOSSLESS, 'image/webp']]) {
    const out = sanitizeProfileImage(buf);
    assert.equal(out.contentType, type, name);
    assert.deepEqual([out.width, out.height], [200, 200], name);
    assert.ok(out.data.length > 0 && out.data.length <= AVATAR_LIMITS.maxStoredBytes, name);
  }
});

test('the test fixtures really carry the metadata markers (so the stripping checks mean something)', () => {
  assert.ok(F.JPEG_WITH_EXIF.includes(Buffer.from('PRIVATE-GPS-MARKER')));
  assert.ok(F.PNG_WITH_TEXT.includes(Buffer.from('PRIVATE-PNG-TEXT-MARKER')));
  assert.ok(F.WEBP_LOSSY_EXIF.includes(Buffer.from('PRIVATE-GPS-MARKER')));
});

test('metadata is stripped: EXIF/GPS, text chunks and WebP EXIF do not survive', () => {
  for (const buf of [F.JPEG_WITH_EXIF, F.PNG_WITH_TEXT, F.WEBP_LOSSY_EXIF]) assert.equal(hasMarker(sanitizeProfileImage(buf).data), false);
  const png = sanitizeProfileImage(F.PNG_WITH_TEXT).data;
  assert.ok(pngChunks(F.PNG_WITH_TEXT).some((c) => c === 'tEXt' || c === 'iTXt'), 'fixture has text chunks');
  assert.ok(pngChunks(png).every((c) => ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(c)), pngChunks(png).join());
  const jpg = sanitizeProfileImage(F.JPEG_WITH_EXIF).data;
  assert.ok(jpegMarkers(F.JPEG_WITH_EXIF).includes(0xe1), 'fixture has an EXIF (APP1) segment');
  assert.ok(!jpegMarkers(jpg).some((m) => m >= 0xe0 && m <= 0xef && m !== 0xee) && !jpegMarkers(jpg).includes(0xfe), jpegMarkers(jpg).map((m) => m.toString(16)).join());
  const webp = sanitizeProfileImage(F.WEBP_LOSSY_EXIF).data;
  assert.ok(webpChunks(F.WEBP_LOSSY_EXIF).includes('EXIF'), 'fixture has an EXIF chunk');
  assert.ok(!webpChunks(webp).some((c) => ['EXIF', 'XMP ', 'ICCP', 'ANIM', 'ANMF'].includes(c)), webpChunks(webp).join());
});

test('pixel data is copied unchanged and the result is well formed and stable', () => {
  const png = sanitizeProfileImage(F.PNG_WITH_TEXT).data;
  const idat = (b) => Buffer.concat(pngChunks(b).map((c, i) => c).length ? (() => { const parts = []; let pos = 8; while (pos < b.length) { const len = b.readUInt32BE(pos); if (b.toString('latin1', pos + 4, pos + 8) === 'IDAT') parts.push(b.subarray(pos + 8, pos + 8 + len)); pos += 12 + len; } return parts; })() : []);
  assert.ok(idat(png).equals(idat(F.PNG_WITH_TEXT)), 'IDAT data identical');
  const jpg = sanitizeProfileImage(F.JPEG_WITH_EXIF).data;
  assert.deepEqual([jpg[0], jpg[1], jpg[jpg.length - 2], jpg[jpg.length - 1]], [0xff, 0xd8, 0xff, 0xd9]);
  const scan = (b) => b.subarray(b.indexOf(Buffer.from([0xff, 0xda])));
  assert.ok(scan(jpg).equals(scan(F.JPEG_WITH_EXIF)), 'scan data identical');
  const webp = sanitizeProfileImage(F.WEBP_LOSSY_EXIF).data;
  assert.equal(webp.readUInt32LE(4) + 8, webp.length, 'RIFF size is consistent');
  for (const buf of [F.JPEG_WITH_EXIF, F.PNG_WITH_TEXT, F.PNG_ALPHA, F.WEBP_LOSSY_EXIF, F.WEBP_LOSSLESS]) {
    const once = sanitizeProfileImage(buf);
    assert.ok(sanitizeProfileImage(once.data).data.equals(once.data), 'sanitising twice changes nothing');
  }
  const lossless = sanitizeProfileImage(F.WEBP_LOSSLESS).data;
  assert.equal(lossless.readUInt32LE(4) + 8, lossless.length);
});

test('the type comes from the bytes: SVG, GIF, HTML, scripts, executables and PDFs are refused', () => {
  for (const [name, buf] of [
    ['gif', F.GIF], ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script></svg>')],
    ['html', Buffer.from('<html><body onload="x()">hi</body></html>')], ['exe', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)])],
    ['pdf', Buffer.from('%PDF-1.7 ...')], ['text', Buffer.from('just a text file')], ['png signature only', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['riff but not webp', Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WAVE')])]
  ]) {
    assert.throws(() => sanitizeProfileImage(buf), (e) => e instanceof ProfileImageError && [415, 400].includes(e.status), name);
  }
  refuses(F.GIF, 'unsupported_type', 415);
  refuses(Buffer.from('<svg></svg>'), 'unsupported_type', 415);
  refuses(Buffer.alloc(0), 'empty_file', 400);
});

test('animated WebP is refused', () => {
  refuses(F.WEBP_ANIMATED, 'animated_image', 400);
  const flagged = Buffer.from(F.WEBP_LOSSLESS);               // a lossless still with a VP8X animation flag forced on
  const x = flagged.indexOf(Buffer.from('VP8X'));
  if (x > 0) { flagged[x + 8] |= 0x02; refuses(flagged, 'animated_image', 400); }
});

test('damaged and truncated files are refused', () => {
  refuses(F.PNG_WITH_TEXT.subarray(0, 300), 'damaged_image', 400);
  refuses(F.PNG_WITH_TEXT.subarray(0, F.PNG_WITH_TEXT.length - 6), 'damaged_image', 400);
  const crc = Buffer.from(F.PNG_ALPHA); crc[40] ^= 0xff; refuses(crc, 'damaged_image', 400);
  refuses(Buffer.concat([F.PNG_ALPHA, Buffer.from('trailing')]), 'damaged_image', 400);
  refuses(F.JPEG_PLAIN.subarray(0, 400), 'damaged_image', 400);
  refuses(F.JPEG_PLAIN.subarray(0, F.JPEG_PLAIN.length - 2), 'damaged_image', 400);
  refuses(F.WEBP_LOSSY_EXIF.subarray(0, 60), 'damaged_image', 400);
  const lie = Buffer.from(F.WEBP_LOSSLESS); lie.writeUInt32LE(9999, 4); refuses(lie, 'damaged_image', 400);
  refuses(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]), Buffer.alloc(8)]), 'damaged_image', 400);
});

test('decoded dimensions are enforced (too small, too large, decompression-bomb headers)', () => {
  refuses(F.SMALL_PNG, 'bad_dimensions', 422);
  const header = (w, h) => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
    const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); body.copy(out, 4);
      let c = 0xffffffff; for (const b of body) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + data.length); return out; };
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from([0x78, 0x9c, 3, 0, 0, 0, 0, 1])), chunk('IEND', Buffer.alloc(0))]);
  };
  refuses(header(1025, 200), 'bad_dimensions', 422);
  refuses(header(5000, 5000), 'bad_dimensions', 422);
  refuses(header(0x7fffffff, 0x7fffffff), 'bad_dimensions', 422);
  refuses(header(31, 200), 'bad_dimensions', 422);
  assert.equal(sanitizeProfileImage(header(1024, 1024)).width, 1024);
  assert.equal(sanitizeProfileImage(header(32, 32)).width, 32);
});

test('size limits: upload and stored size', () => {
  refuses(Buffer.concat([F.PNG_ALPHA, Buffer.alloc(AVATAR_LIMITS.maxUploadBytes)]), 'too_large', 413);
  assert.throws(() => sanitizeProfileImage(F.JPEG_PLAIN, { ...AVATAR_LIMITS, maxStoredBytes: 100 }), (e) => e.code === 'too_large');
});

test('every refusal carries a safe, fixed message (no file content)', () => {
  for (const buf of [F.GIF, F.SMALL_PNG, F.WEBP_ANIMATED, Buffer.from('SECRET-CONTENT-123 not an image')]) {
    try { sanitizeProfileImage(buf); assert.fail('should have thrown'); } catch (e) { assert.ok(e instanceof ProfileImageError); assert.doesNotMatch(e.message, /SECRET|CONTENT/); }
  }
});
