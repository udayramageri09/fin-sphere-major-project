// companionState.js - which state the Financial Companion shows, derived only from real assistant state (Issue #71).
//
// Continuous states come straight from the assistant: the microphone is open (listening), a request is in flight
// (thinking), the voice session is reading a reply aloud (speaking), or the voice session stopped on an error
// (hasError). Short events are "pulses" that expire on their own: a reply arrived (insight), an explicitly requested
// page is being opened (navigating), or a request failed (error). attention and success are supported visually for
// future financial events but nothing triggers them yet.
// Pure: no React, no DOM, no timers; `now` is passed in so expiry is deterministic.

export const COMPANION_STATES = {
  idle:      { label: 'Assistant ready' },
  listening: { label: 'Listening' },
  thinking:  { label: 'Thinking' },
  speaking:  { label: 'Speaking' },
  insight:   { label: 'New answer' },
  navigating: { label: 'Opening' },
  attention: { label: 'Needs your attention' },
  success:   { label: 'Done' },
  error:     { label: 'Something went wrong' },
};

export const PULSE_KINDS = ['insight', 'navigating', 'attention', 'success', 'error'];
export const PULSE_MS = 2500;
// The short "navigating" sweep played as the assistant opens a page (explicit navigation only). Navigation itself
// is not delayed by it; a voice session waits this long before listening again so the sweep is visible.
export const NAVIGATION_PULSE_MS = 600;

// A short-lived event state, or null for an unknown kind.
export function createPulse(kind, now = Date.now(), durationMs = PULSE_MS) {
  if (!PULSE_KINDS.includes(kind) || !Number.isFinite(now) || !(durationMs > 0)) return null;
  return { kind, until: now + durationMs };
}

export function isPulseActive(pulse, now = Date.now()) {
  return Boolean(pulse) && PULSE_KINDS.includes(pulse.kind) && Number.isFinite(pulse.until) && now < pulse.until;
}

/**
 * Priority (highest first):
 *   error (hasError or an error pulse) > listening > thinking > speaking > insight / navigating / attention / success
 *   pulse > idle   (one pulse at a time: the newest replaces the previous one)
 * An error is shown even over listening or thinking so a failure is never hidden; a live activity (listening,
 * thinking, speaking) outranks the softer insight/attention/success pulses, which only decorate a quiet moment, so
 * a reply's insight pulse never hides the voice reading that reply aloud. In a voice session listening, thinking and
 * speaking are mutually exclusive phases; the order only matters if a caller passes several flags at once.
 * Only `=== true` counts for the flags, so missing or malformed input safely gives "idle".
 */
export function deriveCompanionState({ isListening, isThinking, isSpeaking, hasError, pulse } = {}, now = Date.now()) {
  const active = isPulseActive(pulse, now) ? pulse.kind : null;
  if (hasError === true || active === 'error') return 'error';
  if (isListening === true) return 'listening';
  if (isThinking === true) return 'thinking';
  if (isSpeaking === true) return 'speaking';
  if (active) return active;
  return 'idle';
}

export const companionLabel = (state) => (COMPANION_STATES[state] ?? COMPANION_STATES.idle).label;
