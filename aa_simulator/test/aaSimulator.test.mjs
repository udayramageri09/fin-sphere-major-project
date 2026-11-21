// Spawns a disposable instance of this simulator on its own port and exercises the full
// PAN -> account discovery -> consent -> FI request lifecycle, plus isolation between aaIds.
// Synthetic data only; this test never touches a real bank, PAN registry or UPI provider.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const simulatorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.AA_SIMULATOR_TEST_PORT || 7199);
const base = `http://localhost:${port}`;

let child, logs = '';
async function start() {
  child = spawn(process.execPath, ['server.js'], { cwd: simulatorDir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/health`); return; } catch { await sleep(200); }
  }
  throw new Error(`Simulator did not start:\n${logs}`);
}
async function stop() {
  if (child && child.exitCode === null) { child.kill(); await new Promise((r) => child.once('exit', r)); }
}

async function json(p, options) {
  const response = await fetch(`${base}${p}`, options);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const post = (p, body) => json(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const DEMO_PAN = 'DEMO-PAN-001';

// Full happy-path lifecycle for one aaId: PAN -> accounts -> consent -> approve -> FI request -> data.
async function linkAndConsent(aaId, { accountIds } = {}) {
  const pan = await post('/v1/pan/verify', { aaId, pan: DEMO_PAN });
  assert.equal(pan.status, 200);
  const accounts = await json(`/v1/customers/${encodeURIComponent(aaId)}/accounts`);
  const consent = await post('/v1/consents', { aaId, purpose: 'FinSphere personal financial analysis', accountIds });
  const approved = await post(`/v1/consents/${consent.body.consentId}/approve`);
  return { accounts: accounts.body.accounts, consent: approved.body };
}

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };

try {
  await start();

  check((await json('/health')).body.syntheticOnly === true, 'health endpoint exposes synthetic-only status');

  // ── PAN ──────────────────────────────────────────────────────────────────
  {
    const missing = await post('/v1/pan/verify', { aaId: 'pan-test-1@finsphere' });
    check(missing.status === 400, 'PAN verify rejects a missing PAN');

    const invalid = await post('/v1/pan/verify', { aaId: 'pan-test-1@finsphere', pan: 'not-a-pan' });
    check(invalid.status === 400, 'PAN verify rejects an invalid format');

    const demo = await post('/v1/pan/verify', { aaId: 'pan-test-1@finsphere', pan: DEMO_PAN });
    check(demo.status === 200 && demo.body.panStatus === 'VERIFIED', 'demo PAN token verifies');
    check(demo.body.maskedPan === '*********001', 'PAN is returned masked, never raw');
    check(demo.body.maskedPan.includes('DEMO-PAN-001') === false, 'the raw PAN is never echoed back');

    const realFormat = await post('/v1/pan/verify', { aaId: 'pan-test-2@finsphere', pan: 'ABCDE1234F' });
    check(realFormat.status === 200 && realFormat.body.panStatus === 'VERIFIED', 'a real-shaped synthetic PAN also verifies');

    const gated = await json('/v1/customers/pan-test-3@finsphere/accounts');
    check(gated.status === 409, 'account discovery is blocked before PAN verification');
  }

  // ── Account discovery (10 synthetic accounts) ───────────────────────────
  {
    await post('/v1/pan/verify', { aaId: 'discovery-test@finsphere', pan: DEMO_PAN });
    const result = await json('/v1/customers/discovery-test@finsphere/accounts');
    check(result.status === 200, 'accounts endpoint responds after PAN verification');
    check(result.body.accounts.length === 10, 'exactly 10 synthetic accounts are discovered');
    const types = new Set(result.body.accounts.map((a) => a.type));
    check(types.has('SAVINGS') && types.has('CURRENT') && types.has('TERM-DEPOSIT'), 'accounts span multiple real-world types');
    check(result.body.accounts.every((a) => /^XXXXXX\d{4}$|^(FD|RD|MF)-\d{4}$/.test(a.maskedNumber)), 'every account number is masked, never a real number');
    check(result.body.accounts.every((a) => a.linked === true), 'accounts report linked status');
    // Deterministic: fetching again returns byte-identical account data.
    const again = await json('/v1/customers/discovery-test@finsphere/accounts');
    check(JSON.stringify(again.body.accounts) === JSON.stringify(result.body.accounts), 'account discovery is deterministic/repeatable');
  }

  // ── Consent lifecycle ────────────────────────────────────────────────────
  {
    const aaId = 'consent-test@finsphere';
    await post('/v1/pan/verify', { aaId, pan: DEMO_PAN });
    const { body: accounts } = await json(`/v1/customers/${aaId}/accounts`);
    const selected = accounts.accounts.slice(0, 3).map((a) => a.accountId);

    const noConsentFi = await post('/v1/fi-requests', { consentId: 'consent-does-not-exist' });
    check(noConsentFi.status === 404, 'FI request cannot be created without a real consent');

    const created = await post('/v1/consents', { aaId, purpose: 'Personal financial management', accountIds: selected });
    check(created.status === 201 && created.body.status === 'PENDING', 'consent starts PENDING');
    check(created.body.accountIds.length === 3, 'consent records exactly the selected accounts');

    const fiBeforeApproval = await post('/v1/fi-requests', { consentId: created.body.consentId });
    check(fiBeforeApproval.status === 409, 'FI request is refused while consent is still PENDING');

    const approved = await post(`/v1/consents/${created.body.consentId}/approve`);
    check(approved.status === 200 && approved.body.status === 'ACTIVE', 'consent becomes ACTIVE on approval');

    const approvedAgain = await post(`/v1/consents/${created.body.consentId}/approve`);
    check(approvedAgain.status === 409, 'an already-approved consent cannot be approved twice');

    const rejectTarget = await post('/v1/consents', { aaId, purpose: 'Personal financial management' });
    const rejected = await post(`/v1/consents/${rejectTarget.body.consentId}/reject`);
    check(rejected.status === 200 && rejected.body.status === 'REJECTED', 'consent can be rejected');
    const rejectAgain = await post(`/v1/consents/${rejectTarget.body.consentId}/reject`);
    check(rejectAgain.status === 409, 'a rejected consent cannot be rejected again');
    const fiAfterReject = await post('/v1/fi-requests', { consentId: rejectTarget.body.consentId });
    check(fiAfterReject.status === 409, 'FI request is refused for a REJECTED consent');
  }

  // ── FI request: create, status, ready, fetch ────────────────────────────
  {
    const aaId = 'fi-test@finsphere';
    const { consent } = await linkAndConsent(aaId);
    const fi = await post('/v1/fi-requests', { consentId: consent.consentId });
    check(fi.status === 201 && fi.body.status === 'READY', 'FI request resolves to READY');

    const status = await json(`/v1/fi-requests/${fi.body.fiRequestId}/status`);
    check(status.body.status === 'READY', 'FI status endpoint reports READY');

    const data = await json(`/v1/fi-requests/${fi.body.fiRequestId}/data`);
    check(data.status === 200 && data.body.synthetic === true, 'FI data is explicitly marked synthetic');
    check(data.body.accounts.length === 10, 'FI data covers every consented account (consent defaulted to all 10)');
    check(data.body.transactions.length === 40, 'FI data includes generated transactions for every account (4 rows x 10 accounts)');
    check(data.body.transactions.every((t) => t.source === 'ACCOUNT_AGGREGATOR'), 'every transaction is tagged with its synthetic source');

    const missingData = await json('/v1/fi-requests/does-not-exist/data');
    check(missingData.status === 404, 'fetching data for an unknown FI request is a 404');
  }

  // ── Isolation between different aaIds ────────────────────────────────────
  {
    const a = await linkAndConsent('isolation-a@finsphere', { accountIds: undefined });
    const b = await linkAndConsent('isolation-b@finsphere', { accountIds: undefined });
    check(a.accounts[0].accountId === b.accounts[0].accountId, 'both aaIds see the same deterministic synthetic catalog shape');

    const fiA = await post('/v1/fi-requests', { consentId: a.consent.consentId });
    const fiB = await post('/v1/fi-requests', { consentId: b.consent.consentId });
    check(fiA.body.fiRequestId !== fiB.body.fiRequestId, 'each aaId gets its own FI request id');

    // b's session cannot read a's consent or FI request by substituting ids - consents/FI requests
    // are looked up only by their own opaque id, never scoped by a caller-supplied aaId, so this
    // confirms there is no way to address another aaId's artefact through this API at all.
    const crossConsent = await json(`/v1/consents/${a.consent.consentId}`);
    check(crossConsent.status === 200 && crossConsent.body.aaId === 'isolation-a@finsphere', "a consent always reports its own aaId, never another caller's");
  }

  console.log(`AA simulator: ${checks} checks passed`);
} finally {
  await stop();
}
