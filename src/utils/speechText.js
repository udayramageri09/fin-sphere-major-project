// speechText.js - presentation-only rendering of an assistant reply for the browser's voice (Issue #71).
//
// Two representations of ONE grounded reply:
//   display text - exactly what /api/chat returned; shown on screen, never changed here
//   speech text  - the same words made comfortable to hear
// This module only produces the second. It rewrites how figures are SAID (₹1,25,000 -> "one lakh twenty-five
// thousand rupees", 12.5% -> "twelve point five percent", 3.2 -> "three point two"), turns markdown and lists into
// plain sentences, and drops emoji and link syntax. It never computes, rounds, re-signs or reorders a value: every
// digit of the display text is read out in words, a leading minus stays "minus", and dates are left as written.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function belowHundred(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
}

function belowThousand(n) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (hundreds) parts.push(`${ONES[hundreds]} hundred`);
  if (rest) parts.push(belowHundred(rest));
  return parts.join(' ');
}

// A non-negative safe integer in words, in the Indian system (thousand, lakh, crore).
export function indianNumberWords(n) {
  if (!Number.isSafeInteger(n) || n < 0) return null;
  if (n === 0) return 'zero';
  const crore = Math.floor(n / 10_000_000);
  let rest = n % 10_000_000;
  const lakh = Math.floor(rest / 100_000);
  rest %= 100_000;
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  const parts = [];
  if (crore) parts.push(`${indianNumberWords(crore)} crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(' ');
}

const digitWords = (digits) => digits.split('').map((d) => ONES[Number(d)]).join(' ');

// "3.25" -> "three point two five"; integers -> words. Returns null when it cannot be read safely.
function decimalWords(intText, fracText) {
  const whole = indianNumberWords(Number(intText.replace(/,/g, '')));
  if (whole === null) return null;
  return fracText ? `${whole} point ${digitWords(fracText)}` : whole;
}

// ₹ amounts: "₹1,25,000" -> "one lakh twenty-five thousand rupees", "₹1,200.5" -> "... rupees and fifty paise".
function rupeesWords(sign, intText, fracText) {
  const rupees = Number(intText.replace(/,/g, ''));
  const whole = indianNumberWords(rupees);
  if (whole === null) return null;
  let words = `${whole} ${rupees === 1 ? 'rupee' : 'rupees'}`;
  if (fracText) {
    if (fracText.length > 2) return null;                  // more than paise precision: leave it as written
    const paise = Number(fracText.padEnd(2, '0'));
    if (paise > 0) words += ` and ${belowHundred(paise)} ${paise === 1 ? 'paisa' : 'paise'}`;
  }
  return sign ? `minus ${words}` : words;
}

const AMOUNT = String.raw`(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?`;   // "1,25,000" or "125000", optional decimals

function speakFigures(text) {
  return text
    // currency: "₹1,25,000", "-₹8,500", "₹ 950.75", "Rs. 500"
    .replace(new RegExp(String.raw`(-|−)?(?:₹|\bRs\.?\s?|\bINR\s?)\s?${AMOUNT}`, 'g'), (m, sign, i, f) => rupeesWords(sign, i, f) ?? m)
    // percentages: "12.5%", "36%", "-4%"
    .replace(new RegExp(String.raw`(-|−)?${AMOUNT}\s?%`, 'g'), (m, sign, i, f) => {
      const w = decimalWords(i, f);
      return w === null ? m : `${sign ? 'minus ' : ''}${w} percent`;
    })
    // other decimals: "3.2 months" -> "three point two months" (dates like 2026-10 have no decimal point)
    .replace(/(?<![\d.,])(\d+)\.(\d+)(?![\d.])/g, (m, i, f) => decimalWords(i, f) ?? m);
}

function plainSentences(text) {
  const lines = text
    .replace(/```[\s\S]*?```/g, ' ')                       // code blocks
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')               // [label](url) -> label
    .replace(/(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|️|‍)/gu, '') // emoji, flags, joiners
    .split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const isItem = /^\s*(?:[-*•]|\d+[.)])\s+/.test(raw) || /^\s{0,3}#{1,6}\s+/.test(raw);
    let line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, '')                    // headings
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')             // list markers
      .replace(/^\s*>\s?/, '')                             // block quotes
      .replace(/(\*\*|__|\*|`|~~)/g, '')                   // emphasis / inline code marks
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;
    // A list item or heading becomes its own sentence, so the voice pauses instead of running items together.
    if (isItem && !/[.!?:;,]$/.test(line)) line += '.';
    out.push(line);
  }
  return out.join(' ');
}

// Very long replies: speak the opening sentences and say the rest is on screen (the full text stays visible).
export const SPEECH_MAX_CHARS = 600;
function limitLength(text) {
  if (text.length <= SPEECH_MAX_CHARS) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [text];
  let spoken = '';
  for (const s of sentences) {
    if ((spoken + s).length > SPEECH_MAX_CHARS) break;
    spoken += s;
  }
  if (!spoken) return text;                                // a single huge sentence: read it all rather than cut it
  return `${spoken.trim()} The full answer is on your screen.`;
}

export function toSpeechText(text) {
  if (typeof text !== 'string') return '';
  const sentences = plainSentences(text);
  if (!sentences) return '';
  return limitLength(speakFigures(sentences)).replace(/\s+/g, ' ').trim();
}
