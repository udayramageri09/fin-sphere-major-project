// Tests for src/utils/speechText.js (Issue #71): the spoken rendering of a reply. Figures are read out in words,
// never recomputed; the display text itself is never modified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toSpeechText, indianNumberWords, SPEECH_MAX_CHARS } from '../src/utils/speechText.js';

test('INR amounts are spoken in the Indian number system', () => {
  assert.equal(toSpeechText('₹24,320'), 'twenty-four thousand three hundred twenty rupees');
  assert.equal(toSpeechText('₹1,25,000'), 'one lakh twenty-five thousand rupees');
  assert.equal(toSpeechText('₹100000'), 'one lakh rupees');
  assert.equal(toSpeechText('₹12,34,56,789'), 'twelve crore thirty-four lakh fifty-six thousand seven hundred eighty-nine rupees');
  assert.equal(toSpeechText('₹1'), 'one rupee');
  assert.equal(toSpeechText('₹0'), 'zero rupees');
  assert.equal(toSpeechText('₹1,200.5'), 'one thousand two hundred rupees and fifty paise');
  assert.equal(toSpeechText('₹0.05'), 'zero rupees and five paise');
  assert.equal(toSpeechText('Rs. 500 and INR 2,000'), 'five hundred rupees and two thousand rupees');
  assert.equal(indianNumberWords(250000000), 'twenty-five crore');
});

test('signs, dates and unreadable precision are preserved', () => {
  assert.equal(toSpeechText('Your net cash flow is -₹8,500.'), 'Your net cash flow is minus eight thousand five hundred rupees.');
  assert.equal(toSpeechText('This month (2026-10) is listed.'), 'This month (2026-10) is listed.');
  assert.equal(toSpeechText('Due on 2026-11-05.'), 'Due on 2026-11-05.');
  assert.equal(toSpeechText('The figure is ₹1,234.567'), 'The figure is ₹1,234.567', 'more than paise precision is left as written');
  assert.equal(toSpeechText('Across all 9 recorded transactions.'), 'Across all 9 recorded transactions.', 'plain counts are left alone');
});

test('percentages and decimals are spoken naturally', () => {
  assert.equal(toSpeechText('12.5%'), 'twelve point five percent');
  assert.equal(toSpeechText('36%'), 'thirty-six percent');
  assert.equal(toSpeechText('-4%'), 'minus four percent');
  assert.equal(toSpeechText('3.2 months'), 'three point two months');
  assert.equal(toSpeechText('Debt-to-income is 36.5% and coverage 2.1 months.'),
    'Debt-to-income is thirty-six point five percent and coverage two point one months.');
});

test('a grounded reply keeps every figure, only spoken differently', () => {
  const reply = 'This month (2026-10) your spending is ₹9,500: ₹11,000 of expenses minus ₹1,500 of refunds.';
  const before = reply.slice();
  assert.equal(toSpeechText(reply),
    'This month (2026-10) your spending is nine thousand five hundred rupees: eleven thousand rupees of expenses minus one thousand five hundred rupees of refunds.');
  assert.equal(reply, before, 'display text is not modified');
});

test('markdown lists become natural sentences; formatting and emoji are dropped', () => {
  assert.equal(toSpeechText('## Budgets\n- "Food": ₹8,500 spent\n- "Rent": ₹30,000 spent'),
    'Budgets. "Food": eight thousand five hundred rupees spent. "Rent": thirty thousand rupees spent.');
  assert.equal(toSpeechText('1. First step\n2. Second step'), 'First step. Second step.');
  assert.equal(toSpeechText('**Total spending:** ₹9,500 📉'), 'Total spending: nine thousand five hundred rupees');
  assert.equal(toSpeechText('Hi there! 👋 Ask me anything.'), 'Hi there! Ask me anything.');
  assert.equal(toSpeechText('See [the Goals page](https://example.com/goals) for details.'), 'See the Goals page for details.');
  assert.equal(toSpeechText('Use `code` here'), 'Use code here');
});

test('very long replies are shortened for speech only, at a sentence boundary', () => {
  const sentence = 'Your spending on groceries stayed within the limit you set for this month. ';
  const long = sentence.repeat(20);
  const spoken = toSpeechText(long);
  assert.ok(spoken.length <= SPEECH_MAX_CHARS + 40, `spoken ${spoken.length} chars`);
  assert.ok(spoken.endsWith('The full answer is on your screen.'));
  assert.ok(spoken.startsWith('Your spending on groceries stayed within the limit'));
  assert.equal(toSpeechText(sentence.trim()), sentence.trim(), 'short replies are not shortened');
});

test('empty or non-string input gives an empty string', () => {
  assert.equal(toSpeechText(''), '');
  assert.equal(toSpeechText('   '), '');
  assert.equal(toSpeechText(null), '');
  assert.equal(toSpeechText(undefined), '');
  assert.equal(toSpeechText(42), '');
  assert.equal(indianNumberWords(-1), null);
  assert.equal(indianNumberWords(1.5), null);
});
