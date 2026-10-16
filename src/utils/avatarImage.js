// Profile photo helpers (browser side). A chosen photo is decoded, centre-cropped to a square, scaled to 256 px and re-encoded to WebP
// (JPEG where WebP encoding is unavailable) in a canvas, which also removes all camera metadata (EXIF, GPS) and applies the photo's
// orientation. Only that small result is uploaded. The server validates and sanitises the bytes again; nothing here is trusted.

export const AVATAR_ACCEPT = 'image/jpeg,image/png,image/webp';
export const AVATAR_TYPES = AVATAR_ACCEPT.split(',');
export const AVATAR_SIZE = 256;
export const MAX_PICK_BYTES = 10 * 1024 * 1024;   // the photo the user picks (it is shrunk before upload)

const EXTENSION_TYPE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export class AvatarError extends Error {}

// Returns an error message for a file that cannot be used, or '' when it can.
export function avatarFileProblem(file) {
  if (!file) return 'Choose a photo.';
  const ext = String(file.name ?? '').split('.').pop().toLowerCase();
  const type = file.type || EXTENSION_TYPE[ext] || '';
  if (!AVATAR_TYPES.includes(type)) return 'Choose a JPEG, PNG or WebP photo.';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_PICK_BYTES) return `That photo is too large. Choose one under ${MAX_PICK_BYTES / 1024 / 1024} MB.`;
  return '';
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

// file -> { blob, previewUrl }. The caller owns previewUrl and must URL.revokeObjectURL it.
export async function prepareAvatarImage(file) {
  const problem = avatarFileProblem(file);
  if (problem) throw new AvatarError(problem);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new AvatarError('We could not read that image. Try a different photo.');
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (!(side > 0)) throw new AvatarError('We could not read that image. Try a different photo.');
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE; canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    let blob = await toBlob(canvas, 'image/webp', 0.85);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.9);
    if (!blob) throw new AvatarError('We could not process that image. Try a different photo.');
    return { blob, previewUrl: URL.createObjectURL(blob) };
  } finally {
    bitmap.close?.();
  }
}

// Up to two initials from a chosen name ("Alex Kim" -> "AK", "🌿 Nick" -> "N"). Never derived from an email. '' when there is no letter or digit.
export function initialsFor(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  const marks = words.map((w) => Array.from(w).find((ch) => /[\p{L}\p{N}]/u.test(ch))).filter(Boolean);
  if (marks.length === 0) return '';
  const picked = marks.length === 1 ? [marks[0]] : [marks[0], marks[marks.length - 1]];
  return picked.join('').toLocaleUpperCase();
}
