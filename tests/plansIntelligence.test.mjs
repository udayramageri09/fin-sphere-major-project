// Financial Intelligence (Plans page) UI regression test (Issue #80).   Run: npm run test:plans
//
// Renders the REAL Plans page, FinanceProvider and plan components in jsdom (loaded with Vite in SSR mode, like
// financialCopilot.test.mjs). Only what a test environment cannot provide is replaced: AuthContext (no login) and fetch
// (a stub backend that returns a scripted /api/ml/analyze response and records every request).
//
// The page must show what the SERVER computed and never recompute it, so the stub returns hand-written analyses and the
// test checks the screen against those exact numbers.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (!(k in globalThis)) { try { Object.defineProperty(globalThis, k, { get: () => dom.window[k], configurable: true }); } catch { /* not copyable */ } }
}
for (const k of ['window', 'document', 'navigator']) {
  try { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); } catch { /* not copyable */ }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.CustomEvent = window.CustomEvent;   // Node has its own CustomEvent, which jsdom's dispatchEvent rejects
window.scrollTo = () => {};
window.scrollBy = () => {};
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

// ── scripted analyses ──────────────────────────────────────────────────────────────────────────────────────────────
const step = (o) => ({ completed: false, metric_value: null, action_type: 'advisory', timeline: '1 month', expected_outcome: 'Better position', ...o });
const hs05 = step({
  step_id: 'HS-05', title: 'Build Emergency Fund — Coverage Critical', description: 'Your emergency fund covers only 1.42 months of expenses.',
  priority: 'critical', priority_rank: 1, kind: 'risk', method: 'rule', source_model: 'Health score rules', category_order: 3, action: { destination: 'emergency-fund' },
  evidence: {
    metric: 'emergency_coverage', label: 'Emergency coverage', value: 1.42, unit: 'months', threshold: { comparator: '<', value: 3, meaning: 'minimum safe buffer' },
    formula: 'Emergency fund ÷ Average monthly net spending',
    inputs: [{ label: 'Emergency fund', value: 60350, unit: '₹' }, { label: 'Average monthly net spending', value: 42500, unit: '₹/month', period_months: 5 }],
    contributors: [], caveats: [],
  },
});
const hs04 = step({
  step_id: 'HS-04', title: 'Reduce Debt Load — DTI Above Acceptable', description: 'Your monthly debt payments are 41.0% of your monthly income.',
  priority: 'high', priority_rank: 2, kind: 'risk', method: 'rule', source_model: 'Health score rules', category_order: 2, action: { destination: 'liabilities' },
  evidence: {
    metric: 'dti', label: 'Debt-to-income', value: 41.0, unit: '%', threshold: { comparator: '>', value: 36, meaning: 'acceptable ceiling' },
    formula: 'Monthly debt payments ÷ Monthly income × 100',
    inputs: [{ label: 'Monthly debt payments (active liabilities)', value: 21320, unit: '₹/month' }, { label: 'Monthly income', value: 52000, unit: '₹/month', period_months: 5 }],
    contributors: [], caveats: [],
  },
});
const fc01 = step({
  step_id: 'FC-01', title: 'Alert: Expenses Rising Faster Than Income', description: 'The linear-regression trend shows spending is rising while income is stable.',
  priority: 'high', priority_rank: 2, kind: 'risk', method: 'ml_signal', source_model: 'LinearRegression forecast', category_order: 4, action: { destination: 'budgets' }, action_type: 'alert',
  evidence: {
    metric: 'expense_trend', label: 'Spending trend', value: 'rising', unit: null, threshold: { comparator: 'is', value: 'rising', meaning: 'spending rising while income is not rising' },
    formula: 'Slope of a straight-line fit to monthly net spending and to monthly income.',
    inputs: [{ label: 'Spending trend (slope)', value: 820.5, unit: '₹/month per month' }],
    contributors: [{ category: 'Rent', net_spending: 100000, share_pct: 47.1 }, { category: 'Food', net_spending: 60000, share_pct: 28.2 }],
    caveats: ['Low fit (income R² 0.20, spending R² 0.20): the straight-line trend explains little of the month-to-month change, so treat the projection as rough.'],
  },
});
const an01 = step({
  step_id: 'AN-01', title: 'Review 1 Flagged Transaction (Isolation Forest)', description: 'Isolation Forest detected 1 statistically anomalous transaction.',
  priority: 'medium', priority_rank: 3, kind: 'risk', method: 'ml_signal', source_model: 'IsolationForest', category_order: 5, action: { destination: 'transactions' }, action_type: 'alert',
  evidence: {
    metric: 'anomalies_flagged', label: 'Flagged transactions', value: 1, unit: 'transactions', threshold: null,
    formula: 'IsolationForest isolates transactions whose amount and timing pattern is unusual for your own history',
    inputs: [{ label: 'Flagged transactions', value: 1, unit: 'transactions' }],
    contributors: [{ id: 't9', title: 'Zoo tickets', amount: -9800, date: '2026-09-12', severity: 'high', reason: 'Unusually large for Entertainment' }],
    caveats: ['A statistical flag is not proof of fraud or an error.'],
  },
});
const cl01 = step({
  step_id: 'CL-01', title: 'High Concentration in Large Transactions', description: 'Spending clustering (Agglomerative, Ward) shows 80.0% of your spending is in high-value transactions.',
  priority: 'high', priority_rank: 2, kind: 'risk', method: 'ml_signal', source_model: 'Agglomerative clustering (Ward)', category_order: 6, action: null,
  evidence: { metric: 'high_value_exposure_pct', label: 'Spending in the largest-amount cluster', value: 80, unit: '%', threshold: { comparator: '>', value: 70, meaning: 'high concentration' }, formula: 'Share of total spending value in the largest-amount cluster', inputs: [], contributors: [], caveats: [] },
});
const fc02 = step({
  step_id: 'FC-02', title: 'Opportunity: Income Is Trending Upward', description: 'The forecast trend shows positive income momentum.',
  priority: 'medium', priority_rank: 3, kind: 'opportunity', method: 'ml_signal', source_model: 'LinearRegression forecast', category_order: 6, action: null, action_type: 'opportunity',
  evidence: { metric: 'income_trend', label: 'Income trend', value: 'rising', unit: null, threshold: null, formula: 'Slope of a straight-line fit to monthly income.', inputs: [], contributors: [], caveats: [] },
});

const ratio = (value, unit, score, status, benchmark, weight_pct) => ({ value, unit, score, status, benchmark, description: 'x', weight_pct });
const analysis = (over = {}) => ({
  health: {
    composite_score: 62.4, grade: { grade: 'C', label: 'Fair', emoji: '🟠' },
    ratios: {
      savings_rate: ratio(18.2, '%', 58, 'fair', 'Ideal: ≥30%', 29.4),
      expense_ratio: ratio(81.8, '%', 40, 'poor', 'Ideal: ≤50%', 23.5),
      emergency_coverage: ratio(1.4, 'months', 30, 'poor', 'Ideal: ≥6 months', 17.6),
      investment_rate: ratio(16, '%', 100, 'good', 'Ideal: ≥15%', 11.8),
      cash_flow_positivity: ratio(100, '%', 100, 'good', 'Ideal: ≥80%', 11.8),
    },
    unavailable_ratios: ['dti'], unavailable_reasons: { dti: 'debt_total_unavailable' },
    strengths: [], weaknesses: [], recommendations: [],
    metadata: { monthly_income: 52000, avg_monthly_net_spending: 42500, period: { months: 5, first_month: '2026-05', last_month: '2026-09' }, ratios_used: 5, ratios_total: 6 },
    breakdown: { basis: 'Per category and month: spending minus refunds, floored at 0; transfers excluded.', spending_by_category: [{ category: 'Rent', net_spending: 100000, share_pct: 47.1 }, { category: 'Food', net_spending: 60000, share_pct: 28.2 }], other_net_spending: 52500, categories_total: 212500 },
  },
  forecast: {
    historical: [{ month_label: 'Jul 2026', income: 52000, expenses: 40000, net: 12000 }, { month_label: 'Aug 2026', income: 52000, expenses: 42000, net: 10000 }, { month_label: 'Sep 2026', income: 52000, expenses: 43000, net: 9000 }],
    forecast: { months: ['Oct 2026', 'Nov 2026', 'Dec 2026'], income: { predictions: [52000, 52000, 52000], r2: 0.2, model: 'linear_regression' }, expenses: { predictions: [44000, 45000, 46000], r2: 0.2, model: 'linear_regression' }, net: [8000, 7000, 6000] },
    insights: { income_momentum: 'stable', expense_momentum: 'rising', projected_savings_3m: 21000, savings_rate_pct: 18.2, months_analyzed: 5 },
  },
  anomalies: { total_flagged: 1, anomalies: [{ id: 't9', title: 'Zoo tickets', amount: -9800, date: '2026-09-12', severity: 'high', reason: 'Unusually large for Entertainment' }], contamination_rate: 0.1 },
  clusters: { clusters: [{ id: 0, label: 'Everyday spends', description: 'Small', pct_of_total: 20, transaction_count: 30, centroid_amount: 120 }, { id: 2, label: 'Big-ticket', description: 'Large', pct_of_total: 80, transaction_count: 4, centroid_amount: 24000 }], model_metrics: { silhouette_score: 0.52 }, insights: {} },
  plan: {
    plan_title: 'Plan', plan_summary: 'Overall health score: 62/100 (rule-based). 6 action items from rule-based health checks and ML signals (forecast, anomalies, spending clusters).',
    steps: [hs05, hs04, fc01, an01, cl01, fc02], step_count: 6,
    forecast_caveats: ['Low fit (income R² 0.20, spending R² 0.20): the straight-line trend explains little of the month-to-month change, so treat the projection as rough.'],
  },
  metadata: { transaction_count: 40, models_run: ['LinearRegression', 'IsolationForest', 'AgglomerativeClustering (Ward)'], rule_engines_run: ['HealthScorer (rules)', 'PlanGenerator (rules)'], elapsed_ms: 12, errors: null },
  ...over,
});

// ── stub backend ───────────────────────────────────────────────────────────────────────────────────────────────────
let analyzeCalls = 0;
let analyzeMode = 'ok';          // 'ok' | 'fail'
let analysisBody = analysis();
let txList = [{ id: 't1', title: 'Salary', amount: 52000, date: '2026-09-01', type: 'income', category: 'Salary' }];
const planChatBodies = [];
const json = (status, b) => ({ status, ok: status >= 200 && status < 300, json: async () => b });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method ?? 'GET').toUpperCase();
  if (/\/ml\/analyze(?:\?|$)/.test(u)) {
    analyzeCalls += 1;
    if (analyzeMode === 'fail') return json(502, { error: 'ML service returned an error', detail: 'SECRET-UPSTREAM-TEXT lunch at Nobu' });
    const period = Number(new URL(u, 'http://localhost').searchParams.get('months') || 3);
    const result = structuredClone(analysisBody);
    if (period !== 3) {
      result.forecast.forecast.months = Array.from({length:period}, (_,i) => `Month ${i+1}`);
      result.forecast.forecast.income.predictions = Array(period).fill(52000);
      result.forecast.forecast.expenses.predictions = Array(period).fill(44000);
      result.forecast.forecast.net = Array(period).fill(8000);
      result.forecast.insights.projected_savings_total = period * 8000;
    }
    return json(200, result);
  }
  if (/\/plan-chat$/.test(u) && method === 'POST') {
    planChatBodies.push(JSON.parse(opts.body));
    return json(200, { reply: 'REPLY(ok)' });
  }
  if (/\/transactions$/.test(u) && method === 'GET') return json(200, txList);
  if (/\/emergency-fund$/.test(u)) return json(200, { configured: false, currentAmount: null, targetAmount: null, createdAt: null, updatedAt: null });
  return json(200, []);
};

const { createServer } = await import('vite');
const STUBS = { AuthContext: 'export const useAuth = () => ({ invalidateSession: () => {} });' };
const HARNESS = `
import { useState, createElement as h } from 'react';
import { FinanceProvider } from '/src/context/FinanceContext.jsx';
import Plans from '/src/pages/Plans.jsx';
export function App({ onView }) {
  const [view, setView] = useState('plans');
  return h(FinanceProvider, { currentView: view, setCurrentView: (v) => { onView(v); setView(v); } }, h('div', { 'data-view': view }, h(Plans)));
}`;
const vite = await createServer({
  root: REPO,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  esbuild: { jsx: 'automatic' },
  plugins: [{
    name: 'plans-test-stubs',
    transform(code, id) {
      for (const name of ['CurrentState', 'TopFindings', 'AnalysisDetails']) {
        if (!id.endsWith('/' + name + '.jsx')) continue;
        let source = code.replace(new RegExp('function ' + name + String.raw`\(([^)]*)\) \{`),
          (match) => match + ` globalThis.__analysisRenders = (globalThis.__analysisRenders ?? 0) + 1;`);
        if (process.env.FINSPHERE_BENCH_NO_MEMO === 'true') source = source.replace('export default memo(' + name + ');', 'export default ' + name + ';');
        return source;
      }
    },
    enforce: 'pre',
    resolveId(id) {
      if (id === 'virtual:plans-harness') return '\0plans-harness';
      if (id.startsWith('.') && id.split('/').pop() === 'AuthContext') return '\0stub:AuthContext';
      return null;
    },
    load(id) {
      if (id === '\0plans-harness') return HARNESS;
      if (id.startsWith('\0stub:')) return STUBS[id.slice('\0stub:'.length)];
      return null;
    },
  }],
});

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) pass++; else { fail++; console.log('FAIL:', name, extra); } };

try {
  const { App } = await vite.ssrLoadModule('virtual:plans-harness');
  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  let viewChanges = [];
  let root = null;

  const { formatInr, formatValue } = await vite.ssrLoadModule('/src/utils/planIntelligence.js');
  ok(formatInr(-154500) === '-₹1,54,500' && formatInr(1234567.5) === '₹12,34,567.5' && formatInr(0) === '₹0' && formatValue(-5, '₹') === '-₹5', 'formatting: rupees in the Indian system, the sign before the symbol');

  async function mount() {
    if (root) { await act(async () => { root.unmount(); }); }
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.getElementById('root'));
    viewChanges = [];
    analyzeCalls = 0;
    planChatBodies.length = 0;
    await act(async () => { root.render(React.createElement(App, { onView: (v) => viewChanges.push(v) })); await tick(60); });
    await act(async () => { await tick(60); });
  }
  const waitFor = async (predicate, ms = 3000) => {
    const start = Date.now();
    while (!predicate() && Date.now() - start < ms) await act(async () => { await tick(25); });
    return predicate();
  };
  const click = (el) => act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick(30); });
  const page = () => document.body.textContent;
  const step$ = (id) => document.querySelector(`li[data-step-id="${id}"]`);
  const buttonIn = (root$, label) => [...root$.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(label));

  // ═══ 1. a full analysis: order, labels, content ═══════════════════════════════════════════════════════════════════
  analysisBody = analysis();
  await mount();
  ok(await waitFor(() => document.querySelector('.state-card')), 'the analysis renders', document.body.textContent.slice(0, 400));
  ok(analyzeCalls === 1, 'one analysis request is made when there are transactions', String(analyzeCalls));
  ok(document.querySelector('h1').textContent === 'Financial Intelligence' && page().includes('Your outlook. Your next move.'), 'header: title and subtitle');
  ok(buttonIn(document, 'Refresh analysis'), 'header: "Refresh analysis" button');

  const headings = [...document.querySelectorAll('h2.section-heading')].map((h) => h.textContent.trim());
  ok(JSON.stringify(headings) === JSON.stringify(['Your financial position', 'Next actions', 'Top risks and opportunities']), 'sections appear in order: state, findings, actions', headings.join(' | '));
  const details = document.querySelector('[data-testid="analysis-details"]');
  const following = (a, b) => Boolean(a.compareDocumentPosition(b) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  ok(following(document.querySelector('.plan-card'), details), 'Analysis details come after the actions');
  ok(details.tagName === 'DETAILS' && !details.hasAttribute('open'), 'Analysis details are collapsed by default');

  ok(document.querySelectorAll('[data-testid="action-list"] > li').length === 3, 'only three priority actions appear initially');
  ok(document.querySelector('section.advisor-panel[aria-labelledby=advisor-heading]'), 'advisor is always visible in a labelled section');
  ok(!document.querySelector('.ml-metadata'), 'implementation metadata is omitted');
  ok(!document.querySelector('.intelligence-disclosure').open, 'secondary insights are collapsed initially');
  ok(!document.querySelector('.analysis-content > .details-card').closest('details'), 'forecast is visible without expanding details');
  await click(buttonIn(document, 'View all 6 actions'));

  // no false ML labels
  const text = page();
  ok(!/ML Financial Intelligence|Run ML Analysis|Running ML Models|directly from our ML|every insight/i.test(text), 'no "ML Financial Intelligence" / "Run ML Analysis" wording', text.slice(0, 200));
  ok(!/K-?Means/i.test(text), 'no KMeans wording anywhere');
  ok(!text.includes('🤖'), 'no robot badge anywhere');
  ok(/Rule-based score/.test(document.querySelector('.state-score-note').textContent), 'the health score is labelled rule-based');
  ok(step$('HS-05').querySelector('.action-meta span').textContent === 'Rule' && step$('HS-04').querySelector('.action-meta span').textContent === 'Rule', 'health-score steps are tagged "Rule"');
  ok(['FC-01', 'AN-01', 'CL-01', 'FC-02'].every((id) => step$(id).querySelector('.action-meta span').textContent === 'ML signal'), 'forecast / anomaly / cluster steps are tagged "ML signal"');
  ok(!step$('HS-05').textContent.includes('HealthScorer') && !text.includes('source_model'), 'no HealthScorer-as-ML badge');
  const tags = [...document.querySelectorAll('.analysis-content .model-tag')].map((t) => t.textContent);
  ok(tags.length === 3 && /LinearRegression/.test(tags[0]) && /IsolationForest/.test(tags[1]) && /Agglomerative \(Ward\)/.test(tags[2]) && tags.every((t) => t.startsWith('ML')), 'details: honest model tags', tags.join(' | '));
  ok(!text.includes('ML:') && !text.includes('Rules:'), 'technical metadata is not shown in the overview');

  // current state: server figures, period, DTI reason, low-confidence caveat
  const stateText = document.querySelector('.state-card').textContent;
  ok(!stateText.includes('About this figure') && [...document.querySelectorAll('.state-card .metric-note')].every(note=>note.tagName==='P'), 'financial figure notes are displayed directly');
  ok(stateText.includes('62.4') && stateText.includes('Grade C') && stateText.includes('from 5 of 6 ratios'), 'state: score, grade and ratios available', stateText);
  ok(stateText.includes('₹52,000') && stateText.includes('₹42,500') && stateText.includes('over 5 months'), 'state: monthly income and net spending with the period');
  ok(stateText.includes('18.2%') && stateText.includes('1.4 months') && document.querySelector('.forecast-trends').textContent.includes('₹21,000'), 'state: savings rate, emergency coverage, projected savings');
  ok(stateText.includes("Unavailable: the monthly debt total couldn't be worked out"), 'state: DTI unavailable reason from the server', stateText);
  ok(/Based on 5 months of transactions \(2026-05 to 2026-09\)/.test(stateText), 'state: the analysed period is stated');
  ok(document.querySelector('.analysis-content .metric-note').textContent.includes('Low fit (income R² 0.20'), 'forecast: the backend caveat is available in optional details', stateText);

  // findings: at most 3 risks and 2 opportunities, server order kept
  const risks = [...document.querySelectorAll('[data-testid="risk-list"] li')].map((li) => li.textContent);
  ok(risks.length === 3 && risks[0].includes('Emergency Fund') && risks[1].includes('Reduce Debt Load') && risks[2].includes('Expenses Rising'), 'findings: three risks in the server\'s order', risks.join(' | '));
  ok(!risks.join().includes('Flagged') && !risks.join().includes('Concentration'), 'findings: only the first three of five risks');
  const opps = [...document.querySelectorAll('[data-testid="opportunity-list"] li')].map((li) => li.textContent);
  ok(opps.length === 2 && opps[0].includes('Income Is Trending Upward') && opps[1].includes('Investment rate: 16%'), 'findings: two opportunities (a plan opportunity, then a health strength)', opps.join(' | '));
  ok([...document.querySelectorAll('[data-testid="action-list"] > li')].map((li) => li.dataset.stepId).join() === 'HS-05,HS-04,FC-01,AN-01,CL-01,FC-02', 'actions: the server\'s order is not re-sorted');

  // actions: destinations
  ok(buttonIn(step$('HS-05'), 'Go to Emergency Fund') && buttonIn(step$('HS-04'), 'Go to Liabilities') && buttonIn(step$('FC-01'), 'Go to Budgets') && buttonIn(step$('AN-01'), 'Go to Transactions'), 'actions: destination buttons carry the existing page names');
  ok(!buttonIn(step$('CL-01'), 'Go to') && !buttonIn(step$('FC-02'), 'Go to'), 'actions: no button when the server named no destination');
  await click(buttonIn(step$('HS-04'), 'Go to'));
  ok(viewChanges.join() === 'liabilities', 'Go to Liabilities switches to the Liabilities page', viewChanges.join());
  await click(buttonIn(step$('HS-05'), 'Go to'));
  ok(viewChanges.at(-1) === 'goals', 'Go to Emergency Fund switches to Goals (where the section lives) via the existing navigation', viewChanges.join());
  await click(buttonIn(step$('FC-01'), 'Go to'));
  await click(buttonIn(step$('AN-01'), 'Go to'));
  ok(viewChanges.join() === 'liabilities,goals,transactions', 'budgets -> the Goals page (already there, so no second switch), transactions -> Transactions', viewChanges.join());

  // explainability: exactly the response's numbers
  const why = buttonIn(step$('HS-05'), 'Why?');
  ok(why && why.getAttribute('aria-expanded') === 'false', 'explain: "Why?" is a collapsed toggle');
  await click(why);
  const whyText = step$('HS-05').querySelector('[data-panel="why"]').textContent;
  ok(whyText.includes('Emergency coverage: 1.42 months') && whyText.includes('< 3 months (minimum safe buffer)'), 'explain: Why? shows the server value and threshold exactly', whyText);
  await click(buttonIn(step$('HS-05'), 'How calculated?'));
  const howText = step$('HS-05').querySelector('[data-panel="how"]').textContent;
  ok(howText.includes('Emergency fund ÷ Average monthly net spending') && howText.includes('Emergency fund: ₹60,350') && howText.includes('Average monthly net spending: ₹42,500/month (over 5 months)'), 'explain: How calculated? shows the formula and inputs', howText);
  ok(!step$('HS-05').querySelector('[data-panel="why"]'), 'explain: one panel open at a time');
  ok(!buttonIn(step$('HS-05'), 'What caused this?'), 'explain: no "What caused this?" when the server returned no contributors');
  await click(buttonIn(step$('AN-01'), 'What caused this?'));
  const causeText = step$('AN-01').querySelector('[data-panel="cause"]').textContent;
  ok(causeText.includes('Zoo tickets') && causeText.includes('₹9,800') && causeText.includes('2026-09-12') && causeText.includes('Unusually large for Entertainment'), 'explain: What caused this? lists the flagged transaction from the response', causeText);
  await click(buttonIn(step$('FC-01'), 'What caused this?'));
  const causeFc = step$('FC-01').querySelector('[data-panel="cause"]').textContent;
  ok(causeFc.includes('Rent: ₹1,00,000 (47.1% of spending)') && causeFc.includes('Food: ₹60,000'), 'explain: spending contributors are the server\'s category breakdown', causeFc);
  await click(buttonIn(step$('FC-01'), 'Why?'));
  ok(step$('FC-01').querySelector('[data-panel="why"]').textContent.includes('Low fit'), 'explain: evidence caveats are shown');
  await click(buttonIn(step$('HS-05'), 'Show breakdown'));
  const bd = step$('HS-05').querySelector('[data-panel="breakdown"]').textContent;
  ok(bd.includes('Savings rate') && bd.includes('18.2%') && bd.includes('58/100') && bd.includes('29.4%') && bd.includes('Emergency coverage') && bd.includes('17.6%'), 'explain: breakdown shows each ratio with its score and weight from the server', bd);
  ok(bd.includes("Debt-to-income: Unavailable: the monthly debt total couldn't be worked out"), 'explain: breakdown states why a ratio is unavailable');
  ok(bd.includes('Rent: ₹1,00,000 (47.1%)') && bd.includes('Other categories: ₹52,500') && bd.includes('Total: ₹2,12,500'), 'explain: breakdown shows spending by category', bd);

  // analysis details
  await click(details.querySelector('summary'));
  details.setAttribute('open', '');
  ok(document.querySelector('.analysis-content .forecast-bars-wrap') && details.querySelector('.anomaly-item') && details.querySelectorAll('.cluster-card').length === 2, 'details: forecast, anomaly and cluster sections are inside');

  // the advisor: only the conversation is sent
  const chip = [...document.querySelectorAll('.quick-prompt-chip')].find((c) => c.textContent === 'What should I do first?');
  ok(chip && !chip.disabled, 'advisor: quick prompt "What should I do first?"');
  const rendersBeforeChat = globalThis.__analysisRenders;
  await click(chip);
  await waitFor(() => planChatBodies.length === 1);
  ok(planChatBodies.length === 1 && !('mlContext' in planChatBodies[0]) && planChatBodies[0].messages.at(-1).content === 'What should I do first?', 'advisor: the request carries the conversation only (no client-side analysis context)', JSON.stringify(Object.keys(planChatBodies[0] ?? {})));
  ok(document.querySelector('.plan-chat-body').textContent.includes('REPLY(ok)'), 'advisor: the reply is shown');
  ok(document.querySelector('.plan-chat-msg.bot .plan-msg-content').textContent === 'Ask me about your results or what to focus on next.', 'advisor: truthful greeting');
  ok(!/Every insight here comes directly/.test(page()), 'advisor: the false claim is gone');

  const chatRenders = globalThis.__analysisRenders - rendersBeforeChat;
  console.log(`Analysis component renders during one advisor round-trip: ${chatRenders} (memo disabled: ${process.env.FINSPHERE_BENCH_NO_MEMO === 'true'})`);
  ok(process.env.FINSPHERE_BENCH_NO_MEMO === 'true' ? chatRenders > 0 : chatRenders === 0, 'unchanged analysis avoids advisor-only renders');
  const categoryTable = document.querySelector('#intelligence-categories').parentElement.parentElement;
  ok(categoryTable.textContent.includes('Rent') && categoryTable.textContent.includes('₹1,00,000'), 'recorded category totals match the server snapshot');

  // ═══ 2. emergency coverage reasons ═══════════════════════════════════════════════════════════════════════════════
  for (const [reason, expected] of [['no_fund', 'Not set up: add your emergency fund to see this'], ['no_spending', 'Unavailable: no spending recorded to measure it against']]) {
    const a = analysis();
    delete a.health.ratios.emergency_coverage;
    a.health.unavailable_reasons = { dti: 'no_income', emergency_coverage: reason };
    a.health.unavailable_ratios = ['dti', 'emergency_coverage'];
    a.health.metadata.ratios_used = 4;
    a.plan.steps = [hs04];
    analysisBody = a;
    await mount();
    await waitFor(() => document.querySelector('.state-card'));
    const s = document.querySelector('.state-card').textContent;
    ok(s.includes(expected) && s.includes('Unavailable: no income recorded in this period') && s.includes('from 4 of 6 ratios'), `state: emergency "${reason}" and DTI "no_income" reasons`, s);
  }

  // ═══ 3. partial failure ═════════════════════════════════════════════════════════════════════════════════════════
  {
    const a = analysis();
    a.forecast = {};
    a.metadata.errors = { forecast: true };
    analysisBody = a;
    await mount();
    await waitFor(() => document.querySelector('.state-card'));
    const s = document.querySelector('.state-card').textContent;
    ok(!s.includes('Projected savings'), 'partial failure: no duplicate forecast metric in position card', s);
    ok(s.includes('62.4') && document.querySelector('[data-testid="action-list"]') && document.querySelector('[data-testid="risk-list"]'), 'partial failure: the unaffected sections still render');
    const d = document.querySelector('[data-testid="analysis-details"]');
    ok(/3-month forecast[\s\S]*Unavailable/.test(document.querySelector('.analysis-content').textContent) && d.querySelector('.anomaly-item') && d.querySelectorAll('.cluster-card').length === 2, 'partial failure: only the forecast section is Unavailable');
    ok(!page().includes('ValueError'), 'partial failure: no exception text');
  }
  {
    const a = analysis();
    a.plan = {};
    a.health = {};
    a.metadata.errors = { plan: true, health: true };
    analysisBody = a;
    await mount();
    await waitFor(() => document.querySelector('.state-card'));
    ok(document.querySelector('.plan-card').textContent.includes('Unavailable') && document.querySelector('.state-card').textContent.includes('Unavailable'), 'partial failure: plan and health failures read Unavailable');
    ok(document.querySelector('.state-card .state-score.unavailable-block') && document.querySelector('[data-testid="analysis-details"]'), 'partial failure: the rest of the page is still there');
  }

  // ═══ 4. nothing happened to analyse ═════════════════════════════════════════════════════════════════════════════
  analysisBody = analysis();
  txList = [];
  await mount();
  await act(async () => { await tick(150); });
  ok(document.querySelector('[data-testid="plans-empty"]') && page().includes('No transactions to analyse yet'), 'empty: no transactions -> an empty state');
  ok(analyzeCalls === 0, 'empty: the analysis is NOT requested', String(analyzeCalls));
  ok(buttonIn(document, 'Refresh analysis').disabled, 'empty: Refresh is disabled');
  ok(!document.querySelector('.state-card'), 'empty: no result sections');
  txList = [{ id: 't1', title: 'Salary', amount: 52000, date: '2026-09-01', type: 'income', category: 'Salary' }];

  // ═══ 5. the analytics service fails: clean message, retry ═══════════════════════════════════════════════════════
  analyzeMode = 'fail';
  await mount();
  await waitFor(() => document.querySelector('[data-testid="analysis-error"]'));
  const err = document.querySelector('[data-testid="analysis-error"]');
  ok(err && /Analysis unavailable/.test(err.textContent) && /couldn't run the analysis/.test(err.textContent), 'failure: a clean error card');
  ok(!page().includes('SECRET-UPSTREAM-TEXT') && !page().includes('Nobu') && !/stack|Traceback|at \w+\.\w+/.test(err.textContent), 'failure: no upstream or stack text is ever shown', err.textContent);
  analyzeMode = 'ok';
  analysisBody = analysis();
  await click(buttonIn(err, 'Try again'));
  ok(await waitFor(() => document.querySelector('.state-card')) && !document.querySelector('[data-testid="analysis-error"]'), 'failure: "Try again" recovers');
  // A missing forecast total must never become a real zero.
  analysisBody = analysis();
  delete analysisBody.forecast.insights.projected_savings_3m;
  await mount();
  await waitFor(() => document.querySelector('.state-card'));
  const forecastRow = document.querySelector('.forecast-trends');
  ok(forecastRow?.textContent.includes('Unavailable') && !forecastRow.textContent.includes('₹0'), 'missing projection is unavailable, not zero');
  analysisBody = analysis();
  await mount();
  for (const period of [6,12,3]) {
    await act(async () => {
      const select = document.querySelector('#forecast-period');
      select.value = String(period);
      select.dispatchEvent(new window.Event('change', {bubbles:true}));
      await tick(80);
    });
    await waitFor(() => document.querySelector('.analysis-content .section-heading')?.textContent === `${period}-month forecast`);
    ok(document.querySelector('.analysis-content .section-heading')?.textContent === `${period}-month forecast`, `${period}-month selection updates actual forecast results`);
    ok(document.querySelectorAll('.forecast-group').length === period, `${period} forecast months rendered`);
  }
  await act(async () => { document.querySelector('.advisor-invitation button').click(); });
  ok(document.activeElement === document.querySelector('input[aria-label="Ask the advisor about this analysis"]'), 'Ask advisor invitation moves focus to the working composer');
} finally {
  await vite.close();
}

console.log(`plans UI tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
