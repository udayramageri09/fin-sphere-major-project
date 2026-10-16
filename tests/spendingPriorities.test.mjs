import test from 'node:test';
import assert from 'node:assert/strict';
import { priorityBreakdown, priorityFor, suggestedPriority } from '../src/utils/spendingPriorities.js';
const expense = (id, amount, category = 'General', title = 'Something') => ({ id, amount: -amount, category, title, date: '2026-10-05', classification: 'expense' });
test('conservative suggestions leave broad and custom categories in Other', () => {
  for (const c of ['Food', 'Shopping', 'Travel', 'Investment', 'Custom art']) assert.equal(suggestedPriority(expense('1', 10, c)), 'Other');
  assert.equal(suggestedPriority(expense('1', 10, 'Rent')), 'Needs');
  assert.equal(suggestedPriority(expense('1', 10, 'Entertainment')), 'Wants');
  assert.equal(suggestedPriority(expense('1', 10, 'Food', 'ZOMATO ORDER 123')), 'Wants');
});
test('transaction override wins over remembered merchant and default', () => {
  const t = expense('1', 10, 'Food', 'Zomato order 123');
  assert.equal(priorityFor(t, { merchants: { 'zomato': 'Needs' } }).label, 'Needs');
  assert.equal(priorityFor(t, { merchants: { 'zomato': 'Needs' }, transactions: { '1': 'Other' } }).label, 'Other');
  assert.equal(priorityFor(t, { transactions: { '1': 'garbage' } }).label, 'Wants');
});
test('integer paise, selected months, gross expenses only, accurate denominator', () => {
  const list = [expense('1', 100.11, 'Rent'), expense('2', 20.22, 'Entertainment'), expense('3', 3.33), { ...expense('4', 500), classification: 'income' }, { ...expense('5', 30), classification: 'refund' }, { ...expense('6', 30), classification: 'transfer' }, { ...expense('7', 9), date: '2026-09-01' }];
  const r = priorityBreakdown(list, ['2026-10']);
  assert.equal(r.total, 12366); assert.equal(r.rows.length, 3);
  assert.equal(r.groups.reduce((sum, g) => sum + g.paise, 0), r.total);
  assert.equal(Math.round(r.groups.reduce((sum, g) => sum + g.share, 0) * 100), 100);
  assert.ok(priorityBreakdown([], ['2026-10']).groups.every(g => g.share === 0));
});
