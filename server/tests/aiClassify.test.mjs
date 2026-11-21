import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanItems, parseSuggestions } from '../aiClassify.js';

test('items are validated and long reference numbers are masked before leaving the server', () => {
  const ok = cleanItems([{ index: 3, title: 'UPI/Ravi Kumar/9876543210123/ref', type: 'expense' }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.items[0].title, 'UPI/Ravi Kumar/#/ref');
  for (const bad of [null, [], [{ index: 1, title: '', type: 'expense' }], [{ index: 1, title: 'x', type: 'other' }], [{ index: 'a', title: 'x', type: 'income' }],
    Array.from({ length: 101 }, (_, index) => ({ index, title: 'x', type: 'income' }))]) {
    assert.equal(cleanItems(bad).ok, false);
  }
});

test('model output is accepted only from the fixed category list and valid directions', () => {
  const items = [{ index: 0, title: 'a', type: 'expense' }, { index: 1, title: 'b', type: 'income' }];
  const reply = '```json\n[{"index":0,"category":"food","classification":"expense"},{"index":1,"category":"Salary","classification":"expense"},'
    + '{"index":0,"category":"Shopping","classification":"expense"},{"index":7,"category":"Food","classification":"expense"},{"index":1,"category":"Invented","classification":"income"}]\n```';
  assert.deepEqual(parseSuggestions(reply, items), [
    { index: 0, category: 'Food', classification: 'expense' },
    { index: 1, category: 'Salary', classification: 'income' }
  ]);
  assert.deepEqual(parseSuggestions('not json', items), []);
  assert.deepEqual(parseSuggestions('{"index":0}', items), []);
});
