// Provider selection + persistence. Plans.jsx (and anything else that needs an Advisor provider)
// only ever imports from this module - never groqProvider.js/webllmProvider.js directly - so the
// UI never has to care which provider is active or how it is implemented.
export const PROVIDERS = { GROQ: 'groq', LOCAL: 'local' };
export const DEFAULT_PROVIDER = PROVIDERS.GROQ;

const KEY_PREFIX = 'finsphere:intelligence-provider:';
export const providerStorageKey = (userId) => `${KEY_PREFIX}${userId}`;

// Never throws: localStorage can be unavailable (private window, blocked site data, SSR/tests).
// Restores Local only if the user previously chose it - it never auto-initializes the model
// itself; that only happens when the user explicitly activates Local again (see Plans.jsx).
export function loadStoredProvider(userId) {
  if (userId === null || userId === undefined) return DEFAULT_PROVIDER;
  try {
    const value = window.localStorage.getItem(providerStorageKey(userId));
    return value === PROVIDERS.LOCAL ? PROVIDERS.LOCAL : DEFAULT_PROVIDER;
  } catch {
    return DEFAULT_PROVIDER;
  }
}

export function saveStoredProvider(userId, provider) {
  if (userId === null || userId === undefined) return;
  try {
    window.localStorage.setItem(providerStorageKey(userId), provider === PROVIDERS.LOCAL ? PROVIDERS.LOCAL : PROVIDERS.GROQ);
  } catch { /* ignored - persistence is a convenience, never required for the page to work */ }
}

export { createGroqProvider } from './groqProvider.js';
