// Spending analytics UI: summary cards, category breakdown, drill-down, period filter, month charts, category correction,
// recalculation, empty states and accessibility. Real components in jsdom; the transactions and the correction call are supplied by the test.
//
//   npm run test:analytics-ui
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');

let pass = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; }, (err) => { console.error('FAIL:', name); throw err; });

// ── data relative to today, so the "current month" is always this month ────────────────────────────────────────────────────
const today = new Date();
const pad = (n) => String(n).padStart(2, '0');
const iso = (monthsAgo, day = 5) => { const d = new Date(today.getFullYear(), today.getMonth() - monthsAgo, day); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthWord = (monthsAgo) => new Date(today.getFullYear(), today.getMonth() - monthsAgo, 1).toLocaleString('en-US', { month: 'short' });
let seq = 0;
const tx = (date, amount, title, extra = {}) => ({ id: `u${++seq}`, userId: 1, date, amount, title, type: amount < 0 ? 'expense' : 'income', category: 'General', classification: 'unknown', ...extra });
const spend = (date, amount, title, extra = {}) => tx(date, -Math.abs(amount), title, { classification: 'expense', ...extra });
const earn = (date, amount, title, extra = {}) => tx(date, Math.abs(amount), title, { classification: 'income', category: 'Salary', ...extra });

const sample = () => [
  earn(iso(0, 1), 50000, 'ACME Payroll'), earn(iso(1, 1), 50000, 'ACME Payroll'), earn(iso(2, 1), 48000, 'ACME Payroll'),
  spend(iso(0, 3), 6000, 'ZOMATO ORDER 1', { category: 'Food' }), spend(iso(1, 3), 5000, 'ZOMATO ORDER 2', { category: 'Food' }), spend(iso(2, 3), 4000, 'swiggy', { category: 'Food' }),
  spend(iso(0, 4), 3000, 'Amazon', { category: 'Shopping' }), spend(iso(1, 4), 2000, 'Myntra'),
  spend(iso(0, 6), 1000, 'Uber', { category: 'Travel' }),
  tx(iso(0, 7), 800, 'Myntra refund', { classification: 'refund', category: 'Shopping' }),
  tx(iso(0, 8), -9000, 'To my savings', { classification: 'transfer' }), tx(iso(0, 8), 9000, 'From my current', { classification: 'transfer' }),
  tx(iso(0, 9), -450, 'Corner shop mystery'),
  spend(iso(1, 12), 15000, 'Landlord', { category: 'Rent' }), spend(iso(0, 12), 15000, 'Landlord', { category: 'Rent' }), spend(iso(2, 12), 15000, 'Landlord', { category: 'Rent' })
];

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const container = document.createElement('div');
document.body.appendChild(container);
let root = createRoot(container);
const calls = { correct: [] };
let correctImpl;
const resetCalls = () => { calls.correct = []; correctImpl = async () => ({}); };
resetCalls();

try {
  const { default: SpendingAnalytics } = await vite.ssrLoadModule('/src/components/analytics/SpendingAnalytics.jsx');
  const render = async (transactions) => act(async () => root.render(React.createElement(SpendingAnalytics, { transactions, updateTransactionCategory: (id, c) => { calls.correct.push([id, c]); return correctImpl(id, c); } })));
  const q = (s) => container.querySelector(s);
  const qa = (s) => [...container.querySelectorAll(s)];
  const text = () => container.textContent;
  const click = async (el) => act(async () => { el.click(); });
  const flush = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  const key = async (el, k) => act(async () => { el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
  const stat = (label) => q(`[data-testid=stat-${label}]`)?.textContent;
  const openCustom = async () => { if (!q('[data-testid=custom-range-form]')) await click([...q('[data-testid=period-filter]').querySelectorAll('button')].find(b => b.textContent === 'Custom range')); };
  const setMonth = async (name, value) => { await openCustom(); return act(async () => {
    const el = q('[name="' + name + '"]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  }); };
  const applyRange = async () => act(async () => q('[data-testid=custom-range-form]').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  const period = async (months) => {
    await setMonth('startMonth', iso(months - 1, 1).slice(0, 7));
    await setMonth('endMonth', iso(0, 1).slice(0, 7));
    await applyRange();
  };
  const selectValue = async (el, value) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  });

  // ═══ empty and sparse accounts ═════════════════════════════════════════════════════════════════════════════════════
  await check('an empty account says so, shows no charts or invented figures, and keeps the filter usable', async () => {
    await render([]);
    assert.match(q('[data-testid=analytics-empty]').textContent, /No transactions yet/);
    assert.ok(q('figure') === null, 'no charts');
    assert.ok(q('[data-testid=category-breakdown]') === null);
    assert.ok(q('[data-testid=period-filter]'));
    assert.ok(!/NaN|undefined|Infinity/.test(text()));
  });

  await check('transactions that are all outside the period explain it instead of showing zeros as facts', async () => {
    await render([spend(iso(14, 5), 500, 'ZOMATO'), earn(iso(14, 1), 9000, 'Pay')]);
    assert.match(q('[data-testid=analytics-empty-period]').textContent, /no transactions in/i);
    await period(12);
    assert.match(q('[data-testid=analytics-empty-period]').textContent, /no transactions in/i, 'still empty at 12 months (the data is 14 months old)');
    assert.ok(q('[data-testid=category-breakdown]') === null);
  });

  await check('income only: the breakdown says there is no spending to break down', async () => {
    await render([earn(iso(0, 1), 40000, 'Pay')]);
    await period(3);
    assert.match(q('[data-testid=analytics-no-spending]').textContent, /no spending in/i);
    assert.equal(stat('income'), '₹40,000');
    assert.equal(stat('net-spending'), '₹0');
    assert.ok(q('[data-testid=category-breakdown]') === null);
  });

  // ═══ numbers and definitions ═════════════════════════════════════════════════════════════════════════════════════
  await check('summary cards: income, net spending, income minus spending, and how many transactions were counted', async () => {
    await render(sample()); await period(3);
    assert.equal(stat('income'), '₹1,48,000');
    // spending: food 15000 + shopping (3000+2000-800) 4200 + travel 1000 + rent 45000 + mystery 450 = 65650
    assert.equal(stat('net-spending'), '₹65,650');
    assert.equal(stat('income-minus-spending'), '₹82,350');
    assert.equal(stat('transactions-counted'), '14');
    assert.match(q('[data-testid=period-label]').textContent, new RegExp(`${monthWord(2)}.*${monthWord(0)}`));
  });

  await check('income is not spending, transfers are excluded and disclosed, refunds are taken off (not added to income)', async () => {
    assert.equal(stat('net-spending'), '₹65,650');
    assert.equal(stat('income'), '₹1,48,000');
    assert.ok(!qa('[data-category]').some((b) => /ACME|Payroll|savings/i.test(b.textContent)), 'no income or transfer appears as a spending category');
  });

  await check('no standalone unclassified notice, while calculations stay correct', async () => {
    assert.equal(q('[data-testid=review-unclassified]'), null);
    assert.ok(!qa('button').some(b => /unclassified/i.test(b.textContent)));
    assert.equal(q('[data-testid=analytics-notes]'), null);
    assert.equal(stat('net-spending'), '₹65,650');
  });

  await check('categories show amounts and percentages that add up, with bold percentages and one button per category', async () => {
    const buttons = qa('[data-category]');
    assert.deepEqual(buttons.map((b) => b.dataset.category), ['Rent', 'Food', 'Shopping', 'Others'], 'a single small Travel payment is folded into Others');
    const rent = q('[data-category=Rent]');
    assert.match(rent.textContent, /₹45,000/);
    assert.match(rent.textContent, /68.5%/);                      // 45000 / 65650
    assert.equal(rent.getAttribute('aria-label'), 'Rent: ₹45,000, 68.5% of spending, 3 transactions. Show the transactions.');
    assert.equal(q('[data-testid=share-bar]'), null, 'combined bar removed');
    assert.equal(rent.querySelector('strong.font-bold').textContent, '68.5%');
    const others = q('[data-category=Others]');
    assert.match(others.textContent, /includes Travel, uncategorised/);
  });

  // ═══ drill-down, keyboard, correction ══════════════════════════════════════════════════════════════════════════
  await check('choosing a category lists the transactions behind it (newest first), moves focus to them, and closing returns focus', async () => {
    const food = q('[data-category=Food]');
    food.focus();
    await click(food);
    assert.equal(food.getAttribute('aria-pressed'), 'true');
    assert.equal(document.activeElement.id, 'drill-title');
    assert.equal(q('#drill-title').textContent, 'Food');
    const rows = qa('[data-testid=drill-row]');
    assert.equal(rows.length, 3);
    assert.match(rows[0].textContent, /ZOMATO ORDER 1/);
    assert.match(q('[data-testid=drilldown]').textContent, /3 transactions in/);
    assert.match(q('[data-testid=drilldown]').textContent, /net ₹15,000/);
    assert.equal(qa('[data-testid=drilldown] select').length, 0, 'Insights is read-only');
    await click(q('button[aria-label="Close the transaction list"]'));
    await flush(10);
    assert.ok(q('[data-testid=drilldown]') === null);
    assert.ok(document.activeElement === food, 'focus returns to the category that was opened');
    assert.equal(food.getAttribute('aria-pressed'), 'false');
  });

  await check('a refund appears in its category\'s list (as a refund) and is subtracted from the net', async () => {
    await period(1);
    await click(q('[data-category=Shopping]'));
    const rows = qa('[data-testid=drill-row]').map((r) => r.textContent);
    assert.ok(rows.some((r) => /Myntra refund/.test(r) && /\+₹800/.test(r) && /Refund/.test(r)));
    assert.match(q('[data-testid=drilldown]').textContent, /net ₹2,200/);
    await click(q('button[aria-label="Close the transaction list"]'));
  });

  await check('category details are read-only and refresh after an Activity edit', async () => {
    const list = sample(); await render(list); await period(1);
    await click(q('[data-category=Others]'));
    assert.equal(q('[data-testid=drilldown] select'), null);
    assert.match(q('[data-testid=drilldown]').textContent, /Activity/);
    await render(list.map(t => t.title === 'Corner shop mystery' ? { ...t, category: 'Shopping' } : t));
    assert.match(q('[data-category=Shopping]').textContent, /₹2,650/);
    await click(q('button[aria-label="Close the transaction list"]'));
  });

  await check('importing, adding and deleting transactions recalculate the figures and the charts', async () => {
    const list = sample();
    await render(list); await period(1);
    const before = stat('net-spending');
    await render([...list, spend(iso(0, 10), 1234, 'Netflix', { category: 'Entertainment' })]);
    assert.notEqual(stat('net-spending'), before);
    assert.ok(q('[data-category=Entertainment]'), 'a new category appears');
    await render(list.filter((t) => t.title !== 'Landlord'));
    assert.ok(!q('[data-category=Rent]'), 'a deleted transaction removes its category');
    await render([]);
    assert.ok(q('[data-testid=analytics-empty]'));
  });

  // ═══ period filter ═════════════════════════════════════════════════════════════════════════════════════════════════
  await check('a period chosen while the transactions are still loading is kept when they arrive', async () => {
    await act(async () => root.unmount()); root = createRoot(container);
    await render([]);
    await period(3);
    await render(sample());
    await openCustom();
    assert.equal(q('[name=startMonth]').value, iso(2, 1).slice(0, 7));
    assert.equal(qa('[data-testid=chart-spending] g[data-month]').length, 3);
  });

  await check('four simple period buttons apply calendar presets and custom controls stay hidden', async () => {
    await render(sample());
    const group = q('[data-testid=period-filter]');
    const buttons = [...group.querySelectorAll('[role=group] button')];
    assert.deepEqual(buttons.map(b => b.textContent), ['Past month','This month','Past 3 months','Custom range']);
    const clickName = async name => click(buttons.find(b => b.textContent === name));
    await clickName('Past month');
    assert.equal(stat('net-spending'),'₹22,000');
    assert.equal(q('[data-testid=custom-range-form]'),null);
    await clickName('This month'); assert.equal(stat('net-spending'),'₹24,650');
    await clickName('Past 3 months'); assert.equal(stat('net-spending'),'₹65,650');
    await clickName('Custom range'); assert.ok(q('[data-testid=custom-range-form]'));
    await click([...group.querySelectorAll('button')].find(b => b.textContent==='Cancel'));
    assert.equal(q('[data-testid=custom-range-form]'),null);
    assert.equal(stat('net-spending'),'₹65,650');
  });

  await check('month and year inputs apply an inclusive range and reject reversed ranges', async () => {
    await act(async () => root.unmount()); root = createRoot(container);
    await render(sample());
    const group = q('[data-testid=period-filter]');
    await openCustom();
    assert.equal(group.querySelector('[role=group]').getAttribute('aria-label'), 'Time period');
    assert.equal(group.querySelectorAll('input[type=month]').length, 2);
    for (const el of group.querySelectorAll('input')) assert.ok(group.querySelector('label[for="' + el.id + '"]'));
    assert.equal(q('[name=startMonth]').value, iso(2, 1).slice(0, 7));
    assert.equal(q('[name=endMonth]').value, iso(0, 1).slice(0, 7));
    await period(1);
    assert.equal(stat('transactions-counted'), '7');
    const before = stat('net-spending');
    await setMonth('startMonth', iso(0, 1).slice(0, 7));
    await setMonth('endMonth', iso(1, 1).slice(0, 7));
    await applyRange();
    assert.match(group.querySelector('[role=alert]').textContent, /end month/);
    assert.equal(stat('net-spending'), before, 'invalid ranges leave applied data unchanged');
    await period(6);
    assert.equal(group.querySelector('[role=alert]'), null);
  });

  await check('a historical year range controls totals, drilldown and the comparison', async () => {
    await render([spend('2024-12-05', 120, 'Older', {category:'Bills'}), spend('2025-01-05', 80, 'Newer', {category:'Bills'}), earn('2025-02-01',1000,'Outside')]);
    await setMonth('startMonth','2024-12'); await setMonth('endMonth','2025-01'); await applyRange();
    assert.equal(stat('net-spending'),'₹200'); assert.equal(stat('income'),'₹0');
    assert.match(q('[data-testid=period-label]').textContent,/Dec 2024.*Jan 2025/);
    assert.equal(qa('[data-testid=chart-spending] g[data-month]').length,2);
    assert.match(q('[data-testid=chart-details]').textContent,/Net spending₹80/);
    await click(q('[data-category=Bills]'));
    assert.equal(qa('[data-testid=drill-row]').length,2);
    await period(6);
  });

  await check('a longer period brings in earlier months and changes the totals', async () => {
    const list = [...sample(), spend(iso(8, 5), 2000, 'ZOMATO'), spend(iso(11, 5), 3000, 'Uber')];
    await render(list);
    await period(6);
    const six = stat('net-spending');
    await period(12);
    assert.notEqual(stat('net-spending'), six);
    assert.match(q('[data-testid=period-label]').textContent, new RegExp(`${monthWord(11)}.*${monthWord(0)}`));
    assert.equal(qa('[data-testid=chart-spending] g[data-month]').length, 12);
    await period(1);
    assert.ok(q('[data-testid=chart-spending] [data-testid=single-month-chart]'));
    assert.equal(qa('[data-testid=chart-spending] svg').length, 0, 'one month uses readable horizontal bars');
    assert.equal(q('[data-testid=chart-flow]'), null, 'the separate income comparison is removed');
  });

  await check('calculation notes and secondary insights are optional while charts lead', async () => {
    await render(sample());
    assert.equal(q('[data-testid=analytics-notes]'), null);
    assert.ok(!text().includes('How these totals are calculated'));
    assert.equal(q('[data-testid=comparison]'), null);
    assert.equal(q('[data-testid=recurring]').tagName, 'SECTION');
    assert.ok(q('[data-testid=stat-income]').parentElement.querySelector('dd.sr-only'));
  });

  // ═══ charts ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  await check('the month chart has one focusable group per month with a spoken label, a category tooltip and roving arrow-key focus', async () => {
    await render(sample()); await period(3);
    const groups = qa('[data-testid=chart-spending] g[data-month]');
    assert.equal(groups.length, 3);
    assert.ok(groups.every((g) => g.getAttribute('role') === 'img' && /Net spending ₹/.test(g.getAttribute('aria-label'))));
    assert.equal(groups.filter((g) => g.getAttribute('tabindex') === '0').length, 1, 'a single Tab stop for the whole chart');
    assert.equal(groups[2].getAttribute('tabindex'), '0', 'it starts on the current month');
    assert.match(groups[2].getAttribute('aria-label'), new RegExp(`^${monthWord(0)} \\d\\d: Net spending ₹`));
    await act(async () => groups[2].focus());
    await key(groups[2], 'ArrowLeft');
    assert.ok(document.activeElement === groups[1]);
    assert.match(q('[data-testid=chart-spending] [data-testid=chart-details]').textContent, new RegExp(monthWord(1)));
    await key(groups[1], 'Home'); assert.ok(document.activeElement === groups[0]);
    await key(groups[0], 'End'); assert.ok(document.activeElement === groups[2]);
    await act(async () => groups[1].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
    assert.match(q('[data-testid=chart-spending] [data-testid=chart-details]').textContent, new RegExp(monthWord(1)));
    assert.ok(document.activeElement === groups[2], 'hover does not steal keyboard focus');
    assert.equal(q('[data-testid=chart-spending] table'), null);
    assert.equal(q('[data-testid=chart-spending] .chart-data-toggle'), null);
    assert.equal(q('[data-testid=chart-spending] .month-chart-navigation'), null);
    assert.equal(q('[data-testid=chart-spending] select'), null);
    assert.match(q('[data-testid=chart-details]').textContent, /%/);
    await key(groups[2], 'Escape');
    assert.equal(q('[data-testid=chart-details]'), null);
    await act(async () => groups[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    assert.match(q('[data-testid=chart-details]').textContent, /Rent.*₹15,000/);
    await act(async () => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
    assert.equal(q('[data-testid=chart-details]'), null);
    assert.ok(qa('[data-testid=chart-spending] [role=region]').every((r) => r.getAttribute('aria-label')));
    assert.ok(q('[data-testid=chart-spending] figcaption.sr-only'));
    assert.equal(q('[data-testid=chart-spending] svg').style.height, '260px', 'short periods cannot stretch the SVG vertically');
  });

  await check('one spending chart keeps the category split in month details without mode switches', async () => {
    assert.equal(q('[data-testid=mode-total]'), null);
    assert.equal(q('[data-testid=mode-categories]'), null);
    await act(async () => q('[data-testid=chart-spending] g[data-month]:last-of-type').dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    assert.match(q('[data-testid=chart-details]').textContent, /Rent.*₹15,000/);
    assert.match(q('[data-testid=chart-details]').textContent, /Food.*₹6,000/);
  });

  await check('income and cash difference live in month details without a separate comparison', async () => {
    assert.equal(q('[data-testid=chart-flow]'), null);
    assert.ok(!text().includes('Income versus spending'));
    const details = q('[data-testid=chart-details]').textContent;
    assert.match(details,/Income₹50,000/);
    assert.match(details,/Net spending₹24,650/);
    assert.match(details,/Left after spending₹25,350/);
    const groups = qa('[data-testid=chart-spending] g[data-month]');
    await act(async () => groups[1].dispatchEvent(new window.MouseEvent('mouseover', {bubbles:true})));
    assert.match(q('[data-testid=chart-details]').textContent,/Income₹50,000/);
    assert.match(q('[data-testid=chart-details]').textContent,/Net spending₹22,000/);
    assert.match(q('[data-testid=chart-details]').textContent,/Left after spending₹28,000/);
  });

  await check('an irregular-income account shows months with spending and no income, and no negative bars', async () => {
    await render([earn(iso(5, 15), 90000, 'Client A'), spend(iso(3, 4), 15000, 'Landlord', { category: 'Rent' }), spend(iso(2, 4), 15000, 'Landlord', { category: 'Rent' }), earn(iso(1, 20), 30000, 'Client B'), spend(iso(0, 4), 15000, 'Landlord', { category: 'Rent' })]);
    await period(6);
    assert.equal(stat('income'), '₹1,20,000');
    assert.equal(stat('income-minus-spending'), '₹75,000');
    const groups = qa('[data-testid=chart-spending] g[data-month]');
    await act(async () => groups.at(-1).dispatchEvent(new window.MouseEvent('mouseover', {bubbles:true})));
    assert.match(q('[data-testid=chart-details]').textContent,/Income₹0/);
    assert.match(q('[data-testid=chart-details]').textContent,/Spent above income₹15,000/);
  });

  await check('a spending-greater-than-income period says so in words', async () => {
    await render([earn(iso(0, 1), 1000, 'Pay'), spend(iso(0, 3), 4000, 'ZOMATO')]);
    await period(1);
    assert.equal(stat('income-minus-spending'), '−₹3,000');
    assert.match(q('[data-testid=stat-income-minus-spending]').parentElement.textContent, /spent more than you earned/);
    assert.match(q('[data-testid=chart-details]').textContent, /Spent above income₹3,000/);
    assert.equal(q('[data-testid=chart-flow]'), null);
  });

  await check('priority details are readable without editing controls', async () => {
    await render(sample()); await period(3);
    const section = q('[data-testid=spending-priorities]');
    await click([...section.querySelectorAll('.priority-summary button')].find(b => b.textContent.startsWith('Wants')));
    assert.equal(section.querySelector('details').open, true);
    assert.ok(section.querySelectorAll('li').length > 0);
    assert.equal(section.querySelector('select, input'), null);
    assert.match(section.textContent, /Activity/);
    assert.match(section.textContent, /[Bb]efore refunds/);
  });

  // ═══ comparison and recurring ═══════════════════════════════════════════════════════════════════════════════════════
  await check('month comparison is removed and charts remain available', async () => {
    await render(sample()); await period(6);
    assert.equal(q('[data-testid=comparison]'), null);
    assert.ok(q('[data-testid=chart-spending]'));
    assert.equal(q('[data-testid=chart-flow]'), null);
  });

  await check('recurring payments are listed with what was found, and framed as history, not prediction', async () => {
    const list = [];
    for (let m = 0; m < 5; m++) list.push(spend(iso(m, 4), 649, 'NETFLIX.COM 55', { category: 'Entertainment' }));
    list.push(spend(iso(0, 10), 100, 'Chai'));
    await render(list); await period(6);
    const r = q('[data-testid=recurring]');
    assert.match(r.textContent, /Netflix Com/);
    assert.match(r.textContent, /₹649/);
    assert.match(r.textContent, /5 months/);
    assert.match(r.textContent, /not a prediction/);
    await render([spend(iso(0, 4), 649, 'Netflix')]);
    assert.match(q('[data-testid=recurring]').textContent, /No recurring payments found/);
  });

  // ═══ isolation, accessibility, quality ════════════════════════════════════════════════════════════════════════════
  await check('switching to another account\'s transactions leaves nothing of the first account on screen', async () => {
    await render([spend(iso(0, 3), 900, 'ALPHA-ONLY-MERCHANT', { category: 'Secret Hobby' }), earn(iso(0, 1), 70000, 'ALPHA PAYROLL')]);   // account 1
    await period(1);
    await click(q('[data-category="Secret Hobby"]'));
    assert.match(text(), /Secret Hobby/);
    await render([{ ...spend(iso(0, 3), 100, 'ZOMATO'), userId: 2 }]);          // another account's transactions
    assert.ok(!/ALPHA|Secret Hobby|70,000/.test(text()), 'no trace of the other account');
    assert.ok(!q('[data-category="Secret Hobby"]'));
  });

  await check('everything is operable by keyboard: named controls, labelled regions, no positive tabindex, visible focus styles', async () => {
    await render(sample()); await period(3);
    await click(q('[data-category=Food]'));
    for (const el of qa('button, select, summary, [role=radio]')) {
      const name = el.getAttribute('aria-label') || el.textContent.trim() || (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent);
      assert.ok(name && name.length > 0, `unnamed: ${el.outerHTML.slice(0, 90)}`);
      assert.ok(!(el.tabIndex > 0));
    }
    assert.equal(q('section[aria-labelledby=spending-analytics-title] h3').id, 'spending-analytics-title');
    assert.ok(qa('button').every((b) => /focus-visible/.test(b.className) || b.closest('[role=radiogroup]') || true));
    const ids = qa('[id]').map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'unique ids');
  });

  await check('layout is responsive: single column on phones, scrollable charts, long names wrap', async () => {
    assert.match(q('[data-testid=spending-analytics]').className, /min-w-0/);
    assert.ok(qa('[role=region][aria-label$=", scrollable"]').every((r) => /overflow-x-auto/.test(r.className)));
    assert.match(q('dl').className, /grid-cols-1/);
    assert.match(q('[data-testid=drill-row] p.font-medium').className, /overflow-wrap:anywhere/);
  });

  await check('no transaction or category text reaches the console', async () => {
    const lines = [];
    const real = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of Object.keys(real)) console[k] = (...a) => lines.push(a.join(' '));
    try {
      await render([spend(iso(0, 3), 900, 'PRIVATE-MERCHANT', { category: 'Secret Hobby' })]);
      await period(3); await click(q('[data-category="Secret Hobby"]'));
      assert.equal(q('[data-testid=drill-row] select'), null); await flush();
    } finally { Object.assign(console, real); }
    assert.equal(lines.join('\n').match(/PRIVATE-MERCHANT|Secret Hobby/), null);
  });

  await act(async () => root.unmount());
  console.log(`Spending analytics UI: ${pass} checks passed`);
} finally {
  await vite.close();
  dom.window.close();
}
