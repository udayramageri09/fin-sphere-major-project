// Only run against a disposable database explicitly named by the test harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import bcrypt from 'bcrypt';
import { initDatabase, closeDatabase, createUser, findUserByEmail, issuePasswordReset, consumePasswordReset, isCurrentSession } from '../db/index.js';
import { hashResetToken } from '../passwordReset.js';

test('PostgreSQL reset expiry, replacement, atomic replay protection and session revocation', async () => {
  const url = process.env.FINSPHERE_RESET_TEST_DATABASE_URL;
  assert.ok(url && /^\/finsphere_reset_test_\d+$/.test(new URL(url).pathname), 'Requires disposable reset-test database');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await initDatabase({ env: { DATABASE_URL: url, DATABASE_SSL: 'false' } });
    const oldHash = await bcrypt.hash('old-password', 10), newHash = await bcrypt.hash('new-password', 10);
    const user = await createUser('reset@example.com', oldHash);
    const a = hashResetToken('a'.repeat(64)), b = hashResetToken('b'.repeat(64));
    assert.equal(await isCurrentSession(user.id, 0), true);
    assert.equal(await issuePasswordReset('absent@example.com', a), null);
    assert.ok(await issuePasswordReset(user.email, a));
    assert.equal(await issuePasswordReset(user.email, b), null);
    assert.equal((await client.query('SELECT reset_token_hash FROM users WHERE id=$1', [user.id])).rows[0].reset_token_hash, a);
    await client.query("UPDATE users SET reset_token_expires_at=now()-interval '1 second', reset_requested_at=now()-interval '2 minutes' WHERE id=$1", [user.id]);
    assert.equal(await consumePasswordReset(a, newHash), false);
    assert.ok(await issuePasswordReset(user.email, b));
    assert.equal(await consumePasswordReset(a, newHash), false);
    const results = await Promise.all([consumePasswordReset(b, newHash), consumePasswordReset(b, newHash)]);
    assert.deepEqual(results.sort(), [false, true]);
    const updated = await findUserByEmail(user.email);
    assert.equal(await bcrypt.compare('new-password', updated.passwordHash), true);
    assert.equal(await bcrypt.compare('old-password', updated.passwordHash), false);
    assert.equal(await isCurrentSession(user.id, 0), false);
    assert.equal(await isCurrentSession(user.id, updated.sessionVersion), true);
    assert.equal(await consumePasswordReset(b, oldHash), false);
  } finally { await closeDatabase(); await client.end(); }
});
