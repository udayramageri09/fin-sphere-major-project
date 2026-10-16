import { analyticalRole, getMonthKey, parseLocalDate } from './finance.js';
import { categoryFor, normalizeMerchant } from './spendingAnalytics.js';

export const PRIORITIES = ['Needs', 'Wants', 'Other'];
export function suggestedPriority(t) {
  const category = categoryFor(t).name.toLowerCase();
  if (['rent', 'groceries', 'healthcare', 'medical', 'education', 'utilities', 'bills', 'insurance'].includes(category)) return 'Needs';
  if (['entertainment', 'dining', 'restaurants', 'leisure'].includes(category)) return 'Wants';
  const merchant = normalizeMerchant(t.title).text;
  if (/\b(grocery|groceries|supermarket|bigbasket|dmart|pharmacy)\b/.test(merchant)) return 'Needs';
  if (/\b(zomato|swiggy|restaurant|netflix|spotify|cinema)\b/.test(merchant)) return 'Wants';
  return 'Other';
}
export function priorityFor(t, preferences = {}) {
  if (Object.hasOwn(preferences.transactions ?? {}, String(t.id)) && PRIORITIES.includes(preferences.transactions[t.id])) return { label: preferences.transactions[t.id], source: 'Your choice' };
  const merchant = normalizeMerchant(t.title).key;
  if (merchant && Object.hasOwn(preferences.merchants ?? {}, merchant) && PRIORITIES.includes(preferences.merchants[merchant])) return { label: preferences.merchants[merchant], source: 'Your merchant rule' };
  return { label: suggestedPriority(t), source: 'Suggested' };
}
export function priorityBreakdown(transactions, monthKeys, preferences = {}) {
  const months = new Set(monthKeys);
  const rows = transactions.flatMap(t => {
    const date = parseLocalDate(t.date), role = analyticalRole(t);
    if (!date || !months.has(getMonthKey(date)) || role?.role !== 'spending') return [];
    return [{ ...t, ...priorityFor(t, preferences), paise: role.paise, merchant: normalizeMerchant(t.title).key }];
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const total = rows.reduce((sum, r) => sum + r.paise, 0);
  return { rows, total, groups: PRIORITIES.map(label => { const paise = rows.filter(r => r.label === label).reduce((sum, r) => sum + r.paise, 0); return { label, paise, share: total ? paise / total : 0 }; }) };
}

export const priorityStorageKey = owner => owner === undefined || owner === null ? null : `finsphere:spending-priorities:v1:${owner}`;
export function readPriorityPreferences(owner) {
  try { const key = priorityStorageKey(owner); if (!key) return {}; const value = JSON.parse(window.localStorage.getItem(key)); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
export function savePriorityPreference(owner, id, label, merchant, remember, removeRule = false) {
  const key = priorityStorageKey(owner);
  const current = readPriorityPreferences(owner);
  const next = { transactions: { ...current.transactions }, merchants: { ...current.merchants } };
  if (PRIORITIES.includes(label)) Object.defineProperty(next.transactions, String(id), { value: label, enumerable: true, configurable: true }); else delete next.transactions[String(id)];
  if (merchant && removeRule) delete next.merchants[merchant];
  if (merchant && remember && PRIORITIES.includes(label)) Object.defineProperty(next.merchants, merchant, { value: label, enumerable: true, configurable: true });
  try { if (!key) return false; window.localStorage.setItem(key, JSON.stringify(next)); window.dispatchEvent(new window.CustomEvent('finsphere-priorities-updated', { detail: key })); return true; } catch { return false; }
}
