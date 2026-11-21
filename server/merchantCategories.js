// Descriptions that clearly belong to one of FinSphere's existing spending categories. This is a small, readable keyword list, not a model: a
// description that matches nothing stays uncategorised (it ends up in "Others"). Matching is by whole words after the description has
// been cleaned (see normalizeMerchant), and the LONGEST matching keyword wins ("amazon prime video" is Entertainment through
// "prime video", not Shopping through "amazon").
//
// A merchant that merely appears often does NOT become a category: only the words below, or the user's own category, decide that.

export const TAXONOMY = ['Food', 'Shopping', 'Bills', 'Entertainment', 'Travel', 'Petrol', 'P2P', 'Investment', 'Salary'];

export const CATEGORY_KEYWORDS = {
  Food: [
    'zomato', 'swiggy', 'dominos', 'domino', 'pizza', 'burger', 'kfc', 'mcdonalds', 'starbucks', 'cafe', 'coffee', 'restaurant', 'dhaba', 'biryani',
    'bakery', 'blinkit', 'zepto', 'instamart', 'bigbasket', 'dmart', 'grocery', 'groceries', 'supermarket', 'canteen', 'mess', 'food', 'lunch', 'dinner', 'hotel', 'south kitc'
  ],
  Shopping: ['amazon', 'flipkart', 'myntra', 'ajio', 'nykaa', 'meesho', 'snapdeal', 'decathlon', 'ikea', 'croma', 'lifestyle', 'westside', 'zara', 'shopping', 'mall', 'magicpin', 'reliance'],
  Bills: [
    'electricity', 'bescom', 'bses', 'tneb', 'water bill', 'gas bill', 'broadband', 'airtel', 'jio', 'vodafone', 'bsnl', 'recharge', 'postpaid', 'dth', 'tata sky',
    'insurance', 'premium', 'bill', 'utility', 'utilities', 'telecom'
  ],
  Entertainment: ['netflix', 'spotify', 'hotstar', 'disney', 'prime video', 'youtube premium', 'bookmyshow', 'pvr', 'inox', 'cinema', 'movie', 'gaming', 'steam', 'playstation', 'sonyliv', 'zee5', 'jiocinema'],
  Travel: [
    'uber', 'ola', 'rapido', 'irctc', 'makemytrip', 'goibibo', 'redbus', 'indigo', 'spicejet', 'air india', 'vistara', 'metro',
    'taxi', 'cab', 'toll', 'fastag', 'parking', 'bus', 'train', 'flight', 'travel', 'oyo'
  ],
  Petrol: ['fuel', 'petrol', 'diesel', 'iocl', 'hpcl', 'bpcl', 'indian oil', 'bharat petroleum', 'hindustan petroleum'],
  Investment: ['mutual fund', 'mutual', 'sip', 'zerodha', 'groww', 'upstox', 'nps', 'ppf', 'stock', 'stocks', 'dividend', 'demat', 'kuvera', 'indmoney'],
  Salary: ['salary', 'paycheck', 'employer']
};

// Words that carry no merchant identity in a bank narration.
export const NOISE_WORDS = new Set([
  'upi', 'pos', 'neft', 'imps', 'rtgs', 'ach', 'nach', 'ecs', 'payment', 'paid', 'pay', 'to', 'from', 'via', 'ref', 'txn', 'trf', 'transfer', 'debit', 'credit', 'dr', 'cr',
  'purchase', 'online', 'order', 'orders', 'towards', 'for', 'the', 'and', 'pvt', 'ltd', 'limited', 'india', 'private', 'inc', 'llp', 'refund', 'reversal', 'cashback', 'int', 'bank'
]);

export function categoryRuleKey(title) {
  return String(title ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean)
    .filter((token) => !NOISE_WORDS.has(token) && !/^\d+$/.test(token) && !/\d{3,}/.test(token)).join(' ');
}

const KEYWORDS = Object.entries(CATEGORY_KEYWORDS).flatMap(([category, words]) => words.map((word) => ({ category, word })))
  .sort((a, b) => b.word.length - a.word.length);

export function detectMerchantCategory(title) {
  const text = ` ${categoryRuleKey(title)} `;
  const known = KEYWORDS.find(({ word }) => text.includes(` ${word} `))?.category;
  if (known) return known;
  // Only a UPI narration with a person-shaped two- to four-word payee is guessed; banks may put a reference or the name before "UPI/".
  if (/(?<![\p{L}\p{N}])upi[/:\s-]+(?:\d+[/:\s-]+)?\p{L}+(?:[ .]+\p{L}+){1,3}(?=[/@]|$)/iu.test(String(title).trim())) return 'P2P';
  return null;
}
