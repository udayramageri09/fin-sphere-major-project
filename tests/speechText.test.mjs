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

test('instant local replies cover only greetings, thanks and help; everything else goes to the server', async () => {
  const { localCommand } = await import('../src/utils/localCommands.js');
  assert.match(localCommand('Hello!'), /^Hi!/);
  assert.match(localCommand('hey FinSphere'), /^Hi!/);
  assert.equal(localCommand('thank you'), "You're welcome!");
  assert.match(localCommand('what can you do?'), /open any page/);
  for (const text of ['how much did I spend this month', 'hi there, add 450 for lunch', 'help me budget', '', null]) assert.equal(localCommand(text), null);
});

test('circle to ask reads only the text under the circle, in reading order, and ignores the assistant UI', async () => {
  const { JSDOM } = await import('jsdom');
  const { boxFromPoints, collectScreenContext } = await import('../src/utils/screenCapture.js');
  assert.equal(boxFromPoints([{ x: 5, y: 5 }, { x: 10, y: 9 }]), null, 'a tap is not a circle');
  const box = boxFromPoints([{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 200 }, { x: 100, y: 200 }]);
  assert.deepEqual(box, { left: 88, top: 88, right: 312, bottom: 212 });
  const { window } = new JSDOM(`<body>
    <section data-guide-tip="Your balance card."><span id="a">Balance</span><span id="b">Rs 1,000</span></section>
    <p id="far">Elsewhere</p><div class="ai-chat-panel"><span id="chat">Chat text</span></div><span id="hidden">Hidden</span></body>`);
  const rects = { a: [110, 120, 80, 20], b: [210, 120, 60, 20], far: [600, 600, 80, 20], chat: [120, 150, 80, 20], hidden: [150, 150, 40, 20] };
  const rectOf = (node) => {
    const [left, top, width, height] = rects[node.parentElement.id] ?? [0, 0, 0, 0];
    return { left, top, width, height, right: left + width, bottom: top + height };
  };
  const doc = window.document;
  const section = doc.querySelector('section');
  section.getBoundingClientRect = () => ({ left: 90, top: 90, right: 300, bottom: 200, width: 210, height: 110 });
  doc.getElementById('hidden').checkVisibility = () => false;
  assert.deepEqual(collectScreenContext(box, { doc, rectOf }), { text: 'Balance ' + String.fromCharCode(183) + ' Rs 1,000', hint: 'Your balance card.' });
});
