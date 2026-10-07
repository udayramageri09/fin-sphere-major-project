/* eslint-disable no-undef, no-unused-vars, no-useless-assignment */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import XLSX from 'xlsx';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';

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

// ── Authentication Middleware ──────────────────────────────────────────────────
// Reads the JWT from the httpOnly cookie set at login, verifies it, and attaches
// the decoded identity to req.user.  Returns 401 for missing / invalid / expired tokens.
function authenticate(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { id: decoded.id, email: decoded.email };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
// ───────────────────────────────────────────────────────────────────────────────

app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Set up multer for file uploads using memory storage for zero-footprint.
// Limit: 5 MB — generous upper bound for any real-world bank statement
// (typical PDF/Excel statements are 50–500 KB). Blocks pathological uploads
// before they consume server memory or reach the parsing logic.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

// Prepopulated transactions list in memory (resets on server restart for simplicity, 
// but we can persist it to a local JSON file to make it real and persistent!)
const DATA_FILE = path.join(__dirname, 'server_db.json');
let transactions = [];

const defaultTransactions = [
  { id: 1, title: 'Amazon Shopping', amount: -2450.00, date: '2026-05-05', type: 'expense', category: 'Shopping' },
  { id: 2, title: 'Salary Deposit', amount: 185000.00, date: '2026-05-01', type: 'income', category: 'Salary' },
  { id: 3, title: 'Coffee Shop', amount: -350.00, date: '2026-04-30', type: 'expense', category: 'Food' },
  { id: 4, title: 'Stock Dividend', amount: 4500.00, date: '2026-04-28', type: 'income', category: 'Investment' },
];

function loadTransactions() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      transactions = JSON.parse(raw);
    } else {
      transactions = [...defaultTransactions];
      saveTransactions();
    }
  } catch (err) {
    console.error('Error loading transactions, using defaults:', err);
    transactions = [...defaultTransactions];
  }
}

function saveTransactions() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(transactions, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving transactions:', err);
  }
}

loadTransactions();

// ── Goals persistence ──────────────────────────────────────────────────────────
// Same JSON-file approach as transactions, in its own file so it never touches the
// transaction or user data. Path is __dirname-based, so it is the same file no matter
// where the server is started from.
const GOALS_FILE = path.join(__dirname, 'server_goals.json');
let goals = [];

function loadGoals() {
  if (!fs.existsSync(GOALS_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('goals file is not an array');
    goals = parsed;
  } catch (err) {
    // Keep the unreadable file for recovery instead of letting the next save overwrite it.
    console.error('Error loading goals, starting empty:', err);
    try {
      fs.renameSync(GOALS_FILE, `${GOALS_FILE.replace(/\.json$/, '')}.corrupt-${Date.now()}.json`);
    } catch (renameErr) {
      console.error('Could not set aside the unreadable goals file:', renameErr);
    }
  }
}

// Writes via a temp file + rename so a crash mid-write cannot truncate the real file.
// Returns false on failure so the caller can roll back and report an error.
function saveGoals() {
  try {
    const tmpFile = `${GOALS_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(goals, null, 2), 'utf8');
    fs.renameSync(tmpFile, GOALS_FILE);
    return true;
  } catch (err) {
    console.error('Error saving goals:', err);
    return false;
  }
}

loadGoals();

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
  }

  return {
    ok: true,
    value: {
      title,
      amount: type === 'income' ? roundedAmount : -roundedAmount, // sign always follows type
      date: raw.date,
      type,
      category
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
    const result = normalizeTransactionInput(candidate);
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

// Goals have no upper cap, so unlike roundToPaise() this must also cope with huge values
// (String(n) uses exponent form from 1e21, which that helper cannot handle). From 1e13
// up a double cannot hold paise anyway, so the value is already as precise as it gets.
const roundGoalAmount = (n) => (n >= 1e13 ? n : roundToPaise(n));

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

  // Target amount: finite and > 0 (no upper cap), rounded to paise
  const target = toAmount(raw.targetAmount);
  if (target === null) return fail('Target amount must be a number');
  if (target < 0.005) return fail('Target amount must be greater than 0 (minimum 0.01)');
  const targetAmount = roundGoalAmount(target);

  // Current amount: omitted means 0; otherwise 0 <= current <= target
  const current = raw.currentAmount === undefined ? 0 : toAmount(raw.currentAmount);
  if (current === null) return fail('Current amount must be a number');
  if (current < 0) return fail('Current amount cannot be negative');
  const currentAmount = current < 0.005 ? 0 : roundGoalAmount(current);
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
// ───────────────────────────────────────────────────────────────────────────────

// --- AUTHENTICATION ---
const USERS_FILE = path.join(__dirname, 'server_users.json');
let users = [];

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading users:', err);
  }
}
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}
loadUsers();

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  // 1. Presence check (must come first, guards against null/undefined below)
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  // 2. Type check — reject non-string values that passed the truthiness check above
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password must be strings' });
  }
  // 3. Email format check
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  // 4. Password minimum length
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  // 5. Duplicate-user check (only after input is known-clean)
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'User already exists' });
  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = { id: Date.now(), email, password: hashedPassword };
  users.push(newUser);
  saveUsers();
  res.json({ message: 'User registered successfully' });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  // 1. Presence check (must come first, guards against null/undefined below)
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  // 2. Type check — reject non-string values that passed the truthiness check above
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password must be strings' });
  }
  const user = users.find(u => u.email === email);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
  res.cookie('token', token, { httpOnly: true, secure: isProd, sameSite: isProd ? 'strict' : 'lax', maxAge: 60 * 60 * 1000 });
  res.json({ message: 'Logged in successfully', user: { id: user.id, email: user.email } });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, secure: isProd, sameSite: isProd ? 'strict' : 'lax' });
  res.json({ message: 'Logged out successfully' });
});

app.get('/api/auth/verify', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ user: decoded });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});
// ----------------------

// 1. GET /api/transactions
app.get('/api/transactions', authenticate, (req, res) => {
  // Return only the authenticated user's transactions.
  // Orphaned transactions (no userId) are intentionally excluded.
  const userTransactions = transactions.filter(t => t.userId === req.user.id);
  res.json(userTransactions);
});

// 2. POST /api/transactions (Manual Entry)
app.post('/api/transactions', authenticate, (req, res) => {
  // Validate before touching in-memory state or the persistence file.
  const result = normalizeTransactionInput(req.body);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  const newTransaction = {
    id: randomUUID(),
    userId: req.user.id, // ownership stamp — always from verified JWT, never from req.body
    ...result.value
  };

  transactions.unshift(newTransaction); // Add to beginning
  saveTransactions();
  res.status(201).json(newTransaction);
});

// 3. DELETE /api/transactions/:id
app.delete('/api/transactions/:id', authenticate, (req, res) => {
  // The route param is an opaque identifier. New rows have UUID string IDs; historical
  // rows have numeric IDs, so both sides are compared as strings (no parseInt, which
  // would read "123abc" as 123). The ownership test is part of the lookup, so another
  // user's row with the same ID can never match, and exactly one owned row is removed
  // even if legacy data repeats an ID.
  const index = transactions.findIndex(
    t => t.userId === req.user.id && String(t.id) === String(req.params.id)
  );

  // Return 404 for both non-existent and non-owned transactions.
  // This avoids revealing the existence of another user's record.
  if (index === -1) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  transactions.splice(index, 1);
  saveTransactions();
  res.json({ message: 'Transaction deleted successfully' });
});

// ── Goals ──────────────────────────────────────────────────────────────────────
// GET /api/goals - only the authenticated user's goals
app.get('/api/goals', authenticate, (req, res) => {
  res.json(goals.filter(g => g.userId === req.user.id));
});

// POST /api/goals - validate first; nothing is mutated or written on a 400
app.post('/api/goals', authenticate, (req, res) => {
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

  goals.unshift(goal); // newest first
  if (!saveGoals()) {
    goals.shift(); // roll back so memory never disagrees with the file
    return res.status(500).json({ error: 'Could not save goal' });
  }
  res.status(201).json(goal);
});

// DELETE /api/goals/:id - exactly one goal, and only one owned by the caller
app.delete('/api/goals/:id', authenticate, (req, res) => {
  const index = goals.findIndex(g => g.userId === req.user.id && String(g.id) === String(req.params.id));

  // 404 for both missing and not-yours, so another user's goal is never revealed.
  if (index === -1) {
    return res.status(404).json({ error: 'Goal not found' });
  }

  const [removed] = goals.splice(index, 1);
  if (!saveGoals()) {
    goals.splice(index, 0, removed); // roll back
    return res.status(500).json({ error: 'Could not delete goal' });
  }
  res.json({ message: 'Goal deleted successfully' });
});

// 4. POST /api/transactions/parse-statement
// Supports both pasted text (req.body.text) and file upload (req.file)
// upload.single() is called programmatically (not as inline middleware) so that
// Multer's LIMIT_FILE_SIZE error can be caught here and returned as a clean
// 413 JSON response before any parsing logic executes.
app.post('/api/transactions/parse-statement', authenticate, (req, res, next) => {
  upload.single('statementFile')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: 'File too large. Maximum allowed size is 5 MB.'
        });
      }
      // Unexpected multer error — pass to Express error handler
      return next(err);
    }
    next();
  });
}, async (req, res) => {
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
            transactions = [...savedRows, ...transactions];
            saveTransactions();
            return res.json({ success: true, count: savedRows.length, skipped, transactions: savedRows });
          }
          return res.status(400).json({
            error: `No valid transactions found: ${skipped} row(s) failed validation.`,
            skipped
          });
        }
      }

      return res.status(400).json({ error: 'Could not parse transactions from Excel. Make sure it is a valid bank statement.' });
    } catch (excelErr) {
      console.error('Error parsing Excel:', excelErr);
      return res.status(500).json({ error: 'Failed to parse Excel statement.' });
    }
  }

  // Handle standard txt/csv text statements
  if (req.file) {
    try {
      statementText = req.file.buffer.toString('utf8');
    } catch (err) {
      console.error('Error reading text file from buffer:', err);
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
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama3-8b-8192',
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
          temperature: 0.1
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
            transactions = [...rows, ...transactions];
            saveTransactions();
            return res.json({ success: true, count: rows.length, skipped, transactions: rows });
          }
          // No valid rows from the AI: fall through to the rule-based parser below.
        }
      } else {
        const errText = await response.text();
        console.error('Groq API Error during parsing:', errText);
      }
    } catch (err) {
      console.error('Error invoking Groq API for parsing:', err);
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
        transactions = [...savedRows, ...transactions];
        saveTransactions();
        return res.json({
          success: true,
          count: savedRows.length,
          skipped,
          transactions: savedRows,
          notice: 'Parsed using local backup engine'
        });
      }
      return res.status(400).json({
        error: `No valid transactions found: ${skipped} row(s) failed validation.`,
        skipped
      });
    }

    res.status(400).json({ error: 'Could not parse any transactions from the provided statement. Check the format.' });
  } catch (err) {
    console.error('Error parsing file locally:', err);
    res.status(500).json({ error: 'Failed parsing bank statement' });
  }
});

// 5. POST /api/chat
app.post('/api/chat', authenticate, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  // Scope financial context to the authenticated user only.
  // The global transactions array is never sent to the AI.
  const userTransactions = transactions.filter(t => t.userId === req.user.id);

  // Calculate current metrics to provide as context
  const totalIncome = userTransactions.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
  const totalExpenses = userTransactions.filter(t => t.amount < 0).reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const netWorth = 4500000 + (totalIncome - totalExpenses); // base ₹45,50,000 + delta
  const liabilities = 2450000;

  const currentContext = {
    netWorth,
    monthlyIncome: totalIncome,
    monthlyExpenses: totalExpenses,
    liabilities,
    transactionCount: userTransactions.length,
    recentTransactions: userTransactions.slice(0, 10)
  };

  const systemMessage = {
    role: 'system',
    content: `You are FinFlow AI assistant, a helpful financial advisor bot. 
The user is viewing their financial dashboard. 

Here is their LIVE financial context:
- Total Net Worth: ₹${currentContext.netWorth.toLocaleString('en-IN')}
- Monthly Income: ₹${currentContext.monthlyIncome.toLocaleString('en-IN')}
- Monthly Expenses: ₹${currentContext.monthlyExpenses.toLocaleString('en-IN')}
- Active Liabilities: ₹${currentContext.liabilities.toLocaleString('en-IN')}
- Credit Score: 785 out of 850 (Rating: Excellent, Linked to PAN, updated 2 days ago)
- Savings Goals:
  1. Emergency Fund: ₹3,00,000 funded of ₹5,00,000 target (60% completed)
  2. Europe Trip: ₹1,50,000 funded of ₹3,50,000 target (43% completed, Europe Trip is looking very achievable!)
- Portfolio Distribution: Mutual Funds (60%), Direct Stocks (40%)
- Live Transactions (Latest first): ${JSON.stringify(currentContext.recentTransactions)}

Guidelines:
1. Always base your replies on the above live data. When asked about spending, credit score, savings goals, or net worth, refer to their real numbers.
2. Be brief, professional, and friendly. Use relevant emojis.
3. Suggest concrete advice if they are spending too much or have low balance.
4. Let the user know they can update transactions by manual entry or parsing bank statements.

Keep responses under 3-4 sentences if possible, unless a detailed breakdown is requested.`
  };

  const fullMessages = [systemMessage, ...messages];

  if (isGroqConfigured()) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: fullMessages,
          temperature: 0.7,
          max_tokens: 500
        })
      });

      if (response.ok) {
        const data = await response.json();
        const reply = data.choices[0].message.content;
        return res.json({ reply });
      } else {
        const errText = await response.text();
        console.error('Groq API Error:', errText);
      }
    } catch (err) {
      console.error('Error calling Groq API:', err);
    }
  }

  // Fallback chatbot responses (if Groq is not configured or fails)
  console.log('Using fallback chatbot response');
  const userMessage = messages[messages.length - 1].content.toLowerCase();
  let reply = '';

  if (userMessage.includes('hello') || userMessage.includes('hi')) {
    reply = `Hi there! 👋 I am your FinFlow AI assistant. How can I assist you with your budget or transactions today?`;
  } else if (userMessage.includes('credit score') || userMessage.includes('credit')) {
    reply = `Your credit score is 785 out of 850, which is rated as Excellent! 📈 Keep maintaining good financial habits and managing your liabilities to keep it high.`;
  } else if (userMessage.includes('goal') || userMessage.includes('saving') || userMessage.includes('europe') || userMessage.includes('emergency')) {
    reply = `You currently have two savings goals:
1. Emergency Fund: ₹3,00,000 funded of ₹5,00,000 target (60% completed)
2. Europe Trip: ₹1,50,000 funded of ₹3,50,000 target (43% completed, looking very achievable!) ✈️`;
  } else if (userMessage.includes('portfolio') || userMessage.includes('mutual') || userMessage.includes('stock')) {
    reply = `Your portfolio distribution is divided into Mutual Funds (60%) and Direct Stocks (40%). 📊`;
  } else if (userMessage.includes('net worth') || userMessage.includes('wealth') || userMessage.includes('balance')) {
    reply = `Based on your live calculations, your Total Net Worth is ₹${currentContext.netWorth.toLocaleString('en-IN')}. This is calculated from your base net worth plus your active transactions! 💰`;
  } else if (userMessage.includes('spend') || userMessage.includes('expense') || userMessage.includes('cost')) {
    reply = `You have spent a total of ₹${currentContext.monthlyExpenses.toLocaleString('en-IN')} recently. Your transactions show shopping, coffee, and bills. Try to keep an eye on non-essential expenditures! 📉`;
  } else if (userMessage.includes('income') || userMessage.includes('salary') || userMessage.includes('earn')) {
    reply = `Your recent income sums up to ₹${currentContext.monthlyIncome.toLocaleString('en-IN')}. This includes your salary and other dividend gains! 💵`;
  } else if (userMessage.includes('statement') || userMessage.includes('upload') || userMessage.includes('parse')) {
    reply = `You can easily parse bank statements by going to the 'All Transactions' tab, pasting your bank statement logs, or uploading a statement text file! I'll auto-extract all of them. 📂`;
  } else {
    // Pick a random recent transaction to talk about (scoped to the authenticated user)
    const randomTx = userTransactions[Math.floor(Math.random() * userTransactions.length)];
    const txDetail = randomTx ? `For example, I see a recent transaction for "${randomTx.title}" of ₹${Math.abs(randomTx.amount).toLocaleString('en-IN')}.` : '';
    reply = `I can help you review your finances! ${txDetail} Ask me about your net worth, recent expenses, or how to import statements! 💡`;
  }

  res.json({ reply });
});

// 6. GET /api/ml/analyze — proxies full ML analysis to Python microservice
app.get('/api/ml/analyze', authenticate, async (req, res) => {
  try {
    // Scope ML analysis to the authenticated user's transactions only.
    const userTransactions = transactions.filter(t => t.userId === req.user.id);
    const payload = {
      transactions: userTransactions,
      liabilities: 2450000,
      base_net_worth: 4500000,
      emergency_fund: 300000,
      emergency_target: 500000,
      n_forecast_months: 3
    };

    const mlRes = await fetch(`${ML_SERVICE_URL}/ml/full-analysis`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!mlRes.ok) {
      const errText = await mlRes.text();
      console.error('ML Service Error:', errText);
      return res.status(502).json({ error: 'ML service returned an error', detail: errText });
    }

    const mlData = await mlRes.json();
    res.json(mlData);
  } catch (err) {
    console.error('Failed to reach ML service:', err.message);
    res.status(503).json({
      error: 'ML service unavailable',
      detail: 'Make sure the Python ML service is running on port 8000 (npm run start-ml)'
    });
  }
});

// 7. POST /api/plan-chat — LLM narrates ML results only (strict narrate-only prompt)
// Authentication is enforced. mlContext is client-provided state derived from /api/ml/analyze
// (which is now scoped to the authenticated user). Full server-side re-validation of mlContext
// is a follow-up task (tracked separately; a redesign of the plan-chat architecture is required).
app.post('/api/plan-chat', authenticate, async (req, res) => {
  const { messages, mlContext } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  // Build a tightly constrained system prompt from ML data
  const health = mlContext?.health || {};
  const forecast = mlContext?.forecast || {};
  const anomalies = mlContext?.anomalies || {};
  const clusters = mlContext?.clusters || {};
  const plan = mlContext?.plan || {};

  const healthScore = health.composite_score ?? 'N/A';
  const healthGrade = health.grade?.grade ?? 'N/A';
  const savingsRate = health.ratios?.savings_rate?.value ?? 'N/A';
  const dti = health.ratios?.dti?.value ?? 'N/A';
  const emergencyMonths = health.ratios?.emergency_coverage?.value ?? 'N/A';

  const incomeTrend = forecast.insights?.income_momentum ?? 'unknown';
  const expenseTrend = forecast.insights?.expense_momentum ?? 'unknown';
  const projectedSavings = forecast.insights?.projected_savings_3m ?? 'N/A';

  const anomalyCount = anomalies.total_flagged ?? 0;
  const topAnomaly = anomalies.anomalies?.[0]?.title ?? 'None';

  const dominantCluster = clusters.insights?.dominant_cluster ?? 'unknown';
  const planSteps = (plan.steps || []).map((s, i) => `${i+1}. [${s.priority.toUpperCase()}] ${s.title}: ${s.description}`).join('\n');

  const systemPrompt = `You are the FinFlow AI Plan Advisor. Your ONLY job is to NARRATE and EXPLAIN the results 
produced by our ML models to the user in a conversational way. You must NOT invent, assume, 
or generate any financial analysis yourself — all numbers come from our ML pipeline.

Here are the EXACT ML model outputs you must narrate:

=== FINANCIAL HEALTH SCORER (Rule-Based Ratio Engine) ===
- Composite Score: ${healthScore}/100 (Grade: ${healthGrade})
- Savings Rate: ${savingsRate}%  (benchmark: ≥20%)
- Debt-to-Income: ${dti}%  (benchmark: ≤36%)
- Emergency Coverage: ${emergencyMonths} months (benchmark: ≥6 months)
- Strengths: ${(health.strengths || []).join(', ') || 'None identified'}
- Weaknesses: ${(health.weaknesses || []).join(', ') || 'None identified'}

=== LINEAR REGRESSION FORECASTER ===
- Income Trend: ${incomeTrend}
- Expense Trend: ${expenseTrend}
- Projected Net Savings (next 3 months): ₹${projectedSavings}

=== ISOLATION FOREST ANOMALY DETECTOR ===
- Transactions Flagged: ${anomalyCount}
- Most Anomalous: "${topAnomaly}"

=== K-MEANS SPENDING CLUSTER ===
- Dominant Behaviour Cluster: ${dominantCluster}
- High-Value Exposure: ${clusters.insights?.high_value_exposure_pct ?? 'N/A'}%

=== RULE-BASED PLAN GENERATOR OUTPUT ===
${planSteps || 'No plan steps generated.'}

Guidelines:
1. ONLY discuss the above ML-computed numbers. Never say "I think" or invent figures.
2. When explaining a step, say which ML model found it (e.g., "Our Isolation Forest flagged...").
3. Be conversational, encouraging, and specific. Use ₹ for amounts.
4. Keep responses concise (2–4 sentences) unless asked for detail.
5. If asked something not in the ML output, say: "That falls outside what our ML models analysed in this run."`;

  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  if (isGroqConfigured()) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: fullMessages,
          temperature: 0.4,
          max_tokens: 600
        })
      });

      if (response.ok) {
        const data = await response.json();
        return res.json({ reply: data.choices[0].message.content });
      }
    } catch (err) {
      console.error('Groq plan-chat error:', err);
    }
  }

  // Fallback: summarise plan without LLM
  const fallbackReply = plan.plan_summary
    ? `${plan.plan_summary} The ML models identified ${plan.step_count || 0} action items for you.`
    : 'ML analysis complete. Please configure Groq API key for AI narration.';
  res.json({ reply: fallbackReply });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (isGroqConfigured()) {
    console.log('Groq API Key is loaded successfully.');
  } else {
    console.log('Groq API Key is NOT configured or is default. Running in Demo mode with smart local fallbacks.');
  }
});
