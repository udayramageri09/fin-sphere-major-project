import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.AA_SIMULATOR_URL || 'http://localhost:7100';

async function json(path, options) {
  const response = await fetch(`${base}${path}`, options);
  return { status: response.status, body: await response.json() };
}

test('health endpoint exposes synthetic-only status', async () => {
  const result = await json('/health');
  assert.equal(result.status, 200);
  assert.equal(result.body.syntheticOnly, true);
});

test('customer can discover synthetic accounts', async () => {
  const result = await json('/v1/customers/customer1@finsphere/accounts');
  assert.equal(result.status, 200);
  assert.equal(result.body.accounts.length, 1);
  assert.equal(result.body.accounts[0].type, 'SAVINGS');
});

test('consent lifecycle and FI fetch work end to end', async () => {
  const created = await json('/v1/consents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ aaId: 'customer1@finsphere', purpose: 'FinSphere personal financial analysis' })
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'PENDING');

  const approved = await json(`/v1/consents/${created.body.consentId}/approve`, { method: 'POST' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'ACTIVE');

  const fi = await json('/v1/fi-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ consentId: created.body.consentId })
  });
  assert.equal(fi.status, 201);
  assert.equal(fi.body.status, 'READY');

  const status = await json(`/v1/fi-requests/${fi.body.fiRequestId}/status`);
  assert.equal(status.body.status, 'READY');

  const data = await json(`/v1/fi-requests/${fi.body.fiRequestId}/data`);
  assert.equal(data.status, 200);
  assert.equal(data.body.synthetic, true);
  assert.equal(data.body.accounts.length, 1);
  assert.equal(data.body.transactions.length, 5);
});
