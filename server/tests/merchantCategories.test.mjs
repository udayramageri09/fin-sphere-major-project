import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryRuleKey, detectMerchantCategory } from '../merchantCategories.js';

test('known merchants use the most specific category', () => {
  assert.equal(detectMerchantCategory('UPI/123456/Hotel Annapoorna'), 'Food');
  assert.equal(detectMerchantCategory('HPCL PETROL STATION'), 'Petrol');
  assert.equal(detectMerchantCategory('AMAZON PRIME VIDEO'), 'Entertainment');
  assert.equal(detectMerchantCategory('COLA HOUSE'), null);
});

test('only person-shaped UPI narrations are guessed as P2P', () => {
  assert.equal(detectMerchantCategory('UPI/123456/Ravi Kumar/bank'), 'P2P');
  assert.equal(detectMerchantCategory('Ravi Kumar'), null);
  assert.equal(detectMerchantCategory('UPI/123456/Zomato'), 'Food');
});

test('merchant rules ignore references but retain the full payee name', () => {
  assert.equal(categoryRuleKey('UPI/RAVI KUMAR/123456'), categoryRuleKey('UPI/RAVI KUMAR/654321'));
  assert.notEqual(categoryRuleKey('RAVI KUMAR HOTEL'), categoryRuleKey('RAVI KUMAR STORE'));
});
