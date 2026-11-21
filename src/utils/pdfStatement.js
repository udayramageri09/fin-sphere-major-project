import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { pdfTableRows } from './pdfImportReview';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 10;
const MAX_TEXT = 90_000;

export const isPdfStatement = (file) => Boolean(file && /\.pdf$/i.test(file.name ?? ''));

export function pdfPageText(items) {
  const lines = [];
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str.trim() || !item.transform) continue;
    const y = item.transform[5];
    let line = lines.find((candidate) => Math.abs(candidate.y - y) < 3);
    if (!line) { line = { y, items: [] }; lines.push(line); }
    line.items.push({ x: item.transform[4], text: item.str });
  }
  return lines.sort((a, b) => b.y - a.y)
    .map((line) => line.items.sort((a, b) => a.x - b.x).map((item) => item.text).join(' '))
    .join('\n');
}

async function pageImage(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, 4000 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width < 100 || viewport.height < 100 || viewport.width * viewport.height > 16_000_000) {
    throw new Error('This PDF page has unsupported dimensions.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Your browser cannot render this PDF page.');
  const render = page.render({ canvasContext: context, canvas, viewport });
  let timer;
  try {
    await Promise.race([
      render.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Rendering this PDF page took too long. Try a smaller scan or upload it as an image.'));
          render.cancel();
        }, 20_000);
      })
    ]);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob || blob.size > MAX_BYTES) throw new Error('A scanned PDF page is too large to read. Try a smaller scan.');
    return new File([blob], 'statement-page.png', { type: 'image/png' });
  } finally {
    clearTimeout(timer);
    canvas.width = 0;
    canvas.height = 0;
  }
}

// Extraction only. The caller must display the text for review before importing.
export async function extractPdfStatement(file, extractImage, loadPdf = () => import('pdfjs-dist/build/pdf.mjs')) {
  if (!file || file.size === 0 || file.size > MAX_BYTES) throw new Error('Choose a PDF no larger than 5 MB.');
  const pdfjs = await loadPdf();
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
  const loading = pdfjs.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false });
  let pdf;
  try {
    pdf = await loading.promise;
    if (pdf.numPages > MAX_PAGES) throw new Error(`PDFs may contain at most ${MAX_PAGES} pages. Split this statement into smaller files.`);
    const pages = [];
    const pageDrafts = [];
    const warnings = [];
    let usedOcr = false;
    let tableLayout = null;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        const { items } = await page.getTextContent();
        let text = pdfPageText(items).trim();
        const operators = (await page.getOperatorList()).fnArray;
        const hasImages = [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageXObjectRepeat, pdfjs.OPS.paintInlineImageXObjectGroup]
          .some((operator) => operator !== undefined && operators.includes(operator));
        const needsOcr = !text || (hasImages && text.length < 200);
        if (needsOcr) {
          usedOcr = true;
          const result = await extractImage(await pageImage(page));
          text = result.text;
          warnings.push(`Page ${number} was read using OCR. Check every date and amount.`);
          warnings.push(...result.warnings);
        } else if (hasImages) {
          warnings.push(`Page ${number} contains images. Check for any transaction details missing from the extracted text.`);
        }
        const table = needsOcr ? { layout: tableLayout, rows: [] } : pdfTableRows(items, tableLayout);
        tableLayout = table.layout;
        pageDrafts.push({ text, tableRows: table.rows, usedOcr: needsOcr });
        pages.push(text);
        if (pages.join('\n').length > MAX_TEXT) throw new Error('The extracted statement is too long. Split the PDF into smaller files.');
      } finally {
        page.cleanup();
      }
    }
    const text = pages.join('\n\n').trim();
    if (!text) throw new Error('No readable text was found in the PDF.');
    if (new TextEncoder().encode(JSON.stringify({ text })).length > 100 * 1024) throw new Error('The extracted statement is too long. Split the PDF into smaller files.');
    return { text, confidence: null, warnings, usedOcr, pages: pageDrafts };
  } catch (error) {
    if (error?.name === 'PasswordException') throw new Error('This PDF is password-protected. Unlock it before uploading.', { cause: error });
    if (error?.name === 'InvalidPDFException') throw new Error('This PDF is damaged or invalid.', { cause: error });
    throw error;
  } finally {
    await loading.destroy();
  }
}
