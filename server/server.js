import { forecastMonths } from './forecastHorizon.js';
/* eslint-disable no-undef, no-unused-vars, no-useless-assignment */
import express from 'express';
import { parseTrustProxy, developmentOrigins } from './runtimeConfig.js';
import { holdingsRouter } from './holdings.js';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import XLSX from 'xlsx';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import {
  initDatabase, closeDatabase, databaseHealthy, readProfile, updateProfile, saveAvatar, readAvatar, deleteAvatar, createUser, findUserByEmail, normalizeEmail, DuplicateEmailError,
  issuePasswordReset, consumePasswordReset, isCurrentSession,
  listTransactionsByUser, createTransaction, createTransactionsBatch, importTransactionsLocked, ImportMatchLimitError, deleteTransactionByUserAndId, updateTransactionCategory, updateTransactionByUserAndId,
  listGoalsByUser, createGoal, deleteGoalByUserAndId, addGoalContribution, listGoalContributions,
  listLiabilitiesByUser, insertLiabilityIdempotent, deleteLiabilityByUserAndId, sumMonthlyPaymentsByUser, repayLiability, listLiabilityRepayments,
  getEmergencyFundByUser, upsertEmergencyFund, getTransactionTotalsByUser,
  listBudgetsByUserAndMonth, upsertBudget, deleteBudgetByUserAndId,
  getActiveProposal, replaceActiveProposal, getProposalByUserAndId, claimProposal, finishProposal, cancelProposal,
  expireProposal, previewGoalContribution, previewLiabilityRepayment, setBudgetExpecting
} from './db/index.js';
import { createAssistantActions, shiftDate, monthLabel } from './assistantActions.js';
import { createStructuredExtractor } from './structuredActionExtractor.js';
import { getChatModel, getParseModel, groqChatUrl, modelRequestFields } from './groqModels.js';
import { createOcrService, createTesseractEngine, createOcrStatementImageHandlers } from './imageOcr.js';
import { sanitizeProfileImage, ProfileImageError, AVATAR_LIMITS } from './profileImage.js';
import { MAX_IMPORT_ROWS, findDuplicates, buildPreview, reviewDigest, digestsEqual, parseConfirmRequest, planImport } from './importDuplicates.js';
import { createSnapshotStore, sanitizeAnalysis } from './planSnapshot.js';
import { createResetDelivery, createDevMailHandlers, createPasswordResetHandlers } from './passwordReset.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 5000;
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:8000';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Refusing to start.');
  process.exit(1);
}
if (JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters long. Refusing to start.');
  process.exit(1);
}

const isProd = process.env.NODE_ENV === 'production';

// Tokens are signed and accepted with HS256 only, so a token can never choose its own algorithm.
const JWT_ALGORITHM = 'HS256';
const JWT_VERIFY_OPTIONS = { algorithms: [JWT_ALGORITHM] };

// ── Authentication Middleware ──────────────────────────────────────────────────
// Reads the JWT from the httpOnly cookie set at login, verifies it, and attaches
// the decoded identity to req.user.  Returns 401 for missing / invalid / expired tokens.
// Identity contract: every financial query uses req.user.id only after token verification
// and session-version validation. The stale-tab header below is never an identity source.
async function authenticate(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET, JWT_VERIFY_OPTIONS);
    if (!await isCurrentSession(decoded.id, decoded.sessionVersion ?? 0)) return res.status(401).json({ error: 'Invalid or expired token' });
    req.user = { id: decoded.id, email: decoded.email };
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // Tabs of one browser share the session cookie. The signed-in app sends X-FinSphere-User (the account id it is showing); if the session
  // now belongs to a different account (changed in another tab) the request is refused BEFORE anything is read, answered, proposed or
  // written. The header is optional and is only ever compared with the verified session id; it is never used to choose an owner.
  const claimed = req.get('x-finsphere-user');
  if (claimed !== undefined && claimed !== String(req.user.id)) {
    return res.status(409).json({ code: 'account_changed', error: 'Your account changed in another tab. Nothing was done.' });
  }
  next();
}
// ───────────────────────────────────────────────────────────────────────────────

// ── Deployment configuration (environment-driven; see docs/SECURITY_DEPLOYMENT.md) ──────────────────────────────
// CORS_ORIGINS: comma-separated list of the exact frontend origins allowed to call this API with cookies.
//   Unset in development -> local Vite ports 5173 and 5174.
//   Unset in production  -> NO cross-origin browser access (same-origin and non-browser clients still work).
//   A wildcard is refused: it can never be combined with credentials.
const configuredOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
if (configuredOrigins.includes('*')) {
  console.error('FATAL: CORS_ORIGINS must list explicit origins; "*" is not allowed with credentials.');
  process.exit(1);
}
const allowedOrigins = configuredOrigins.length > 0 ? configuredOrigins : developmentOrigins(isProd);
if (isProd && allowedOrigins.length === 0) {
  console.warn('WARNING: CORS_ORIGINS is not set; browsers on other origins cannot call this API. Set it to your frontend origin.');
}

// TRUST_PROXY: how many reverse-proxy hops sit in front of this server (e.g. 1 on Render / behind one load
// balancer). Without it req.ip is the proxy's address, so every client shares one rate-limit bucket. A bare
// "true" is refused because it would let any client choose its own IP through X-Forwarded-For.
try {
  app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
} catch (err) {
  console.error('FATAL:', err.message);
  process.exit(1);
}

app.use(helmet());   // security headers; also removes X-Powered-By
// Financial responses and session failures must not survive in browser/proxy caches.
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(cors({ origin: allowedOrigins, credentials: true }));
// CORS controls response visibility, not writes. Refuse browser writes from other origins,
// including same-site sibling subdomains that SameSite cookies alone would permit.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if ((origin && !allowedOrigins.includes(origin)) || req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: 'Request origin is not allowed' });
    }
  }
  next();
});
// Largest JSON body accepted (pasted statement text, chat and plan-chat). Stated explicitly rather than relying on
// the library default; larger requests are answered 413.
const globalJson = express.json({ limit: '100kb' });
app.use((req, res, next) => (req.path === '/api/transactions/import-confirm' ? next() : globalJson(req, res, next)));   // that one route has its own, authenticated, 256 KB parser
app.use(cookieParser());
app.get('/api/health', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  try { await databaseHealthy(); res.json({ status: 'ok' }); }
  catch { res.status(503).json({ status: 'unavailable' }); }
});

// Set up multer for file uploads using memory storage for zero-footprint.
// Limit: 5 MB — generous upper bound for any real-world bank statement
// (typical PDF/Excel statements are 50–500 KB). Blocks pathological uploads
// before they consume server memory or reach the parsing logic.
const STATEMENT_EXTENSIONS = ['.csv', '.txt', '.xls', '.xlsx'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5, parts: 6 }, // 5 MB, one file, no more than a few text fields
  // Only the formats the UI offers; anything else is refused before it is buffered or parsed.
  fileFilter: (req, file, cb) => {
    const name = (file.originalname ?? '').toLowerCase();
    if (STATEMENT_EXTENSIONS.some((ext) => name.endsWith(ext))) return cb(null, true);
    const err = new Error('Unsupported file type');
    err.code = 'UNSUPPORTED_FILE_TYPE';
    cb(err);
  }
});

// Transactions live in PostgreSQL (see ./db). server_db.json is only read once, at startup,
// to import existing rows; nothing writes to it any more.
const LEGACY_TRANSACTIONS_FILE = path.join(__dirname, 'server_db.json');

// Goals live in PostgreSQL (see ./db). server_goals.json is only read once, at startup,
// to import existing rows; nothing writes to it any more.
const LEGACY_GOALS_FILE = path.join(__dirname, 'server_goals.json');

// Liabilities live in PostgreSQL (see ./db). server_liabilities.json is only read once, at startup,
// to import existing rows; nothing writes to it any more.
const LEGACY_LIABILITIES_FILE = path.join(__dirname, 'server_liabilities.json');

// ── Transaction validation & normalization ─────────────────────────────────────
// The single boundary every persisted transaction passes through: manual POST and
// all three statement-import parsers. normalizeTransactionInput() returns either
// { ok: true, value } with canonical fields or { ok: false, error } - never a
// partially normalized object. It only reads title/amount/date/type/category and
// never returns id or userId, so ownership cannot come from request data.
const MAX_TITLE_LENGTH = 120;
const MAX_ABS_AMOUNT = 100_000_000; // ₹10 crore
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

const fail = (error) => ({ ok: false, error });

// Analytical classification (Issue #59): what a transaction WAS, separate from `type` (its direction and sign).
// Which classifications each direction may carry; nothing else is coherent, and direction is never inferred from it.
// Downstream totals (income, DTI, emergency expenses, budget actuals, dashboard sums) do NOT use it yet (Issue #61).
const CLASSIFICATIONS_BY_TYPE = {
  income: ['income', 'refund', 'transfer', 'unknown'],
  expense: ['expense', 'transfer', 'unknown']
};

function isRealCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

// Shifting the decimal point through the exponent avoids binary drift of n * 100
// (1.005 -> 1.01, where Math.round(1.005 * 100) / 100 would give 1).
// Only call with 0.005 <= n <= MAX_ABS_AMOUNT so String(n) never uses exponent form.
function roundToPaise(n) {
  return Number(`${Math.round(Number(`${n}e2`))}e-2`);
}

function normalizeTransactionInput(raw, nowMs = Date.now()) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('Transaction must be an object');
  }

  // Title
  if (typeof raw.title !== 'string') return fail('Title must be a string');
  const title = raw.title.trim();
  if (title.length === 0) return fail('Title is required');
  // PostgreSQL text cannot hold a NUL character, so it is refused here instead of failing at save time.
  if (title.includes('\u0000')) return fail('Title contains an invalid character');
  if (title.length > MAX_TITLE_LENGTH) {
    return fail(`Title must be ${MAX_TITLE_LENGTH} characters or fewer`);
  }

  // Amount: only numbers and plain decimal strings. Number()/parseFloat() alone would
  // accept "123abc" (parseFloat), "" and null (Number -> 0), and "0x10"/"1e3".
  const rawAmount = typeof raw.amount === 'string' ? raw.amount.trim() : raw.amount;
  if (typeof rawAmount === 'string' && !DECIMAL_PATTERN.test(rawAmount)) {
    return fail('Amount must be a plain decimal number, e.g. 1234.56');
  }
  if (typeof rawAmount !== 'number' && typeof rawAmount !== 'string') {
    return fail('Amount must be a number');
  }
  const parsedAmount = Number(rawAmount);
  if (!Number.isFinite(parsedAmount)) return fail('Amount must be a finite number');
  const absAmount = Math.abs(parsedAmount);
  if (absAmount > MAX_ABS_AMOUNT) {
    return fail(`Amount must not exceed ${MAX_ABS_AMOUNT} (₹10 crore)`);
  }
  if (absAmount < 0.005) return fail('Amount must be non-zero (minimum 0.01)');
  const roundedAmount = roundToPaise(absAmount);

  // Type (case-insensitive, nothing else accepted)
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
  if (type !== 'income' && type !== 'expense') {
    return fail('Type must be "income" or "expense"');
  }

  // Classification: optional. Omitted/null means 'unknown' (we never assume that a credit is income or a debit an
  // expense); anything else must be one of the allowed values for this direction. Case-insensitive like `type`.
  let classification = 'unknown';
  if (raw.classification !== undefined && raw.classification !== null) {
    if (typeof raw.classification !== 'string') return fail('Classification must be a string');
    classification = raw.classification.toLowerCase();
    if (!['income', 'expense', 'refund', 'transfer', 'unknown'].includes(classification)) {
      return fail('Classification must be one of: income, expense, refund, transfer, unknown');
    }
    if (!CLASSIFICATIONS_BY_TYPE[type].includes(classification)) {
      return fail(`Classification "${classification}" is not valid for an ${type} transaction (allowed: ${CLASSIFICATIONS_BY_TYPE[type].join(', ')})`);
    }
  }

  // Date: exact YYYY-MM-DD, real calendar date, at most one day ahead. The limit is
  // UTC today + 1 day: any real local date (UTC-12 .. UTC+14) is at most one day
  // ahead of the UTC date, so users in every timezone pass. Fixed-width ISO strings
  // compare correctly as text, so no Date parsing or local-time conversion is involved.
  if (typeof raw.date !== 'string') return fail('Date must be a string in YYYY-MM-DD format');
  const dateMatch = DATE_PATTERN.exec(raw.date);
  if (!dateMatch) return fail('Date must be in YYYY-MM-DD format');
  if (!isRealCalendarDate(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]))) {
    return fail('Date is not a valid calendar date');
  }
  const latestAllowedDate = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (raw.date > latestAllowedDate) return fail('Date cannot be more than one day in the future');

  // Category: omitted/blank -> General
  let category = 'General';
  if (raw.category !== undefined && raw.category !== null) {
    if (typeof raw.category !== 'string') return fail('Category must be a string');
    category = raw.category.trim() || 'General';
    if (category.includes('\u0000')) return fail('Category contains an invalid character');
  }

  return {
    ok: true,
    value: {
      title,
      amount: type === 'income' ? roundedAmount : -roundedAmount, // sign always follows type
      date: raw.date,
      type,
      category,
      classification
    }
  };
}

// Runs importer candidates (which carry the userId stamped by the parsers) through
// the same boundary. Invalid rows are skipped, never fatal to valid ones. Row IDs
// are generated here, never taken from a parser.
function normalizeImportedRows(candidates) {
  const rows = [];
  let skipped = 0;
  for (const candidate of candidates) {
    // Importers only know direction (debit / credit), never meaning: every imported row is 'unknown', whatever the
    // candidate carries, so nothing a parser or an AI model emits can set a classification.
    const result = normalizeTransactionInput({ ...candidate, classification: 'unknown' });
    if (!result.ok) {
      skipped++;
      continue;
    }
    rows.push({ id: randomUUID(), userId: candidate.userId, ...result.value });
  }
  return { rows, skipped };
}
// ───────────────────────────────────────────────────────────────────────────────

// ── Statement parsing helpers ──────────────────────────────────────────────────
// Pure helpers for the Excel and text importers. They only turn raw statement
// content into candidate rows; every candidate still goes through
// normalizeImportedRows(), which owns all validation (dates, amounts, titles).
// Header labels are matched exactly (after normalization), in priority order, so a
// "Value Date" column never wins over a "Transaction Date" column.
const HEADER_ALIASES = {
  date: ['transaction date', 'txn date', 'date', 'value date'],
  description: ['transaction remarks', 'remarks', 'narration', 'description', 'particulars'],
  debit: ['withdrawal amount', 'withdrawal amt', 'withdrawal', 'debit amount', 'debit amt', 'debit'],
  credit: ['deposit amount', 'deposit amt', 'deposit', 'credit amount', 'credit amt', 'credit']
};

// Lower-case, drop "(INR)"-style notes and dots, collapse whitespace.
const normalizeHeaderCell = (cell) =>
  String(cell ?? '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[.:*]/g, ' ').replace(/\s+/g, ' ').trim();

// Column indexes for the header row, or null unless it names a date, a description and
// at least one of debit/credit. A serial-number column, if present, is simply not used.
function findStatementColumns(row) {
  const cells = Array.from(row, normalizeHeaderCell);
  const find = (aliases) => {
    for (const alias of aliases) {
      const index = cells.indexOf(alias);
      if (index !== -1) return index;
    }
    return -1;
  };
  const columns = {
    date: find(HEADER_ALIASES.date),
    description: find(HEADER_ALIASES.description),
    debit: find(HEADER_ALIASES.debit),
    credit: find(HEADER_ALIASES.credit)
  };
  if (columns.date === -1 || columns.description === -1) return null;
  if (columns.debit === -1 && columns.credit === -1) return null;
  return columns;
}

// The "Legends Used in Account Statement" footer block. Only a row that STARTS with the
// word counts, so a merchant called "Legend Hotel" in a narration does not end the import.
function isLegendRow(row) {
  const first = row.find((cell) => cell !== undefined && cell !== null && String(cell).trim() !== '');
  return first !== undefined && /^legends?\b/i.test(String(first).trim());
}

const formatYmd = (year, month, day) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

// Normalizes a statement date to YYYY-MM-DD, day-first. Accepts YYYY-MM-DD, DD/MM/YYYY
// (also - or . separators), an optional trailing time, and Excel serial numbers.
// It does NOT check the calendar or fall back to today: an unrecognized or impossible
// date comes back in a form the validator rejects, so that row is skipped.
function parseStatementDate(value) {
  if (typeof value === 'number') {
    const parts = Number.isFinite(value) ? XLSX.SSF.parse_date_code(Math.floor(value)) : null;
    // The window keeps stray numbers (1, 5000, 125000) from becoming plausible-looking dates.
    if (parts && parts.y >= 1990 && parts.y <= 2100) return formatYmd(parts.y, parts.m, parts.d);
    return String(value);
  }
  if (typeof value !== 'string') return '';
  const text = value.trim().replace(/[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?$/, '');
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (match) return formatYmd(match[1], match[2], match[3]);
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text); // DD/MM/YYYY, never MM/DD
  if (match) return formatYmd(match[3], match[2], match[1]);
  return text;
}

// One debit/credit cell -> blank | zero | positive (with value) | invalid.
// Negative values and text that is not a plain number are invalid, not guessed at.
function classifyAmountCell(cell) {
  if (cell === undefined || cell === null) return { kind: 'blank' };
  let n;
  if (typeof cell === 'number') {
    n = cell;
  } else {
    const text = String(cell).replace(/[\s,]/g, '').replace(/^(?:₹|rs\.?|inr)/i, '');
    if (text === '' || text === '-') return { kind: 'blank' };
    if (!DECIMAL_PATTERN.test(text)) return { kind: 'invalid' };
    n = Number(text);
  }
  if (!Number.isFinite(n) || n < 0) return { kind: 'invalid' };
  return n === 0 ? { kind: 'zero' } : { kind: 'positive', value: n };
}

// Trim separator punctuation from the ends (an explicit character list: the old
// /[\s,;-|]/ was a RANGE from ';' to '|' that also deleted every letter), and fall
// back only when nothing usable is left. It never shortens a title: the 120-character
// limit belongs to normalizeTransactionInput(), which skips an overlong row.
function finalizeStatementTitle(text) {
  const cleaned = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:|/\\-]+|[\s,;:|/\\-]+$/g, '');
  return cleaned || 'Bank Transaction';
}

// "UPI/123456789012/Swiggy/..." -> the first segment that is not just a reference number.
function titleFromRemarks(remarks) {
  const text = remarks.trim();
  if (/^upi\//i.test(text)) {
    const payee = text.split('/').slice(1).map((part) => part.trim()).find((part) => part && !/^\d+$/.test(part));
    if (payee) return payee;
  }
  return text;
}

const TEXT_DATE_PATTERN = /(?<![\w/.-])(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})(?![\w/-])/;
const AMOUNT_TOKEN = /(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?/g;
const DIRECTION_WORDS = 'CREDITED|CREDIT|DEBITED|DEBIT|CR|DR';
const MARKER_AFTER = new RegExp(`^\\s*\\.?\\s*(${DIRECTION_WORDS})\\b`, 'i');
const MARKER_BEFORE = new RegExp(`\\b(${DIRECTION_WORDS})\\.?\\s*$`, 'i');
const markerDirection = (word) => (/^(?:credit|credited|cr)$/i.test(word) ? 'income' : 'expense');
// A running balance ("15000.00 CR") that follows the amount is not part of the description.
const TRAILING_BALANCE = new RegExp(`\\s[-+]?\\d[\\d,]*\\.\\d{2}(?:\\s*(?:${DIRECTION_WORDS})\\b\\.?)?`, 'gi');

// One line of pasted/text statement -> null (not a transaction line), { ambiguous: true }
// (a date and an amount but no clear direction), or { date, amount, type, titleText }.
// Direction comes only from evidence attached to the amount itself: an explicit +/- sign,
// or a whole-word CR/DR/CREDIT/DEBIT directly before or after it. Words inside the
// narration ("Microsoft", "Credit Card Bill", "Dr. Sharma") are never evidence, and a
// number with no evidence (a balance, a reference) is passed over.
function parseTextStatementLine(line) {
  const dateMatch = TEXT_DATE_PATTERN.exec(line);
  if (!dateMatch) return null;
  const text = line.replace(new RegExp(TEXT_DATE_PATTERN, 'g'), ' ').replace(/\b(?:INR|Rs)\b\.?|₹/gi, ' ');

  let plausibleAmounts = 0;
  for (const match of text.matchAll(AMOUNT_TOKEN)) {
    const token = match[0];
    // Longer than any storable amount: phone, account and reference numbers.
    if (token.replace(/^[-+]/, '').split('.')[0].replace(/,/g, '').length > 9) continue;
    plausibleAmounts++;

    const start = match.index;
    const end = start + token.length;
    const sign = token[0] === '-' ? 'expense' : token[0] === '+' ? 'income' : null;
    const before = MARKER_BEFORE.exec(text.slice(0, start));
    const after = MARKER_AFTER.exec(text.slice(end));
    const directions = new Set(
      [sign, before && markerDirection(before[1]), after && markerDirection(after[1])].filter(Boolean)
    );
    if (directions.size === 0) continue;
    if (directions.size > 1) return { ambiguous: true }; // e.g. "-450.00 CR"

    const afterText = text.slice(after ? end + after[0].length : end).replace(TRAILING_BALANCE, ' ');
    return {
      date: parseStatementDate(dateMatch[0]),
      amount: Math.abs(Number(token.replace(/,/g, ''))),
      type: [...directions][0],
      titleText: `${text.slice(0, before ? before.index : start)} ${afterText}`
    };
  }
  return plausibleAmounts > 0 ? { ambiguous: true } : null;
}
// ───────────────────────────────────────────────────────────────────────────────

// ── Goal validation & normalization ────────────────────────────────────────────
// Server-side authority for POST /api/goals; the frontend checks are only a convenience.
// Returns { ok: true, value } or { ok: false, error }. It never reads or returns id,
// userId or createdAt: the route stamps those, so ownership cannot come from the body.

// A JSON number, or a plain decimal string, as a finite Number; anything else is null.
// (Number()/parseFloat() alone would accept "", null, "0x10", "1e3" and "12abc".)
function toAmount(raw) {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof value === 'string') {
    if (!DECIMAL_PATTERN.test(value)) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Goals and liabilities have no upper cap, so unlike roundToPaise() this must also cope with
// huge values (String(n) uses exponent form from 1e21, which that helper cannot handle).
// From 1e13 up a double cannot hold paise anyway, so the value is already as precise as it gets.
const roundUncappedAmount = (n) => (n >= 1e13 ? n : roundToPaise(n));

function normalizeGoalInput(raw, nowMs = Date.now()) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('Goal must be an object');
  }

  // Title
  if (typeof raw.title !== 'string') return fail('Title must be a string');
  const title = raw.title.trim();
  if (title.length === 0) return fail('Title is required');
  if (title.length > MAX_TITLE_LENGTH) {
    return fail(`Title must be ${MAX_TITLE_LENGTH} characters or fewer`);
  }
  if (title.includes('\u0000')) return fail('Title contains an invalid character');   // PostgreSQL text cannot hold NUL

  // Target amount: finite and > 0 (no upper cap), rounded to paise
  const target = toAmount(raw.targetAmount);
  if (target === null) return fail('Target amount must be a number');
  if (target < 0.005) return fail('Target amount must be greater than 0 (minimum 0.01)');
  const targetAmount = roundUncappedAmount(target);

  // Current amount: omitted means 0; otherwise 0 <= current <= target
  const current = raw.currentAmount === undefined ? 0 : toAmount(raw.currentAmount);
  if (current === null) return fail('Current amount must be a number');
  if (current < 0) return fail('Current amount cannot be negative');
  const currentAmount = current < 0.005 ? 0 : roundUncappedAmount(current);
  if (currentAmount > targetAmount) return fail('Current amount cannot exceed the target amount');

  // Target date: exact YYYY-MM-DD, a real calendar date, not in the past. "Past" is judged
  // against the server's UTC calendar date, so the result is deterministic. Fixed-width ISO
  // strings compare correctly as text, so no Date parsing or local-time conversion is involved.
  if (typeof raw.targetDate !== 'string') return fail('Target date must be a string in YYYY-MM-DD format');
  const dateMatch = DATE_PATTERN.exec(raw.targetDate);
  if (!dateMatch) return fail('Target date must be in YYYY-MM-DD format');
  if (!isRealCalendarDate(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]))) {
    return fail('Target date is not a valid calendar date');
  }
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (raw.targetDate < today) return fail('Target date cannot be in the past');

  return { ok: true, value: { title, targetAmount, currentAmount, targetDate: raw.targetDate } };
}

// ── Goal contribution validation ───────────────────────────────────────────────
// A contribution is a positive amount (finite, > 0, no upper cap), rounded to paise. Only "amount" is read: the
// client can never submit a new balance, an id, an owner or a timestamp through this endpoint.
function normalizeContributionInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('Contribution must be an object');
  }
  const amount = toAmount(raw.amount);
  if (amount === null) return fail('Amount must be a number');
  if (amount < 0.005) return fail('Amount must be greater than 0 (minimum 0.01)');
  return { ok: true, value: { amount: roundUncappedAmount(amount) } };
}

// ── Liability repayment validation ─────────────────────────────────────────────
// A repayment is a positive amount (finite, > 0, no upper cap), rounded to paise. Only "amount" is read: the client
// can never submit a balance, an id, an owner or a timestamp through this endpoint.
function normalizeRepaymentInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('Repayment must be an object');
  }
  const amount = toAmount(raw.amount);
  if (amount === null) return fail('Amount must be a number');
  if (amount < 0.005) return fail('Amount must be greater than 0 (minimum 0.01)');
  return { ok: true, value: { amount: roundUncappedAmount(amount) } };
}

// ── Liability validation & normalization ───────────────────────────────────────
// Server-side authority for POST /api/liabilities. Returns { ok: true, value } or
// { ok: false, error }; it never reads or returns id, userId or createdAt (the route stamps
// those), so ownership cannot come from the request body. Every field is required: a
// missing interest rate or payment is rejected rather than defaulted to a made-up 0.
const LIABILITY_TYPES = ['home_loan', 'personal_loan', 'vehicle_loan', 'education_loan', 'credit_card', 'other'];

function normalizeLiabilityInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('Liability must be an object');
  }

  if (typeof raw.name !== 'string') return fail('Name must be a string');
  const name = raw.name.trim();
  if (name.length === 0) return fail('Name is required');
  if (name.includes('\u0000')) return fail('Name contains an invalid character');   // PostgreSQL text cannot hold NUL
  if (name.length > MAX_TITLE_LENGTH) return fail(`Name must be ${MAX_TITLE_LENGTH} characters or fewer`);

  if (typeof raw.type !== 'string' || !LIABILITY_TYPES.includes(raw.type)) {
    return fail(`Type must be one of: ${LIABILITY_TYPES.join(', ')}`);
  }

  // Outstanding amount: finite and > 0, no upper cap (unlike transactions), rounded to paise
  const outstanding = toAmount(raw.outstandingAmount);
  if (outstanding === null) return fail('Outstanding amount must be a number');
  if (outstanding < 0.005) return fail('Outstanding amount must be greater than 0 (minimum 0.01)');
  const outstandingAmount = roundUncappedAmount(outstanding);

  // Interest rate: percent per year, 0..100, stored as given
  const interestRate = toAmount(raw.interestRate);
  if (interestRate === null) return fail('Interest rate must be a number');
  if (interestRate < 0) return fail('Interest rate cannot be negative');
  if (interestRate > 100) return fail('Interest rate cannot exceed 100');

  // Monthly payment: finite and >= 0 (0 is a real value, e.g. no fixed payment)
  const payment = toAmount(raw.monthlyPayment);
  if (payment === null) return fail('Monthly payment must be a number');
  if (payment < 0) return fail('Monthly payment cannot be negative');
  const monthlyPayment = payment < 0.005 ? 0 : roundUncappedAmount(payment);

  return { ok: true, value: { name, type: raw.type, outstandingAmount, interestRate, monthlyPayment } };
}
// ───────────────────────────────────────────────────────────────────────────────

// Helper: check if Groq API key is configured
function isGroqConfigured() {
  return process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here';
}

// ── Auth Rate Limiter ──────────────────────────────────────────────────────────
// Applies to POST /api/auth/register and POST /api/auth/login only.
// 15 requests per 15 minutes per IP — generous enough for genuine users who
// mistype their password. Helps reduce brute-force and registration-spam
// attempts. Uses in-memory store (resets on restart); a
// production deployment should use a Redis-backed store instead.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,
  standardHeaders: true,  // Return RateLimit-* headers (RFC 6585 draft)
  legacyHeaders: false,   // Disable deprecated X-RateLimit-* headers
  message: { error: 'Too many attempts. Please try again in 15 minutes.' }
});

// Per-user limits for the endpoints that are expensive (an LLM call, a file parse, the ML service). They run after
// authenticate, so the bucket is the signed-in user, not an IP address; ordinary reads are not limited.
const perUserLimiter = (max, what) => rateLimit({
  windowMs: 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: { error: `Too many ${what} requests. Please wait a minute and try again.` }
});
const chatLimiter = perUserLimiter(30, 'assistant');
// Statement uploads: 10 per minute per user. FINSPHERE_TEST_UPLOAD_LIMIT exists ONLY so automated parser tests,
// which upload dozens of fixtures in seconds, can run below the limit. It is read from the process environment at
// startup (never from a request) and is ignored whenever NODE_ENV is "production".
const DEFAULT_UPLOAD_LIMIT = 10;
let uploadLimit = DEFAULT_UPLOAD_LIMIT;
if (process.env.FINSPHERE_TEST_UPLOAD_LIMIT) {
  if (isProd) {
    console.warn('WARNING: FINSPHERE_TEST_UPLOAD_LIMIT is ignored in production.');
  } else if (/^[1-9]\d{0,6}$/.test(process.env.FINSPHERE_TEST_UPLOAD_LIMIT)) {
    uploadLimit = Number(process.env.FINSPHERE_TEST_UPLOAD_LIMIT);
    console.warn(`WARNING: statement upload rate limit raised to ${uploadLimit}/min by FINSPHERE_TEST_UPLOAD_LIMIT (test use only).`);
  }
}
const parseLimiter = perUserLimiter(uploadLimit, 'statement upload');
const mlLimiter = perUserLimiter(10, 'analysis');
// Image OCR is CPU-heavy (a WASM engine): 5 per minute per user, on top of the service's own concurrency cap.
const ocrLimiter = perUserLimiter(5, 'image text recognition');
const actionLimiter = perUserLimiter(30, 'assistant action');
// ───────────────────────────────────────────────────────────────────────────────

// --- AUTHENTICATION ---
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many password recovery attempts. Please try again in 15 minutes.' } });
// Delivery: Resend by default. PASSWORD_RESET_DELIVERY=local is an explicit, development-only opt-in that captures the email in
// memory instead (refused when NODE_ENV=production; never a fallback for missing Resend settings).
const resetDelivery = createResetDelivery(process.env);
const resetHandlers = createPasswordResetHandlers({
  issueToken: issuePasswordReset, consumeToken: consumePasswordReset,
  hashPassword: (password) => bcrypt.hash(password, 10), sendEmail: resetDelivery.sendEmail,
  reportFailure: () => console.error('Password recovery operation failed')
});
app.post('/api/auth/forgot-password', resetLimiter, resetHandlers.forgot);
app.post('/api/auth/reset-password', authLimiter, resetHandlers.reset);
if (resetDelivery.capture) {
  const devMail = createDevMailHandlers({ capture: resetDelivery.capture, env: process.env });
  app.get('/api/dev/password-reset-mail', devMail.list);
  app.delete('/api/dev/password-reset-mail', devMail.clear);
  console.warn('WARNING: password reset emails are CAPTURED LOCALLY, not sent (PASSWORD_RESET_DELIVERY=local, development only).');
}
// Users live in PostgreSQL (see ./db). The previous flat file is only read once, at startup,
// to import existing accounts; nothing writes to it any more.
const LEGACY_USERS_FILE = path.join(__dirname, 'server_users.json');
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  // 1. Presence check (must come first, guards against null/undefined below)
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  // 2. Type check — reject non-string values that passed the truthiness check above
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password must be strings' });
  }
  // 3. Email format check (on the normalized address, which is also what gets stored)
  const normalizedEmail = normalizeEmail(email);
  if (!EMAIL_PATTERN.test(normalizedEmail) || normalizedEmail.length > MAX_EMAIL_LENGTH) {
    return res.status(400).json({ error: 'Invalid email format' });
  }
  // 4. Password minimum length
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    // 5. The UNIQUE constraint is the duplicate check, so concurrent registrations cannot both succeed.
    await createUser(normalizedEmail, hashedPassword);
    res.json({ message: 'User registered successfully' });
  } catch (err) {
    if (err instanceof DuplicateEmailError) return res.status(400).json({ error: 'User already exists' });
    console.error('Registration failed:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  // 1. Presence check (must come first, guards against null/undefined below)
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  // 2. Type check — reject non-string values that passed the truthiness check above
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password must be strings' });
  }
  try {
    const user = await findUserByEmail(normalizeEmail(email));
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, email: user.email, sessionVersion: user.sessionVersion }, JWT_SECRET, { algorithm: JWT_ALGORITHM, expiresIn: '1h' });
    res.cookie('token', token, { httpOnly: true, secure: isProd, sameSite: isProd ? 'strict' : 'lax', maxAge: 60 * 60 * 1000 });
    res.json({ message: 'Logged in successfully', user: await readProfile(user.id) });
  } catch (err) {
    console.error('Login failed:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, secure: isProd, sameSite: isProd ? 'strict' : 'lax' });
  res.json({ message: 'Logged out successfully' });
});

app.get('/api/auth/verify', async (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET, JWT_VERIFY_OPTIONS);
    if (!await isCurrentSession(decoded.id, decoded.sessionVersion ?? 0)) return res.status(401).json({ error: 'Invalid token' });
    const user = await readProfile(decoded.id);
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    res.json({ user });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});
// ----------------------

// A database failure is logged without query text or row values and answered generically.
function respondDbError(res, err, message) {
  console.error(`${message}:`, err.code ?? err.message);
  return res.status(500).json({ error: message });
}

app.use('/api/holdings', holdingsRouter(authenticate, perUserLimiter(120, 'investment holdings')));

// Optional profile: no legal name, PAN, phone, or financial details collected. Only these two fields can be changed here; the
// sign-in email is deliberately NOT editable through this endpoint (there is no verified email-change flow).
const PROFILE_FIELDS = ['displayName', 'reduceMotion', 'onboardingState'];
const ONBOARDING_STATES = ['pending', 'skipped', 'completed'];
app.patch('/api/auth/profile', authenticate, async (req, res) => {
  const body = req.body;
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  const valid = keys.length > 0 && keys.every((key) => PROFILE_FIELDS.includes(key)) &&
    (!('displayName' in body) || (typeof body.displayName === 'string' && body.displayName.length <= 80 && !/[\p{Cc}\p{Cf}]/u.test(body.displayName))) &&
    (!('reduceMotion' in body) || typeof body.reduceMotion === 'boolean') &&
    (!('onboardingState' in body) || ONBOARDING_STATES.includes(body.onboardingState));
  if (!valid) {
    return res.status(400).json({ error: 'Send a display name of at most 80 characters without control characters, the reduce-motion preference, and/or a setup-guide state (pending, skipped or completed).' });
  }
  try {
    const user = await updateProfile(req.user.id, {
      displayName: 'displayName' in body ? body.displayName.trim() : undefined,
      reduceMotion: 'reduceMotion' in body ? body.reduceMotion : undefined,
      onboardingState: 'onboardingState' in body ? body.onboardingState : undefined
    });
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ user });
  } catch (err) { respondDbError(res, err, 'Could not save profile'); }
});

// Profile photo. The owner is always the session user (there is no id in any of these URLs), so one account can never read, replace
// or delete another account's photo. The image is validated by its real bytes and re-written without metadata (profileImage.js);
// its bytes and the user's profile are never logged. Rate limited like other expensive per-user work.
const avatarLimiter = perUserLimiter(10, 'profile photo');
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AVATAR_LIMITS.maxUploadBytes, files: 1, fields: 0, parts: 2 } });
app.put('/api/auth/avatar', authenticate, avatarLimiter, (req, res, next) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Photo is too large (maximum ${AVATAR_LIMITS.maxUploadBytes / 1024} KB).` });
    return res.status(400).json({ error: 'Choose one photo.' });
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a photo.' });
  let image;
  try {
    image = sanitizeProfileImage(req.file.buffer);
  } catch (err) {
    if (err instanceof ProfileImageError) return res.status(err.status).json({ error: err.message });
    console.error('Profile photo check failed unexpectedly');
    return res.status(500).json({ error: 'Could not check this photo.' });
  } finally {
    req.file.buffer = null;
  }
  try {
    await saveAvatar(req.user.id, image);
    const user = await readProfile(req.user.id);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ user });
  } catch (err) { respondDbError(res, err, 'Could not save photo'); }
});
app.get('/api/auth/avatar', authenticate, async (req, res) => {
  try {
    const avatar = await readAvatar(req.user.id);
    if (!avatar) return res.status(404).json({ error: 'No photo' });
    res.set({ 'Content-Type': avatar.contentType, 'Content-Length': String(avatar.data.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
    res.end(avatar.data);
  } catch (err) { respondDbError(res, err, 'Could not load photo'); }
});
app.delete('/api/auth/avatar', authenticate, async (req, res) => {
  try {
    await deleteAvatar(req.user.id);
    const user = await readProfile(req.user.id);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ user });
  } catch (err) { respondDbError(res, err, 'Could not remove photo'); }
});

// 1. GET /api/transactions
app.get('/api/transactions', authenticate, async (req, res) => {
  // Only the authenticated user's transactions (the owner is part of the query).
  try {
    res.json(await listTransactionsByUser(req.user.id));
  } catch (err) {
    respondDbError(res, err, 'Could not load transactions');
  }
});

// ── Shared write executors (Issue #73) ────────────────────────────────────────────────────────────────────────────
// The manual routes and a confirmed assistant action run exactly this code, so validation, ownership and the locked
// database checks can never differ between "typed into a form" and "said to the assistant". They return
// { ok: true, ... } or { ok: false, status, error }; database failures are thrown for the caller to report.
async function createTransactionFor(userId, input) {
  // Validate before touching the database.
  const result = normalizeTransactionInput(input);
  if (!result.ok) return { ok: false, status: 400, error: result.error };
  const transaction = {
    id: randomUUID(),
    userId, // ownership stamp: always the verified session user, never from the input
    ...result.value
  };
  await createTransaction(transaction);
  return { ok: true, transaction };
}

async function addGoalContributionFor(userId, goalId, body) {
  const result = normalizeContributionInput(body);
  if (!result.ok) return { ok: false, status: 400, error: result.error };
  const outcome = await addGoalContribution({
    userId, // ownership: always the verified session user
    goalId,
    amount: result.value.amount,
    contributionId: randomUUID(),
    now: new Date().toISOString()
  });
  // 404 for both missing and not-yours, exactly like DELETE /api/goals/:id.
  if (outcome.status === 'not_found') return { ok: false, status: 404, error: 'Goal not found' };
  if (outcome.status === 'complete') return { ok: false, status: 400, error: 'This goal is already complete' };
  if (outcome.status === 'exceeds') {
    return { ok: false, status: 400, error: `Contribution would exceed the goal target (${formatRupees(outcome.remaining)} remaining)` };
  }
  return { ok: true, goal: outcome.goal, contribution: outcome.contribution };
}

// The ONE way a liability is created: the manual route and a confirmed assistant action both call this. It validates
// with normalizeLiabilityInput (every field required, nothing defaulted), stamps the owner from the caller's verified id
// and inserts under `id` at most once (a repeat with the same id returns the existing row instead of a second one).
async function createLiabilityFor(userId, body, { id = randomUUID() } = {}) {
  const result = normalizeLiabilityInput(body);
  if (!result.ok) return { ok: false, status: 400, error: result.error };
  const stored = await insertLiabilityIdempotent({
    id,
    userId, // ownership: always the verified session user, never from the body
    ...result.value,
    createdAt: new Date().toISOString()
  });
  return { ok: true, liability: stored.liability, created: stored.created };
}

async function repayLiabilityFor(userId, liabilityId, body) {
  const result = normalizeRepaymentInput(body);
  if (!result.ok) return { ok: false, status: 400, error: result.error };
  const outcome = await repayLiability({
    userId, // ownership: always the verified session user
    liabilityId,
    amount: result.value.amount,
    repaymentId: randomUUID(),
    now: new Date().toISOString()
  });
  // 404 for both missing and not-yours, exactly like DELETE /api/liabilities/:id.
  if (outcome.status === 'not_found') return { ok: false, status: 404, error: 'Liability not found' };
  if (outcome.status === 'paid_off') return { ok: false, status: 400, error: 'This liability is already paid off' };
  if (outcome.status === 'exceeds') {
    return { ok: false, status: 400, error: `Repayment would exceed the outstanding balance (${formatRupees(outcome.outstanding)} outstanding)` };
  }
  return { ok: true, liability: outcome.liability, repayment: outcome.repayment };
}

// Create-or-update the budget for (month, category). Without `expect` this is the manual PUT's plain upsert (an
// existing row is silently overwritten, as it always was). With `expect` - only passed by a confirmed assistant
// action - it is a compare-and-set against what the user was shown: see setBudgetExpecting in db/index.js.
const BUDGET_CHANGED_MESSAGE = 'That budget changed after I showed you the preview, so I did not save anything. Please ask again.';
async function setBudgetFor(userId, body, { expect } = {}) {
  const result = normalizeBudgetInput(body);
  if (!result.ok) return { ok: false, status: 400, error: result.error };
  if (!expect) {
    const { budget, created } = await upsertBudget({
      id: randomUUID(), // used only if the row is new; an existing row keeps its id
      userId, // ownership: always the verified session user
      ...result.value,
      now: new Date().toISOString()
    });
    return { ok: true, budget, created };
  }
  const outcome = await setBudgetExpecting({
    id: randomUUID(),
    userId,
    ...result.value,
    now: new Date().toISOString(),
    expect
  });
  if (outcome.status === 'conflict') return { ok: false, status: 409, error: BUDGET_CHANGED_MESSAGE };
  return { ok: true, budget: outcome.budget, created: outcome.created };
}

// 2. POST /api/transactions (Manual Entry)
app.post('/api/transactions', authenticate, async (req, res) => {
  let outcome;
  try {
    outcome = await createTransactionFor(req.user.id, req.body);
  } catch (err) {
    return respondDbError(res, err, 'Could not save transaction');
  }
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
  res.status(201).json(outcome.transaction);
});

// 3. DELETE /api/transactions/:id
app.delete('/api/transactions/:id', authenticate, async (req, res) => {
  // The route param is an opaque identifier. New rows have UUID string IDs; historical
  // rows have numeric IDs, stored as text, so the comparison is always on strings (no
  // parseInt, which would read "123abc" as 123). The ownership test is part of the query,
  // so another user's row with the same ID can never match, and exactly one owned row is
  // removed even if legacy data repeats an ID.
  let removed;
  try {
    removed = await deleteTransactionByUserAndId(req.user.id, req.params.id);
  } catch (err) {
    return respondDbError(res, err, 'Could not delete transaction');
  }

  // Return 404 for both non-existent and non-owned transactions.
  // This avoids revealing the existence of another user's record.
  if (!removed) {
    return res.status(404).json({ error: 'Transaction not found' });
  }
  res.json({ message: 'Transaction deleted successfully' });
});

// 3b. PATCH /api/transactions/:id - the user's correction of ONE transaction's category (nothing else can be changed here).
// Only { category } is accepted: a title, amount, date, type, classification, id or owner in the body is refused (400), so a correction can
// never rewrite money or the analytical classification. The target is the signed-in user's own row (same targeting as DELETE); another
// user's id answers 404 exactly like a missing one.
const MAX_CATEGORY_LENGTH = 60;
const categoryEditLimiter = perUserLimiter(120, 'transaction edit');
app.patch('/api/transactions/:id', authenticate, categoryEditLimiter, async (req, res) => {
  const body = req.body;
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  const category = keys.length === 1 && keys[0] === 'category' && typeof body.category === 'string' ? body.category.trim() : '';
  if (category.length === 0 || category.length > MAX_CATEGORY_LENGTH || /[\p{Cc}\p{Cf}]/u.test(category)) {
    return res.status(400).json({ error: `Send only a category of 1 to ${MAX_CATEGORY_LENGTH} characters without control characters.` });
  }
  let updated;
  try {
    updated = await updateTransactionCategory(req.user.id, req.params.id, category);
  } catch (err) {
    return respondDbError(res, err, 'Could not change the category');
  }
  if (!updated) return res.status(404).json({ error: 'Transaction not found' });
  res.json(updated);
});

// Activity editor: complete validated fields; ownership and identity never come from the body.
app.put('/api/transactions/:id', authenticate, categoryEditLimiter, async (req, res) => {
  const fields = ['title', 'amount', 'date', 'type', 'category', 'classification'];
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== fields.length || !fields.every(k => Object.hasOwn(body, k))) return res.status(400).json({ error: 'Send title, amount, date, type, category and classification only.' });
  const checked = normalizeTransactionInput(body);
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  if (checked.value.category.length > MAX_CATEGORY_LENGTH || /[\p{Cc}\p{Cf}]/u.test(checked.value.category)) return res.status(400).json({ error: 'Category must be at most 60 characters without control characters.' });
  try {
    const updated = await updateTransactionByUserAndId(req.user.id, req.params.id, checked.value);
    if (!updated) return res.status(404).json({ error: 'Transaction not found' });
    res.json(updated);
  } catch (err) { return respondDbError(res, err, 'Could not save the transaction'); }
});

// ── Goals ──────────────────────────────────────────────────────────────────────
// GET /api/goals - only the authenticated user's goals
app.get('/api/goals', authenticate, async (req, res) => {
  try {
    res.json(await listGoalsByUser(req.user.id));
  } catch (err) {
    respondDbError(res, err, 'Could not load goals');
  }
});

// POST /api/goals - validate first; nothing is written on a 400
app.post('/api/goals', authenticate, async (req, res) => {
  const result = normalizeGoalInput(req.body);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  const goal = {
    id: randomUUID(),
    userId: req.user.id, // ownership stamp: always from the verified JWT, never from req.body
    ...result.value,
    createdAt: new Date().toISOString()
  };

  try {
    await createGoal(goal);
  } catch (err) {
    return respondDbError(res, err, 'Could not save goal');
  }
  res.status(201).json(goal);
});

// DELETE /api/goals/:id - exactly one goal, and only one owned by the caller
app.delete('/api/goals/:id', authenticate, async (req, res) => {
  let removed;
  try {
    removed = await deleteGoalByUserAndId(req.user.id, req.params.id);
  } catch (err) {
    return respondDbError(res, err, 'Could not delete goal');
  }

  // 404 for both missing and not-yours, so another user's goal is never revealed.
  if (!removed) {
    return res.status(404).json({ error: 'Goal not found' });
  }
  res.json({ message: 'Goal deleted successfully' });
});

// POST /api/goals/:id/contributions - add a real contribution to one of the caller's goals
app.post('/api/goals/:id/contributions', authenticate, async (req, res) => {
  let outcome;
  try {
    outcome = await addGoalContributionFor(req.user.id, req.params.id, req.body);   // owner: always from the verified JWT
  } catch (err) {
    return respondDbError(res, err, 'Could not save contribution');
  }
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
  res.status(201).json({ goal: outcome.goal, contribution: outcome.contribution });
});

// GET /api/goals/:id/contributions - the caller's contribution history for one goal, newest first
app.get('/api/goals/:id/contributions', authenticate, async (req, res) => {
  try {
    const contributions = await listGoalContributions(req.user.id, req.params.id);
    if (contributions === null) return res.status(404).json({ error: 'Goal not found' });
    res.json(contributions);
  } catch (err) {
    respondDbError(res, err, 'Could not load contributions');
  }
});

// ── Liabilities ────────────────────────────────────────────────────────────────
// GET /api/liabilities - only the authenticated user's liabilities
app.get('/api/liabilities', authenticate, async (req, res) => {
  try {
    res.json(await listLiabilitiesByUser(req.user.id));
  } catch (err) {
    respondDbError(res, err, 'Could not load liabilities');
  }
});

// POST /api/liabilities - validate first; nothing is written on a 400
app.post('/api/liabilities', authenticate, async (req, res) => {
  let out;
  try {
    out = await createLiabilityFor(req.user.id, req.body);   // owner: always from the verified JWT; a fresh id per request
  } catch (err) {
    return respondDbError(res, err, 'Could not save liability');
  }
  if (!out.ok) {
    return res.status(out.status).json({ error: out.error });
  }
  res.status(201).json(out.liability);
});

// DELETE /api/liabilities/:id - exactly one liability, and only one owned by the caller
app.delete('/api/liabilities/:id', authenticate, async (req, res) => {
  let removed;
  try {
    removed = await deleteLiabilityByUserAndId(req.user.id, req.params.id);
  } catch (err) {
    return respondDbError(res, err, 'Could not delete liability');
  }

  // 404 for both missing and not-yours, so another user's liability is never revealed.
  if (!removed) {
    return res.status(404).json({ error: 'Liability not found' });
  }
  res.json({ message: 'Liability deleted successfully' });
});

// ── Budgets ────────────────────────────────────────────────────────────────────
// Server-side authority for /api/budgets. The month is exactly 'YYYY-MM' (checked as text; no Date parsing, so no
// time zone can shift it). The category is trimmed text of 1-60 characters without NUL; its canonical key
// (lower-case of the trimmed text) is derived by the database, which also enforces one budget per user / month / key.
const MONTH_PATTERN = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/;
const MAX_BUDGET_CATEGORY_LENGTH = 60;

function validMonth(month) {
  return typeof month === 'string' && MONTH_PATTERN.test(month);
}

function normalizeBudgetInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('Budget must be an object');
  }
  if (!validMonth(raw.month)) return fail('Month must be in YYYY-MM format');
  if (typeof raw.category !== 'string') return fail('Category must be a string');
  const category = raw.category.trim();
  if (category.length === 0) return fail('Category is required');
  if (category.includes('\u0000')) return fail('Category contains an invalid character');
  if (category.length > MAX_BUDGET_CATEGORY_LENGTH) return fail(`Category must be ${MAX_BUDGET_CATEGORY_LENGTH} characters or fewer`);
  const amount = toAmount(raw.amount);
  if (amount === null) return fail('Amount must be a number');
  if (amount < 0.005) return fail('Amount must be greater than 0 (minimum 0.01)');
  return { ok: true, value: { month: raw.month, label: category, amount: roundUncappedAmount(amount) } };
}

// GET /api/budgets?month=YYYY-MM - the caller's budgets for one month, each with actualSpent, remaining,
// percentUsed and status computed from the caller's real expense transactions of that month
app.get('/api/budgets', authenticate, async (req, res) => {
  if (!validMonth(req.query.month)) {
    return res.status(400).json({ error: 'Month must be in YYYY-MM format' });
  }
  try {
    res.json(await listBudgetsByUserAndMonth(req.user.id, req.query.month));
  } catch (err) {
    respondDbError(res, err, 'Could not load budgets');
  }
});

// PUT /api/budgets - create or update the budget for (month, category); nothing is written on a 400
app.put('/api/budgets', authenticate, async (req, res) => {
  let outcome;
  try {
    outcome = await setBudgetFor(req.user.id, req.body);   // owner: always from the verified JWT; plain upsert
  } catch (err) {
    return respondDbError(res, err, 'Could not save budget');
  }
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
  res.status(outcome.created ? 201 : 200).json(outcome.budget);
});

// DELETE /api/budgets/:id - exactly one budget, and only one owned by the caller
app.delete('/api/budgets/:id', authenticate, async (req, res) => {
  let removed;
  try {
    removed = await deleteBudgetByUserAndId(req.user.id, req.params.id);
  } catch (err) {
    return respondDbError(res, err, 'Could not delete budget');
  }
  // 404 for both missing and not-yours, so another user's budget is never revealed.
  if (!removed) {
    return res.status(404).json({ error: 'Budget not found' });
  }
  res.json({ message: 'Budget deleted successfully' });
});

// ── Emergency fund ─────────────────────────────────────────────────────────────
// Server-side authority for PUT /api/emergency-fund. currentAmount is required: finite and >= 0 (0 is a real,
// configured value). targetAmount is optional (omitted or null = no target); when given it is finite and > 0. Neither has an
// upper cap, and current may exceed target. Never reads userId or timestamps from the body.
function normalizeEmergencyFundInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('Emergency fund must be an object');
  }
  const current = toAmount(raw.currentAmount);
  if (current === null) return fail('Current amount must be a number');
  if (current < 0) return fail('Current amount cannot be negative');
  const currentAmount = current < 0.005 ? 0 : roundUncappedAmount(current);

  let targetAmount = null;
  if (raw.targetAmount !== undefined && raw.targetAmount !== null) {
    const target = toAmount(raw.targetAmount);
    if (target === null) return fail('Target amount must be a number');
    if (target < 0.005) return fail('Target amount must be greater than 0 (minimum 0.01)');
    targetAmount = roundUncappedAmount(target);
  }
  return { ok: true, value: { currentAmount, targetAmount } };
}

// Stable API shape. "configured" tells a saved fund of 0 apart from no fund at all.
const emergencyFundResponse = (record) => record
  ? { configured: true, ...record }
  : { configured: false, currentAmount: null, targetAmount: null, createdAt: null, updatedAt: null };

// GET /api/emergency-fund - only the authenticated user's record
app.get('/api/emergency-fund', authenticate, async (req, res) => {
  try {
    res.json(emergencyFundResponse(await getEmergencyFundByUser(req.user.id)));
  } catch (err) {
    respondDbError(res, err, 'Could not load emergency fund');
  }
});

// PUT /api/emergency-fund - create or replace the caller's record; nothing is written on a 400
app.put('/api/emergency-fund', authenticate, async (req, res) => {
  const result = normalizeEmergencyFundInput(req.body);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  try {
    const saved = await upsertEmergencyFund({
      userId: req.user.id, // ownership: always from the verified JWT, never from req.body
      ...result.value,
      now: new Date().toISOString()
    });
    res.json(emergencyFundResponse(saved));
  } catch (err) {
    respondDbError(res, err, 'Could not save emergency fund');
  }
});

// POST /api/liabilities/:id/repayments - record a real repayment toward one of the caller's liabilities
app.post('/api/liabilities/:id/repayments', authenticate, async (req, res) => {
  let outcome;
  try {
    outcome = await repayLiabilityFor(req.user.id, req.params.id, req.body);   // owner: always from the verified JWT
  } catch (err) {
    return respondDbError(res, err, 'Could not save repayment');
  }
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
  res.status(201).json({ liability: outcome.liability, repayment: outcome.repayment });
});

// GET /api/liabilities/:id/repayments - the caller's repayment history for one liability, newest first
app.get('/api/liabilities/:id/repayments', authenticate, async (req, res) => {
  try {
    const repayments = await listLiabilityRepayments(req.user.id, req.params.id);
    if (repayments === null) return res.status(404).json({ error: 'Liability not found' });
    res.json(repayments);
  } catch (err) {
    respondDbError(res, err, 'Could not load repayments');
  }
});

// ── Duplicate-aware statement import (the default) ──────────────────────────────────────────────────────────────────────────
// Every statement import (text, CSV, TXT, XLS, XLSX, OCR-derived text) is protected unless the caller says ?duplicates=allow. The rows
// are checked, inside one locked transaction, against the SAME user's saved transactions: with no match they are saved as usual; with
// any likely or possible match NOTHING is saved and a preview comes back (409), to be confirmed through
// /api/transactions/import-confirm. ?duplicates=allow is the explicit, intentional legacy behaviour (no check, no row cap). If the
// bounded lookup cannot be complete the import fails closed (422) instead of being treated as duplicate-free.
const IMPORT_CONFIRM_PATH = '/api/transactions/import-confirm';
// A duplicate check that could not be completed is not "no duplicates": nothing is saved and the caller is told why.
function respondImportError(res, err, message) {
  if (err instanceof ImportMatchLimitError) {
    return res.status(422).json({ success: false, code: 'MATCH_LIMIT_EXCEEDED', error: 'Too many of your saved transactions share the dates and amounts in this import for the duplicate check to be complete. Nothing was imported. Import fewer rows at a time.' });
  }
  if (err?.code === '55P03') {   // lock_timeout: another import for this user held the lock for too long
    res.set('Retry-After', '5');
    return res.status(503).json({ success: false, code: 'IMPORT_BUSY', error: 'Another import for your account is still running. Nothing was imported. Please try again in a moment.' });
  }
  return respondDbError(res, err, message);
}
async function respondWithImport(req, res, rows, { skipped, notice } = {}) {
  const extra = notice ? { notice } : {};
  if (req.query.duplicates === 'allow') {   // explicit legacy behaviour: no duplicate check
    try {
      await createTransactionsBatch(rows); // one statement: all accepted rows or none
    } catch (dbErr) {
      return respondDbError(res, dbErr, 'Could not save transactions');
    }
    return res.json({ success: true, count: rows.length, skipped, transactions: rows, ...extra });
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return res.status(413).json({ error: `This statement has ${rows.length} rows; at most ${MAX_IMPORT_ROWS} can be imported at once. Split it into smaller parts.` });
  }
  let outcome;
  try {
    outcome = await importTransactionsLocked(req.user.id, rows, (existing) => {
      const results = findDuplicates(rows, existing);
      if (results.every((r) => !r.tier)) return { insert: rows, result: { conflict: false } };
      const digest = reviewDigest(JWT_SECRET, req.user.id, rows, results, existing);
      return { insert: [], result: { conflict: true, preview: buildPreview(rows, results, { skipped, digest }) } };
    });
  } catch (dbErr) {
    return respondImportError(res, dbErr, 'Could not save transactions');
  }
  if (outcome.conflict) {
    return res.status(409).json({ success: false, code: 'DUPLICATES_FOUND', error: 'Some rows look like transactions you already have. Nothing was imported; review them first.', ...outcome.preview });
  }
  return res.json({ success: true, count: rows.length, skipped, transactions: rows, ...extra });
}

// 4. POST /api/transactions/parse-statement
// Supports both pasted text (req.body.text) and file upload (req.file)
// upload.single() is called programmatically (not as inline middleware) so that
// Multer's LIMIT_FILE_SIZE error can be caught here and returned as a clean
// 413 JSON response before any parsing logic executes.
app.post('/api/transactions/parse-statement', authenticate, parseLimiter, (req, res, next) => {
  upload.single('statementFile')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: 'File too large. Maximum allowed size is 5 MB.'
        });
      }
      // Unexpected multer error — pass to Express error handler
      if (err.code === 'UNSUPPORTED_FILE_TYPE') {
        return res.status(400).json({ error: 'Unsupported file type. Upload a .csv, .txt, .xls or .xlsx statement.' });
      }
      return next(err);
    }
    next();
  });
}, async (req, res) => {
  if (req.query.duplicates !== undefined && !['allow', 'report'].includes(req.query.duplicates)) {
    return res.status(400).json({ error: 'duplicates must be "report" (default) or "allow"' });
  }
  let statementText = '';
  let isExcel = false;

  if (req.file) {
    const originalName = req.file.originalname.toLowerCase();
    isExcel = originalName.endsWith('.xls') || originalName.endsWith('.xlsx');
  }

  // If it's an Excel file, parse it using SheetJS (XLSX)
  if (isExcel) {
    try {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const sheetRows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

      // Find the header row: it must name a date, a description and at least one of a
      // debit/credit column (see HEADER_ALIASES). A serial-number column is not needed.
      let headerRowIndex = -1;
      let columns = null;
      for (let i = 0; i < sheetRows.length; i++) {
        columns = Array.isArray(sheetRows[i]) ? findStatementColumns(sheetRows[i]) : null;
        if (columns) {
          headerRowIndex = i;
          break;
        }
      }

      if (columns) {
        const parsedTxns = [];
        let parserSkipped = 0; // rows the parser itself refuses (ambiguous or unreadable amounts)

        for (let i = headerRowIndex + 1; i < sheetRows.length; i++) {
          const row = sheetRows[i];
          if (!Array.isArray(row)) continue;

          // Stop at the "Legends Used" footer block
          if (isLegendRow(row)) break;
          // Exported statements often repeat the header row on every page
          if (HEADER_ALIASES.date.includes(normalizeHeaderCell(row[columns.date]))) continue;

          const debit = classifyAmountCell(row[columns.debit]);
          const credit = classifyAmountCell(row[columns.credit]);
          if (debit.kind === 'invalid' || credit.kind === 'invalid') {
            parserSkipped++;
            continue;
          }
          const hasDebit = debit.kind === 'positive';
          const hasCredit = credit.kind === 'positive';
          if (!hasDebit && !hasCredit) continue; // no amount: notes, balances, blank lines
          if (hasDebit && hasCredit) {
            parserSkipped++; // both sides filled in: do not guess the direction
            continue;
          }

          const rawRemarks = row[columns.description] != null ? String(row[columns.description]).trim() : '';
          const amount = hasCredit ? credit.value : -debit.value;
          const type = hasCredit ? 'income' : 'expense';

          // Categories
          let category = 'General';
          const lowerRemarks = rawRemarks.toLowerCase();
          if (lowerRemarks.includes('magicpin') || lowerRemarks.includes('amazon') || lowerRemarks.includes('flipkart') || lowerRemarks.includes('shop') || lowerRemarks.includes('reliance')) {
            category = 'Shopping';
          } else if (lowerRemarks.includes('south kitc') || lowerRemarks.includes('zomato') || lowerRemarks.includes('swiggy') || lowerRemarks.includes('restaurant') || lowerRemarks.includes('food') || lowerRemarks.includes('coffee') || lowerRemarks.includes('starbucks')) {
            category = 'Food';
          } else if (lowerRemarks.includes('pvr') || lowerRemarks.includes('inox') || lowerRemarks.includes('cinema') || lowerRemarks.includes('movie') || lowerRemarks.includes('netflix') || lowerRemarks.includes('spotify')) {
            category = 'Entertainment';
          } else if (lowerRemarks.includes('salary') || lowerRemarks.includes('paycheck') || lowerRemarks.includes('employer')) {
            category = 'Salary';
          } else if (lowerRemarks.includes('dividend') || lowerRemarks.includes('mutual') || lowerRemarks.includes('groww') || lowerRemarks.includes('zerodha') || lowerRemarks.includes('stock')) {
            category = 'Investment';
          } else if (lowerRemarks.includes('bill') || lowerRemarks.includes('electricity') || lowerRemarks.includes('utility') || lowerRemarks.includes('recharge') || lowerRemarks.includes('telecom') || lowerRemarks.includes('airtel') || lowerRemarks.includes('jio')) {
            category = 'Bills';
          } else if (lowerRemarks.includes('uber') || lowerRemarks.includes('ola') || lowerRemarks.includes('travel') || lowerRemarks.includes('flight') || lowerRemarks.includes('metro')) {
            category = 'Travel';
          }

          parsedTxns.push({
            userId: req.user.id, // ownership stamp for Excel-parsed transactions
            title: finalizeStatementTitle(titleFromRemarks(rawRemarks)),
            amount,
            date: parseStatementDate(row[columns.date]),
            type,
            category
          });
        }

        if (parsedTxns.length > 0 || parserSkipped > 0) {
          const { rows: savedRows, skipped: invalidRows } = normalizeImportedRows(parsedTxns);
          const skipped = parserSkipped + invalidRows;
          if (savedRows.length > 0) {
            return respondWithImport(req, res, savedRows, { skipped });
          }
          return res.status(400).json({
            error: `No valid transactions found: ${skipped} row(s) failed validation.`,
            skipped
          });
        }
      }

      return res.status(400).json({ error: 'Could not parse transactions from Excel. Make sure it is a valid bank statement.' });
    } catch (excelErr) {
      console.error('Error parsing Excel:', excelErr?.name ?? 'error');   // name only: never the error object (stack with paths, parser text)
      return res.status(500).json({ error: 'Failed to parse Excel statement.' });
    }
  }

  // Handle standard txt/csv text statements
  if (req.file) {
    try {
      statementText = req.file.buffer.toString('utf8');
    } catch (err) {
      console.error('Error reading text file from buffer:', err?.name ?? 'error');
      return res.status(500).json({ error: 'Failed to read statement file.' });
    }
  } else if (req.body.text) {
    statementText = req.body.text;
  } else {
    return res.status(400).json({ error: 'No statement text or file provided.' });
  }

  if (!statementText.trim()) {
    return res.status(400).json({ error: 'Statement content is empty.' });
  }

  console.log('Parsing statement. Length:', statementText.length);

  // If Groq is configured, use it for parsing
  if (isGroqConfigured()) {
    try {
      // Model: GROQ_PARSE_MODEL (default openai/gpt-oss-20b). No response_format (the prompt asks for a top-level JSON array,
      // which JSON mode cannot return) and no max_tokens (the output grows with the statement).
      // Provider output is untrusted extraction, not a ledger. The downstream normalizer
      // must reject malformed rows before duplicate review or persistence.
      const parseModel = getParseModel(process.env);
      const response = await fetch(groqChatUrl(process.env), {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: parseModel,
          messages: [
            {
              role: 'system',
              content: `You are an expert financial tool. Parse the bank statement or transaction logs provided by the user.
Extract all transactions and return ONLY a JSON array of objects. Do not write any markdown codeblocks, notes, or HTML.
Each transaction object MUST have:
1. "title": Description of transaction (e.g. "Walmart", "Gas Station", "Salary").
2. "amount": A number (negative for debit/expense/withdrawals, positive for credit/deposit/income).
3. "date": Date in YYYY-MM-DD format (if year is not provided, assume 2026).
4. "type": Either "income" or "expense".
5. "category": A single category name (e.g. "Salary", "Shopping", "Food", "Bills", "Investment", "Entertainment", "Travel", "General").

Return only the valid JSON array, like: [{"title": "Salary", "amount": 50000, "date": "2026-05-01", "type": "income", "category": "Salary"}]`
            },
            {
              role: 'user',
              content: statementText
            }
          ],
          temperature: 0.1,
          ...modelRequestFields(parseModel)
        })
      });

      if (response.ok) {
        const data = await response.json();
        let reply = data.choices[0].message.content.trim();
        
        if (reply.startsWith('```')) {
          reply = reply.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
        }

        const parsed = JSON.parse(reply);
        if (Array.isArray(parsed)) {
          const candidates = parsed.map((item) => {
            // Non-object entries become empty candidates and are skipped by validation.
            const txn = item !== null && typeof item === 'object' ? item : {};
            return {
              userId: req.user.id, // ownership stamp for AI-parsed transactions
              title: txn.title || 'Unlabeled Transaction',
              amount: txn.amount, // passed raw: strict parsing happens in the validator
              date: txn.date || new Date().toISOString().split('T')[0],
              type: txn.type || (txn.amount > 0 ? 'income' : 'expense'),
              category: txn.category || 'General'
            };
          });
          const { rows, skipped } = normalizeImportedRows(candidates);

          if (rows.length > 0) {
            return respondWithImport(req, res, rows, { skipped });
          }
          // No valid rows from the AI: fall through to the rule-based parser below.
        }
      } else {
        // The status only: a provider error body can echo the generated text, and so the user's statement.
        console.error('Groq API Error during parsing: status', response.status);
      }
    } catch (err) {
      console.error('Error invoking Groq API for parsing:', err?.name ?? 'error');
    }
  }

  // Fallback Rule-Based Parser (if Groq is not configured or fails)
  console.log('Using rule-based parser fallback');
  try {
    const lines = statementText.split(/\r?\n/);
    const parsedTxns = [];
    let parserSkipped = 0; // lines with a date and an amount but no clear direction

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const parsed = parseTextStatementLine(line);
      if (!parsed) continue; // not a transaction line (no date, or no usable amount)
      if (parsed.ambiguous) {
        parserSkipped++;
        continue;
      }

      const title = finalizeStatementTitle(parsed.titleText);

      let category = 'General';
      const lowerTitle = title.toLowerCase();
      if (lowerTitle.includes('amazon') || lowerTitle.includes('flipkart') || lowerTitle.includes('shop')) category = 'Shopping';
      else if (lowerTitle.includes('coffee') || lowerTitle.includes('restaurant') || lowerTitle.includes('zomato') || lowerTitle.includes('swiggy') || lowerTitle.includes('food')) category = 'Food';
      else if (lowerTitle.includes('salary') || lowerTitle.includes('deposit') || lowerTitle.includes('paycheck')) category = 'Salary';
      else if (lowerTitle.includes('netflix') || lowerTitle.includes('spotify') || lowerTitle.includes('hotstar')) category = 'Entertainment';
      else if (lowerTitle.includes('dividend') || lowerTitle.includes('stock') || lowerTitle.includes('mutual')) category = 'Investment';
      else if (lowerTitle.includes('bill') || lowerTitle.includes('electricity') || lowerTitle.includes('recharge')) category = 'Bills';

      parsedTxns.push({
        userId: req.user.id, // ownership stamp for rule-based-parsed transactions
        title,
        amount: parsed.type === 'income' ? parsed.amount : -parsed.amount,
        date: parsed.date,
        type: parsed.type,
        category
      });
    }

    if (parsedTxns.length > 0 || parserSkipped > 0) {
      const { rows: savedRows, skipped: invalidRows } = normalizeImportedRows(parsedTxns);
      const skipped = parserSkipped + invalidRows;
      if (savedRows.length > 0) {
        return respondWithImport(req, res, savedRows, { skipped, notice: 'Parsed using local backup engine' });
      }
      return res.status(400).json({
        error: `No valid transactions found: ${skipped} row(s) failed validation.`,
        skipped
      });
    }

    res.status(400).json({ error: 'Could not parse any transactions from the provided statement. Check the format.' });
  } catch (err) {
    console.error('Error parsing file locally:', err?.name ?? 'error');
    res.status(500).json({ error: 'Failed parsing bank statement' });
  }
});

// 4b. POST /api/transactions/import-confirm (duplicate-aware import, step 2)
// The rows of a duplicate preview come back with the user's decision. Nothing the client says about identity or duplicates is trusted:
// every row is validated again, ids are generated here, the owner is the session user, and the matches are recomputed inside the
// per-user import lock. The reviewDigest must equal the fingerprint of what is about to be saved (a stale or edited review gets 409).
// No statement is parsed again and no language model is called.
const importConfirmLimiter = perUserLimiter(20, 'import confirmation');
const importConfirmJson = express.json({ limit: '256kb' });
app.post(IMPORT_CONFIRM_PATH, authenticate, importConfirmLimiter, importConfirmJson, async (req, res) => {
  const parsed = parseConfirmRequest(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const rows = [];
  for (let i = 0; i < parsed.value.rows.length; i++) {
    const raw = parsed.value.rows[i];
    // Only these five fields are read. An id, userId, classification or duplicate flag in the request is ignored.
    const normalized = normalizeTransactionInput({ title: raw?.title, amount: raw?.amount, date: raw?.date, type: raw?.type, category: raw?.category });
    if (!normalized.ok) return res.status(400).json({ error: `Row ${i + 1}: ${normalized.error}` });
    rows.push({ id: randomUUID(), userId: req.user.id, ...normalized.value });
  }
  let outcome;
  try {
    outcome = await importTransactionsLocked(req.user.id, rows, (existing) => {
      const results = findDuplicates(rows, existing);
      const digest = reviewDigest(JWT_SECRET, req.user.id, rows, results, existing);
      if (!digestsEqual(digest, parsed.value.reviewDigest)) {
        return { insert: [], result: { stale: true, preview: buildPreview(rows, results, { skipped: 0, digest }) } };
      }
      const plan = planImport(rows, results, parsed.value);
      return { insert: plan.insert, result: { stale: false, plan } };
    });
  } catch (dbErr) {
    return respondImportError(res, dbErr, 'Could not save transactions');
  }
  if (outcome.stale) {
    return res.status(409).json({ success: false, code: 'STALE_PREVIEW', error: 'Your transactions changed since this import was reviewed. Nothing was imported; review it again.', ...outcome.preview });
  }
  const { insert, skippedLikely, skippedByUser, likelyImportedAnyway, possibleImported } = outcome.plan;
  return res.json({
    success: true, count: insert.length, skipped: skippedLikely + skippedByUser, transactions: insert,
    duplicates: { skippedLikely, skippedByUser, likelyImportedAnyway, possibleImported }
  });
});

// 5. POST /api/transactions/ocr-statement-image (Stage 1 of image statement upload)
// Local Tesseract.js OCR of one JPG/JPEG/PNG. Returns the extracted TEXT and warnings only: it never inserts a transaction, never
// calls Groq or any other external service, and neither the image nor the text is logged or stored. Its upload handling is separate
// from the statement import above, whose allow-list is unchanged. See imageOcr.js.
const imageOcr = createOcrService({ engine: createTesseractEngine() });
app.post('/api/transactions/ocr-statement-image', authenticate, ocrLimiter, ...createOcrStatementImageHandlers({ ocr: imageOcr }));

// ₹ with Indian grouping, at most 2 decimals, and a leading minus for negatives.
const formatRupees = (n) => {
  // Values this large have no paise to round (and n * 100 would overflow to Infinity).
  const rounded = Math.abs(n) >= 1e13 ? n : Math.round(n * 100) / 100 || 0; // also normalizes -0
  return `${rounded < 0 ? '-' : ''}₹${Math.abs(rounded).toLocaleString('en-IN')}`;
};

// The caller's own saved goals as assistant context. Titles are user text, so they are
// quoted with JSON.stringify to keep them on one line and clearly data. Capped so a
// user with many goals cannot bloat the prompt.
const MAX_GOALS_IN_PROMPT = 20;
function describeGoalsForAssistant(userGoals) {
  if (userGoals.length === 0) return ' none saved yet';
  const lines = userGoals.slice(0, MAX_GOALS_IN_PROMPT).map((g) => {
    const percent = g.targetAmount > 0 ? Math.round((g.currentAmount / g.targetAmount) * 100) : 0;
    return `  - ${JSON.stringify(g.title)}: ${formatRupees(g.currentAmount)} saved of ${formatRupees(g.targetAmount)} target (${percent}% complete), target date ${g.targetDate}`;
  });
  if (userGoals.length > MAX_GOALS_IN_PROMPT) {
    lines.push(`  - (${userGoals.length - MAX_GOALS_IN_PROMPT} more goals not shown)`);
  }
  return `\n${lines.join('\n')}`;
}

// The caller's budgets for one month as assistant context: only configured limits and the real spending figures
// computed from their transactions. Names are user text, so they are quoted. Capped like the other lists.
const MAX_BUDGETS_IN_PROMPT = 20;
function describeBudgetsForAssistant(userBudgets) {
  if (userBudgets.length === 0) return ' none set';
  const lines = userBudgets.slice(0, MAX_BUDGETS_IN_PROMPT).map((b) => {
    const state = b.status === 'over'
      ? `over budget by ${formatRupees(-b.remaining)}`
      : b.status === 'at' ? 'exactly at budget' : `under budget, ${formatRupees(b.remaining)} left`;
    return `  - ${JSON.stringify(b.category)}: ${formatRupees(b.actualSpent)} spent of ${formatRupees(b.amount)} (${b.percentUsed}% used), ${state}`;
  });
  if (userBudgets.length > MAX_BUDGETS_IN_PROMPT) {
    lines.push(`  - (${userBudgets.length - MAX_BUDGETS_IN_PROMPT} more budgets not shown)`);
  }
  return `\n${lines.join('\n')}`;
}

// The caller's own saved emergency fund as assistant context: the amount they entered (and the optional
// target they chose), never a coverage figure - months of coverage only come from the ML analysis.
function describeEmergencyFundForAssistant(fund) {
  if (!fund) return 'not set up yet (the user has not entered one)';
  const target = fund.targetAmount === null
    ? 'no target set'
    : `target ${formatRupees(fund.targetAmount)} (${Math.round((fund.currentAmount / fund.targetAmount) * 100)}% of target)`;
  return `${formatRupees(fund.currentAmount)} saved, ${target}`;
}

// Same idea for the caller's own saved liabilities (names are user text, so they are quoted).
const MAX_LIABILITIES_IN_PROMPT = 20;
function describeLiabilitiesForAssistant(userLiabilities) {
  if (userLiabilities.length === 0) return ' none saved yet';
  const lines = userLiabilities.slice(0, MAX_LIABILITIES_IN_PROMPT).map((l) => {
    const kind = String(l.type).replace(/_/g, ' ');
    // A fully repaid liability has no payment due, so its stored monthly payment is not reported.
    if (l.outstandingAmount === 0) return `  - ${JSON.stringify(l.name)} (${kind}): paid off (${formatRupees(0)} outstanding)`;
    return `  - ${JSON.stringify(l.name)} (${kind}): ${formatRupees(l.outstandingAmount)} outstanding, ${l.interestRate}% interest per year, ${formatRupees(l.monthlyPayment)} monthly payment`;
  });
  if (userLiabilities.length > MAX_LIABILITIES_IN_PROMPT) {
    lines.push(`  - (${userLiabilities.length - MAX_LIABILITIES_IN_PROMPT} more liabilities not shown)`);
  }
  return `\n${lines.join('\n')}`;
}

// ── Assistant chat contract (Issue #69) ───────────────────────────────────────────────────────────────────────
// POST /api/chat and /api/plan-chat accept { messages: [{ role, content }] }: 1-20 items, role "user" or "assistant"
// only (never "system" or anything else), content a non-empty string of at most 2000 characters, and the last item
// from the user. Anything else is answered 400; it is never reinterpreted. Only the most recent 12 turns are sent to
// the language model. History is conversational context, never a source of financial facts.
const CHAT_MAX_MESSAGES = 20;
const CHAT_MAX_CONTENT = 2000;
const CHAT_HISTORY_TURNS = 12;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Returns an error message, or null when `messages` is a valid conversation.
function validateChatMessages(messages) {
  if (!Array.isArray(messages)) return 'messages must be an array';
  if (messages.length < 1 || messages.length > CHAT_MAX_MESSAGES) return `messages must contain 1-${CHAT_MAX_MESSAGES} items`;
  for (const m of messages) {
    if (!isPlainObject(m)) return 'each message must be an object';
    if (Object.keys(m).some((k) => k !== 'role' && k !== 'content')) return 'a message may only have role and content';
    if (m.role !== 'user' && m.role !== 'assistant') return 'message role must be "user" or "assistant"';
    if (typeof m.content !== 'string' || m.content.trim() === '') return 'message content must be a non-empty string';
    if (m.content.length > CHAT_MAX_CONTENT) return `message content must be at most ${CHAT_MAX_CONTENT} characters`;
  }
  if (messages[messages.length - 1].role !== 'user') return 'the last message must be from the user';
  return null;
}
const recentTurns = (messages) => messages.slice(-CHAT_HISTORY_TURNS).map(({ role, content }) => ({ role, content: content.trim() }));

// ── Deterministic assistant (used when no language model is configured, or the call fails) ────────────────────
// Every answer is built only from the server-side context below; nothing is guessed. Topics are matched on whole
// words ("high" is not "hi", "remaining" is not "main"). A message with no topic of its own ("why?", "tell me more",
// "how did you calculate that?") continues the most recent user topic in the bounded history.
const FALLBACK_TOPICS = [
  ['credit', /\b(?:credit\s+score|cibil|credit\s+rating)\b/],
  ['portfolio', /\b(?:portfolio|stocks?|shares|mutual\s+funds?|holdings)\b/],
  ['networth', /\b(?:net\s+worth|wealth)\b/],
  ['emergency', /\bemergency\b/],
  ['budget', /\bbudgets?\b/],
  ['liabilities', /\b(?:liabilit(?:y|ies)|loans?|debts?|emis?)\b/],
  ['goals', /\bgoals?\b/],
  ['income', /\b(?:income|salary|earn|earned|earnings?|received)\b/],
  ['spending', /\b(?:spend|spent|spending|expenses?|costs?|refunds?)\b/],
  ['cashflow', /\b(?:cash\s*flow|how\s+am\s+i\s+doing|doing\s+financially|overview|summary|summari[sz]e|balance|savings?)\b/],
  ['statement', /\b(?:statements?|upload|import)\b/],
];
const GREETING = /^\s*(?:hi|hello|hey|namaste|good\s+(?:morning|afternoon|evening))(?:\s+(?:there|finsphere))?[\s!.,]*$/i;
const ASKS_CALCULATION = /\b(?:calculat\w*|comput\w*|work(?:ed)?\s+(?:that|it|this)\s+out|formula|how\s+did\s+you\s+get)\b/i;
const ASKS_WHY = /^\s*(?:why|how\s+come)\b/i;

function fallbackTopic(text) {
  const lower = text.toLowerCase();
  return FALLBACK_TOPICS.find(([, re]) => re.test(lower))?.[0] ?? null;
}

function fallbackReply(history, ctx) {
  const last = history[history.length - 1].content;
  if (GREETING.test(last)) {
    return 'Hi! 👋 Ask me about your spending, income, savings goals, budgets, liabilities, emergency fund or cash flow.';
  }
  let topic = fallbackTopic(last);
  let continued = false;
  if (!topic) {
    // Follow-up: continue the most recent earlier USER topic (assistant text is never used as a fact source).
    for (let i = history.length - 2; i >= 0 && !topic; i--) {
      if (history[i].role === 'user') topic = fallbackTopic(history[i].content);
    }
    continued = Boolean(topic);
  }
  if (!topic) {
    return "I'm not sure which figure you mean. I can answer from your recorded data about your spending, income, savings goals, budgets, liabilities, emergency fund and cash flow.";
  }
  const explain = ASKS_CALCULATION.test(last) || ASKS_WHY.test(last);
  const m = ctx.monthTotals, all = ctx.allTotals, month = ctx.month;
  const provisional = m.unknownCount > 0
    ? ` ${m.unknownCount} of this month's transactions are not classified yet and are counted by their direction, so treat the figures as provisional.`
    : '';
  const lead = continued && ASKS_WHY.test(last) ? 'I can only explain this from your recorded figures. ' : '';
  const spendingRule = 'Spending = expenses (plus unclassified money going out) minus refunds, never below ₹0 for the period; transfers are not counted.';
  const incomeRule = 'Income = transactions classified as income plus unclassified money coming in; refunds and transfers are not income.';
  let reply;
  switch (topic) {
    case 'credit':
      reply = "I don't have a credit score for you. FinSphere isn't connected to any credit bureau, and I won't estimate one from your transactions.";
      break;
    case 'portfolio':
      reply = "Open Portfolio to view or record your investment holdings and valuations. Investment records are not connected to this chat, so I cannot report their allocation or returns here.";
      break;
    case 'networth':
      reply = `I can't work out your net worth because FinSphere doesn't have your assets. From your recorded transactions, your net cash flow (total income minus total spending, refunds and transfers handled as described) is ${formatRupees(all.netCashFlow)}.`;
      break;
    case 'emergency':
      reply = ctx.emergencyFund
        ? `Your saved emergency fund: ${describeEmergencyFundForAssistant(ctx.emergencyFund)}.`
        : "You haven't set up an emergency fund yet. You can add it on the Goals page.";
      break;
    case 'budget':
      reply = ctx.budgets.length === 0
        ? `You haven't set any budgets for ${month}. You can add them on the Goals page.`
        : `Your budgets for ${month}:${describeBudgetsForAssistant(ctx.budgets)}`;
      if (explain && ctx.budgets.length) reply += `\nEach budget's spending is that category's expenses minus its refunds in ${month} (never below ₹0); transfers are not counted.`;
      break;
    case 'liabilities':
      reply = ctx.liabilities.length === 0
        ? "You don't have any saved liabilities yet. You can add them on the Liabilities page."
        : `Your saved liabilities:${describeLiabilitiesForAssistant(ctx.liabilities)}`;
      break;
    case 'goals':
      reply = ctx.goals.length === 0
        ? "You don't have any saved goals yet. You can add one on the Goals page."
        : `Your saved goals:${describeGoalsForAssistant(ctx.goals)}`;
      break;
    case 'income':
      reply = `This month (${month}) your income is ${formatRupees(m.totalIncome)}. Across all ${all.count} recorded transactions it is ${formatRupees(all.totalIncome)}.${provisional}`;
      if (explain) reply += ` ${incomeRule}`;
      break;
    case 'spending':
      reply = `This month (${month}) your spending is ${formatRupees(m.totalSpending)}: ${formatRupees(m.grossSpending)} of expenses minus ${formatRupees(m.refunds)} of refunds. Across all ${all.count} recorded transactions it is ${formatRupees(all.totalSpending)}.${provisional}`;
      if (explain) reply += ` ${spendingRule}`;
      break;
    case 'cashflow': {
      const over = ctx.budgets.filter((b) => b.status === 'over').length;
      const budgetLine = ctx.budgets.length ? ` ${over} of your ${ctx.budgets.length} budgets for ${month} ${over === 1 ? 'is' : 'are'} over the limit.` : '';
      reply = `This month (${month}): income ${formatRupees(m.totalIncome)}, spending ${formatRupees(m.totalSpending)}, net cash flow ${formatRupees(m.netCashFlow)}.${budgetLine}${provisional} Your overall health score comes from the analysis on the Plans page.`;
      if (explain) reply += ` Net cash flow = income minus spending. ${incomeRule} ${spendingRule}`;
      break;
    }
    case 'statement':
      reply = 'You can import transactions on the Transactions page, by pasting statement text or uploading a .csv, .txt, .xls or .xlsx file.';
      break;
    default:
      reply = "I'm not sure which figure you mean.";
  }
  return lead + reply;
}

// ── Confirmed assistant actions (Issue #73, Phase 1) ──────────────────────────────────────────────────────────────
// The assistant proposes (see assistantActions.js); only these two endpoints can execute or cancel a proposal, and they
// take nothing but the proposal id from the URL. The payload, owner and goal id are the ones the server stored.
const assistantActions = createAssistantActions({
  db: {
    getActiveProposal, replaceActiveProposal, cancelProposal, previewGoalContribution, listGoalsByUser,
    listLiabilitiesByUser, previewLiabilityRepayment, listBudgetsByUserAndMonth
  },
  normalizeTransactionInput,
  normalizeContributionInput,
  normalizeRepaymentInput,
  normalizeBudgetInput,
  normalizeLiabilityInput,
  formatRupees,
  // Optional language-model FALLBACK for messages the deterministic parser does not understand (Issue #77). It can only
  // describe the message; every value is re-derived from the user's words and the usual preview + confirmation follows.
  // Off when GROQ_API_KEY is missing or ASSISTANT_ACTION_LLM=off.
  extractStructured: createStructuredExtractor({ isConfigured: isGroqConfigured })
});

// Runs a claimed proposal through the same executors as the manual routes.
async function executeProposal(userId, proposal) {
  const p = proposal.payload;
  if (proposal.kind === 'create_transaction') {
    const out = await createTransactionFor(userId, p.input);
    if (!out.ok) return { ok: false, error: out.error };
    const t = out.transaction;
    return {
      ok: true,
      result: {
        kind: proposal.kind,
        message: `Done. I added the ${formatRupees(Math.abs(t.amount))} ${t.title} ${t.type === 'income' ? 'income' : 'expense'}.`,
        transaction: t
      }
    };
  }
  if (proposal.kind === 'contribute_to_goal') {
    const out = await addGoalContributionFor(userId, p.goalId, { amount: p.amount });
    if (!out.ok) return { ok: false, error: out.error };
    return {
      ok: true,
      result: {
        kind: proposal.kind,
        message: `Done. I added ${formatRupees(out.contribution.amount)} to ${out.goal.title}. It's now ${formatRupees(out.goal.currentAmount)} of ${formatRupees(out.goal.targetAmount)}.`,
        goal: out.goal,
        contribution: out.contribution
      }
    };
  }
  if (proposal.kind === 'record_liability_repayment') {
    // The same locked repayment the manual route runs. A balance that moved since the preview is fine as long as the
    // user's exact amount is still valid (the lock decides); the message reports the ACTUAL resulting balance.
    const out = await repayLiabilityFor(userId, p.liabilityId, { amount: p.amount });
    if (!out.ok) return { ok: false, error: out.error };
    const l = out.liability;
    return {
      ok: true,
      result: {
        kind: proposal.kind,
        message: `Done. I recorded a ${formatRupees(out.repayment.amount)} repayment on ${l.name}. Its outstanding balance is now ${formatRupees(l.outstandingAmount)}${l.outstandingAmount === 0 ? ', so it is paid off' : ''}.`,
        liability: l,
        repayment: out.repayment
      }
    };
  }
  if (proposal.kind === 'create_liability') {
    // The same validator and insert as POST /api/liabilities, run again on the stored input. The id was fixed when the
    // proposal was built, so a repeated execution can never create a second row.
    const out = await createLiabilityFor(userId, p.input, { id: p.liabilityId });
    if (!out.ok) return { ok: false, error: out.error };
    const l = out.liability;
    return {
      ok: true,
      result: {
        kind: proposal.kind,
        message: `Done. I added ${l.name} with ${formatRupees(l.outstandingAmount)} outstanding.`,
        liability: l,
        created: true
      }
    };
  }
  if (proposal.kind === 'set_budget') {
    const out = await setBudgetFor(userId, { month: p.month, category: p.label, amount: p.amount }, { expect: p.expect });
    if (!out.ok) return { ok: false, error: out.error };
    const b = out.budget;
    const was = p.expect?.exists ? ` from ${formatRupees(p.expect.amount)}` : '';
    return {
      ok: true,
      result: {
        kind: proposal.kind,
        message: out.created
          ? `Done. I created the ${b.category} budget for ${monthLabel(b.month)}: ${formatRupees(b.amount)}.`
          : `Done. I changed the ${b.category} budget for ${monthLabel(b.month)}${was} to ${formatRupees(b.amount)}.`,
        budget: b,
        created: out.created
      }
    };
  }
  return { ok: false, error: 'This kind of action is not supported.' };
}

const EXPIRED_MESSAGE = 'This request expired. Nothing was saved.';

// POST /api/assistant/actions/:id/confirm - execute exactly once. The body is ignored on purpose.
app.post('/api/assistant/actions/:id/confirm', authenticate, actionLimiter, async (req, res) => {
  const userId = req.user.id;   // ownership: always from the verified JWT
  const id = req.params.id;
  try {
    const claimed = await claimProposal(userId, id);   // atomic: only one confirmation can win
    if (claimed) {
      let outcome;
      try {
        outcome = await executeProposal(userId, claimed);
      } catch (err) {
        await finishProposal(userId, id, 'failed', { error: 'Could not save this action.' }).catch(() => {});
        return respondDbError(res, err, 'Could not save this action');
      }
      if (!outcome.ok) {
        await finishProposal(userId, id, 'failed', { error: outcome.error });
        return res.status(400).json({ status: 'failed', error: outcome.error });
      }
      await finishProposal(userId, id, 'executed', outcome.result);
      return res.json({ status: 'executed', ...outcome.result });
    }
    // Not claimed: say why, without ever writing. Missing and not-yours look the same.
    const existing = await getProposalByUserAndId(userId, id);
    if (!existing) return res.status(404).json({ error: 'Action not found' });
    if (existing.status === 'executed') return res.json({ status: 'executed', replay: true, ...existing.result });   // stored result, no second write
    if (existing.status === 'executing') return res.status(409).json({ status: 'executing', error: 'This action is already being processed.' });
    if (existing.status === 'failed') return res.status(400).json({ status: 'failed', error: existing.result?.error ?? 'This action could not be completed.' });
    if (existing.status === 'cancelled') return res.status(409).json({ status: 'cancelled', error: 'This action was cancelled. Nothing was saved.' });
    if (existing.status === 'expired' || existing.expired) {
      await expireProposal(userId, id);
      return res.status(410).json({ status: 'expired', error: EXPIRED_MESSAGE });
    }
    return res.status(409).json({ status: existing.status, error: 'This action is not ready to confirm yet.' });
  } catch (err) {
    respondDbError(res, err, 'Could not confirm this action');
  }
});

// POST /api/assistant/actions/:id/cancel - nothing is written. The body is ignored on purpose.
app.post('/api/assistant/actions/:id/cancel', authenticate, actionLimiter, async (req, res) => {
  const userId = req.user.id;
  const id = req.params.id;
  try {
    if (await cancelProposal(userId, id)) return res.json({ status: 'cancelled', message: 'Cancelled. Nothing was saved.' });
    const existing = await getProposalByUserAndId(userId, id);
    if (!existing) return res.status(404).json({ error: 'Action not found' });
    if (existing.status === 'executed') return res.status(409).json({ status: 'executed', error: 'This action was already completed.' });
    if (existing.status === 'executing') return res.status(409).json({ status: 'executing', error: 'This action is already being processed.' });
    res.json({ status: existing.status, message: 'Nothing was saved.' });
  } catch (err) {
    respondDbError(res, err, 'Could not cancel this action');
  }
});

// The client's local calendar date, sent with chat messages so "today" / "yesterday" mean the user's today and
// yesterday. It is only used to resolve those words: undefined when absent, null when invalid, otherwise
// 'YYYY-MM-DD'. A real local date is never more than a day away from the UTC date.
function parseClientLocalDate(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return null;
  const m = DATE_PATTERN.exec(raw);
  if (!m || !isRealCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
  const utcToday = new Date().toISOString().slice(0, 10);
  return raw >= shiftDate(utcToday, -1) && raw <= shiftDate(utcToday, 1) ? raw : null;
}

// 5. POST /api/chat
// The assistant may only state facts that exist for the authenticated user, all loaded here on the server: their
// own transactions and the classification-aware totals derived from them (all-time and for the current month),
// goals, liabilities, emergency fund and this month's budgets. Credit score, portfolio and net worth do not exist in
// FinSphere, so they are declared unavailable instead of being filled in.
app.post('/api/chat', authenticate, chatLimiter, async (req, res) => {
  const invalid = validateChatMessages(req.body?.messages);
  if (invalid) return res.status(400).json({ error: invalid });
  const history = recentTurns(req.body.messages);
  const localDate = parseClientLocalDate(req.body?.localDate);
  if (localDate === null) return res.status(400).json({ error: 'localDate must be today\'s date as YYYY-MM-DD' });

  // Action requests ("add ₹450 for lunch", "put ₹5,000 into my Goa goal") and answers to an open clarification or
  // confirmation are handled deterministically, with no language model. Anything else falls through to normal chat.
  let actionTurn;
  try {
    actionTurn = await assistantActions.handleTurn({ userId: req.user.id, text: history[history.length - 1].content, localDate });
  } catch (err) {
    return respondDbError(res, err, 'Could not process that request');
  }
  if (actionTurn.handled) {
    return res.json({ reply: actionTurn.reply, ...(actionTurn.action ? { action: actionTurn.action } : {}) });
  }
  // A cancelled proposal is reported to the client, and the user is told, before the normal answer.
  let visualization = null;
  const answer = (reply) => res.json({
    ...(visualization ? { visualization } : {}),
    reply: actionTurn.cancelNotice ? `${actionTurn.cancelNotice} ${reply}` : reply,
    ...(actionTurn.action ? { action: actionTurn.action } : {})
  });

  try {
    // Scope financial context to the authenticated user only. Nothing belonging to other users is read.
    // The month the assistant talks about is the server's current UTC month (the same month used for budgets).
    const month = new Date().toISOString().slice(0, 7);
    let userTransactions, userGoals, emergencyFund, userBudgets, userLiabilities, allTotals, monthTotals;
    try {
      [userTransactions, userGoals, emergencyFund, userBudgets, userLiabilities, allTotals, monthTotals] = await Promise.all([
        listTransactionsByUser(req.user.id),
        listGoalsByUser(req.user.id),
        getEmergencyFundByUser(req.user.id),
        listBudgetsByUserAndMonth(req.user.id, month),
        listLiabilitiesByUser(req.user.id),
        // Classification-aware and computed exactly in the database (server/db/index.js): income excludes refunds
        // and transfers; spending is expenses minus refunds (floored at 0 for the period) without transfers;
        // unlabelled ("unknown") rows count by direction.
        getTransactionTotalsByUser(req.user.id),
        getTransactionTotalsByUser(req.user.id, { month }),
      ]);
    } catch (err) {
      return respondDbError(res, err, 'Could not load your financial data');
    }

    const ctx = { month, allTotals, monthTotals, goals: userGoals, liabilities: userLiabilities, emergencyFund, budgets: userBudgets };
    // Visuals come only from the same authenticated database totals as the prose.
    // Keep action previews on their existing, separate confirmation path.
    const topic = fallbackTopic(history.at(-1).content);
    if (['income', 'spending', 'cashflow'].includes(topic)) {
      visualization = {
        title: `Recorded cash flow · ${month} (UTC)`,
        provisional: monthTotals.unknownCount > 0,
        rows: [
          { label: 'Income', amount: monthTotals.totalIncome },
          { label: 'Net spending', amount: monthTotals.totalSpending },
          { label: 'Net cash flow', amount: monthTotals.netCashFlow },
        ],
      };
    }
    const recentTransactions = userTransactions.slice(0, 10);

    const systemMessage = {
      role: 'system',
      content: `You are the FinSphere assistant. You answer the user's questions about their own finances.

AUTHORITATIVE FINANCIAL DATA for this user, loaded from the FinSphere database for this request. It is the only source of financial facts:

This month (${month}, the current calendar month in UTC):
- Income: ${formatRupees(monthTotals.totalIncome)}
- Spending: ${formatRupees(monthTotals.totalSpending)} (expenses ${formatRupees(monthTotals.grossSpending)} minus refunds ${formatRupees(monthTotals.refunds)}; transfers excluded)
- Net cash flow (income minus spending): ${formatRupees(monthTotals.netCashFlow)}
- Transactions this month: ${monthTotals.count}, of which ${monthTotals.unknownCount} are not classified yet and ${monthTotals.transferCount} are transfers

All recorded transactions:
- Total income (all recorded transactions; refunds and transfers are not income): ${formatRupees(allTotals.totalIncome)}
- Total spending (all recorded transactions; expenses minus refunds, transfers excluded): ${formatRupees(allTotals.totalSpending)}
- Net cash flow (total income minus total spending): ${formatRupees(allTotals.netCashFlow)}
- Number of recorded transactions: ${allTotals.count}, of which ${allTotals.unknownCount} are not classified yet (they are counted as income or spending by their direction, which is provisional - do not call them confirmed income or expenses)

- Savings goals (saved by the user):${describeGoalsForAssistant(userGoals)}
- Liabilities (saved by the user):${describeLiabilitiesForAssistant(userLiabilities)}
- Emergency fund (saved by the user): ${describeEmergencyFundForAssistant(emergencyFund)}
- Monthly budgets for ${month} (limits the user set, with their real spending that month):${describeBudgetsForAssistant(userBudgets)}
- The 10 most recent transactions, latest first (examples only; never add them up to get a total - use the totals above). "classification" is an optional analytical label; "unknown" means not labelled yet - such a transaction is counted by its direction in the totals above; a refund reduces spending and is not income; a transfer is in neither total: ${JSON.stringify(recentTransactions)}

NOT available to this chat: credit score, portfolio holdings or returns, net worth (FinSphere has no asset data), months of emergency-fund coverage and the financial health score (those come from the analysis on the Plans page and are not in this data).

Rules:
1. State figures only from the AUTHORITATIVE FINANCIAL DATA above. For "this month" questions use the "This month" figures.
2. Earlier messages in this conversation are context for understanding follow-up questions ("why?", "tell me more", "that"). They are NOT a source of financial facts: never take a figure or claim from an earlier assistant or user message as true unless it matches the data above.
3. If something is not available, say it is not available in FinSphere. Never estimate, guess or invent figures for it, and never derive a credit score from transactions.
4. Refunds are not income; they reduce spending. Transfers are neither income nor spending.
5. If asked how a figure was calculated, explain it with the definitions above.
6. You cannot open pages or perform actions. Never say you will navigate or that a page is opening; the app handles navigation itself when the user asks for it.
7. Be brief, clear and friendly; keep replies to 3-4 sentences unless a breakdown is requested. Use ₹ for amounts.`
    };

    if (isGroqConfigured()) {
      try {
        const chatModel = getChatModel(process.env);   // GROQ_CHAT_MODEL (default openai/gpt-oss-120b)
        const response = await fetch(groqChatUrl(process.env), {
          method: 'POST',
          signal: AbortSignal.timeout(30_000),
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: chatModel,
            messages: [systemMessage, ...history],
            temperature: 0.4,
            max_tokens: 500,
            ...modelRequestFields(chatModel)
          })
        });

        if (response.ok) {
          const data = await response.json();
          const reply = data?.choices?.[0]?.message?.content;
          if (typeof reply === 'string' && reply.trim()) return answer(reply);
          console.error('Groq API returned no reply text');
        } else {
          console.error('Groq API Error: status', response.status);
        }
      } catch (err) {
        console.error('Error calling Groq API:', err.name);
      }
    }

    // Deterministic fallback (no language model configured, or the call failed)
    console.log('Using fallback chatbot response');
    return answer(fallbackReply(history, ctx));
  } catch (err) {
    // Never let one request take the process down; nothing from the request is logged.
    console.error('Chat request failed:', err?.name ?? 'unknown');
    if (!res.headersSent) return res.status(500).json({ error: 'Could not answer right now' });
  }
});

// The last successful Plans analysis per signed-in user (in memory, 30 minutes, bounded). /api/plan-chat narrates THIS, never a
// context the browser sends.
const planSnapshots = createSnapshotStore();

// 6. GET /api/ml/analyze — proxies full analysis (ML models + rule engines) to the Python microservice
app.get('/api/ml/analyze', authenticate, mlLimiter, async (req, res) => {
  const months = forecastMonths(req.query.months);
  if (months === null) return res.status(400).json({ error: 'Choose a 3, 6 or 12 month forecast.' });
  try {
    // Scope ML analysis to the authenticated user's own data only (ownership always comes
    // from req.user.id, never from the client). Besides transactions, the only other real
    // inputs are the user's saved liabilities (their monthly payments) and their emergency fund.
    let userTransactions;
    try {
      userTransactions = await listTransactionsByUser(req.user.id);
    } catch (dbErr) {
      return respondDbError(res, dbErr, 'Could not load transactions');   // not an ML-service problem
    }
    // Total monthly debt payments across the user's liabilities (monthly payments only: not the
    // outstanding balances, not the interest), summed exactly in the database. FinSphere has a
    // liabilities feature, so "no saved liabilities" is a real 0 (not unknown). If the exact total is
    // too large for a finite number it cannot be sent truthfully, so it is left out (null = unavailable)
    // instead of being capped or replaced. The ML service computes
    // DTI = monthly_debt_payments / monthly income x 100.
    let monthlyDebtPayments;
    try {
      monthlyDebtPayments = await sumMonthlyPaymentsByUser(req.user.id);
    } catch (dbErr) {
      return respondDbError(res, dbErr, 'Could not load liabilities');   // not an ML-service problem
    }
    // The user's saved emergency fund amount. No record = null (unavailable: the coverage ratio is then
    // omitted); a saved 0 is sent as 0. The target is not sent: no ML consumer uses it.
    let emergencyFund;
    try {
      const record = await getEmergencyFundByUser(req.user.id);
      emergencyFund = record && Number.isFinite(record.currentAmount) ? record.currentAmount : null;
    } catch (dbErr) {
      return respondDbError(res, dbErr, 'Could not load emergency fund');   // not an ML-service problem
    }
    // Ward clustering is quadratic in row count. Refuse oversized histories explicitly;
    // never silently truncate the user's analysis or compete without a memory bound.
    if (userTransactions.length > 3000) return res.status(422).json({ error: 'Analysis supports up to 3000 transactions per account.' });
    const payload = {
      transactions: userTransactions,
      monthly_debt_payments: monthlyDebtPayments,
      emergency_fund: emergencyFund,
      n_forecast_months: months
    };

    // Only server-loaded, owner-scoped data crosses this boundary. The private Python
    // service is stateless and unauthenticated; its output cannot authorize database writes.
    const mlRes = await fetch(`${ML_SERVICE_URL}/ml/full-analysis`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!mlRes.ok) {
      // Only the status is logged and nothing upstream is returned: the body can echo the user's transactions.
      console.error('ML Service Error: HTTP', mlRes.status);
      return res.status(502).json({ error: 'ML service returned an error' });
    }

    // Failure texts reduced to "this section failed", the per-transaction cluster labels removed.
    const mlData = sanitizeAnalysis(await mlRes.json());
    planSnapshots.set(req.user.id, mlData);   // owner: the verified session user
    res.json(mlData);
  } catch (err) {
    console.error('Failed to reach ML service:', err?.name ?? 'error');
    res.status(503).json({
      error: 'ML service unavailable',
      detail: 'Make sure the Python ML service is running on port 8000 (npm run start-ml)'
    });
  }
});

// 7. POST /api/plan-chat — the LLM narrates the analysis (strict narrate-only prompt)
// Authentication is enforced. The prompt is built from the SERVER's own snapshot of the caller's last /api/ml/analyze
// (see planSnapshots): a `mlContext` sent by the browser is still accepted so old clients keep working, but it is only
// shape-checked and then IGNORED, so a forged context cannot change what the advisor says.
const NO_ANALYSIS_REPLY = 'Run the analysis first.';
app.post('/api/plan-chat', authenticate, chatLimiter, async (req, res) => {
  const { messages, mlContext: legacyClientContext } = req.body ?? {};
  const invalid = validateChatMessages(messages);
  if (invalid) return res.status(400).json({ error: invalid });
  if (legacyClientContext !== undefined && legacyClientContext !== null && !isPlainObject(legacyClientContext)) {
    return res.status(400).json({ error: 'mlContext must be an object' });
  }
  const snapshot = planSnapshots.get(req.user.id);
  if (!snapshot) return res.json({ reply: NO_ANALYSIS_REPLY });
  try {
  const mlContext = snapshot.data;
  // The data is the server's own, but the shapes are still guarded so an unexpected section cannot throw.
  const section = (v) => (isPlainObject(v) ? v : {});
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : []);
  const health = section(mlContext?.health);
  const forecast = section(mlContext?.forecast);
  const anomalies = section(mlContext?.anomalies);
  const clusters = section(mlContext?.clusters);
  const plan = section(mlContext?.plan);

  const healthScore = health.composite_score ?? 'N/A';
  const healthGrade = health.grade?.grade ?? 'N/A';
  const savingsRate = health.ratios?.savings_rate?.value ?? 'N/A';
  // dti / emergency_coverage are omitted by the ML service when the monthly debt payments or income / the
  // emergency fund or expenses are unknown. They are then left out of the prompt (no "N/A%" line) and listed as
  // not analysed, so the advisor says so instead of guessing.
  const dti = health.ratios?.dti?.value ?? null;
  const emergencyMonths = health.ratios?.emergency_coverage?.value ?? null;
  const optionalHealthLines = [
    dti !== null ? `- Debt-to-Income (monthly debt payments as a share of monthly income): ${dti}%  (benchmark: ≤36%)` : null,
    emergencyMonths !== null ? `- Emergency Coverage: ${emergencyMonths} months (benchmark: ≥6 months)` : null,
  ].filter(Boolean).map((line) => `${line}\n`).join('');
  const notAnalysed = [
    dti === null ? 'Debt-to-Income' : null,
    emergencyMonths === null ? 'Emergency Coverage' : null,
  ].filter(Boolean);
  const notAnalysedLine = notAnalysed.length
    ? `- Not analysed (no data provided): ${notAnalysed.join(', ')}\n`
    : '';

  const incomeTrend = forecast.insights?.income_momentum ?? 'unknown';
  const expenseTrend = forecast.insights?.expense_momentum ?? 'unknown';
  const projectedSavings = forecast.insights?.projected_savings_3m ?? 'N/A';
  const forecastPeriod = forecast.forecast?.months?.length ?? 3;
  const horizonSavings = forecast.insights?.projected_savings_total ?? projectedSavings;

  const anomalyCount = anomalies.total_flagged ?? 0;
  const topAnomaly = (Array.isArray(anomalies.anomalies) && isPlainObject(anomalies.anomalies[0]) ? anomalies.anomalies[0].title : null) ?? 'None';

  const dominantCluster = clusters.insights?.dominant_cluster ?? 'unknown';
  // Structured evidence per step (value, threshold, formula, inputs) so "why" answers quote the same numbers as the page.
  const evidenceLine = (e) => {
    if (!isPlainObject(e)) return '';
    const th = isPlainObject(e.threshold) ? `, threshold: ${e.threshold.comparator} ${e.threshold.value}` : '';
    const inputs = (Array.isArray(e.inputs) ? e.inputs.filter(isPlainObject) : []).map((i) => `${i.label}: ${i.value}${i.unit ? ` ${i.unit}` : ''}`).join('; ');
    return `\n   Evidence: ${String(e.label ?? '')} = ${e.value}${e.unit ? ` ${e.unit}` : ''}${th}. Formula: ${String(e.formula ?? '')}. Inputs: ${inputs || 'none'}.`;
  };
  const planSteps = (Array.isArray(plan.steps) ? plan.steps.filter(isPlainObject) : [])
    .map((s, i) => `${i+1}. [${String(s.priority ?? 'info').toUpperCase()}] (${s.method === 'rule' ? 'rule-based' : 'rule applied to an ML signal'}) ${String(s.title ?? '')}: ${String(s.description ?? '')}${evidenceLine(s.evidence)}`).join('\n');
  const hMeta = isPlainObject(health.metadata) ? health.metadata : {};
  const periodLine = isPlainObject(hMeta.period) && hMeta.period.months
    ? `- Period analysed: ${hMeta.period.months} month(s), ${hMeta.period.first_month} to ${hMeta.period.last_month}. Average monthly income: ₹${hMeta.monthly_income}; average monthly net spending: ₹${hMeta.avg_monthly_net_spending}\n`
    : '';
  const forecastCaveats = strings(plan.forecast_caveats);
  const caveatLine = forecastCaveats.length ? `- Forecast caveats: ${forecastCaveats.join(' ')}\n` : '';

  const systemPrompt = `You are the FinFlow AI Plan Advisor. Your ONLY job is to NARRATE and EXPLAIN the results 
produced by our analysis pipeline to the user in a conversational way. The health score and the plan are RULE-BASED (fixed formulas and thresholds, not machine learning); only the forecast, the anomalies and the spending clusters come from machine-learning models. You must NOT invent, assume,
or generate any financial analysis yourself — all numbers come from the pipeline output below.

Here are the EXACT outputs you must narrate:

=== FINANCIAL HEALTH SCORE (RULE-BASED, not machine learning) ===
- Composite Score: ${healthScore}/100 (Grade: ${healthGrade})
${periodLine}- Savings Rate: ${savingsRate}%  (benchmark: ≥20%)
${optionalHealthLines}${notAnalysedLine}- Strengths:${strings(health.strengths).join(', ') || 'None identified'}
- Weaknesses: ${strings(health.weaknesses).join(', ') || 'None identified'}

=== FORECAST (ML: linear regression) ===
- Income Trend: ${incomeTrend}
- Expense Trend: ${expenseTrend}
- Projected Net Savings (next 3 months): ₹${projectedSavings}
- Selected forecast period: ${forecastPeriod} months; projected net savings over that period: ₹${horizonSavings}
${caveatLine}
=== ANOMALIES (ML: Isolation Forest) ===
- Transactions Flagged: ${anomalyCount}
- Most Anomalous: "${topAnomaly}"

=== SPENDING CLUSTERS (Agglomerative, Ward) (ML) ===
- Dominant Behaviour Cluster: ${dominantCluster}
- High-Value Exposure: ${clusters.insights?.high_value_exposure_pct ?? 'N/A'}%

=== PLAN (deterministic rules; some rules read the ML outputs above) ===
${planSteps || 'No plan steps generated.'}

Guidelines:
1. ONLY discuss the numbers above. Never say "I think" or invent figures.
2. Explain actions in plain language using the recorded figures. Name models, formulas and statistical methods only when the user asks how a result was calculated.
   When asked "why" or "how was it calculated", quote the step's Evidence line.
3. Be conversational, encouraging, and specific. Use ₹ for amounts.
4. Keep responses concise (2–4 sentences) unless asked for detail.
5. If asked something not in the output above, say: "That falls outside what this analysis computed."`;

  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...recentTurns(messages)
  ];

  if (isGroqConfigured()) {
    try {
      const planModel = getChatModel(process.env);   // GROQ_CHAT_MODEL (default openai/gpt-oss-120b)
      const response = await fetch(groqChatUrl(process.env), {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: planModel,
          messages: fullMessages,
          temperature: 0.4,
          max_tokens: 600,
          ...modelRequestFields(planModel)
        })
      });

      if (response.ok) {
        const data = await response.json();
        const reply = data?.choices?.[0]?.message?.content;
        if (typeof reply === 'string' && reply.trim()) return res.json({ reply });
      }
    } catch (err) {
      console.error('Groq plan-chat error:', err.name);
    }
  }

  // Fallback: summarise plan without LLM
  const fallbackReply = typeof plan.plan_summary === 'string' && plan.plan_summary
    ? `${plan.plan_summary} The analysis identified ${Number(plan.step_count) || 0} action items for you.`
    : 'Analysis complete. Please configure Groq API key for AI narration.';
  res.json({ reply: fallbackReply });
  } catch (err) {
    console.error('Plan chat request failed:', err?.name ?? 'unknown');
    if (!res.headersSent) res.status(500).json({ error: 'Could not answer right now' });
  }
});

// Last-resort error handler: always JSON, never a stack trace, and nothing from the request body is logged.
// (Without it Express answers body-parser and multer failures with an HTML page that includes the stack
// trace whenever NODE_ENV is not "production".)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  if (err?.name === 'MulterError') return res.status(400).json({ error: 'Invalid file upload.' });
  console.error('Unhandled request error:', err?.code ?? err?.name ?? 'unknown');
  res.status(500).json({ error: 'Internal server error' });
});

// Routes only start accepting traffic once the database is ready. If PostgreSQL is
// missing, unreachable or fails to initialise, refuse to start rather than pretend that
// accounts can be saved.
try {
  await initDatabase({ legacyUsersFile: LEGACY_USERS_FILE, legacyTransactionsFile: LEGACY_TRANSACTIONS_FILE, legacyGoalsFile: LEGACY_GOALS_FILE, legacyLiabilitiesFile: LEGACY_LIABILITIES_FILE });
} catch (err) {
  console.error(`FATAL: PostgreSQL initialisation failed: ${err.message}`);
  console.error('Set DATABASE_URL to a reachable PostgreSQL database (see server/.env.example).');
  process.exit(1);
}
const httpServer = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (isGroqConfigured()) {
    console.log('Groq API Key is loaded successfully.');
  } else {
    console.log('Groq API Key is NOT configured or is default. Running in Demo mode with smart local fallbacks.');
  }
});

// Stop accepting requests before draining the pool; in-flight writes finish first.
// The deadline bounds shutdown if an upstream service or client never completes.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(1), 10_000).unref();
    httpServer.close(() => closeDatabase().then(() => process.exit(0), () => process.exit(1)));
    httpServer.closeIdleConnections();
  });
}
