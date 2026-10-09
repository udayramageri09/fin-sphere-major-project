// Tests for the deterministic extraction in server/assistantActions.js (Issue #73).
//   npm --prefix server run test:actions-extract
// Pure functions only: no database, no network, no language model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTransaction, looksLikeTransaction, extractGoalContribution, chooseAmount, findAmounts, findDate, shiftDate,
  exactGoalMatches, nearGoalMatches, pickCandidate, parseEdit, parseYesNo, stripPolite, isQuestion,
} from '../assistantActions.js';

const LOCAL = '2026-10-08';
const tx = (text) => extractTransaction(text, { localDate: LOCAL });

test('amount forms: ₹, bare, k, lakh, crore, Indian grouping', () => {
  const v = (t) => chooseAmount(t).value;
  assert.equal(v('₹500'), 500);
  assert.equal(v('500'), 500);
  assert.equal(v('5k'), 5000);
  assert.equal(v('1.5k'), 1500);
  assert.equal(v('1 lakh'), 100000);
  assert.equal(v('1.5 lakh'), 150000);
  assert.equal(v('2 crore'), 20000000);
  assert.equal(v('₹1,25,000'), 125000);
  assert.equal(v('Rs. 2,500.50'), 2500.5);
  assert.equal(v('0.1 lakh'), 10000, 'exact decimal scaling, no float drift');
  assert.equal(v('1.1k'), 1100);
  assert.equal(v('450 rupees'), 450);
});

test('amounts: dates are not amounts; marked amounts beat bare numbers; conflicting amounts are ambiguous', () => {
  assert.equal(chooseAmount('lunch on 2026-10-05').status, 'none');
  assert.equal(chooseAmount('₹450 for 2 people').value, 450);
  assert.equal(chooseAmount('add 5th item').status, 'none');
  assert.equal(chooseAmount('₹450 and ₹600').status, 'many');
  assert.equal(chooseAmount('2 coffees for 500').status, 'many');
  assert.equal(chooseAmount('₹450, that is 450 rupees').status, 'one', 'the same value twice is one amount');
  assert.equal(chooseAmount('no number here').status, 'none');
  assert.equal(findAmounts('₹10 and 5k').length, 2);
});

test('dates: today / yesterday resolve from the CLIENT local date; unsupported phrases are not guessed', () => {
  assert.deepEqual(findDate('lunch today', LOCAL), { kind: 'ok', date: '2026-10-08' });
  assert.deepEqual(findDate('lunch yesterday', LOCAL), { kind: 'ok', date: '2026-10-07' });
  assert.deepEqual(findDate('the day before yesterday', LOCAL), { kind: 'ok', date: '2026-10-06' });
  assert.deepEqual(findDate('on 2026-09-30', LOCAL), { kind: 'ok', date: '2026-09-30' });
  assert.deepEqual(findDate('today', undefined), { kind: 'needs-local' }, 'no client date: never fall back to the server clock');
  assert.equal(findDate('on friday', LOCAL).kind, 'unsupported');
  assert.equal(findDate('last week', LOCAL).kind, 'unsupported');
  assert.equal(findDate('on the 5th', LOCAL).kind, 'unsupported');
  assert.equal(findDate('5 oct', LOCAL).kind, 'unsupported');
  assert.equal(findDate('12/10/2026', LOCAL).kind, 'unsupported');
  assert.equal(findDate('tomorrow', LOCAL).kind, 'unsupported');
  assert.equal(findDate('2026-02-30', LOCAL).kind, 'unsupported', 'not a real calendar date');
  assert.equal(findDate('lunch', LOCAL).kind, 'none');
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDate('2024-03-01', -1), '2024-02-29');
});

test('transactions: the practical phrasings from the spec', () => {
  assert.deepEqual(tx('Add ₹450 for lunch today').fields, { type: 'expense', amount: 450, date: '2026-10-08', titleRaw: 'lunch', title: 'Lunch' });
  assert.deepEqual(tx('Record ₹1,250 spent on fuel yesterday').fields, { type: 'expense', amount: 1250, date: '2026-10-07', titleRaw: 'fuel', title: 'Fuel' });
  assert.deepEqual(tx('Add salary of ₹65,000 today').fields, { type: 'income', amount: 65000, date: '2026-10-08', titleRaw: 'salary', title: 'Salary' });
  assert.deepEqual(tx('Log 500 expense for coffee').fields, { type: 'expense', amount: 500, titleRaw: 'coffee', title: 'Coffee' });
  assert.deepEqual(tx('I received 5000 salary today').fields, { type: 'income', amount: 5000, date: '2026-10-08', titleRaw: 'salary', title: 'Salary' });
  assert.deepEqual(tx('Spent 1.5k on groceries').fields, { type: 'expense', amount: 1500, titleRaw: 'groceries', title: 'Groceries' });
  assert.equal(tx('Add 1.5 lakh salary today').fields.amount, 150000);
  assert.equal(tx('Please can you add ₹80 for tea').fields.title, 'Tea');
  assert.equal(tx('Someone paid me ₹900 for the old book').fields.type, 'income', '"paid me" is money received');
});

test('transactions: missing and ambiguous pieces are reported, never guessed', () => {
  const noTitle = tx('Add ₹450 expense');
  assert.equal(noTitle.fields.amount, 450); assert.equal(noTitle.fields.title, undefined);
  const noAmount = tx('Add lunch expense');
  assert.equal(noAmount.fields.amount, undefined); assert.equal(noAmount.fields.title, 'Lunch');
  assert.equal(tx('Add 2 coffees for 500').issues.amountAmbiguous, true);
  assert.equal(tx('Add ₹450 and ₹600 for lunch').fields.amount, undefined);
  assert.equal(tx('Add ₹450').fields.type, undefined, 'no direction word: the direction is asked, not assumed');
  assert.equal(tx('Add ₹450 for lunch on friday').issues.dateIssue, 'unsupported');
  assert.equal(tx('Add ₹450 for lunch on friday').fields.title, 'Lunch', 'the unresolved date phrase is not kept in the title');
  assert.equal(extractTransaction('Add ₹450 for lunch today', {}).issues.dateIssue, 'needs-local');
  assert.equal(tx('Add salary expense of ₹100').issues.directionConflict, true);
});

test('transactions: refunds and transfers are never classified from chat; classification is never guessed', () => {
  assert.equal(tx('Add ₹500 refund from Amazon').unsupportedClassification, true);
  assert.equal(tx('Record ₹2,000 transfer to savings').unsupportedClassification, true);
  assert.equal(tx('Add ₹450 for lunch today').unsupportedClassification, false);
  assert.equal('classification' in tx('Add ₹450 for lunch today').fields, false, 'the API default (unknown) applies');
  assert.equal('category' in tx('Add ₹450 for lunch today').fields, false, 'the API default (General) applies');
});

test('what counts as a transaction request (questions and other topics are left alone)', () => {
  for (const yes of ['Add ₹450 for lunch today', 'Log 500 expense for coffee', 'I spent 300 on tea', 'Paid ₹1,200 for fuel', 'Received 5000 salary', 'Add lunch expense', 'Can you add ₹80 for tea'])
    assert.equal(looksLikeTransaction(yes), true, yes);
  for (const no of ['How much did I spend this month?', 'What did I spend on food?', 'Did I pay rent?', 'Add a goal of 50000', 'Add ₹500 to my budget', 'Show me my expenses', 'Open transactions', 'hi', 'Why is my spending high?', 'Can I add a transaction?'])
    assert.equal(looksLikeTransaction(no), false, no);
});

test('goal contributions: the practical phrasings', () => {
  const g = (t) => extractGoalContribution(t);
  assert.deepEqual(pick(g('Add ₹5,000 to my Goa goal')), { amount: 5000, namePhrase: 'Goa', hasGoalWord: true });
  assert.deepEqual(pick(g('Put ₹10,000 into my Travel goal')), { amount: 10000, namePhrase: 'Travel', hasGoalWord: true });
  assert.deepEqual(pick(g('Contribute 2k to Goa')), { amount: 2000, namePhrase: 'Goa', hasGoalWord: false });
  assert.equal(g('Contribute 2k to Goa').strongVerb, true);
  assert.deepEqual(pick(g('Save 2k for my Goa goal')), { amount: 2000, namePhrase: 'Goa', hasGoalWord: true });
  assert.deepEqual(pick(g('Please add 1.5 lakh into the Wedding Fund goal')), { amount: 150000, namePhrase: 'Wedding Fund', hasGoalWord: true });
  assert.equal(g('Add to my Goa goal').amount.status, 'none', 'missing amount');
  assert.equal(g('Add ₹450 for lunch'), null, '"for lunch" is a transaction, not a goal');
  assert.equal(g('How much is in my Goa goal?'), null);
  assert.equal(g('Add ₹400 and ₹500 to Goa').amount.status, 'many');
});
const pick = (r) => ({ amount: r.amount.value, namePhrase: r.namePhrase, hasGoalWord: r.hasGoalWord });

test('goal matching: exact, case-insensitive, duplicates; near-misses are suggestions only', () => {
  const goals = [
    { id: 'a', title: 'Goa Trip', currentAmount: 20000, targetAmount: 50000 },
    { id: 'b', title: 'goa trip', currentAmount: 0, targetAmount: 10000 },
    { id: 'c', title: 'Travel', currentAmount: 1, targetAmount: 100 },
    { id: 'd', title: 'Emergency Laptop', currentAmount: 5, targetAmount: 5 },
  ];
  assert.deepEqual(exactGoalMatches(goals, 'travel').map((x) => x.id), ['c']);
  assert.deepEqual(exactGoalMatches(goals, '  TRAVEL ').map((x) => x.id), ['c'], 'trimmed and case-insensitive');
  assert.deepEqual(exactGoalMatches(goals, 'Goa trip').map((x) => x.id), ['a', 'b'], 'duplicate exact names need clarification');
  assert.deepEqual(exactGoalMatches(goals, 'Goa'), [], '"Goa" is NOT an exact match for "Goa Trip"');
  assert.deepEqual(nearGoalMatches(goals, 'Goa').map((x) => x.id), ['a', 'b'], 'but it is offered as a choice');
  assert.deepEqual(nearGoalMatches(goals, 'Holiday'), []);
  assert.deepEqual(exactGoalMatches(goals, 'Laptop'), []);
});

test('choosing between candidates', () => {
  const two = [{ title: 'Goa Trip' }, { title: 'Goa Fund' }];
  assert.equal(pickCandidate('1', two), 0);
  assert.equal(pickCandidate('the second one', two), 1);
  assert.equal(pickCandidate('second', two), 1);
  assert.equal(pickCandidate('Goa Fund', two), 1);
  assert.equal(pickCandidate('3', two), null, 'out of range');
  assert.equal(pickCandidate('yes', two), null, 'a yes does not choose between two');
  assert.equal(pickCandidate('whatever', two), null);
  assert.equal(pickCandidate('yes', [{ title: 'Goa Trip' }]), 0, 'a yes does choose a single suggestion');
  assert.equal(pickCandidate('Goa Trip', [{ title: 'Goa Trip' }, { title: 'goa trip' }]), null, 'identical names cannot be told apart by name');
});

test('edits to a pending proposal', () => {
  assert.deepEqual(parseEdit('make it ₹600', 'create_transaction'), { patch: { amount: 600 } });
  assert.deepEqual(parseEdit('Actually make it 1.5k', 'create_transaction'), { patch: { amount: 1500 } });
  assert.deepEqual(parseEdit('change it to yesterday', 'create_transaction'), { patch: { relativeDate: 'yesterday' } });
  assert.deepEqual(parseEdit('change the date to 2026-10-01', 'create_transaction'), { patch: { date: '2026-10-01' } });
  assert.deepEqual(parseEdit('make it income', 'create_transaction'), { patch: { type: 'income' } });
  assert.deepEqual(parseEdit('call it dinner', 'create_transaction'), { patch: { title: 'Dinner', titleRaw: 'dinner' } });
  assert.deepEqual(parseEdit('make it 600 yesterday', 'create_transaction'), { patch: { amount: 600, relativeDate: 'yesterday' } });
  assert.deepEqual(parseEdit('make it ₹600', 'contribute_to_goal'), { patch: { amount: 600 } });
  assert.deepEqual(parseEdit('use the Goa Trip goal', 'contribute_to_goal'), { patch: { goalPhrase: 'Goa Trip' } });
  assert.deepEqual(parseEdit('make it 500 or 600', 'contribute_to_goal'), { ambiguous: 'amount' });
  assert.equal(parseEdit('how much did I spend?', 'create_transaction'), null);
  assert.equal(parseEdit('hello there', 'create_transaction'), null);
  assert.equal(parseEdit('make it', 'create_transaction'), null);
});

test('server-side yes / no and helpers', () => {
  for (const y of ['yes', 'Yes!', 'yes please', 'confirm', 'go ahead', 'do it', 'haan']) assert.equal(parseYesNo(y), 'yes', y);
  for (const n of ['no', 'No.', 'cancel', 'stop', "don't", 'never mind']) assert.equal(parseYesNo(n), 'no', n);
  for (const x of ['yes but make it 600', 'yesterday', 'I said yes earlier', 'nobody', 'cancel my subscription', 'stopwatch', 'yes and open goals'])
    assert.equal(parseYesNo(x), null, x);
  assert.equal(stripPolite('Please could you add ₹5'), 'add ₹5');
  assert.equal(isQuestion('How is my budget'), true);
  assert.equal(isQuestion('add lunch'), false);
});
