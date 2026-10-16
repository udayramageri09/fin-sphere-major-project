import test from 'node:test';
import assert from 'node:assert/strict';
import { monthRangeKeys, defaultMonthRange, buildSpendingAnalytics, transactionsBehind, detectRecurring } from '../src/utils/spendingAnalytics.js';
test('inclusive month range handles a single month and year boundary',()=>{
 assert.deepEqual(monthRangeKeys('2025-12','2026-02'),['2025-12','2026-01','2026-02']);
 assert.deepEqual(monthRangeKeys('2024-02','2024-02'),['2024-02']);
 assert.equal(monthRangeKeys('2020-01','2026-10').length,82);
});
test('invalid, missing or reversed month ranges are refused',()=>{
 for(const pair of [['2026-13','2026-14'],['2026-00','2026-01'],['2026-2','2026-03'],['2026-03','2026-02'],['','2026-01'],[undefined,'2026-01'],['1899-12','2026-01']]) assert.throws(()=>monthRangeKeys(...pair),RangeError);
});
test('default selection is six local calendar months including the current one',()=>{
 assert.deepEqual(defaultMonthRange(new Date(2026,0,15)),{startMonth:'2025-08',endMonth:'2026-01'});
});
const tx=(id,date,amount,classification='expense')=>({id,date,amount,title:'Rent',category:'Bills',type:amount<0?'expense':'income',classification});
test('historical range includes both boundaries and empty months, excludes outside records',()=>{
 const rows=[tx('a','2024-12-01',-100),tx('b','2025-02-28',-200),tx('c','2025-03-01',-300),tx('d','2024-11-30',-500),tx('e','2025-01-01',500,'income'),tx('f','2025-02-01',25,'refund'),tx('g','2025-01-02',-1000,'transfer')];
 const a=buildSpendingAnalytics(rows,{startMonth:'2024-12',endMonth:'2025-02'});
 assert.equal(a.period.label,'Dec 2024 – Feb 2025');assert.equal(a.period.months,3);
 assert.equal(a.totals.income,500);assert.equal(a.totals.spending,275);assert.equal(a.monthly[1].spending,0);
 assert.deepEqual(transactionsBehind(rows,a,'Bills').map(r=>r.id),['b','f','a']);
});
test('recurring detection can be scoped to the selected months',()=>{
 const rows=[tx('a','2025-01-01',-100),tx('b','2025-02-01',-100),tx('c','2025-03-01',-100)];
 assert.equal(detectRecurring(rows,new Date(2026,9,15),monthRangeKeys('2025-01','2025-03')).length,1);
 assert.equal(detectRecurring(rows,new Date(2026,9,15),monthRangeKeys('2025-02','2025-03')).length,0);
});
