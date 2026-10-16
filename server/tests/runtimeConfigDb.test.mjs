import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';
import { initDatabase, closeDatabase } from '../db/index.js';

test('production skips legacy files at the actual database boundary', async () => {
  const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = process.env.DATABASE_URL ?? dotenv.parse(fs.readFileSync(path.join(server, '.env'))).DATABASE_URL;
  const db = `finsphere_runtime_test_${process.pid}`;
  assert.match(db, /^finsphere_runtime_test_\d+$/);
  const urlFor = name => { const u = new URL(source); u.pathname = '/' + name; return u.toString(); };
  const admin = new pg.Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  // No pre-emptive DROP: an unexpected collision fails closed.
  await admin.query(`CREATE DATABASE ${db}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finsphere-runtime-test-'));
  const legacy = path.join(dir, 'synthetic-invalid.json');
  fs.writeFileSync(legacy, 'not valid JSON');
  const env = { DATABASE_URL: urlFor(db), DATABASE_SSL: 'false', NODE_ENV: 'production' };
  try {
    await initDatabase({ env, legacyUsersFile: legacy });
    await closeDatabase();
    const client = new pg.Client({ connectionString: urlFor(db) });
    await client.connect();
    try {
      assert.equal(Number((await client.query('SELECT count(*) FROM users')).rows[0].count), 0);
      assert.equal(Number((await client.query('SELECT count(*) FROM schema_migrations')).rows[0].count), 0);
    } finally { await client.end(); }
    // An explicit migration opt-in must actually attempt the file, not silently ignore it.
    await assert.rejects(initDatabase({ env: { ...env, IMPORT_LEGACY_JSON: 'true' }, legacyUsersFile: legacy }), SyntaxError);
  } finally {
    await closeDatabase();
    fs.unlinkSync(legacy); fs.rmdirSync(dir);
    await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
    await admin.end();
  }
});
