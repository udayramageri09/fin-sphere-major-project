// Tests for src/utils/actionConfirmation.js and src/utils/localDate.js (Issue #73).   Run: npm run test:confirmation
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfirmation, CONFIRM_PHRASES, CANCEL_PHRASES } from '../src/utils/actionConfirmation.js';
import { CONFIRM_PHRASES as SERVER_CONFIRM, CANCEL_PHRASES as SERVER_CANCEL, parseYesNo } from '../server/assistantActions.js';
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

test('Issue #75: the new confirmation verbs (record it / set it / update it / create it), whole utterance only', () => {
  for (const t of ['record it', 'Record it!', 'set it', 'update it', 'create it', 'yes record it', 'yes set it', 'yes update it', 'yes create it']) {
    assert.equal(parseConfirmation(t), 'yes', t);
  }
  for (const t of ['record it later', 'set it to 9000', 'update it to 5000', 'do not set it', 'yes record it tomorrow', 'record', 'update', 'create it for me tomorrow']) {
    assert.equal(parseConfirmation(t), null, t);
  }
});

test('Issue #75: the browser and the server read confirmations IDENTICALLY (same vocabulary, same answers)', () => {
  assert.deepEqual([...CONFIRM_PHRASES].sort(), [...SERVER_CONFIRM].sort(), 'confirm phrases are the same list');
  assert.deepEqual([...CANCEL_PHRASES].sort(), [...SERVER_CANCEL].sort(), 'cancel phrases are the same list');
  const samples = [
    ...CONFIRM_PHRASES, ...CANCEL_PHRASES,
    'yes but make it 600', 'yesterday', 'I said yes earlier', 'yes and open goals', 'nobody', 'stopwatch', 'cancel my subscription',
    'record it later', 'set it to 9000', 'update it please', 'make it 600', 'lunch', '', 'YES!', 'No.', 'Go Ahead!!', 'never mind.',
  ];
  for (const t of samples) assert.equal(parseConfirmation(t), parseYesNo(t), `client and server disagree on ${JSON.stringify(t)}`);
  assert.ok(!CANCEL_PHRASES.some((c) => CONFIRM_PHRASES.includes(c)), 'no phrase both confirms and cancels');
});

test('Issue #77: natural whole-utterance confirmations (yeah sure, ok do it, ...)', () => {
  for (const t of ['yeah sure', 'yes sure', 'sure', 'sure do it', 'ok', 'okay', 'ok do it', 'okay do it', 'yes do it', 'yeah do it', 'go ahead', 'please do', 'do it', 'confirm it', 'Yeah, sure!', 'OK, do it.', 'Okay do it!']) {
    assert.equal(parseConfirmation(t), 'yes', t);
    assert.equal(parseYesNo(t), 'yes', `server: ${t}`);
  }
});

test('Issue #77: confirmations are whole-utterance only; edits and conditions never confirm', () => {
  for (const t of [
    'yes but make it 600', 'okay change it to 9000', 'sure use the other loan', 'yeah maybe', 'do it tomorrow', 'yes if the balance is enough',
    'yeah sure but make it 600', 'ok do it later', 'sure do it for yesterday', 'okay do it twice', 'confirm it tomorrow', 'yeah sure thing',
    'ok do', 'sure sure sure', 'yeah sure.. actually no',
  ]) {
    assert.equal(parseConfirmation(t), null, t);
    assert.equal(parseYesNo(t), null, `server: ${t}`);
  }
});
