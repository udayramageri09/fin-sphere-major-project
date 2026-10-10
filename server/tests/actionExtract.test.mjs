// Tests for the deterministic extraction in server/assistantActions.js (Issue #73).
//   npm --prefix server run test:actions-extract
// Pure functions only: no database, no network, no language model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTransaction, looksLikeTransaction, extractGoalContribution, chooseAmount, findAmounts, findDate, shiftDate,
  exactGoalMatches, nearGoalMatches, pickCandidate, parseEdit, parseYesNo, stripPolite, isQuestion,
  extractRepayment, exactLiabilityMatches, nearLiabilityMatches, extractBudget, findBudgetMonth, shiftMonth, monthLabel,
  cleanBudgetCategory, CONFIRM_PHRASES, CANCEL_PHRASES,
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

// ═════════════ Issue #75: liability repayments ═════════════
const rep = (text) => extractRepayment(text);

test('repayments: the practical phrasings', () => {
  const r = (t) => { const x = rep(t); return x && { amount: x.amount.value, name: x.namePhrase, raw: x.rawPhrase }; };
  assert.deepEqual(r('I paid ₹6,500 toward my bike loan'), { amount: 6500, name: 'bike', raw: 'bike loan' });
  assert.deepEqual(r('Record ₹2,000 repayment on my personal loan'), { amount: 2000, name: 'personal', raw: 'personal loan' });
  assert.deepEqual(r('Repay 5k on my HDFC car loan'), { amount: 5000, name: 'HDFC car', raw: 'HDFC car loan' });
  assert.deepEqual(r('Put ₹10,000 toward my education loan'), { amount: 10000, name: 'education', raw: 'education loan' });
  assert.deepEqual(r('Pay ₹6,500 to my vehicle loan'), { amount: 6500, name: 'vehicle', raw: 'vehicle loan' });
  assert.deepEqual(r('Paid ₹5,000 toward my car loan'), { amount: 5000, name: 'car', raw: 'car loan' });
  assert.deepEqual(r('I paid my car loan EMI ₹5,000'), { amount: 5000, name: 'car', raw: 'car loan' });
  assert.equal(rep('Pay ₹6,500 to my vehicle loan').hasEmi, false);
});

test('repayments: ordinary expenses are not repayments', () => {
  for (const t of ['Paid ₹500 for lunch', 'I spent 300 on tea', 'Add ₹450 for lunch today', 'Pay ₹1,200 for fuel', 'How much is my loan?', 'What is my EMI?', 'Show my loans'])
    assert.equal(rep(t), null, t);
  assert.equal(looksLikeTransaction('Paid ₹500 for lunch'), true, 'it stays a transaction');
});

test('repayments: missing pieces are reported, never filled from the EMI', () => {
  const noAmount = rep('Record a repayment on my bike loan');
  assert.equal(noAmount.amount.status, 'none'); assert.equal(noAmount.namePhrase, 'bike');
  const noLiability = rep('I paid ₹5,000 toward my loan');
  assert.equal(noLiability.namePhrase, ''); assert.equal(noLiability.amount.value, 5000);
  const emi = rep('Paid EMI');
  assert.equal(emi.amount.status, 'none'); assert.equal(emi.hasEmi, true); assert.equal(emi.namePhrase, '');
  assert.equal(rep('Paid my EMI on my HDFC Car Loan').amount.status, 'none', 'no amount is invented from a monthly payment');
  assert.equal(rep('Repay ₹500 and ₹600 on my loan').amount.status, 'many');
});

test('liability matching: exact, duplicates, near matches are suggestions only', () => {
  const liabs = [
    { id: 'a', name: 'HDFC Car Loan', type: 'vehicle_loan', outstandingAmount: 120000 },
    { id: 'b', name: 'Bike Loan', type: 'vehicle_loan', outstandingAmount: 8000 },
    { id: 'c', name: 'Twin', type: 'other', outstandingAmount: 10 },
    { id: 'd', name: 'twin', type: 'other', outstandingAmount: 20 },
    { id: 'e', name: 'Study Fund', type: 'education_loan', outstandingAmount: 5000 },
    { id: 'f', name: 'Old Card', type: 'credit_card', outstandingAmount: 0 },
  ];
  assert.deepEqual(exactLiabilityMatches(liabs, 'hdfc car loan').map((l) => l.id), ['a'], 'case-insensitive, trimmed');
  assert.deepEqual(exactLiabilityMatches(liabs, '  BIKE LOAN ').map((l) => l.id), ['b']);
  assert.deepEqual(exactLiabilityMatches(liabs, 'twin').map((l) => l.id), ['c', 'd'], 'duplicate exact names');
  assert.deepEqual(exactLiabilityMatches(liabs, 'car'), [], '"car" is NOT an exact match');
  assert.deepEqual(nearLiabilityMatches(liabs, 'car').map((l) => l.id), ['a', 'b'], 'but the type word offers vehicle loans');
  assert.deepEqual(nearLiabilityMatches(liabs, 'education').map((l) => l.id), ['e'], 'type word: education');
  assert.deepEqual(nearLiabilityMatches(liabs, 'hdfc').map((l) => l.id), ['a'], 'name token');
  assert.deepEqual(nearLiabilityMatches(liabs, 'mortgage'), [], 'no home loan here');
  assert.deepEqual(exactLiabilityMatches(liabs, 'Old Card').map((l) => l.id), ['f'], 'paid-off ones still match exactly (they are refused later)');
});

// ═════════════ Issue #75: budgets ═════════════
const LOCAL75 = '2026-10-08';
const bud = (text) => extractBudget(text, { localDate: LOCAL75 });

test('budgets: the practical phrasings', () => {
  assert.deepEqual(bud('Set my food budget to ₹8,000 this month').fields, { amount: 8000, categoryPhrase: 'food', month: '2026-10' });
  assert.deepEqual(bud('Make transport budget ₹4,500').fields, { amount: 4500, categoryPhrase: 'transport' });
  assert.deepEqual(bud('Set dining budget to 10k for October 2026').fields, { amount: 10000, categoryPhrase: 'dining', month: '2026-10' });
  assert.deepEqual(bud('Budget ₹6,000 for groceries next month').fields, { amount: 6000, categoryPhrase: 'groceries', month: '2026-11' });
  assert.deepEqual(bud('₹5,000 fuel budget').fields, { amount: 5000, categoryPhrase: 'fuel' });
  assert.deepEqual(bud('Raise the food budget to 9000').fields, { amount: 9000, categoryPhrase: 'food' });
  assert.equal(bud('Raise the food budget to 9000').relative, false, '"raise to" is an exact amount');
});

test('budgets: month references from the client local date', () => {
  assert.equal(bud('Set food budget to 8000 this month').fields.month, '2026-10');
  assert.equal(bud('Set food budget to 8000 for the current month').fields.month, '2026-10');
  assert.equal(bud('Set food budget to 8000 next month').fields.month, '2026-11');
  assert.equal(bud('Set food budget to 8000 for last month').fields.month, '2026-09');
  assert.equal(bud('Set food budget to 8000 for 2026-12').fields.month, '2026-12');
  assert.equal(bud('Set food budget to 8000 for October 2026').fields.month, '2026-10');
  assert.equal(bud('Set food budget to 8000 for Oct 2026').fields.month, '2026-10');
  assert.equal(bud('Set food budget to 8000 for dec 2027').fields.month, '2027-12');
  assert.equal(findBudgetMonth('next month', '2026-12-15').month, '2027-01', 'year rollover forward');
  assert.equal(findBudgetMonth('last month', '2026-01-15').month, '2025-12', 'year rollover back');
  assert.equal(findBudgetMonth('this month', undefined).kind, 'needs-local', 'no client date: never the server clock');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(monthLabel('2026-10'), 'October 2026');
  assert.equal(bud('Set food budget to ₹8,000').fields.month, undefined, 'no month said: the caller defaults to the local month');
});

test('budgets: a month NAME without a year always asks for the year', () => {
  const r = bud('Set my October food budget to ₹8,000');
  assert.equal(r.issues.monthIssue, 'needs-year'); assert.equal(r.issues.monthName, 'october'); assert.equal(r.fields.month, undefined);
  assert.equal(r.fields.categoryPhrase, 'food');
  assert.equal(bud('Set food budget to 8000 for Oct').issues.monthIssue, 'needs-year');
  assert.equal(bud('Set food budget to 8000 for October').issues.monthIssue, 'needs-year', 'even the CURRENT month (October) asks for the year');
  assert.equal(extractBudget('Set food budget to 8000 for October', { localDate: '2026-10-31' }).issues.monthIssue, 'needs-year');
  assert.equal(findBudgetMonth('I may set it', LOCAL75).kind, 'none', '"may" the verb is not a month');
  assert.equal(findBudgetMonth('for May', LOCAL75).kind, 'needs-year');
});

test('budgets: ambiguous months are asked about', () => {
  for (const t of ['Set food budget 8000 for October or November', 'Set food budget 8000 for the 5th', 'Set food budget 8000 for next quarter', 'Set food budget 8000 for 12/10'])
    assert.equal(bud(t).issues.monthIssue, 'ambiguous', t);
  assert.equal(bud('Set food budget 8000 for October or November').fields.categoryPhrase, 'food', 'date words are not part of the category');
});

test('budgets: missing pieces', () => {
  const noCategory = bud('Set a budget of ₹8,000');
  assert.equal(noCategory.fields.categoryPhrase, undefined); assert.equal(noCategory.fields.amount, 8000);
  const noAmount = bud('Set my food budget');
  assert.equal(noAmount.fields.amount, undefined); assert.equal(noAmount.fields.categoryPhrase, 'food');
  assert.equal(bud('Set food budget to ₹8,000 or ₹9,000').issues.amountAmbiguous, true);
});

test('budgets: categories keep the user\'s own words (never mapped semantically)', () => {
  assert.equal(bud('Set groceries budget to ₹2,500').fields.categoryPhrase, 'groceries');
  assert.equal(bud('Set dining budget to ₹2,500').fields.categoryPhrase, 'dining');
  assert.equal(bud('Set my Food & Dining budget to ₹3,000').fields.categoryPhrase, 'Food & Dining');
  assert.equal(cleanBudgetCategory('the transport budget'), 'transport');
});

test('budgets: "add to / raise by" a budget is not supported (and is never a goal or a transaction)', () => {
  assert.equal(bud('Add ₹2,000 to my travel budget').relative, true);
  assert.equal(bud('Increase my food budget by 500').relative, true);
  assert.equal(bud('Add ₹500 for budget meeting'), null, 'an ordinary expense that mentions a budget meeting');
  assert.equal(bud('How is my budget?'), null);
  assert.equal(bud('Open budgets'), null);
});

test('ROUTING: loans, EMIs, credit cards and budgets are never goal contributions', () => {
  for (const t of ['Add ₹5,000 to my car loan', 'Put 12000 into my HDFC loan', 'Add ₹2,000 to my travel budget', 'Add ₹300 to my credit card', 'Put ₹500 into my EMI', 'Add ₹100 to my home liability'])
    assert.equal(extractGoalContribution(t), null, t);
  // but they still are goals when the sentence says so, and ordinary goals are untouched
  assert.notEqual(extractGoalContribution('Add ₹5,000 to my Goa goal'), null);
  assert.notEqual(extractGoalContribution('Contribute 2k to Goa'), null);
  assert.notEqual(extractGoalContribution('Add ₹500 to my car loan goal'), null, 'an explicit "goal" wins');
  // and the repayment / budget readings claim them instead
  assert.notEqual(extractRepayment('Add ₹5,000 to my car loan'), null);
  assert.notEqual(extractRepayment('Put 12000 into my HDFC loan'), null);
  assert.notEqual(extractBudget('Add ₹2,000 to my travel budget'), null);
});

test('edits: every kind has its own grammar (no fall-through)', () => {
  // repayment
  assert.deepEqual(parseEdit('make it ₹6,000', 'record_liability_repayment'), { patch: { amount: 6000 } });
  assert.deepEqual(parseEdit('use the HDFC loan', 'record_liability_repayment'), { patch: { namePhrase: 'HDFC', rawPhrase: 'HDFC loan' } });
  assert.deepEqual(parseEdit('yes but make it 7000', 'record_liability_repayment'), { patch: { amount: 7000 } });
  assert.deepEqual(parseEdit('make it 500 or 600', 'record_liability_repayment'), { ambiguous: 'amount' });
  // budget
  assert.deepEqual(parseEdit('make it ₹9,000', 'set_budget'), { patch: { amount: 9000 } });
  assert.deepEqual(parseEdit('for next month', 'set_budget'), { patch: { monthText: 'next month' } });
  assert.deepEqual(parseEdit('change it to November 2026', 'set_budget'), { patch: { monthText: 'November 2026' } });
  assert.deepEqual(parseEdit('change the category to groceries', 'set_budget'), { patch: { categoryPhrase: 'groceries' } });
  assert.deepEqual(parseEdit('call it travel', 'set_budget'), { patch: { categoryPhrase: 'travel' } });
  assert.deepEqual(parseEdit('yes but make it 9000', 'set_budget'), { patch: { amount: 9000 } });
  assert.equal(parseEdit('make it groceries', 'set_budget'), null, 'a bare word after "make it" is not a category');
  assert.equal(parseEdit('hello', 'set_budget'), null);
  // transaction / goal keep their own meanings
  assert.deepEqual(parseEdit('make it ₹600', 'create_transaction'), { patch: { amount: 600 } });
  assert.deepEqual(parseEdit('use the Goa Trip goal', 'contribute_to_goal'), { patch: { goalPhrase: 'Goa Trip' } });
  assert.equal(parseEdit('use the Goa Trip goal', 'create_transaction'), null, '"use the X goal" means nothing for a transaction');
  // an unknown kind has NO grammar
  assert.equal(parseEdit('make it ₹600', 'delete_everything'), null);
  assert.equal(parseEdit('make it ₹600', undefined), null);
});

test('confirmation vocabulary: the new verbs, whole utterance only', () => {
  for (const y of ['record it', 'set it', 'update it', 'create it', 'Record it!', 'yes record it', 'yes set it', 'yes update it'])
    assert.equal(parseYesNo(y), 'yes', y);
  for (const x of ['record it later', 'set it to 9000', 'update it please make it 5', 'do not record it', 'yes set it to 9000', 'record'])
    assert.equal(parseYesNo(x), null, x);
  assert.ok(CONFIRM_PHRASES.includes('record it') && CONFIRM_PHRASES.includes('set it') && CONFIRM_PHRASES.includes('update it'));
  assert.ok(CANCEL_PHRASES.includes('cancel') && !CANCEL_PHRASES.some((c) => CONFIRM_PHRASES.includes(c)), 'no phrase both confirms and cancels');
});
