#!/usr/bin/env node
// Convenient complete test runner for the frontend (`npm run test:all` / `npm test`).
//
// Runs every "test:*" script declared in package.json, discovered dynamically so a newly
// added script is picked up automatically. Each suite runs as its own `npm run` child
// process -- this matches how the suites were already designed to be run individually
// (README's PowerShell loop) and keeps any in-process state (jsdom globals, Vite dev
// servers) from one file leaking into the next. Suites run SEQUENTIALLY, not in parallel:
// nothing here currently binds a fixed port or a shared resource, but running sequentially
// is the safe default regardless of what a future test file does.
//
// Exits 0 only if every suite exits 0. Prints a pass/fail summary either way so a failure
// is never silent.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

const SAFE_SCRIPT_NAME = /^test:[a-z0-9-]+$/;
const names = Object.keys(pkg.scripts)
  .filter((name) => name.startsWith('test:') && name !== 'test:all')
  .sort();
for (const name of names) {
  if (!SAFE_SCRIPT_NAME.test(name)) throw new Error(`Refusing to run unexpected script name: ${name}`);
}

if (names.length === 0) {
  console.error('No "test:*" scripts found in package.json.');
  process.exit(1);
}

console.log(`Running ${names.length} frontend test suites sequentially (one child process each):\n  ${names.join('\n  ')}\n`);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const results = [];
for (const name of names) {
  console.log(`\n=== ${name} ===`);
  // Each name was just checked against SAFE_SCRIPT_NAME above, so building the shell command
  // string here (rather than an args array with shell:true, which Node warns is unescaped) is safe.
  const res = spawnSync(`${npmCmd} run ${name}`, { stdio: 'inherit', cwd: rootDir, shell: true });
  results.push({ name, code: res.status ?? 1 });
}

console.log('\n=== Summary ===');
for (const r of results) console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.name}`);

const failed = results.filter((r) => r.code !== 0);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} frontend suites failed: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
console.log(`\nAll ${results.length} frontend suites passed.`);
