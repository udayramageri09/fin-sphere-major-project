// Client side of image statement upload (Stage 2). Only the OCR request lives here: the server returns TEXT, which the page
// puts in the paste editor for the user to review. Nothing here saves a transaction or calls the statement-import endpoint.

const IMAGE_NAME = /\.(jpe?g|png)$/i;
export const isOcrImageFile = (file) => Boolean(file && IMAGE_NAME.test(String(file.name ?? '')));

export class ImageOcrError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ImageOcrError';
    this.status = status;
  }
}

// Used only when the server's own message is missing (for example a proxy answered instead of the API).
const FALLBACK_MESSAGE = {
  400: 'This image could not be read. Upload a valid JPG or PNG.',
  413: 'Image too large. Maximum allowed size is 5 MB.',
  415: 'Unsupported image. Upload a JPG, JPEG or PNG image.',
  422: 'No readable text was found in this image. Try a sharper, well-lit image.',
  429: 'Too many image requests. Please wait a minute and try again.',
  503: 'Text recognition is busy. Please try again in a moment.',
  504: 'Reading the image took too long. Try a smaller or clearer image.'
};

// POSTs one image as multipart FormData (field `statementImage`) with the session cookie, like every other API call.
// Resolves { text, confidence, warnings }. Rejects with ImageOcrError (status 401 = session expired; the caller decides what
// to do about it). The text is never logged.
export async function requestImageText({ apiUrl, file, fetchImpl = fetch }) {
  const formData = new FormData();
  formData.append('statementImage', file);
  let res;
  try {
    res = await fetchImpl(`${apiUrl}/transactions/ocr-statement-image`, { method: 'POST', credentials: 'include', body: formData });
  } catch {
    throw new ImageOcrError('Could not reach the server. Check your connection and try again.');
  }
  if (res.status === 401) throw new ImageOcrError('Session expired', 401);
  let body = null;
  try { body = await res.json(); } catch { /* not JSON: a proxy or gateway answered */ }
  if (!res.ok) {
    const serverMessage = typeof body?.error === 'string' && body.error.trim() ? body.error : null;
    throw new ImageOcrError(serverMessage ?? FALLBACK_MESSAGE[res.status] ?? 'Could not read text from this image. Please try again.', res.status);
  }
  if (typeof body?.text !== 'string' || !body.text.trim()) throw new ImageOcrError('No readable text was found in this image.', 422);
  return {
    text: body.text,
    confidence: Number.isFinite(body.confidence) ? Math.max(0, Math.min(100, Math.round(body.confidence))) : null,
    warnings: Array.isArray(body.warnings) ? body.warnings.filter((w) => typeof w === 'string' && w.trim()).slice(0, 10) : []
  };
}
