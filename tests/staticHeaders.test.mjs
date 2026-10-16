// The static-host security headers file exists, is in Cloudflare Pages' format, and cannot break the app.
//   npm run test:static-headers
import assert from 'node:assert/strict';
import fs from 'node:fs';

const text = fs.readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
assert.equal(lines[0].trim(), '/*', 'applies to every path');
const headers = Object.fromEntries(lines.slice(1).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]; }));
assert.equal(headers['x-content-type-options'], 'nosniff');
assert.equal(headers['x-frame-options'], 'DENY');
assert.match(headers['referrer-policy'], /strict-origin/);
assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
assert.match(headers['permissions-policy'], /microphone=\(self\)/, 'the voice assistant needs the microphone on this origin');
assert.doesNotMatch(headers['content-security-policy'], /default-src|script-src|connect-src/, 'a partial script/connect policy would break the app; the full CSP belongs in the runbook until the API origin is known');
assert.ok(lines.length - 1 <= 100, 'Cloudflare Pages allows at most 100 header rules');
console.log('Static headers file: 7 checks passed');
