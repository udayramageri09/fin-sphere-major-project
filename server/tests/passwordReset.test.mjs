import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { createPasswordResetHandlers, createResetMailer, hashResetToken, validResetPassword, RESET_MESSAGE } from '../passwordReset.js';

const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
test('known and unknown accounts respond identically before lookup; only digest is persisted', async () => {
  const issued = [], sent = [];
  const handlers = createPasswordResetHandlers({ issueToken: async (email, hash) => { issued.push({ email, hash }); return email === 'known@example.com' ? { email } : null; },
    sendEmail: async (email, token) => sent.push({ email, token }) });
  const a = response(), b = response();
  handlers.forgot({ body: { email: ' Known@Example.com ' } }, a);
  handlers.forgot({ body: { email: 'unknown@example.com' } }, b);
  assert.deepEqual(a.body, b.body); assert.equal(a.code, 202); assert.equal(a.body.message, RESET_MESSAGE);
  assert.equal(issued.length, 0);
  await tick();
  assert.equal(sent.length, 1); assert.equal(sent[0].token.length, 64);
  assert.equal(issued[0].hash, hashResetToken(sent[0].token)); assert.notEqual(issued[0].hash, sent[0].token);
});
test('configuration, invalid input, and delivery failures never disclose tokens', async () => {
  let failures = 0;
  const disabled = createPasswordResetHandlers({});
  let res = response(); disabled.forgot({ body: { email: 'a@example.com' } }, res); assert.equal(res.code, 503);
  res = response(); disabled.forgot({ body: { email: {} } }, res); assert.equal(res.code, 400);
  const handlers = createPasswordResetHandlers({ issueToken: async () => ({ email: 'a@example.com' }), sendEmail: async () => { throw Error('secret'); }, reportFailure: () => failures++ });
  res = response(); handlers.forgot({ body: { email: 'a@example.com' } }, res);
  await tick(); assert.equal(failures, 1); assert.deepEqual(res.body, { message: RESET_MESSAGE });
});
test('reset validates token and bcrypt byte bounds, handles invalid links and database failure', async () => {
  let consumed;
  const handlers = createPasswordResetHandlers({ hashPassword: async () => 'hash', consumeToken: async (token, hash) => { consumed = [token, hash]; return false; } });
  for (const body of [{ token: 'bad', password: 'long-password' }, { token: 'a'.repeat(64), password: 'short' }, { token: 'a'.repeat(64), password: '₹'.repeat(25) }]) {
    const res = response(); await handlers.reset({ body }, res); assert.equal(res.code, 400);
  }
  const res = response(); await handlers.reset({ body: { token: 'a'.repeat(64), password: 'long-password' } }, res);
  assert.equal(res.code, 400); assert.deepEqual(consumed, [hashResetToken('a'.repeat(64)), 'hash']);
  assert.equal(validResetPassword('₹'.repeat(24)), true);
  const failed = createPasswordResetHandlers({ hashPassword: async () => { throw Error('private'); } });
  const failRes = response(); await failed.reset({ body: { token: 'a'.repeat(64), password: 'long-password' } }, failRes);
  assert.equal(failRes.code, 500); assert.equal(JSON.stringify(failRes.body).includes('private'), false);
});
test('successful reset does not issue a session', async () => {
  const handlers = createPasswordResetHandlers({ hashPassword: async () => 'hash', consumeToken: async () => true });
  const res = response(); await handlers.reset({ body: { token: 'a'.repeat(64), password: 'long-password' } }, res);
  assert.equal(res.code, 200); assert.match(res.body.message, /log in/); assert.equal(res.body.token, undefined);
});
test('mailer uses configured origin and fragment; unsafe URLs and provider errors are rejected', async () => {
  const env = { RESEND_API_KEY: 'test-key', PASSWORD_RESET_FROM: 'noreply@example.com', PASSWORD_RESET_URL: 'https://app.example.com/' };
  let request;
  const send = createResetMailer(env, async (url, options) => { request = { url, options }; return { ok: true }; });
  await send('a@example.com', 'a'.repeat(64));
  const body = JSON.parse(request.options.body);
  assert.match(body.text, /https:\/\/app.example.com\/#reset=/); assert.deepEqual(body.to, ['a@example.com']);
  assert.equal(request.url, 'https://api.resend.com/emails');
  for (const url of ['http://evil.example/', 'https://user:pass@app.example.com/', 'https://app.example.com/?redirect=evil']) {
    assert.throws(() => createResetMailer({ ...env, PASSWORD_RESET_URL: url }));
  }
  assert.throws(() => createResetMailer({ ...env, NODE_ENV: 'production', PASSWORD_RESET_URL: 'http://localhost:5173/' }));
  await assert.rejects(createResetMailer(env, async () => ({ ok: false }))('a@example.com', 'a'.repeat(64)), /delivery failed/);
});

// ── development-only local capture (PASSWORD_RESET_DELIVERY=local) ───────────────────────────────────────────────────
import { createResetDelivery, createLocalMailCapture, createDevMailHandlers, resolveResetDeliveryMode, LOCAL_MAIL_LIMIT } from '../passwordReset.js';

const RESEND_ENV = { RESEND_API_KEY: 'test-key', PASSWORD_RESET_FROM: 'noreply@example.com', PASSWORD_RESET_URL: 'https://app.example.com/' };
const TOKEN = 'ab'.repeat(32);

test('delivery mode: resend is the default, local needs an explicit opt-in, production refuses local, nothing else is accepted', () => {
  for (const value of [undefined, '', '  ', 'resend', ' RESEND ']) assert.equal(resolveResetDeliveryMode({ PASSWORD_RESET_DELIVERY: value }), 'resend', String(value));
  assert.equal(resolveResetDeliveryMode({}), 'resend');
  assert.equal(resolveResetDeliveryMode({ PASSWORD_RESET_DELIVERY: 'local' }), 'local');
  assert.equal(resolveResetDeliveryMode({ PASSWORD_RESET_DELIVERY: 'LOCAL', NODE_ENV: 'development' }), 'local');
  for (const value of ['local', 'LOCAL', ' Local ']) {
    assert.throws(() => resolveResetDeliveryMode({ PASSWORD_RESET_DELIVERY: value, NODE_ENV: 'production' }), /not allowed when NODE_ENV=production/);
    assert.throws(() => createResetDelivery({ PASSWORD_RESET_DELIVERY: value, NODE_ENV: 'production' }), /not allowed when NODE_ENV=production/);
  }
  for (const value of ['smtp', 'localhost', 'true', '1', 'console']) assert.throws(() => resolveResetDeliveryMode({ PASSWORD_RESET_DELIVERY: value }), /must be "resend" or "local"/, value);
});

test('there is never a silent fallback from Resend to local capture', () => {
  for (const env of [{}, { NODE_ENV: 'development' }, { PASSWORD_RESET_DELIVERY: 'resend', NODE_ENV: 'development' }, { RESEND_API_KEY: 'k' }]) {
    const delivery = createResetDelivery(env);
    assert.equal(delivery.mode, 'resend');
    assert.equal(delivery.sendEmail, null, 'unconfigured Resend stays unconfigured (the endpoint answers 503)');
    assert.equal(delivery.capture, null);
  }
  const res = response();
  createPasswordResetHandlers({ sendEmail: createResetDelivery({ NODE_ENV: 'development' }).sendEmail }).forgot({ body: { email: 'a@example.com' } }, res);
  assert.equal(res.code, 503);
});

test('local mode captures the mail, never calls Resend, and the text is the same as the real email', async () => {
  const calls = [];
  const noNetwork = async (...args) => { calls.push(args); throw new Error('network must not be used in local mode'); };
  const local = createResetDelivery({ PASSWORD_RESET_DELIVERY: 'local', NODE_ENV: 'development', ...RESEND_ENV }, noNetwork);
  assert.equal(local.mode, 'local');
  await local.sendEmail('person@example.com', TOKEN);
  assert.equal(calls.length, 0, 'Resend is not called, even when Resend settings are present');
  const [mail] = local.capture.list();
  assert.equal(mail.to, 'person@example.com');
  assert.equal(mail.subject, 'Reset your FinSphere password');
  assert.equal(mail.link, `https://app.example.com/#reset=${TOKEN}`);
  assert.ok(mail.text.includes(mail.link) && mail.text.includes('within 15 minutes') && typeof mail.capturedAt === 'string');
  // the same message Resend would have been given
  let body;
  await createResetDelivery(RESEND_ENV, async (url, options) => { body = JSON.parse(options.body); return { ok: true }; }).sendEmail('person@example.com', TOKEN);
  assert.equal(body.text, mail.text);
  assert.equal(body.subject, mail.subject);
});

test('local mode link base: defaults to the Vite dev URL, honours PASSWORD_RESET_URL, rejects unsafe URLs', async () => {
  const d = createResetDelivery({ PASSWORD_RESET_DELIVERY: 'local' });
  await d.sendEmail('a@example.com', TOKEN);
  assert.equal(d.capture.list()[0].link, `http://localhost:5173/#reset=${TOKEN}`);
  const custom = createResetDelivery({ PASSWORD_RESET_DELIVERY: 'local', PASSWORD_RESET_URL: 'http://127.0.0.1:4173/app' });
  await custom.sendEmail('a@example.com', TOKEN);
  assert.equal(custom.capture.list()[0].link, `http://127.0.0.1:4173/app#reset=${TOKEN}`);
  for (const url of ['http://evil.example/', 'https://user:pass@app.example.com/', 'https://app.example.com/?x=1', 'https://app.example.com/#frag']) {
    assert.throws(() => createResetDelivery({ PASSWORD_RESET_DELIVERY: 'local', PASSWORD_RESET_URL: url }), /trusted HTTPS frontend URL/, url);
  }
});

test('Resend mode is unchanged: it posts to Resend, captures nothing, and rejects a failed provider', async () => {
  let request;
  const delivery = createResetDelivery(RESEND_ENV, async (url, options) => { request = { url, options }; return { ok: true }; });
  assert.equal(delivery.mode, 'resend');
  assert.equal(delivery.capture, null);
  await delivery.sendEmail('a@example.com', TOKEN);
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(request.options.body).to, ['a@example.com']);
  await assert.rejects(createResetDelivery(RESEND_ENV, async () => ({ ok: false })).sendEmail('a@example.com', TOKEN), /delivery failed/);
  // an explicit "resend" with production settings behaves the same
  assert.equal(createResetDelivery({ ...RESEND_ENV, PASSWORD_RESET_DELIVERY: 'resend', NODE_ENV: 'production' }, async () => ({ ok: true })).mode, 'resend');
});

test('the capture is bounded, newest first, filterable by address, clearable', () => {
  const capture = createLocalMailCapture({ limit: 3, now: () => 'T' });
  for (const n of [1, 2, 3, 4]) capture.add({ to: n % 2 ? 'odd@example.com' : 'Even@Example.com', n });
  assert.equal(capture.size, 3);
  assert.deepEqual(capture.list().map((m) => m.n), [4, 3, 2]);
  assert.deepEqual(capture.list(' EVEN@example.com ').map((m) => m.n), [4, 2]);
  assert.deepEqual(capture.list('nobody@example.com'), []);
  assert.equal(capture.clear(), 3);
  assert.equal(capture.size, 0);
  assert.equal(LOCAL_MAIL_LIMIT, 20);
});

test('local mode keeps the generic response, the digest-only storage and the one-token flow', async () => {
  const delivery = createResetDelivery({ PASSWORD_RESET_DELIVERY: 'local' });
  const issued = [];
  const handlers = createPasswordResetHandlers({ issueToken: async (email, hash) => { issued.push({ email, hash }); return email === 'known@example.com' ? { email } : null; }, sendEmail: delivery.sendEmail });
  const a = response(), b = response();
  handlers.forgot({ body: { email: 'Known@Example.com' } }, a);
  handlers.forgot({ body: { email: 'unknown@example.com' } }, b);
  assert.deepEqual(a.body, b.body);
  assert.equal(a.code, 202); assert.equal(b.code, 202);
  await tick();
  assert.equal(delivery.capture.size, 1, 'only an existing account produces a captured email');
  const mail = delivery.capture.list()[0];
  const token = /#reset=([a-f0-9]{64})$/.exec(mail.link)[1];
  assert.equal(issued[0].hash, hashResetToken(token), 'the stored value is the SHA-256 digest of the emailed token');
  assert.notEqual(issued[0].hash, token);
  assert.equal(mail.to, 'known@example.com');
});

test('the local-mail route answers only on the loopback interface, with a localhost Host, outside production', () => {
  const capture = createLocalMailCapture();
  capture.add({ to: 'a@example.com', subject: 's', link: 'l', text: 't' });
  const call = (handler, { env = { NODE_ENV: 'development' }, remote = '127.0.0.1', host = 'localhost:5000', headers = {}, query = {} } = {}) => {
    const h = createDevMailHandlers({ capture, env })[handler];
    const res = { code: 200, headers: {}, status(c) { this.code = c; return this; }, json(body) { this.body = body; return this; }, set(k, v) { this.headers[k] = v; return this; } };
    h({ socket: { remoteAddress: remote }, headers: { host, ...headers }, query }, res);
    return res;
  };
  for (const [remote, host] of [['127.0.0.1', 'localhost:5000'], ['::1', '[::1]:5000'], ['::ffff:127.0.0.1', '127.0.0.1:5000'], ['127.0.0.1', 'LOCALHOST']]) {
    const r = call('list', { remote, host });
    assert.equal(r.code, 200, `${remote} ${host}`);
    assert.equal(r.body.mails.length, 1);
    assert.equal(r.headers['Cache-Control'], 'no-store');
  }
  assert.deepEqual(Object.keys(call('list').body), ['mails'], 'only captured mail is exposed');
  assert.equal(call('list', { env: { NODE_ENV: 'production' } }).code, 404, 'unavailable in production');
  assert.equal(call('clear', { env: { NODE_ENV: 'production' } }).code, 404);
  assert.equal(capture.size, 1, 'a refused request clears nothing');
  assert.equal(call('list', { remote: '203.0.113.9' }).code, 404, 'not from another machine');
  assert.equal(call('list', { remote: '203.0.113.9', headers: { 'x-forwarded-for': '127.0.0.1' } }).code, 404, 'a spoofed X-Forwarded-For does not count');
  assert.equal(call('list', { host: 'evil.example' }).code, 404, 'a non-localhost Host (DNS rebinding) is refused');
  assert.equal(call('list', { host: 'localhost.evil.example:5000' }).code, 404);
  assert.equal(call('list', { remote: null }).code, 404);
  assert.equal(call('list', { query: { email: 'other@example.com' } }).body.mails.length, 0, 'the address filter works');
  assert.equal(call('clear').body.cleared, 1);
  assert.equal(capture.size, 0);
});

test('no token or link reaches any console output in local mode', async () => {
  const lines = [];
  const original = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) { original[level] = console[level]; console[level] = (...args) => lines.push(args.join(' ')); }
  let delivery, token;
  try {
    delivery = createResetDelivery({ PASSWORD_RESET_DELIVERY: 'local' });
    const handlers = createPasswordResetHandlers({ issueToken: async (email) => ({ email }), sendEmail: delivery.sendEmail, reportFailure: () => console.error('Password recovery operation failed') });
    const res = response();
    handlers.forgot({ body: { email: 'known@example.com' } }, res);
    await tick();
    token = /#reset=([a-f0-9]{64})$/.exec(delivery.capture.list()[0].link)[1];
  } finally { Object.assign(console, original); }
  assert.equal(delivery.capture.size, 1);
  assert.equal(lines.join('\n').includes(token), false, 'the token is not logged');
  assert.equal(lines.join('\n').includes('reset='), false, 'the link is not logged');
  assert.equal(lines.length, 0, 'nothing at all is logged by the delivery path');
});
