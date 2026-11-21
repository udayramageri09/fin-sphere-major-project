import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

test('sandbox requires consent and imports only authenticated, owner-scoped fixture transactions', async (t) => {
  const url = new URL(process.env.DATABASE_URL);
  const database = `finsphere_aa_test_${process.pid}`;
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  t.after(() => admin.end());
  await admin.query(`CREATE DATABASE ${database}`);
  url.pathname = `/${database}`;
  const request = async (base, path, body, cookie) => fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  });
  const start = async (mode, enabled, check) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: new URL('../', import.meta.url),
      env: {
        ...process.env, HOST: '127.0.0.1', PORT: '0',
        NODE_ENV: mode, FINSPHERE_AA_SANDBOX: enabled, TRUST_PROXY: 'false',
        CORS_ORIGINS: 'http://localhost:5174', IMPORT_LEGACY_JSON: 'false',
        DATABASE_URL: url.toString(), DATABASE_SSL: process.env.DATABASE_SSL ?? 'false',
        JWT_SECRET: 'test-secret-for-isolated-sandbox-testing-only', GROQ_API_KEY: '', PASSWORD_RESET_DELIVERY: '',
        // This test starts the real server, including the (unrelated) AA simulator provider wired
        // up in server.js. It is not exercising that provider, so it opts in to the same
        // synthetic-data acknowledgement a real production deployment would make explicitly -
        // see aaProvider.js's createAaProvider().
        AA_ALLOW_LOCAL_SIMULATOR_IN_PRODUCTION: 'true'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const closed = once(child, 'close');
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const port = /Server running on http:\/\/localhost:(\d+)/.exec(output)?.[1];
        if (port) {
          const base = `http://127.0.0.1:${port}/api`;
          assert.equal((await request(base, '/health')).status, 200);
          await check(base);
          return;
        }
        if (child.exitCode !== null) break;
        await sleep(50);
      }
      assert.fail(`Sandbox server did not start: ${output}`);
    } finally {
      child.kill();
      await closed;
    }
  };
  const path = '/transactions/account-aggregator-sandbox';
  const approved = { identity: 'DEMO-PAN-001', approved: true };
  try {
    await start('development', 'true', async (base) => {
      const signIn = async (email) => {
        const body = { email, password: 'Local-fixture-Password1!' };
        assert.ok((await request(base, '/auth/register', body)).ok);
        const response = await request(base, '/auth/login', body);
        assert.equal(response.status, 200);
        return response.headers.get('set-cookie').split(';')[0];
      };
      const first = await signIn('first@example.test');
      const second = await signIn('second@example.test');
      const ledger = async (cookie) => (await request(base, '/transactions', undefined, cookie)).json();
      assert.equal((await request(base, `${path}/consent`, approved)).status, 401);
      assert.equal((await request(base, `${path}/consent`, { ...approved, approved: false }, first)).status, 400);
      assert.equal((await request(base, `${path}/consent`, { ...approved, identity: 'not-the-demo-identity' }, first)).status, 400);
      const preview = await request(base, `${path}/consent`, approved, first);
      assert.equal(preview.status, 200);
      const { consent, overview } = await preview.json();
      for (const section of ['bankAccounts', 'transactions', 'investments', 'loans', 'insurance']) assert.ok(overview[section].length);
      assert.deepEqual(await ledger(first), []);
      assert.equal((await request(base, `${path}/import`, { consent }, second)).status, 403);
      assert.equal((await request(base, `${path}/import`, { consent, amount: 999 }, first)).status, 403);
      const both = await Promise.all(Array.from({ length: 2 }, async () => {
        const response = await request(base, `${path}/import`, { consent }, first);
        assert.equal(response.status, 200);
        return response.json();
      }));
      const count = overview.transactions.length;
      assert.deepEqual(both.sort((a, b) => b.count - a.count), [{ count, skipped: 0 }, { count: 0, skipped: count }]);
      const expected = new Map(overview.transactions.map(({ title, amount }) => [title, amount]));
      assert.deepEqual(new Map((await ledger(first)).map(({ title, amount }) => [title, amount])), expected);
      assert.deepEqual(await ledger(second), []);
    });
    await start('development', 'false', async (base) => {
      assert.equal((await request(base, `${path}/consent`, approved)).status, 404);
    });
    await start('production', 'true', async (base) => {
      assert.equal((await request(base, `${path}/consent`, approved)).status, 404);
      assert.equal((await request(base, `${path}/import`, { consent: 'not-a-token' })).status, 404);
    });
  } finally {
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
  }
});
