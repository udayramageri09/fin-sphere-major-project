import { categoryRuleKey } from './merchantCategories.js';
import { pdfRuleKey } from './pdfImportReview.js';

const storageKey = (owner) => owner == null ? null : `finsphere:category-rules:v1:${owner}`;

export function readCategoryRules(owner) {
  const key = storageKey(owner);
  if (!key) return [];
  try {
    const rules = JSON.parse(window.localStorage.getItem(key) || '[]');
    return Array.isArray(rules) ? rules.filter((rule) => typeof rule?.key === 'string' && typeof rule?.category === 'string') : [];
  } catch {
    throw new Error('Could not read your saved category rules in this browser.');
  }
}

export function saveCategoryRule(owner, title, category) {
  const key = storageKey(owner);
  const merchant = categoryRuleKey(title);
  if (!key || !merchant) throw new Error('This description cannot be remembered as a category rule.');
  const rules = readCategoryRules(owner).filter((rule) => rule.key !== merchant);
  if (rules.length >= 100) throw new Error('You have reached the limit of 100 saved category rules.');
  rules.push({ key: merchant, category });
  try {
    window.localStorage.setItem(key, JSON.stringify(rules));
  } catch {
    throw new Error('Could not save your category rule in this browser.');
  }
}

const pdfStorageKey = (owner) => `finsphere:pdf-classification-rules:v1:${owner}`;

export function readPdfRules(owner) {
  if (owner == null) return [];
  try {
    const rules = JSON.parse(window.localStorage.getItem(pdfStorageKey(owner)) || '[]');
    return Array.isArray(rules) ? rules.filter((rule) => typeof rule?.key === 'string' && typeof rule.category === 'string') : [];
  } catch (cause) {
    throw new Error('Could not read your saved PDF rules in this browser.', { cause });
  }
}

export function rememberPdfRules(owner, rows) {
  if (owner == null || !rows.length) return;
  const rules = new Map(readPdfRules(owner).map((rule) => [rule.key, rule]));
  for (const { title, type, category, classification } of rows) {
    const key = pdfRuleKey(title, type);
    if (!key) continue;
    rules.delete(key);
    rules.set(key, { key, category, classification });
  }
  try {
    window.localStorage.setItem(pdfStorageKey(owner), JSON.stringify([...rules.values()].slice(-100)));
  } catch (cause) {
    throw new Error('Transactions were imported, but this browser could not remember your corrections.', { cause });
  }
}
