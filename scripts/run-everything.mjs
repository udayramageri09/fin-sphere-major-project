#!/usr/bin/env node
// One command for every test suite in the repository: `npm run verify` from the root.
//
// Runs four groups, one after another, each as its own child process:
//   1. frontend      - the existing root runner (scripts/run-all-tests.mjs)
//   2. server        - the existing server runner (server/scripts/run-all-tests.mjs)
//   3. aa_simulator  - its own `npm test`
//   4. ml_service    - `python -m unittest discover -s tests`
// Output is streamed live AND captured, so the summary at the end can report the counts the suites
// actually printed. Nothing is estimated: a count that was not printed is shown as "-".
//
// Named "verify", not "test:...": the frontend runner runs every "test:*" script except "test:all",
// so a "test:everything" script would make it start this file again, forever.
//
// Server suites need the same environment as before (DATABASE_URL to a disposable test server,
// JWT_SECRET, IMPORT_LEGACY_JSON=false ...; see the README). This script passes the current
// environment through unchanged and never reads or prints any of it.
//
// Python: set FINSPHERE_PYTHON to choose the interpreter, e.g. "py -3.12" or a full path to python.exe.
// Default: "python" on Windows, "python3" elsewhere.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

function pythonCommand() {
  const configured = process.env.FINSPHERE_PYTHON?.trim();
  if (!configured) return { cmd: isWindows ? 'python' : 'python3', args: [] };
  // A full path may contain spaces ("C:\Program Files\..."), so an existing file is used as-is.
  if (existsSync(configured)) return { cmd: configured, args: [] };
  const [cmd, ...args] = configured.split(/\s+/);   // e.g. "py -3.12"
  return { cmd, args };
}

const python = pythonCommand();
const groups = [
  // The npm groups use shell:true because Windows cannot spawn npm.cmd directly (Node refuses .cmd
  // files without a shell). Every command string here is a fixed literal, never user input.
  { name: 'frontend', cwd: rootDir, cmd: `${npmCmd} run test:all`, args: [], shell: true },
  { name: 'server', cwd: path.join(rootDir, 'server'), cmd: `${npmCmd} run test:all`, args: [], shell: true },
  { name: 'aa_simulator', cwd: path.join(rootDir, 'aa_simulator'), cmd: `${npmCmd} test`, args: [], shell: true },
  { name: 'ml_service', cwd: path.join(rootDir, 'ml_service'), cmd: python.cmd,
    args: [...python.args, '-m', 'unittest', 'discover', '-s', 'tests'], shell: false }
];

// Runs one group, streaming its output and keeping a copy for the summary.
function run(group) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(group.cmd, group.args, { cwd: group.cwd, shell: group.shell });
    const keep = (stream) => (chunk) => { stream.write(chunk); output += chunk.toString(); };
    child.stdout.on('data', keep(process.stdout));
    child.stderr.on('data', keep(process.stderr));   // unittest reports on stderr
    child.on('error', (err) => resolve({ code: 1, output, startError: err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

const sum = (re, text) => [...text.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);
const has = (re, text) => re.test(text);

// Reads only what the suites printed. Three formats exist in this repo:
//   node:test     "# pass 12" / "# fail 0"   (or "ℹ pass 12" when the output is a terminal)
//   custom suites "29 checks passed" / "177 passed, 0 failed"
//   unittest      "Ran 48 tests in 2.8s" followed by "OK" or "FAILED (...)"
function counts(text) {
  return {
    suitesPassed: (text.match(/^PASS {2}test:/gm) ?? []).length,
    suitesFailed: (text.match(/^FAIL {2}test:/gm) ?? []).length,
    nodePass: sum(/^(?:#|ℹ) pass (\d+)$/gm, text),
    nodeFail: sum(/^(?:#|ℹ) fail (\d+)$/gm, text),
    checks: sum(/^.*?(\d+) (?:regression )?checks passed/gm, text) + sum(/^.*?(\d+) passed, 0 failed/gm, text),
    pythonRan: has(/^Ran \d+ tests?/m, text) ? sum(/^Ran (\d+) tests?/gm, text) : null
  };
}

const results = [];
for (const group of groups) {
  console.log(`\n########## ${group.name} ##########\n`);
  const result = await run(group);
  results.push({ ...group, ...result, counts: counts(result.output) });
}

console.log('\n========== verify: summary ==========');
const show = (n) => (n ? String(n) : '-');
for (const r of results) {
  const c = r.counts;
  const status = r.code === 0 ? 'PASS' : 'FAIL';
  const parts = [];
  if (c.suitesPassed || c.suitesFailed) parts.push(`suites ${c.suitesPassed} passed / ${c.suitesFailed} failed`);
  if (c.nodePass || c.nodeFail) parts.push(`node:test ${c.nodePass} passed / ${c.nodeFail} failed`);
  if (c.checks) parts.push(`checks ${show(c.checks)} passed`);
  if (c.pythonRan !== null) parts.push(`unittest ran ${c.pythonRan}`);
  if (r.startError) parts.push(`could not start: ${r.startError}`);
  console.log(`${status}  ${r.name.padEnd(13)} ${parts.join(', ') || 'no counts printed'}`);
}

const failed = results.filter((r) => r.code !== 0);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} groups failed: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
console.log(`\nAll ${results.length} groups passed.`);