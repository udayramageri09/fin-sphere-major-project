// AI-assisted classification of bank narrations that the local rules could not place (first-time merchants).
// The model only SUGGESTS a category and classification from a fixed list; every suggestion is validated here, and the user's own
// review, edits and remembered corrections still decide what is saved. Long digit runs (account / reference numbers) are masked
// before anything leaves the server.
import { TAXONOMY } from './merchantCategories.js';

export const AI_CATEGORIES = [...new Set([...TAXONOMY, 'Groceries', 'Housing', 'Healthcare', 'Education', 'Subscriptions', 'Insurance',
  'Loan Repayment', 'Bank Fees', 'Interest', 'Dividends', 'Transfers', 'Cash', 'General'])];
const CLASSIFICATIONS = { income: ['income', 'refund', 'transfer'], expense: ['expense', 'transfer'] };
export const MAX_AI_ITEMS = 100;

export function cleanItems(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_AI_ITEMS) return { ok: false, error: `Send between 1 and ${MAX_AI_ITEMS} items.` };
  const items = [];
  for (const entry of raw) {
    const title = typeof entry?.title === 'string' ? entry.title.replace(/\d{5,}/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    if (!Number.isInteger(entry?.index) || !title || !CLASSIFICATIONS[entry?.type]) return { ok: false, error: 'Each item needs an index, a title and a type of income or expense.' };
    items.push({ index: entry.index, title, type: entry.type });
  }
  return { ok: true, items };
}

export function buildMessages(items) {
  return [
    {
      role: 'system',
      content: `You classify Indian bank statement narrations for a personal finance app. For each item choose ONE category from this list: ${AI_CATEGORIES.join(', ')}.
Use "P2P" for UPI payments to or from a person, "Food" for restaurants and delivery, "Groceries" for supermarkets, "Transfers" only for moves between the user's own accounts, and "General" only if nothing fits.
Also choose a classification: for money out ("expense") use "expense" or "transfer"; for money in ("income") use "income", "refund" or "transfer".
Return ONLY a JSON array like [{"index":0,"category":"Food","classification":"expense"}]. No markdown, no notes.`
    },
    { role: 'user', content: JSON.stringify(items.map(({ index, title, type }) => ({ index, narration: title, direction: type }))) }
  ];
}

export function parseSuggestions(reply, items) {
  const text = String(reply ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const byIndex = new Map(items.map((item) => [item.index, item]));
  const categories = new Map(AI_CATEGORIES.map((name) => [name.toLowerCase(), name]));
  const seen = new Set();
  const suggestions = [];
  for (const entry of parsed) {
    const item = byIndex.get(entry?.index);
    const category = categories.get(String(entry?.category ?? '').trim().toLowerCase());
    if (!item || !category || seen.has(item.index)) continue;
    const allowed = CLASSIFICATIONS[item.type];
    const classification = allowed.includes(entry?.classification) ? entry.classification : allowed[0];
    seen.add(item.index);
    suggestions.push({ index: item.index, category, classification });
  }
  return suggestions;
}
