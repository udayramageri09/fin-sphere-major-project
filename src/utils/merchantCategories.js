// Descriptions that clearly belong to one of FinSphere's existing spending categories. This is a small, readable keyword list, not a model: a
// description that matches nothing stays uncategorised (it ends up in "Others"). Matching is by whole words after the description has
// been cleaned (see normalizeMerchant), and the LONGEST matching keyword wins ("amazon prime video" is Entertainment through
// "prime video", not Shopping through "amazon").
//
// A merchant that merely appears often does NOT become a category: only the words below, or the user's own category, decide that.

export const TAXONOMY = ['Food', 'Shopping', 'Bills', 'Entertainment', 'Travel', 'Investment', 'Salary'];

export const CATEGORY_KEYWORDS = {
  Food: [
    'zomato', 'swiggy', 'dominos', 'domino', 'pizza', 'burger', 'kfc', 'mcdonalds', 'starbucks', 'cafe', 'coffee', 'restaurant', 'dhaba', 'biryani',
    'bakery', 'blinkit', 'zepto', 'instamart', 'bigbasket', 'dmart', 'grocery', 'groceries', 'supermarket', 'canteen', 'mess', 'food', 'lunch', 'dinner'
  ],
  Shopping: ['amazon', 'flipkart', 'myntra', 'ajio', 'nykaa', 'meesho', 'snapdeal', 'decathlon', 'ikea', 'croma', 'lifestyle', 'westside', 'zara', 'shopping', 'mall'],
  Bills: [
    'electricity', 'bescom', 'bses', 'tneb', 'water bill', 'gas bill', 'broadband', 'airtel', 'jio', 'vodafone', 'bsnl', 'recharge', 'postpaid', 'dth', 'tata sky',
    'insurance', 'premium', 'bill', 'utility', 'utilities'
  ],
  Entertainment: ['netflix', 'spotify', 'hotstar', 'disney', 'prime video', 'youtube premium', 'bookmyshow', 'pvr', 'inox', 'cinema', 'movie', 'gaming', 'steam', 'playstation', 'sonyliv', 'zee5', 'jiocinema'],
  Travel: [
    'uber', 'ola', 'rapido', 'irctc', 'makemytrip', 'goibibo', 'redbus', 'indigo', 'spicejet', 'air india', 'vistara', 'metro', 'fuel', 'petrol', 'diesel',
    'iocl', 'hpcl', 'bpcl', 'taxi', 'cab', 'toll', 'fastag', 'parking', 'bus', 'train', 'flight', 'hotel', 'oyo'
  ],
  Investment: ['mutual fund', 'sip', 'zerodha', 'groww', 'upstox', 'nps', 'ppf', 'stocks', 'demat', 'kuvera', 'indmoney']
};

// Words that carry no merchant identity in a bank narration.
export const NOISE_WORDS = new Set([
  'upi', 'pos', 'neft', 'imps', 'rtgs', 'ach', 'nach', 'ecs', 'payment', 'paid', 'pay', 'to', 'from', 'via', 'ref', 'txn', 'trf', 'transfer', 'debit', 'credit', 'dr', 'cr',
  'purchase', 'online', 'order', 'orders', 'towards', 'for', 'the', 'and', 'pvt', 'ltd', 'limited', 'india', 'private', 'inc', 'llp', 'refund', 'reversal', 'cashback', 'int', 'bank'
]);
