// Tests for src/utils/companionState.js (Issue #71).   Run: npm run test:companion
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANION_STATES, PULSE_KINDS, PULSE_MS, NAVIGATION_PULSE_MS, createPulse, isPulseActive, deriveCompanionState, companionLabel,
} from '../src/utils/companionState.js';

const NOW = 1_000_000;
const pulse = (kind, until = NOW + 1000) => ({ kind, until });
const derive = (input) => deriveCompanionState(input, NOW);

test('every supported state exists with an accessible label', () => {
  assert.deepEqual(Object.keys(COMPANION_STATES).sort(),
    ['attention', 'error', 'idle', 'insight', 'listening', 'navigating', 'speaking', 'success', 'thinking']);
  assert.deepEqual(
    Object.fromEntries(Object.entries(COMPANION_STATES).map(([k, v]) => [k, v.label])),
    {
      idle: 'Assistant ready', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking',
      insight: 'New answer', navigating: 'Opening', attention: 'Needs your attention', success: 'Done', error: 'Something went wrong',
    });
  for (const s of Object.keys(COMPANION_STATES)) assert.equal(companionLabel(s), COMPANION_STATES[s].label);
  assert.equal(companionLabel('nonsense'), 'Assistant ready');
  assert.equal(companionLabel(undefined), 'Assistant ready');
});

test('each state is reachable from real inputs', () => {
  assert.equal(derive({}), 'idle');
  assert.equal(derive({ isListening: true }), 'listening');
  assert.equal(derive({ isThinking: true }), 'thinking');
  assert.equal(derive({ isSpeaking: true }), 'speaking');
  for (const kind of PULSE_KINDS) assert.equal(derive({ pulse: pulse(kind) }), kind);
});

test('priority: error > listening > thinking > speaking > insight/attention/success > idle', () => {
  assert.equal(derive({ isListening: true, isThinking: true, isSpeaking: true, pulse: pulse('error') }), 'error');
  assert.equal(derive({ isListening: true, isThinking: true, isSpeaking: true, pulse: pulse('insight') }), 'listening');
  assert.equal(derive({ isThinking: true, isSpeaking: true, pulse: pulse('success') }), 'thinking');
  assert.equal(derive({ isSpeaking: true, pulse: pulse('attention') }), 'speaking');
  assert.equal(derive({ isThinking: true, pulse: pulse('error') }), 'error');
  for (const kind of ['insight', 'attention', 'success']) {
    assert.equal(derive({ isListening: true, pulse: pulse(kind) }), 'listening', `listening outranks ${kind}`);
    assert.equal(derive({ isThinking: true, pulse: pulse(kind) }), 'thinking', `thinking outranks ${kind}`);
  }
});

test('pulses expire deterministically', () => {
  const p = createPulse('insight', NOW);
  assert.deepEqual(p, { kind: 'insight', until: NOW + PULSE_MS });
  assert.ok(PULSE_MS >= 2000 && PULSE_MS <= 3000, 'pulse lasts about 2-3 seconds');
  assert.equal(deriveCompanionState({ pulse: p }, NOW), 'insight');
  assert.equal(deriveCompanionState({ pulse: p }, NOW + PULSE_MS - 1), 'insight');
  assert.equal(deriveCompanionState({ pulse: p }, NOW + PULSE_MS), 'idle');
  assert.equal(deriveCompanionState({ pulse: createPulse('error', NOW) }, NOW + PULSE_MS + 5), 'idle');
  // an expired error no longer hides real activity
  assert.equal(deriveCompanionState({ isThinking: true, pulse: createPulse('error', NOW) }, NOW + PULSE_MS), 'thinking');
  assert.equal(isPulseActive(p, NOW), true);
  assert.equal(isPulseActive(p, NOW + PULSE_MS), false);
  assert.deepEqual(createPulse('error', NOW, 500), { kind: 'error', until: NOW + 500 });
});

test('dormant states (speaking, attention, success) are supported but nothing creates them implicitly', () => {
  // supported when explicitly given
  assert.equal(derive({ isSpeaking: true }), 'speaking');
  assert.equal(derive({ pulse: createPulse('attention', NOW) }), 'attention');
  assert.equal(derive({ pulse: createPulse('success', NOW) }), 'success');
  // never produced from the live assistant flags alone
  for (const isListening of [false, true]) {
    for (const isThinking of [false, true]) {
      const s = derive({ isListening, isThinking, isSpeaking: false, pulse: null });
      assert.ok(!['speaking', 'attention', 'success'].includes(s), `${s} from listening=${isListening} thinking=${isThinking}`);
    }
  }
});

test('voice session: speaking is a real state, a persistent error outranks everything', () => {
  assert.equal(derive({ isSpeaking: true, pulse: pulse('insight') }), 'speaking', 'an insight pulse never hides speech');
  assert.equal(derive({ isSpeaking: true, pulse: { kind: 'insight', until: NOW - 1 } }), 'speaking', 'expired pulse irrelevant');
  assert.equal(derive({ hasError: true }), 'error');
  assert.equal(derive({ hasError: true, isListening: true, isThinking: true, isSpeaking: true, pulse: pulse('insight') }), 'error');
  assert.equal(derive({ hasError: 'yes', isListening: true }), 'listening', 'only hasError === true counts');
  // the voice phases are exclusive by design; each maps to its own state
  assert.equal(derive({ isListening: true }), 'listening');
  assert.equal(derive({ isThinking: true }), 'thinking');
  assert.equal(derive({ isSpeaking: true }), 'speaking');
});

test('navigating: a short pulse below live activity, gone after its duration', () => {
  assert.ok(NAVIGATION_PULSE_MS >= 300 && NAVIGATION_PULSE_MS <= 700, `duration ${NAVIGATION_PULSE_MS} ms`);
  const p = createPulse('navigating', NOW, NAVIGATION_PULSE_MS);
  assert.deepEqual(p, { kind: 'navigating', until: NOW + NAVIGATION_PULSE_MS });
  assert.equal(deriveCompanionState({ pulse: p }, NOW), 'navigating');
  assert.equal(deriveCompanionState({ pulse: p }, NOW + NAVIGATION_PULSE_MS), 'idle');
  assert.equal(deriveCompanionState({ isListening: true, pulse: p }, NOW), 'listening', 'never hides real listening');
  assert.equal(deriveCompanionState({ isSpeaking: true, pulse: p }, NOW), 'speaking');
  assert.equal(deriveCompanionState({ hasError: true, pulse: p }, NOW), 'error');
});

test('reduced motion: the navigating sweep animates only when motion is allowed, and has a static form', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../src/components/FinancialCompanion.css', import.meta.url), 'utf8');
  const motionStart = css.indexOf('@media (prefers-reduced-motion: no-preference)');
  assert.ok(motionStart > 0, 'motion block exists');
  const motionBlock = css.slice(motionStart, css.indexOf('@keyframes', motionStart));
  const outside = css.slice(0, motionStart) + css.slice(css.indexOf('@keyframes', motionStart));
  assert.match(motionBlock, /\[data-state="navigating"\] \.fc-sweep \{ animation: fc-sweep/);
  assert.doesNotMatch(outside, /\[data-state="navigating"\][^{]*\{[^}]*animation:/, 'no navigating animation outside the motion block');
  assert.match(outside, /\[data-state="navigating"\] \.fc-sweep \{ opacity: 0\.95; \}/, 'static arc shows the state without motion');
  // every animation in the stylesheet is inside the no-preference block
  assert.doesNotMatch(outside, /animation:/, 'all companion animations are gated by prefers-reduced-motion');
});

test('invalid or missing input safely gives idle', () => {
  assert.equal(deriveCompanionState(), 'idle');
  assert.equal(deriveCompanionState(undefined, NOW), 'idle');
  assert.equal(derive({ isListening: 'yes', isThinking: 1, isSpeaking: {} }), 'idle');
  assert.equal(derive({ pulse: { kind: 'party', until: NOW + 1000 } }), 'idle');
  assert.equal(derive({ pulse: { kind: 'insight' } }), 'idle');
  assert.equal(derive({ pulse: { kind: 'insight', until: 'later' } }), 'idle');
  assert.equal(derive({ pulse: 'insight' }), 'idle');
  assert.equal(createPulse('party', NOW), null);
  assert.equal(createPulse('insight', NaN), null);
  assert.equal(createPulse('insight', NOW, 0), null);
  assert.equal(isPulseActive(null, NOW), false);
});
