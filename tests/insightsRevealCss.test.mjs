// Regression: the Insights panel's reveal animation must never start at opacity 0.
// With a frozen animation clock (background tab, stalled compositor) an opacity fade leaves the fully rendered panel invisible, which looks
// like a blank Insights page. A slide-only reveal keeps the content visible whatever the animation clock does.
//
//   npm run test:insights-css
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/components/analytics/Analytics.css', import.meta.url), 'utf8');
const keyframes = /@keyframes insights-reveal\s*\{([\s\S]*?\})\s*\}/.exec(css);
assert.ok(keyframes, 'the insights-reveal keyframes exist');
assert.ok(!/opacity/i.test(keyframes[1]), 'insights-reveal must not animate opacity (a stalled animation clock would leave the panel invisible)');
assert.match(css, /\.transaction-insights-panel:not\(\[hidden\]\)\s*\{\s*animation:\s*insights-reveal/, 'the panel still uses the reveal animation');
for (const rule of css.match(/\.transaction-insights-panel[^{]*\{[^}]*\}/g) ?? []) assert.ok(!/opacity\s*:\s*0\b/.test(rule), 'no rule may hide the panel with opacity 0');
console.log('Insights reveal CSS: 4 checks passed');
