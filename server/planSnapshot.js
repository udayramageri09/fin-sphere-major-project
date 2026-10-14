// planSnapshot.js - the last successful Plans analysis, kept per signed-in user (Issue #80).
//
// /api/plan-chat narrates the analysis the SERVER produced for the caller, never a context sent by the browser. This store
// is deliberately small and ephemeral: in memory only (nothing is persisted), keyed by the authenticated user id, each entry
// valid for a fixed time, bounded in size, with the least recently used user evicted first. One user's entry can never be
// returned for another id.

export const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
export const SNAPSHOT_MAX_ENTRIES = 1000;

export function createSnapshotStore({ ttlMs = SNAPSHOT_TTL_MS, maxEntries = SNAPSHOT_MAX_ENTRIES, now = () => Date.now() } = {}) {
  const entries = new Map();   // insertion order = least recently used first

  const keyOf = (userId) => String(userId);

  function get(userId) {
    const key = keyOf(userId);
    const entry = entries.get(key);
    if (!entry) return null;
    if (now() - entry.at >= ttlMs) { entries.delete(key); return null; }
    entries.delete(key);          // reading refreshes recency, never the expiry time
    entries.set(key, entry);
    return entry;
  }

  function set(userId, data) {
    const key = keyOf(userId);
    entries.delete(key);
    entries.set(key, { data, at: now() });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  return { get, set, delete: (userId) => entries.delete(keyOf(userId)), get size() { return entries.size; } };
}

// What the client receives and what plan-chat is built from: the FastAPI analysis without the per-transaction cluster
// labels (the browser never uses them and they repeat every transaction), and with the failure messages reduced to
// "this section failed" (a Python exception text can echo input).
export function sanitizeAnalysis(data) {
  const out = data !== null && typeof data === 'object' && !Array.isArray(data) ? { ...data } : {};
  if (out.clusters && typeof out.clusters === 'object' && !Array.isArray(out.clusters)) {
    const clusters = { ...out.clusters };
    delete clusters.labeled_transactions;
    out.clusters = clusters;
  }
  if (out.metadata && typeof out.metadata === 'object' && !Array.isArray(out.metadata)) {
    const metadata = { ...out.metadata };
    const errors = metadata.errors;
    if (errors && typeof errors === 'object' && !Array.isArray(errors)) {
      metadata.errors = Object.fromEntries(Object.keys(errors).map((section) => [section, true]));
    } else {
      metadata.errors = null;
    }
    out.metadata = metadata;
  }
  return out;
}
