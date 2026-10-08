// PostgreSQL access for FinSphere (pg + parameterized SQL, no ORM).
// Scope: users, transactions, goals (with their contributions), liabilities (with their repayments), the emergency fund and monthly budgets (every domain is in PostgreSQL).
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');
const LEGACY_USERS_MIGRATION = 'import_users_json_v1';
const LEGACY_TRANSACTIONS_MIGRATION = 'import_transactions_json_v1';
const LEGACY_GOALS_MIGRATION = 'import_goals_json_v1';
const LEGACY_LIABILITIES_MIGRATION = 'import_liabilities_json_v1';
// Arbitrary constant: serializes schema setup/migration across concurrently starting instances.
const INIT_LOCK_ID = 703939;

let pool = null;

// Same rule at every entry point (register, login, import): trim, then lower-case.
export const normalizeEmail = (email) => email.trim().toLowerCase();

function sslConfig(env) {
  // An explicit sslmode in the URL is honoured by pg itself.
  if (/[?&]sslmode=/.test(env.DATABASE_URL)) return undefined;
  const flag = (env.DATABASE_SSL ?? '').toLowerCase();
  if (flag === 'false') return undefined;
  if (flag === 'true' || env.NODE_ENV === 'production') {
    // Certificate verification stays ON. A private CA can be supplied; verification is never switched off.
    return env.DATABASE_SSL_CA ? { rejectUnauthorized: true, ca: env.DATABASE_SSL_CA } : { rejectUnauthorized: true };
  }
  return undefined;
}

function toUser(row) {
  const id = Number(row.id);
  if (!Number.isSafeInteger(id)) throw new Error('users.id is outside the safe integer range');
  return { id, email: row.email, passwordHash: row.password_hash };
}

// Creates the pool, applies the schema and runs the one-time legacy users import.
// Throws (never swallows) so the caller can refuse to start.
export async function initDatabase({ env = process.env, legacyUsersFile, legacyTransactionsFile, legacyGoalsFile, legacyLiabilitiesFile } = {}) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  pool = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: sslConfig(env), max: 10, connectionTimeoutMillis: 10_000 });
  // An error on an idle client must not crash the process; the next query reports a real failure.
  pool.on('error', (err) => console.error('PostgreSQL idle client error:', err.message));

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [INIT_LOCK_ID]);
    try {
      await client.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));
      if (legacyUsersFile) await importLegacyUsers(client, legacyUsersFile);
      // After users: transactions reference them.
      if (legacyTransactionsFile) await importLegacyTransactions(client, legacyTransactionsFile);
      if (legacyGoalsFile) await importLegacyGoals(client, legacyGoalsFile);
      if (legacyLiabilitiesFile) await importLegacyLiabilities(client, legacyLiabilitiesFile);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [INIT_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

// One-time import of server_users.json. Existing ids are kept (other JSON data is owned by
// them and issued JWTs carry them); emails are normalized; hashes are copied as they are.
// All-or-nothing, and recorded in schema_migrations so it never runs twice.
async function importLegacyUsers(client, file) {
  const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [LEGACY_USERS_MIGRATION]);
  if (done.rowCount > 0) return;

  let legacy = [];
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));   // corrupt file: throw, do not mark as migrated
    if (!Array.isArray(parsed)) throw new Error('legacy users file is not an array');
    legacy = parsed;
  }

  await client.query('BEGIN');
  try {
    let imported = 0, skipped = 0;
    for (const u of legacy) {
      const valid = u && Number.isSafeInteger(u.id) && u.id > 0 && typeof u.email === 'string' && typeof u.password === 'string';
      if (!valid) { skipped++; console.warn('Legacy user import: skipped a malformed record'); continue; }
      const email = normalizeEmail(u.email);
      // Legacy ids are Date.now() values, so they double as the creation time when plausible.
      const createdAt = new Date(u.id > 1e12 && u.id < 4e12 ? u.id : Date.now()).toISOString();
      try {
        await client.query('SAVEPOINT legacy_user');
        const r = await client.query(
          `INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [u.id, email, u.password, createdAt]);
        await client.query('RELEASE SAVEPOINT legacy_user');
        if (r.rowCount === 1) imported++; else { skipped++; console.warn(`Legacy user import: user id ${u.id} skipped (id or normalized email already exists)`); }
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT legacy_user');
        skipped++;
        console.warn(`Legacy user import: user id ${u.id} skipped (${err.code ?? err.message})`);
      }
    }
    // New accounts must get ids above every imported one.
    await client.query(
      `SELECT setval(pg_get_serial_sequence('users', 'id'),
                     (SELECT COALESCE(MAX(id), 1) FROM users),
                     (SELECT COUNT(*) > 0 FROM users))`);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [LEGACY_USERS_MIGRATION]);
    await client.query('COMMIT');
    console.log(`Legacy users import: ${imported} imported, ${skipped} skipped.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export class DuplicateEmailError extends Error {}

// email must already be normalized by the caller (normalizeEmail).
export async function createUser(email, passwordHash) {
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, password_hash',
      [email, passwordHash]);
    return toUser(rows[0]);
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'users_email_unique') throw new DuplicateEmailError();
    throw err;
  }
}

export async function findUserByEmail(email) {
  const { rows } = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
  return rows.length ? toUser(rows[0]) : null;
}

// ── Transactions ───────────────────────────────────────────────────────────────
// Rows come back in the shape the API has always returned: amount as a Number, date as
// 'YYYY-MM-DD' text (selected with to_char so no time-zone conversion can shift it), and
// the id as the stored text (historical numeric ids therefore read back as numeric strings).
const TX_COLUMNS = `id, user_id, title, amount, to_char(date, 'YYYY-MM-DD') AS date, type, category`;

function toTransaction(row) {
  return {
    id: row.id,
    userId: Number(row.user_id),
    title: row.title,
    amount: Number(row.amount),   // NUMERIC(14,2): at most 14 digits, so the double is exact to the paisa
    date: row.date,
    type: row.type,
    category: row.category,
  };
}

// Newest first, like the old in-memory list (new rows were unshifted onto the front).
export async function listTransactionsByUser(userId) {
  const { rows } = await pool.query(`SELECT ${TX_COLUMNS} FROM transactions WHERE user_id = $1 ORDER BY seq DESC`, [userId]);
  return rows.map(toTransaction);
}

// Inserts `rows` (already validated; shape {id, userId, title, amount, date, type, category}) in one
// statement, so either all land or none do. The first element gets the highest seq, i.e. it is listed
// first, exactly as `[...rows, ...existing]` ordered the old array.
async function insertTransactions(db, rows) {
  await db.query(
    `INSERT INTO transactions (id, user_id, title, amount, type, date, category)
     SELECT id, user_id, title, amount, type, date::date, category
     FROM unnest($1::text[], $2::bigint[], $3::text[], $4::numeric[], $5::text[], $6::text[], $7::text[])
          WITH ORDINALITY AS t(id, user_id, title, amount, type, date, category, ord)
     ORDER BY ord DESC`,
    [
      rows.map((r) => String(r.id)),
      rows.map((r) => r.userId),
      rows.map((r) => r.title),
      rows.map((r) => r.amount.toFixed(2)),
      rows.map((r) => r.type),
      rows.map((r) => r.date),
      rows.map((r) => r.category),
    ]);
}

export const createTransaction = (tx) => insertTransactions(pool, [tx]);

export async function createTransactionsBatch(rows) {
  if (rows.length > 0) await insertTransactions(pool, rows);
}

// Removes exactly one row: the owner's first match in list order. The owner is part of the
// lookup, so another user's row with the same id can never be touched. Returns true if a row was removed.
export async function deleteTransactionByUserAndId(userId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM transactions
     WHERE seq = (SELECT seq FROM transactions WHERE user_id = $1 AND id = $2 ORDER BY seq DESC LIMIT 1)
       AND user_id = $1`,
    [userId, String(id)]);
  return rowCount > 0;
}

// Decides whether one server_db.json record can become a database row WITHOUT being changed.
// Historical data is never rewritten to make it fit: id, userId, title, signed amount, type, date and
// category are stored exactly as they were. A record that cannot be stored as-is (or that breaks the
// table's invariants) is skipped and counted, never repaired. The one representation step is an
// id that was a JSON number, which is stored as its decimal text (7 -> '7'); that is how every id is stored.
function legacyTransactionRow(t, knownUserIds) {
  if (t === null || typeof t !== 'object' || Array.isArray(t)) return { reason: 'malformed' };
  if (t.userId === undefined || t.userId === null) return { reason: 'no owner' };
  if (!Number.isSafeInteger(t.userId) || !knownUserIds.has(t.userId)) return { reason: 'unknown owner' };
  const hasNul = (v) => v.includes('\u0000');   // PostgreSQL text cannot hold NUL
  const id = typeof t.id === 'number' ? (Number.isFinite(t.id) ? String(t.id) : '') : t.id;
  if (typeof id !== 'string' || id.length < 1 || id.length > 64 || hasNul(id)) return { reason: 'malformed' };
  // Title: must already be trimmed and 1-120 characters (the table's constraint); not trimmed here.
  if (typeof t.title !== 'string' || t.title.length < 1 || t.title.length > 120 || t.title !== t.title.trim() || hasNul(t.title)) return { reason: 'malformed' };
  // Amount: already a number with at most 2 decimals, non-zero, within NUMERIC(14,2); not rounded here.
  const amount = t.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.abs(amount) < 0.01 || Math.abs(amount) >= 1e12 || Number(amount.toFixed(2)) !== amount) return { reason: 'malformed' };
  // Type: exactly 'income' or 'expense' (not case-folded), and the sign must already agree with it.
  if (!((t.type === 'income' && amount > 0) || (t.type === 'expense' && amount < 0))) return { reason: 'malformed' };
  if (typeof t.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) return { reason: 'malformed' };
  const parsed = new Date(`${t.date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== t.date) return { reason: 'malformed' };
  // Category: kept verbatim; a missing or blank category is not replaced by 'General' (that is a rule for new input).
  if (typeof t.category !== 'string' || t.category.trim() === '' || hasNul(t.category)) return { reason: 'malformed' };
  return { row: { id, userId: t.userId, title: t.title, amount, date: t.date, type: t.type, category: t.category } };
}

// One-time import of server_db.json. Same rules as the users import: all-or-nothing, recorded in
// schema_migrations so it never runs twice, an unreadable file refuses startup, and a record that
// cannot be stored exactly as it is (see legacyTransactionRow) is skipped with a logged count (never its contents). Ids and owners are kept
// exactly; the file's order is kept (its first element is the newest and is listed first).
// Records with no owner were never served by any endpoint, so skipping them loses nothing visible.
async function importLegacyTransactions(client, file) {
  const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [LEGACY_TRANSACTIONS_MIGRATION]);
  if (done.rowCount > 0) return;

  let legacy = [];
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));   // corrupt file: throw, do not mark as migrated
    if (!Array.isArray(parsed)) throw new Error('legacy transactions file is not an array');
    legacy = parsed;
  }

  await client.query('BEGIN');
  try {
    const knownUserIds = new Set((await client.query('SELECT id FROM users')).rows.map((r) => Number(r.id)));
    const rows = [];
    const skipped = { 'no owner': 0, 'unknown owner': 0, malformed: 0 };
    for (const t of legacy) {
      const result = legacyTransactionRow(t, knownUserIds);
      if (result.row) rows.push(result.row); else skipped[result.reason]++;
    }
    if (rows.length > 0) await insertTransactions(client, rows);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [LEGACY_TRANSACTIONS_MIGRATION]);
    await client.query('COMMIT');
    const skippedTotal = skipped['no owner'] + skipped['unknown owner'] + skipped.malformed;
    console.log(`Legacy transactions import: ${rows.length} imported, ${skippedTotal} skipped (${skipped['no owner']} without an owner, ${skipped['unknown owner']} with an unknown owner, ${skipped.malformed} malformed).`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// ── Goals ──────────────────────────────────────────────────────────────────────
// Same API shape as before: amounts as JS numbers, targetDate as 'YYYY-MM-DD' text, createdAt as an ISO string.
// NUMERIC has no precision limit here, so a Number survives the round trip (its shortest decimal form is stored
// and parsed back to the same double); values with paise stay exact, there is no float arithmetic in SQL.
const GOAL_COLUMNS = `id, user_id, title, target_amount, current_amount, to_char(target_date, 'YYYY-MM-DD') AS target_date, created_at`;

function toGoal(row) {
  return {
    id: row.id,
    userId: Number(row.user_id),
    title: row.title,
    targetAmount: Number(row.target_amount),
    currentAmount: Number(row.current_amount),
    targetDate: row.target_date,
    createdAt: row.created_at.toISOString(),
  };
}

// Newest first, like the old in-memory list.
export async function listGoalsByUser(userId) {
  const { rows } = await pool.query(`SELECT ${GOAL_COLUMNS} FROM goals WHERE user_id = $1 ORDER BY seq DESC`, [userId]);
  return rows.map(toGoal);
}

// Inserts validated goals ({id, userId, title, targetAmount, currentAmount, targetDate, createdAt}) in one
// statement (all or none). The first element gets the highest seq, i.e. it is listed first.
async function insertGoals(db, rows) {
  await db.query(
    `INSERT INTO goals (id, user_id, title, target_amount, current_amount, target_date, created_at)
     SELECT id, user_id, title, target_amount, current_amount, target_date::date, created_at::timestamptz
     FROM unnest($1::text[], $2::bigint[], $3::text[], $4::numeric[], $5::numeric[], $6::text[], $7::text[])
          WITH ORDINALITY AS t(id, user_id, title, target_amount, current_amount, target_date, created_at, ord)
     ORDER BY ord DESC`,
    [
      rows.map((r) => r.id),
      rows.map((r) => r.userId),
      rows.map((r) => r.title),
      rows.map((r) => String(r.targetAmount)),     // shortest round-trip decimal text, e.g. '1234.56' or '1e+300'
      rows.map((r) => String(r.currentAmount)),
      rows.map((r) => r.targetDate),
      rows.map((r) => r.createdAt),
    ]);
}

export const createGoal = (goal) => insertGoals(pool, [goal]);

// Removes exactly one goal and only one owned by userId (the owner is part of the lookup).
export async function deleteGoalByUserAndId(userId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM goals
     WHERE seq = (SELECT seq FROM goals WHERE user_id = $1 AND id = $2 ORDER BY seq DESC LIMIT 1)
       AND user_id = $1`,
    [userId, String(id)]);
  return rowCount > 0;
}

// ── Goal contributions ─────────────────────────────────────────────────────────
const CONTRIBUTION_COLUMNS = 'id, user_id, goal_id, amount, created_at';

function toContribution(row) {
  return {
    id: row.id,
    userId: Number(row.user_id),
    goalId: row.goal_id,
    amount: Number(row.amount),
    createdAt: row.created_at.toISOString(),
  };
}

// Records one contribution and raises the goal's balance by exactly that amount, atomically:
//   1. BEGIN, then lock the owner's goal row (SELECT ... FOR UPDATE). Concurrent contributions to the same goal
//      queue here, so each one sees the balance left by the previous one and none can push it past the target.
//   2. The new balance and the "does it exceed the target" test are computed in exact NUMERIC arithmetic.
//   3. Insert the contribution row and update the balance; COMMIT. Any failure rolls both back.
// Returns { status: 'ok', goal, contribution } | { status: 'not_found' } (missing or not the owner's) |
// { status: 'complete' } (balance already at the target) | { status: 'exceeds', remaining } (nothing is stored).
export async function addGoalContribution({ userId, goalId, amount, contributionId, now }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT current_amount, target_amount, (current_amount + $3::numeric) > target_amount AS exceeds,
              (target_amount - current_amount) AS remaining
       FROM goals WHERE user_id = $1 AND id = $2 FOR UPDATE`,
      [userId, String(goalId), String(amount)]);
    if (locked.rowCount === 0) { await client.query('ROLLBACK'); return { status: 'not_found' }; }
    const { exceeds, remaining } = locked.rows[0];
    if (exceeds) {
      await client.query('ROLLBACK');
      return Number(remaining) === 0 ? { status: 'complete' } : { status: 'exceeds', remaining: Number(remaining) };
    }
    const inserted = await client.query(
      `INSERT INTO goal_contributions (id, user_id, goal_id, amount, created_at)
       VALUES ($1, $2, $3, $4::numeric, $5::timestamptz) RETURNING ${CONTRIBUTION_COLUMNS}`,
      [contributionId, userId, String(goalId), String(amount), now]);
    const updated = await client.query(
      `UPDATE goals SET current_amount = current_amount + $3::numeric
       WHERE user_id = $1 AND id = $2 RETURNING ${GOAL_COLUMNS}`,
      [userId, String(goalId), String(amount)]);
    await client.query('COMMIT');
    return { status: 'ok', goal: toGoal(updated.rows[0]), contribution: toContribution(inserted.rows[0]) };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the original error is what matters */ }
    throw err;
  } finally {
    client.release();
  }
}

// The owner's contributions to one goal, newest first; null if the goal is missing or not theirs.
export async function listGoalContributions(userId, goalId) {
  const owned = await pool.query('SELECT 1 FROM goals WHERE user_id = $1 AND id = $2', [userId, String(goalId)]);
  if (owned.rowCount === 0) return null;
  const { rows } = await pool.query(
    `SELECT ${CONTRIBUTION_COLUMNS} FROM goal_contributions WHERE user_id = $1 AND goal_id = $2 ORDER BY seq DESC`,
    [userId, String(goalId)]);
  return rows.map(toContribution);
}

// Whether one server_goals.json record can become a row WITHOUT being changed. Nothing is trimmed, rounded,
// defaulted or invented: id, userId, title, targetAmount, currentAmount, targetDate and createdAt are stored
// exactly as they were, or the record is skipped and counted.
function legacyGoalRow(g, knownUserIds) {
  if (g === null || typeof g !== 'object' || Array.isArray(g)) return { reason: 'malformed' };
  if (g.userId === undefined || g.userId === null) return { reason: 'no owner' };
  if (!Number.isSafeInteger(g.userId) || !knownUserIds.has(g.userId)) return { reason: 'unknown owner' };
  const hasNul = (v) => v.includes('\u0000');   // PostgreSQL text cannot hold NUL
  if (typeof g.id !== 'string' || g.id.length < 1 || g.id.length > 64 || hasNul(g.id)) return { reason: 'malformed' };
  if (typeof g.title !== 'string' || g.title.length < 1 || g.title.length > 120 || g.title !== g.title.trim() || hasNul(g.title)) return { reason: 'malformed' };
  const { targetAmount: target, currentAmount: current } = g;
  if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) return { reason: 'malformed' };
  if (typeof current !== 'number' || !Number.isFinite(current) || current < 0 || current > target) return { reason: 'malformed' };
  if (typeof g.targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(g.targetDate)) return { reason: 'malformed' };
  const day = new Date(`${g.targetDate}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== g.targetDate) return { reason: 'malformed' };
  // createdAt must already be the canonical ISO timestamp the API produced; a missing one is not invented.
  if (typeof g.createdAt !== 'string' || Number.isNaN(Date.parse(g.createdAt)) || new Date(g.createdAt).toISOString() !== g.createdAt) return { reason: 'malformed' };
  return { row: { id: g.id, userId: g.userId, title: g.title, targetAmount: target, currentAmount: current, targetDate: g.targetDate, createdAt: g.createdAt } };
}

// One-time import of server_goals.json; same rules as the transactions import (all-or-nothing, recorded in
// schema_migrations, unreadable file refuses startup, skipped records are counted and never logged, file untouched,
// the file's order is kept: its first element is the newest and is listed first).
async function importLegacyGoals(client, file) {
  const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [LEGACY_GOALS_MIGRATION]);
  if (done.rowCount > 0) return;

  let legacy = [];
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));   // corrupt file: throw, do not mark as migrated
    if (!Array.isArray(parsed)) throw new Error('legacy goals file is not an array');
    legacy = parsed;
  }

  await client.query('BEGIN');
  try {
    const knownUserIds = new Set((await client.query('SELECT id FROM users')).rows.map((r) => Number(r.id)));
    const rows = [];
    const seen = new Set();
    const skipped = { 'no owner': 0, 'unknown owner': 0, malformed: 0 };
    for (const g of legacy) {
      const result = legacyGoalRow(g, knownUserIds);
      if (result.row && seen.has(`${result.row.userId}:${result.row.id}`)) { skipped.malformed++; continue; }   // repeated id for one owner
      if (result.row) { seen.add(`${result.row.userId}:${result.row.id}`); rows.push(result.row); } else skipped[result.reason]++;
    }
    if (rows.length > 0) await insertGoals(client, rows);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [LEGACY_GOALS_MIGRATION]);
    await client.query('COMMIT');
    const skippedTotal = skipped['no owner'] + skipped['unknown owner'] + skipped.malformed;
    console.log(`Legacy goals import: ${rows.length} imported, ${skippedTotal} skipped (${skipped['no owner']} without an owner, ${skipped['unknown owner']} with an unknown owner, ${skipped.malformed} malformed).`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// ── Liabilities ────────────────────────────────────────────────────────────────
// Same API shape as before: money and the rate as JS numbers, createdAt as an ISO string. NUMERIC has no
// precision limit, so a Number survives the round trip (its shortest decimal form is stored and parsed back
// to the same double) and nothing is computed in floating point inside SQL.
const LIABILITY_TYPES = ['home_loan', 'personal_loan', 'vehicle_loan', 'education_loan', 'credit_card', 'other'];
const LIABILITY_COLUMNS = 'id, user_id, name, type, outstanding_amount, interest_rate, monthly_payment, created_at';

function toLiability(row) {
  return {
    id: row.id,
    userId: Number(row.user_id),
    name: row.name,
    type: row.type,
    outstandingAmount: Number(row.outstanding_amount),
    interestRate: Number(row.interest_rate),
    monthlyPayment: Number(row.monthly_payment),
    createdAt: row.created_at.toISOString(),
  };
}

// Newest first, like the old in-memory list.
export async function listLiabilitiesByUser(userId) {
  const { rows } = await pool.query(`SELECT ${LIABILITY_COLUMNS} FROM liabilities WHERE user_id = $1 ORDER BY seq DESC`, [userId]);
  return rows.map(toLiability);
}

// Total of one user's monthly payments on debts that are still owed (outstanding_amount > 0: a fully repaid
// liability keeps its row but no longer has a payment due). Nothing else contributes: not the balances, not the
// rates, not the repayments. Summed exactly in SQL. No rows -> 0, a real zero. Returns null if the exact total is too large for
// a finite number, so the caller can report "unavailable" instead of a capped or fake value.
export async function sumMonthlyPaymentsByUser(userId) {
  const { rows } = await pool.query('SELECT COALESCE(SUM(monthly_payment), 0)::text AS total FROM liabilities WHERE user_id = $1 AND outstanding_amount > 0', [userId]);
  const total = Number(rows[0].total);
  return Number.isFinite(total) ? total : null;
}

// Inserts validated liabilities in one statement (all or none). The first element gets the highest seq,
// i.e. it is listed first.
async function insertLiabilities(db, rows) {
  await db.query(
    `INSERT INTO liabilities (id, user_id, name, type, outstanding_amount, interest_rate, monthly_payment, created_at)
     SELECT id, user_id, name, type, outstanding_amount, interest_rate, monthly_payment, created_at::timestamptz
     FROM unnest($1::text[], $2::bigint[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[], $8::text[])
          WITH ORDINALITY AS t(id, user_id, name, type, outstanding_amount, interest_rate, monthly_payment, created_at, ord)
     ORDER BY ord DESC`,
    [
      rows.map((r) => r.id),
      rows.map((r) => r.userId),
      rows.map((r) => r.name),
      rows.map((r) => r.type),
      rows.map((r) => String(r.outstandingAmount)),   // shortest round-trip decimal text, e.g. '1234.56' or '1e+300'
      rows.map((r) => String(r.interestRate)),
      rows.map((r) => String(r.monthlyPayment)),
      rows.map((r) => r.createdAt),
    ]);
}

export const createLiability = (liability) => insertLiabilities(pool, [liability]);

// Removes exactly one liability and only one owned by userId (the owner is part of the lookup).
export async function deleteLiabilityByUserAndId(userId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM liabilities
     WHERE seq = (SELECT seq FROM liabilities WHERE user_id = $1 AND id = $2 ORDER BY seq DESC LIMIT 1)
       AND user_id = $1`,
    [userId, String(id)]);
  return rowCount > 0;
}

// ── Liability repayments ───────────────────────────────────────────────────────
const REPAYMENT_COLUMNS = 'id, user_id, liability_id, amount, created_at';

function toRepayment(row) {
  return {
    id: row.id,
    userId: Number(row.user_id),
    liabilityId: row.liability_id,
    amount: Number(row.amount),
    createdAt: row.created_at.toISOString(),
  };
}

// Records one repayment and lowers the liability's outstanding balance by exactly that amount, atomically:
//   1. BEGIN, then lock the owner's liability row (SELECT ... FOR UPDATE). Concurrent repayments to the same
//      liability queue here, so each sees the balance left by the previous one and none can take it below 0.
//   2. "Is it already paid off" and "does the repayment exceed the balance" are tested in exact NUMERIC arithmetic.
//   3. Insert the repayment row, reduce the balance, COMMIT. Any failure rolls both back.
// Returns { status: 'ok', liability, repayment } | { status: 'not_found' } (missing or not the owner's) |
// { status: 'paid_off' } | { status: 'exceeds', outstanding } (nothing is stored). The liability is never deleted.
export async function repayLiability({ userId, liabilityId, amount, repaymentId, now }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT outstanding_amount, outstanding_amount = 0 AS paid_off, $3::numeric > outstanding_amount AS exceeds
       FROM liabilities WHERE user_id = $1 AND id = $2 FOR UPDATE`,
      [userId, String(liabilityId), String(amount)]);
    if (locked.rowCount === 0) { await client.query('ROLLBACK'); return { status: 'not_found' }; }
    const { paid_off: paidOff, exceeds, outstanding_amount: outstanding } = locked.rows[0];
    if (paidOff) { await client.query('ROLLBACK'); return { status: 'paid_off' }; }
    if (exceeds) { await client.query('ROLLBACK'); return { status: 'exceeds', outstanding: Number(outstanding) }; }
    const inserted = await client.query(
      `INSERT INTO liability_repayments (id, user_id, liability_id, amount, created_at)
       VALUES ($1, $2, $3, $4::numeric, $5::timestamptz) RETURNING ${REPAYMENT_COLUMNS}`,
      [repaymentId, userId, String(liabilityId), String(amount), now]);
    const updated = await client.query(
      `UPDATE liabilities SET outstanding_amount = outstanding_amount - $3::numeric
       WHERE user_id = $1 AND id = $2 RETURNING ${LIABILITY_COLUMNS}`,
      [userId, String(liabilityId), String(amount)]);
    await client.query('COMMIT');
    return { status: 'ok', liability: toLiability(updated.rows[0]), repayment: toRepayment(inserted.rows[0]) };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the original error is what matters */ }
    throw err;
  } finally {
    client.release();
  }
}

// The owner's repayments toward one liability, newest first; null if the liability is missing or not theirs.
export async function listLiabilityRepayments(userId, liabilityId) {
  const owned = await pool.query('SELECT 1 FROM liabilities WHERE user_id = $1 AND id = $2', [userId, String(liabilityId)]);
  if (owned.rowCount === 0) return null;
  const { rows } = await pool.query(
    `SELECT ${REPAYMENT_COLUMNS} FROM liability_repayments WHERE user_id = $1 AND liability_id = $2 ORDER BY seq DESC`,
    [userId, String(liabilityId)]);
  return rows.map(toRepayment);
}

// Whether one server_liabilities.json record can become a row WITHOUT being changed. Nothing is trimmed,
// case-folded, rounded, clamped, defaulted or invented: every field is stored exactly as it was, or the record
// is skipped and counted.
function legacyLiabilityRow(l, knownUserIds) {
  if (l === null || typeof l !== 'object' || Array.isArray(l)) return { reason: 'malformed' };
  if (l.userId === undefined || l.userId === null) return { reason: 'no owner' };
  if (!Number.isSafeInteger(l.userId) || !knownUserIds.has(l.userId)) return { reason: 'unknown owner' };
  const hasNul = (v) => v.includes('\u0000');   // PostgreSQL text cannot hold NUL
  if (typeof l.id !== 'string' || l.id.length < 1 || l.id.length > 64 || hasNul(l.id)) return { reason: 'malformed' };
  if (typeof l.name !== 'string' || l.name.length < 1 || l.name.length > 120 || l.name !== l.name.trim() || hasNul(l.name)) return { reason: 'malformed' };
  if (!LIABILITY_TYPES.includes(l.type)) return { reason: 'malformed' };
  const { outstandingAmount: owed, interestRate: rate, monthlyPayment: payment } = l;
  if (typeof owed !== 'number' || !Number.isFinite(owed) || owed <= 0) return { reason: 'malformed' };
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 100) return { reason: 'malformed' };
  if (typeof payment !== 'number' || !Number.isFinite(payment) || payment < 0) return { reason: 'malformed' };
  // createdAt must already be the canonical ISO timestamp the API produced; a missing one is not invented.
  if (typeof l.createdAt !== 'string' || Number.isNaN(Date.parse(l.createdAt)) || new Date(l.createdAt).toISOString() !== l.createdAt) return { reason: 'malformed' };
  return { row: { id: l.id, userId: l.userId, name: l.name, type: l.type, outstandingAmount: owed, interestRate: rate, monthlyPayment: payment, createdAt: l.createdAt } };
}

// One-time import of server_liabilities.json; same rules as the goals import (all-or-nothing, recorded in
// schema_migrations, unreadable file refuses startup, skipped records are counted and never logged, file untouched,
// the file's order is kept: its first element is the newest and is listed first).
async function importLegacyLiabilities(client, file) {
  const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [LEGACY_LIABILITIES_MIGRATION]);
  if (done.rowCount > 0) return;

  let legacy = [];
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));   // corrupt file: throw, do not mark as migrated
    if (!Array.isArray(parsed)) throw new Error('legacy liabilities file is not an array');
    legacy = parsed;
  }

  await client.query('BEGIN');
  try {
    const knownUserIds = new Set((await client.query('SELECT id FROM users')).rows.map((r) => Number(r.id)));
    const rows = [];
    const seen = new Set();
    const skipped = { 'no owner': 0, 'unknown owner': 0, malformed: 0 };
    for (const l of legacy) {
      const result = legacyLiabilityRow(l, knownUserIds);
      if (!result.row) { skipped[result.reason]++; continue; }
      const key = `${result.row.userId}:${result.row.id}`;
      if (seen.has(key)) { skipped.malformed++; continue; }   // repeated id for one owner
      seen.add(key);
      rows.push(result.row);
    }
    if (rows.length > 0) await insertLiabilities(client, rows);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [LEGACY_LIABILITIES_MIGRATION]);
    await client.query('COMMIT');
    const skippedTotal = skipped['no owner'] + skipped['unknown owner'] + skipped.malformed;
    console.log(`Legacy liabilities import: ${rows.length} imported, ${skippedTotal} skipped (${skipped['no owner']} without an owner, ${skipped['unknown owner']} with an unknown owner, ${skipped.malformed} malformed).`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// ── Monthly category budgets ───────────────────────────────────────────────────
// API shape: category = the label the user typed, categoryKey = the canonical key (lower(btrim(label))) used to
// match transactions, month = 'YYYY-MM'. The month is a DATE (first day) in the database; to_char keeps any
// time-zone conversion out of it.
const BUDGET_COLUMNS = "id, user_id, to_char(month, 'YYYY-MM') AS month, label, category, amount, created_at, updated_at";

// The same columns, qualified with the table alias for the joined query.
const BUDGET_COLUMNS_B = "b.id, b.user_id, to_char(b.month, 'YYYY-MM') AS month, b.label, b.category, b.amount, b.created_at, b.updated_at";

function toBudget(row) {
  return {
    id: row.id,
    userId: Number(row.user_id),
    month: row.month,
    category: row.label,
    categoryKey: row.category,
    amount: Number(row.amount),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// The owner's budgets for one month ('YYYY-MM'), each with its real spending, in ONE query:
//   budgets LEFT JOIN (the owner's expense transactions of that calendar month, summed per canonical category).
// - Expense rows are identified by type = 'expense' (the table also guarantees their amount is negative), and the
//   total is negated so actualSpent is a positive spending figure. Income never counts.
// - A transaction belongs to a budget when lower(btrim(transaction.category)) = budgets.category - the same rule the
//   budgets use for their own key, with no aliases (Food = FOOD = " food ", but not Foods and not Dining).
// - The month window is [first day, first day of the next month) on the DATE column: no time zone is involved.
// - Everything is exact NUMERIC arithmetic; status compares the UNROUNDED values; percentUsed is only rounded for display.
// Ordered by category key (unique per user / month), so the order is fully deterministic.
export async function listBudgetsByUserAndMonth(userId, month) {
  const { rows } = await pool.query(
    `WITH m AS (SELECT ($2 || '-01')::date AS first_day),
          spent AS (
            SELECT lower(btrim(t.category)) AS category, -SUM(t.amount) AS total
            FROM transactions t, m
            WHERE t.user_id = $1 AND t.type = 'expense'
              AND t.date >= m.first_day AND t.date < (m.first_day + INTERVAL '1 month')
            GROUP BY lower(btrim(t.category)))
     SELECT ${BUDGET_COLUMNS_B},
            COALESCE(s.total, 0)::text AS actual_spent,
            (b.amount - COALESCE(s.total, 0))::text AS remaining,
            ROUND(COALESCE(s.total, 0) * 100 / b.amount, 2)::text AS percent_used,
            CASE WHEN COALESCE(s.total, 0) < b.amount THEN 'under'
                 WHEN COALESCE(s.total, 0) = b.amount THEN 'at'
                 ELSE 'over' END AS status
     FROM budgets b CROSS JOIN m
     LEFT JOIN spent s ON s.category = b.category
     WHERE b.user_id = $1 AND b.month = m.first_day
     ORDER BY b.category`,
    [userId, month]);
  return rows.map((row) => ({
    ...toBudget(row),
    actualSpent: Number(row.actual_spent),
    remaining: Number(row.remaining),
    percentUsed: Number(row.percent_used),
    status: row.status,
  }));
}

// Create-or-update the budget for (user, month, canonical category) in one statement. created_at and id are kept
// on update; label (display text), amount and updated_at are replaced. Returns { budget, created }.
export async function upsertBudget({ id, userId, month, label, amount, now }) {
  const { rows } = await pool.query(
    `INSERT INTO budgets (id, user_id, month, label, amount, created_at, updated_at)
     VALUES ($1, $2, ($3 || '-01')::date, $4, $5::numeric, $6::timestamptz, $6::timestamptz)
     ON CONFLICT (user_id, month, category) DO UPDATE
       SET label = EXCLUDED.label, amount = EXCLUDED.amount, updated_at = EXCLUDED.updated_at
     RETURNING ${BUDGET_COLUMNS}, (xmax = 0) AS inserted`,
    [id, userId, month, label, String(amount), now]);
  return { budget: toBudget(rows[0]), created: rows[0].inserted };
}

// Removes exactly one budget, and only one owned by userId (id is the primary key). Returns true if removed.
export async function deleteBudgetByUserAndId(userId, id) {
  const { rowCount } = await pool.query('DELETE FROM budgets WHERE user_id = $1 AND id = $2', [userId, String(id)]);
  return rowCount > 0;
}

// ── Emergency fund ─────────────────────────────────────────────────────────────
// One record per user. No row = not configured; a row with currentAmount 0 = configured, nothing saved yet.
function toEmergencyFund(row) {
  return {
    currentAmount: Number(row.current_amount),
    targetAmount: row.target_amount === null ? null : Number(row.target_amount),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const EMERGENCY_FUND_COLUMNS = 'current_amount, target_amount, created_at, updated_at';

// The user's record, or null when none has been saved.
export async function getEmergencyFundByUser(userId) {
  const { rows } = await pool.query(`SELECT ${EMERGENCY_FUND_COLUMNS} FROM emergency_funds WHERE user_id = $1`, [userId]);
  return rows.length ? toEmergencyFund(rows[0]) : null;
}

// Create-or-replace the user's record. created_at is set only on the first save; every save sets updated_at.
// targetAmount may be null (no target). now is an ISO timestamp from the server.
export async function upsertEmergencyFund({ userId, currentAmount, targetAmount, now }) {
  const { rows } = await pool.query(
    `INSERT INTO emergency_funds (user_id, current_amount, target_amount, created_at, updated_at)
     VALUES ($1, $2::numeric, $3::numeric, $4::timestamptz, $4::timestamptz)
     ON CONFLICT (user_id) DO UPDATE
       SET current_amount = EXCLUDED.current_amount,
           target_amount  = EXCLUDED.target_amount,
           updated_at     = EXCLUDED.updated_at
     RETURNING ${EMERGENCY_FUND_COLUMNS}`,
    [userId, String(currentAmount), targetAmount === null ? null : String(targetAmount), now]);
  return toEmergencyFund(rows[0]);
}

export async function closeDatabase() {
  if (pool) await pool.end();
  pool = null;
}
