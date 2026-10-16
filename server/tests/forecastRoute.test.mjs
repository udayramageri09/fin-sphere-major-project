// Exercises the real route body with owner-scoped data and an in-memory analytics service.
// No database connections, account writes, or external requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { forecastMonths } from '../forecastHorizon.js';
import { sanitizeAnalysis } from '../planSnapshot.js';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf("app.get('/api/ml/analyze'");
const end = source.indexOf('\n// 7. POST /api/plan-chat', start);
let handler, reads = [], payload;
const context = {
  app: { get: (...args) => { handler = args.at(-1); } }, authenticate: () => {}, mlLimiter: () => {},
  forecastMonths, sanitizeAnalysis, AbortSignal, console,
  listTransactionsByUser: async id => { reads.push(id); return [{id:1,amount:100,date:'2026-01-01'}]; },
  sumMonthlyPaymentsByUser: async id => { reads.push(id); return 10; },
  getEmergencyFundByUser: async id => { reads.push(id); return {currentAmount:100}; },
  ML_SERVICE_URL: 'http://analytics.test',
  fetch: async (_url, init) => { payload = JSON.parse(init.body); return {ok:true,json:async()=>({forecast:{forecast:{months:Array(payload.n_forecast_months).fill('month')}},metadata:{errors:null}})}; },
  planSnapshots: { set: id => assert.equal(id,17) },
};
vm.runInNewContext(source.slice(start,end), context);
for (const [query, expected] of [[{},3],[{months:'6'},6],[{months:'12'},12]]) {
  reads = []; let result;
  const res = { status(code) { this.code=code; return this; }, json(body) { result=body; } };
  await handler({user:{id:17},query:{...query,userId:999}},res);
  assert.equal(payload.n_forecast_months,expected);
  assert.deepEqual(reads,[17,17,17]);
  assert.equal(result.forecast.forecast.months.length,expected);
}
for (const months of ['7', ['6','12'], '6oops']) {
  reads=[];
  const res={status(code){this.code=code;return this;},json(){}};
  await handler({user:{id:17},query:{months}},res);
  assert.equal(res.code,400);
  assert.equal(reads.length,0);
}
console.log('Forecast route: 6 scenarios passed (period forwarding, account scope, invalid input)');
