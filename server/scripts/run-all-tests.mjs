#!/usr/bin/env node
// Convenient complete test runner for the server (`npm run test:all` / `npm test`).
//
// Runs every "test:*" script declared in server/package.json, discovered dynamically so a
// newly added script is picked up automatically. Each suite runs as its own `npm run` child
// process, matching how the suites were already designed to be run individually. Several
// suites start a real server on a FIXED port and/or create their own disposable PostgreSQL
// database named "finsphere_<suite>_<pid>" -- ports are already distinct per file (5075-5097;
// see server/tests/*.test.mjs) and the PID-named databases are unique to each child process,
// so parallel execution would not currently collide. This runner still executes suites
// SEQUENTIALLY: that is the safe, deterministic default and does not depend on today's port
// assignments staying distinct if a future test file is added carelessly.
//
// "test:password-reset-db" is SKIPPED by default: unlike every other database-dependent
// suite, it does not create its own disposable database -- it requires an explicitly
// pre-provisioned "finsphere_reset_test_<digits>" database named by
// FINSPHERE_RESET_TEST_DATABASE_URL (see server/tests/passwordResetDb.test.mjs and the
// README). Running it here unconditionally would either skip silently or fail noisily on a
// machine that has not provisioned that database. Set FINSPHERE_RESET_TEST_DATABASE_URL
// before invoking this script (pointing at a disposable "finsphere_reset_test_*" database,
// never the faculty/report databases) to include it automatically.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(serverDir, 'package.json'), 'utf8'));

const GATED_DB_TEST = 'test:password-reset-db';
const hasResetTestDb = Boolean(process.env.FINSPHERE_RESET_TEST_DATABASE_URL);

const SAFE_SCRIPT_NAME = /^test:[a-z0-9-]+$/;
const names = Object.keys(pkg.scripts)
  .filter((name) => name.startsWith('test:') && name !== 'test:all')
  .filter((name) => name !== GATED_DB_TEST || hasResetTestDb)
  .sort();
for (const name of names) {
  if (!SAFE_SCRIPT_NAME.test(name)) throw new Error(`Refusing to run unexpected script name: ${name}`);
}

if (!hasResetTestDb) {
  console.log(`Skipping ${GATED_DB_TEST}: set FINSPHERE_RESET_TEST_DATABASE_URL (a disposable finsphere_reset_test_<digits> database) to include it.\n`);
}

if (names.length === 0) {
  console.error('No "test:*" scripts found in server/package.json.');
  process.exit(1);
}

console.log(`Running ${names.length} server test suites sequentially (one child process each):\n  ${names.join('\n  ')}\n`);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const results = [];
for (const name of names) {
  console.log(`\n=== ${name} ===`);
  // Each name was just checked against SAFE_SCRIPT_NAME above, so building the shell command
  // string here (rather than an args array with shell:true, which Node warns is unescaped) is safe.
  const res = spawnSync(`${npmCmd} run ${name}`, { stdio: 'inherit', cwd: serverDir, shell: true });
  results.push({ name, code: res.status ?? 1 });
}

console.log('\n=== Summary ===');
for (const r of results) console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.name}`);

const failed = results.filter((r) => r.code !== 0);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} server suites failed: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
console.log(`\nAll ${results.length} server suites passed.`);
