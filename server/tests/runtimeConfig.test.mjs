import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyImportEnabled, parseTrustProxy } from '../runtimeConfig.js';
test('production never imports legacy files implicitly', () => {
  assert.equal(legacyImportEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(legacyImportEnabled({ NODE_ENV: 'production', IMPORT_LEGACY_JSON: 'true' }), true);
  assert.equal(legacyImportEnabled({ IMPORT_LEGACY_JSON: 'false' }), false);
  assert.equal(legacyImportEnabled({}), true);
  assert.throws(() => legacyImportEnabled({ IMPORT_LEGACY_JSON: 'yes' }));
});
test('proxy trust is explicit and bounded to a valid configuration', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy(' 1 '), 1);
  assert.equal(parseTrustProxy('0'), 0);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy('127.0.0.1, ::1'), '127.0.0.1, ::1');
  for (const value of ['true', '-1', '1.5', 'nonsense', '9007199254740992']) assert.throws(() => parseTrustProxy(value));
});
