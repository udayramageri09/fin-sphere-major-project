// PostgreSQL access for FinSphere (pg + parameterized SQL, no ORM).
// Scope today: the users table only.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');
const LEGACY_USERS_MIGRATION = 'import_users_json_v1';
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
export async function initDatabase({ env = process.env, legacyUsersFile } = {}) {
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

export async function closeDatabase() {
  if (pool) await pool.end();
  pool = null;
}
