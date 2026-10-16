import assert from 'node:assert/strict';
import { forecastMonths } from '../forecastHorizon.js';
assert.equal(forecastMonths(undefined),3);
for (const value of ['3','6','12']) assert.equal(forecastMonths(value),Number(value));
for (const value of ['', '0','1','4','13','6x','06','6.0','6.5','Infinity',null,6, ['6'],{months:'6'}]) assert.equal(forecastMonths(value),null);
console.log('Forecast horizon validation: 18 checks passed');
