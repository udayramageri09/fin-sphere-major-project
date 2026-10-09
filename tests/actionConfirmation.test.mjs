// Tests for src/utils/actionConfirmation.js and src/utils/localDate.js (Issue #73).   Run: npm run test:confirmation
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfirmation } from '../src/utils/actionConfirmation.js';
import { localDateString } from '../src/utils/localDate.js';

test('whole-utterance confirmations', () => {
  for (const t of ['yes', 'Yes', 'YES!', 'yes please', 'Yes, please.', 'confirm', 'go ahead', 'Go ahead!', 'do it', 'add it', 'haan', 'yeah', 'ok', 'okay', 'sure', 'yes go ahead']) {
    assert.equal(parseConfirmation(t), 'yes', t);
  }
});

test('whole-utterance cancellations', () => {
  for (const t of ['no', 'No.', 'cancel', 'Cancel it', 'stop', "don't", 'dont', 'never mind', 'Never mind!', 'nevermind', 'no thanks', 'forget it']) {
    assert.equal(parseConfirmation(t), 'no', t);
  }
});

test('anything longer or different is NOT a confirmation (substrings never count)', () => {
  for (const t of [
    'yes but make it 600', 'yes, but change it to yesterday', 'yesterday', 'I said yes earlier', 'yes and open goals', 'yes how much did I spend',
    'nobody', 'notes', 'stopwatch', 'cancel my subscription', 'do it tomorrow', 'go ahead and change the amount', 'okay so how much is that',
    'add it to my goal', 'confirmation', 'yess', 'make it 600', 'lunch', '', '   ', 'no I mean yes',
  ]) assert.equal(parseConfirmation(t), null, JSON.stringify(t));
  assert.equal(parseConfirmation(undefined), null);
  assert.equal(parseConfirmation(null), null);
  assert.equal(parseConfirmation(42), null);
});

test('localDateString uses the LOCAL calendar date, never the UTC one', () => {
  assert.equal(localDateString(new Date(2026, 9, 8, 23, 59, 59)), '2026-10-08');   // 11:59 pm local, whatever the UTC date is
  assert.equal(localDateString(new Date(2026, 9, 8, 0, 0, 1)), '2026-10-08');      // just after local midnight
  assert.equal(localDateString(new Date(2026, 0, 5, 12)), '2026-01-05');
  assert.equal(localDateString(new Date(2024, 1, 29, 12)), '2024-02-29');
  assert.match(localDateString(), /^\d{4}-\d{2}-\d{2}$/);
});
