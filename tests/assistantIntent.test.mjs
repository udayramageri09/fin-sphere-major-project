// Tests for src/utils/assistantIntent.js and src/utils/chatHistory.js (Issue #69).   Run: npm run test:assistant
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAssistantInput, topicDestination } from '../src/utils/assistantIntent.js';
import { buildChatHistory, CHAT_HISTORY_TURNS, CHAT_CONTENT_MAX } from '../src/utils/chatHistory.js';

const nav = (text, ctx) => parseAssistantInput(text, ctx).navigation;
const target = (text, ctx) => nav(text, ctx)?.target ?? null;

test('questions never navigate, whatever topic words they contain', () => {
  const questions = [
    'What is my largest expense?', 'How much did I spend?', 'How much did I spend this month?', 'Why is my debt high?',
    'How are my goals doing?', 'Am I saving enough?', 'What is my remaining budget?', 'What are my monthly expenses?',
    'Should I invest more?', 'Explain the forecast.', 'What is my net worth?', 'How is my emergency fund?',
    'Summarize my income', 'How am I doing financially?', 'How is my budget?', 'Why is my health score low?',
    'How much emergency coverage do I have?', 'What should I do about my emergency fund?', 'How much did I pay for my loan?',
    'Show my spending summary', 'What did I spend on food?', 'Which transactions were refunds?', 'Is my portfolio doing well?',
    'how much did i spend this month', 'what is my credit score', 'how do I open budgets', 'can I go to the gym this month',
    'what is the main reason my spending went up', 'my dashboard shows a high balance why',
  ];
  for (const q of questions) {
    const r = parseAssistantInput(q);
    assert.equal(r.navigation, null, `must not navigate: "${q}"`);
    assert.equal(r.question, q, `question preserved: "${q}"`);
  }
});

test('substring traps: remaining/main, high/hi, monthly', () => {
  assert.equal(nav('What is my remaining budget?'), null);
  assert.equal(nav('remaining'), null);
  assert.equal(nav('Why is my debt so high'), null);
  assert.equal(nav('monthly'), null);
  assert.equal(nav('What are my monthly subscriptions costing me?'), null);
  assert.equal(nav('show me my monthly'), null);
});

test('explicit navigation commands', () => {
  const cases = {
    'Open transactions': 'transactions', 'Go to transactions': 'transactions', 'open transaction history': 'transactions',
    'Open the expenses page': 'transactions', 'show transactions': 'transactions', 'Show me the transactions.': 'transactions',
    'Take me to liabilities': 'liabilities', 'open the loans page': 'liabilities', 'go to the debt page': 'liabilities',
    'Show my goals page': 'goals', 'show me the goals page': 'goals', 'open goals': 'goals', 'switch to the goal page': 'goals',
    'Open budgets': 'budgets', 'open my budget section': 'budgets', 'go to budgets': 'budgets',
    'Navigate to emergency fund': 'emergency-fund', 'open emergency savings': 'emergency-fund',
    'go to dashboard': 'dashboard', 'take me home': 'dashboard', 'go to home': 'dashboard', 'open the main dashboard': 'dashboard',
    'go to plans': 'plans', 'open financial intelligence': 'plans', 'open the analysis page': 'plans',
    'open portfolio': 'portfolio', 'go to subscriptions': 'subscriptions', 'bring up liabilities': 'liabilities',
    'Please open transactions': 'transactions', 'Can you open budgets please': 'budgets', 'could you take me to goals': 'goals',
    'would you go to the transactions page': 'transactions',
  };
  for (const [text, expected] of Object.entries(cases)) {
    assert.equal(target(text), expected, `"${text}"`);
    if (expected) assert.equal(parseAssistantInput(text).question, null, `pure command has no question: "${text}"`);
  }
});

test('budgets and emergency fund are sections of the Goals page', () => {
  assert.deepEqual(nav('Open budgets'), { type: 'section', target: 'budgets', view: 'goals', label: 'Budgets' });
  assert.deepEqual(nav('Navigate to emergency fund'), { type: 'section', target: 'emergency-fund', view: 'goals', label: 'Emergency Fund' });
  assert.deepEqual(nav('open transactions'), { type: 'view', target: 'transactions', view: 'transactions', label: 'Transactions' });
});

test('topic words without a page word do not become destinations', () => {
  for (const t of ['open spending', 'go to debt', 'open savings', 'show me my spending', 'open expenses', 'go to income']) {
    assert.equal(nav(t), null, `"${t}"`);
  }
});

test('scroll commands', () => {
  assert.deepEqual(nav('scroll down'), { type: 'scroll', target: 'down', label: 'Scroll down' });
  assert.equal(target('Scroll up'), 'up');
  assert.equal(target('scroll to the top'), 'top');
  assert.equal(target('scroll to bottom'), 'bottom');
  assert.equal(target('go to the top of the page'), 'top');
  assert.equal(target('why does my balance go down'), null);
});

test('question + action, with punctuation', () => {
  let r = parseAssistantInput('How is my budget? Open it.');
  assert.equal(r.question, 'How is my budget?');
  assert.equal(r.navigation.target, 'budgets');
  r = parseAssistantInput('How much debt do I have? Open liabilities.');
  assert.equal(r.question, 'How much debt do I have?');
  assert.equal(r.navigation.target, 'liabilities');
  r = parseAssistantInput('How is my emergency fund? Take me there.');
  assert.equal(r.question, 'How is my emergency fund?');
  assert.equal(r.navigation.target, 'emergency-fund');
  r = parseAssistantInput('How is my budget? Show me the details.');
  assert.equal(r.question, 'How is my budget?');
  assert.equal(r.navigation.target, 'budgets');
  r = parseAssistantInput('How much did I spend this month? Show me the transactions.');
  assert.equal(r.question, 'How much did I spend this month?');
  assert.equal(r.navigation.target, 'transactions');
});

test('question + action without punctuation (voice)', () => {
  let r = parseAssistantInput('how is my budget open it');
  assert.equal(r.question, 'how is my budget');
  assert.equal(r.navigation.target, 'budgets');
  r = parseAssistantInput('how much debt do I have take me there');
  assert.equal(r.question, 'how much debt do I have');
  assert.equal(r.navigation.target, 'liabilities');
  r = parseAssistantInput('how is my emergency fund and then open it');
  assert.equal(r.question, 'how is my emergency fund');
  assert.equal(r.navigation.target, 'emergency-fund');
  r = parseAssistantInput('how much did i spend this month and open transactions');
  assert.equal(r.question, 'how much did i spend this month');
  assert.equal(r.navigation.target, 'transactions');
  r = parseAssistantInput('open goals and tell me how they are doing');
  assert.equal(r.question, 'tell me how they are doing');
  assert.equal(r.navigation.target, 'goals');
});

test('pronoun commands resolve only to a clear destination', () => {
  // previous user topic
  assert.equal(target('Show me.', { previousUserText: 'How is my emergency fund?' }), 'emergency-fund');
  assert.equal(target('open it', { previousUserText: 'How much debt do I have?' }), 'liabilities');
  assert.equal(parseAssistantInput('take me there', { previousUserText: 'How is my budget?' }).question, null);
  // nothing to resolve -> no navigation, the text goes to the assistant instead
  let r = parseAssistantInput('Show me.');
  assert.equal(r.navigation, null);
  assert.equal(r.question, 'Show me.');
  assert.equal(r.unresolvedPronoun, true);
  r = parseAssistantInput('show me', { previousUserText: 'How am I doing financially?' });
  assert.equal(r.navigation, null);
  // ambiguous topics -> do not guess
  r = parseAssistantInput('How are my budget and my debt? Open it.');
  assert.equal(r.navigation, null);
  assert.equal(r.unresolvedPronoun, true);
  assert.equal(r.question, 'How are my budget and my debt?');
  // an ambiguous question does not fall back to an older topic either
  assert.equal(target('Compare my budget and my loans. Open it.', { previousUserText: 'How are my goals?' }), null);
  // previous topic is never used to navigate without an explicit command
  assert.equal(nav('Why?', { previousUserText: 'How is my budget?' }), null);
});

test('follow-ups and empty input', () => {
  for (const t of ['Why?', 'Tell me more', 'What should I do?', 'Which one?', 'How did you calculate that?']) {
    assert.deepEqual(parseAssistantInput(t), { question: t, navigation: null, unresolvedPronoun: false });
  }
  assert.deepEqual(parseAssistantInput('   '), { question: null, navigation: null, unresolvedPronoun: false });
  assert.deepEqual(parseAssistantInput(undefined), { question: null, navigation: null, unresolvedPronoun: false });
});

test('topicDestination uses whole words only', () => {
  assert.equal(topicDestination('what is my remaining budget'), 'budgets');
  assert.equal(topicDestination('remaining'), null);
  assert.equal(topicDestination('why is it so high'), null);
  assert.equal(topicDestination('my EMIs'), 'liabilities');
  assert.equal(topicDestination('spend vs budget'), null);   // two topics -> ambiguous
});

test('buildChatHistory: bounded, user/assistant only, content capped', () => {
  const entries = [];
  for (let i = 0; i < 30; i++) entries.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
  entries.push({ role: 'system', content: 'never sent' }, { role: 'assistant', content: '   ' });
  entries.push({ role: 'assistant', content: 'x'.repeat(5000) });
  const h = buildChatHistory(entries, 'latest question');
  assert.equal(h.length, CHAT_HISTORY_TURNS);
  assert.deepEqual(h.at(-1), { role: 'user', content: 'latest question' });
  assert.ok(h.every((m) => (m.role === 'user' || m.role === 'assistant') && Object.keys(m).length === 2));
  assert.ok(h.every((m) => m.content.length <= CHAT_CONTENT_MAX && m.content.trim().length > 0));
  assert.equal(h.at(-2).content.length, CHAT_CONTENT_MAX);
  assert.ok(!h.some((m) => m.content === 'never sent'));
});
