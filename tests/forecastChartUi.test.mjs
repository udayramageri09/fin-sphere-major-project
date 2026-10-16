// Forecast chart (Financial Intelligence): pointer, touch and keyboard inspection, exact figures, table, provenance, missing values.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const container = document.getElementById('root');
let root = createRoot(container), checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const q = (sel) => container.querySelector(sel);
const qa = (sel) => [...container.querySelectorAll(sel)];
const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const key = async (el, k) => act(async () => { el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
const hover = async (el) => act(async () => { el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })); el.dispatchEvent(new window.MouseEvent('mouseenter')); });
const click = async (el) => act(async () => { el.click(); });

const historical = [
  { month: '2026-05', month_label: 'May 2026', income: 50000, expenses: 30000 },
  { month: '2026-06', month_label: 'Jun 2026', income: 52000, expenses: 31000.5 },
  { month: '2026-07', month_label: 'Jul 2026', income: 48000, expenses: 49000 },
  { month: '2026-08', month_label: 'Aug 2026', income: 50000, expenses: 50000 },
  { month: '2026-09', month_label: 'Sep 2026', income: 51000, expenses: 32000 },
];
const forecast = { months: ['Oct 2026', 'Nov 2026', 'Dec 2026'], income: { predictions: [52000, 52500, 53000], r2: 0.2, model: 'linear_regression' }, expenses: { predictions: [33000, 33500, null], r2: 0.35, model: 'linear_regression' } };

try {
  const { default: ForecastChart } = await vite.ssrLoadModule('/src/components/plans/ForecastChart.jsx');
  const render = async (props) => act(async () => root.render(React.createElement(ForecastChart, props)));

  await render({ historical, forecast });
  const groups = qa('button.bar-group');
  check(q('.forecast-bars-wrap') && groups.length === 7, 'last four recorded months plus three forecast months are shown as buttons');
  check(groups.slice(0, 4).every((g) => g.dataset.kind === 'recorded') && groups.slice(4).every((g) => g.dataset.kind === 'forecast'), 'recorded and forecast months are marked differently');
  check(qa('.forecast-group').length === 3 && qa('.forecast-bar').length === 5 && qa('.bar-kind').filter((e) => text(e) === 'Forecast').length === 3, 'forecast months are visibly and textually distinct (not colour alone)');
  check(q('.forecast-divider'), 'a divider separates recorded from forecast');
  check(groups.every((g) => !g.hasAttribute('title')), 'no hover-only title tooltips');
  check(groups[0].getAttribute('aria-label') === 'Jun 2026, recorded: income ₹52,000, spending ₹31,000.5', 'each month has a spoken label with exact figures');
  check(groups[4].getAttribute('aria-label') === 'Oct 2026, forecast: income ₹52,000, spending ₹33,000', 'forecast labels say forecast');
  check(groups[6].getAttribute('aria-label').endsWith('spending Unavailable'), 'a missing prediction is spoken as Unavailable, not zero');

  // default selection and detail panel
  check(groups.filter((g) => g.getAttribute('aria-pressed') === 'true').length === 1 && groups[3].getAttribute('aria-pressed') === 'true', 'the latest recorded month starts selected');
  const detail = () => q('[data-testid=forecast-detail]');
  check(text(detail()).includes('Sep 2026') && text(detail()).includes('Recorded') && text(detail()).includes('₹51,000') && text(detail()).includes('₹32,000') && text(detail()).includes('Left after spending₹19,000'), 'details show exact income, spending and the amount left');
  check(detail().getAttribute('role') === 'region' && detail().getAttribute('aria-live') === 'polite', 'details are an announced region');
  check(!!(q('.bars-container').compareDocumentPosition(detail()) & window.Node.DOCUMENT_POSITION_FOLLOWING), 'the details come after the chart in reading order (never over the bars)');

  // pointer, touch, keyboard
  await hover(groups[0]);
  check(text(detail()).includes('Jun 2026') && text(detail()).includes('₹31,000.5') && text(detail()).includes('Left after spending₹20,999.5'), 'hover selects a month; paise-exact amounts are kept');
  await click(groups[1]);
  check(text(detail()).includes('Jul 2026') && text(detail()).includes('Spending above income₹1,000'), 'tap or click selects a month; overspending is stated in words');
  await click(groups[2]);
  check(text(detail()).includes('Aug 2026') && text(detail()).includes('Income equals spending₹0'), 'equal income and spending is handled');
  await act(async () => groups[0].focus()); await act(async () => groups[0].dispatchEvent(new window.FocusEvent('focus')));
  await key(groups[0], 'ArrowRight');
  check(document.activeElement === groups[1] && groups[1].getAttribute('aria-pressed') === 'true', 'ArrowRight moves focus and selection to the next month');
  await key(groups[1], 'End');
  check(document.activeElement === groups[6] && text(detail()).includes('Dec 2026'), 'End jumps to the last forecast month');
  await key(groups[6], 'Home');
  check(document.activeElement === groups[0], 'Home jumps to the first month');
  await key(groups[0], 'ArrowLeft');
  check(document.activeElement === groups[0], 'ArrowLeft stops at the first month');
  check(groups.filter((g) => g.getAttribute('tabindex') === '0').length === 1, 'one Tab stop for the whole chart (roving tabindex)');
  check(groups.every((g) => g.tagName === 'BUTTON' && g.type === 'button'), 'months are real buttons, so Enter and Space work');

  // forecast detail: provenance and missing value
  await click(groups[4]);
  check(text(detail()).includes('Forecast') && text(detail()).includes('ML · LinearRegression') && text(detail()).includes('R² income 0.2, spending 0.35'), 'forecast details keep the model and fit provenance');
  await click(groups[6]);
  check(text(detail()).includes('Spending') && text(detail()).includes('Unavailable') && !text(detail()).includes('Left after spending₹'), 'a missing forecast value reads Unavailable and no amount left is invented');
  check(qa('.bar-pair')[6].querySelectorAll('.bar').length === 1, 'no bar is drawn for a missing value');
  await click(groups[0]);
  check(!text(detail()).includes('ML · LinearRegression'), 'recorded months do not claim a model');

  // exact values table
  const details = q('details.forecast-table-details');
  check(details && !details.open && text(details.querySelector('summary')) === 'View exact values', 'exact values are in a collapsed disclosure');
  const rows = qa('.forecast-table-details tbody tr').map((r) => [...r.children].map(text));
  check(rows.length === 7 && JSON.stringify(rows[0]) === JSON.stringify(['Jun 2026', 'Recorded', '₹52,000', '₹31,000.5']), 'the table lists every shown month with exact figures');
  check(JSON.stringify(rows[6]) === JSON.stringify(['Dec 2026', 'Forecast', '₹53,000', 'Unavailable']), 'forecast rows are labelled and missing values read Unavailable');
  check(q('.forecast-table-details caption') && qa('.forecast-table-details thead th[scope=col]').length === 4 && qa('.forecast-table-details tbody th[scope=row]').length === 7, 'the table has a caption and header scopes');
  check(q('.forecast-table-scroll').getAttribute('tabindex') === '0' && q('.forecast-table-scroll').getAttribute('role') === 'region', 'the table scrolls inside a focusable labelled region');

  // no forecast available, and missing history
  await render({ historical, forecast: undefined });
  check(qa('button.bar-group').length === 4 && !q('.forecast-divider') && qa('.bar-kind').every((e) => text(e) === 'Recorded'), 'with no forecast only recorded months are shown');
  await render({ historical: [], forecast });
  check(text(q('.no-data')) === 'No forecast data', 'no history shows the existing empty message');
  await render({ historical: [{ month_label: 'Sep 2026', income: null, expenses: undefined }], forecast: undefined });
  check(text(q('[data-testid=forecast-detail]')).includes('Unavailable') && !/NaN|undefined/.test(container.textContent), 'missing recorded values read Unavailable, never NaN');
  await render({ historical: [{ month_label: 'Sep 2026', income: 0, expenses: 0 }], forecast: undefined });
  check(text(q('[data-testid=forecast-detail]')).includes('Income equals spending₹0') && qa('.bar').every((b) => b.style.height === '0%'), 'an all-zero month is handled without dividing by zero');

  console.log(`Forecast chart UI: ${checks} checks passed`);
} finally {
  await act(async () => root.unmount());
  await vite.close();
  dom.window.close();
}
