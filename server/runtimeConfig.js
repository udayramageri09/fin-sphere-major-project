import { isIP } from 'node:net';

// Keep local recovery compatible; production requires a deliberate one-time migration.
// An explicit false also keeps test databases free of private legacy account data.
export function legacyImportEnabled(env) {
  const value = env.IMPORT_LEGACY_JSON;
  if (value === undefined || value === '') return env.NODE_ENV !== 'production';
  if (!['true', 'false'].includes(value)) throw new Error('IMPORT_LEGACY_JSON must be true or false');
  return value === 'true';
}

// Express accepts arbitrary truthy strings; reject typos before they silently trust a proxy.
// A hop count still requires the host to prevent shorter paths bypassing that proxy.
export function parseTrustProxy(value) {
  const text = value?.trim() ?? '';
  if (!text || text === 'false') return false;
  if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
  const valid = text.split(',').every(part => {
    const item = part.trim();
    if (['loopback', 'linklocal', 'uniquelocal'].includes(item)) return true;
    const [address, bits, extra] = item.split('/');
    const family = isIP(address);
    return family && extra === undefined && (bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128)));
  });
  if (valid) return text;
  throw new Error('TRUST_PROXY must be false, a nonnegative safe hop count, or valid IP/subnet list; true is forbidden');
}
