// assistantIntent.js - decides whether an assistant message asks a question, requests navigation, or both (Issue #69).
//
// The one rule: topic words alone NEVER navigate. "How is my budget?" is a question. Navigation needs explicit action
// language ("open budgets", "go to transactions", "show me the goals page", "take me there") that forms a whole
// clause. A message can hold both: "How is my budget? Open it." -> answer the question, then open the budget section.
// Voice transcripts have no punctuation, so a trailing ("... open it") or leading ("open goals and ...") command is
// also recognised. The parser is pure: no React, no DOM, no network.

// Where the app can go. `view` is a top-level page (App.jsx currentView); `section` scrolls to an element on a page.
export const DESTINATIONS = {
  dashboard:       { type: 'view', target: 'dashboard', view: 'dashboard', label: 'Dashboard' },
  transactions:    { type: 'view', target: 'transactions', view: 'transactions', label: 'Transactions' },
  liabilities:     { type: 'view', target: 'liabilities', view: 'liabilities', label: 'Liabilities' },
  goals:           { type: 'view', target: 'goals', view: 'goals', label: 'Goals' },
  budgets:         { type: 'section', target: 'budgets', view: 'goals', label: 'Budgets' },
  'emergency-fund': { type: 'section', target: 'emergency-fund', view: 'goals', label: 'Emergency Fund' },
  plans:           { type: 'view', target: 'plans', view: 'plans', label: 'Plans' },
  portfolio:       { type: 'view', target: 'portfolio', view: 'portfolio', label: 'Portfolio' },
  subscriptions:   { type: 'view', target: 'subscriptions', view: 'subscriptions', label: 'Subscriptions' },
};

// Destination names accepted AFTER an action verb. Generic topic words ("spending", "debt", "saving", "monthly") are
// deliberately absent: they may only name a destination when followed by "page" (e.g. "debt page", "expenses page").
const ALIASES = [
  ['transaction history', 'transactions'], ['transactions', 'transactions'], ['transaction', 'transactions'],
  ['expenses page', 'transactions'], ['expense page', 'transactions'],
  ['liabilities', 'liabilities'], ['liability', 'liabilities'], ['loans page', 'liabilities'], ['loan page', 'liabilities'],
  ['debt page', 'liabilities'], ['debts page', 'liabilities'],
  ['goals', 'goals'], ['goal page', 'goals'], ['goal', 'goals'],
  ['monthly budgets', 'budgets'], ['budget section', 'budgets'], ['budgets', 'budgets'], ['budget', 'budgets'],
  ['emergency fund', 'emergency-fund'], ['emergency savings', 'emergency-fund'],
  ['main dashboard', 'dashboard'], ['dashboard', 'dashboard'], ['home page', 'dashboard'], ['homepage', 'dashboard'], ['home', 'dashboard'],
  ['financial intelligence', 'plans'], ['analysis page', 'plans'], ['ml plans', 'plans'], ['plans', 'plans'], ['plan page', 'plans'],
  ['portfolio', 'portfolio'],
  ['sips and subscriptions', 'subscriptions'], ['subscriptions', 'subscriptions'],
];

const POLITE_PREFIX = String.raw`(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`;
const POLITE_SUFFIX = String.raw`(?:\s+(?:please|for me|now|thanks|thank you))*`;
const ARTICLE = String.raw`(?:(?:the|my|our)\s+)?`;
const PAGE_WORD = String.raw`(?:\s+(?:page|section|tab|screen|view))?`;
const ALIAS_GROUP = ALIASES.map(([alias]) => alias.replace(/ /g, String.raw`\s+`)).join('|');

// "open budgets", "go to the transactions page", "take me to liabilities", "show me my goals page".
const NAV_CLAUSE = new RegExp(
  String.raw`^${POLITE_PREFIX}(?:open(?:\s+up)?|go\s+to|goto|take\s+me\s+to|take\s+me(?=\s+home)|navigate\s+to|switch\s+to|bring\s+up|jump\s+to|show(?:\s+me)?)\s+${ARTICLE}(${ALIAS_GROUP})${PAGE_WORD}${POLITE_SUFFIX}$`);

// Commands whose destination is "it" / "there": resolved from the question, never guessed.
const PRONOUN_CLAUSE = new RegExp(
  String.raw`^${POLITE_PREFIX}(?:open\s+(?:it|that|them|that\s+page|those)|show\s+me(?:\s+(?:it|that|those|them|the\s+details|more\s+details|the\s+page|where))?|show\s+(?:it|that|the\s+details)|take\s+me\s+(?:there|to\s+it|to\s+that(?:\s+page)?)|go\s+there|navigate\s+there|bring\s+(?:it|that)\s+up)${POLITE_SUFFIX}$`);

const SCROLL_CLAUSE = new RegExp(
  String.raw`^${POLITE_PREFIX}(?:scroll\s+(up|down)|scroll\s+to\s+(?:the\s+)?(top|bottom)(?:\s+of\s+the\s+page)?|go\s+to\s+(?:the\s+)?(top|bottom)(?:\s+of\s+the\s+page)?)${POLITE_SUFFIX}$`);

// Topics that let a pronoun command ("open it") find its destination. Whole words only, so "remaining" is not
// "main" and "monthly" names nothing. Only consulted for pronoun commands, never to navigate on its own.
const TOPICS = [
  ['emergency-fund', /\bemergency\s+(?:fund|savings|reserve|buffer)\b/],
  ['budgets', /\bbudgets?\b/],
  ['liabilities', /\b(?:debts?|loans?|liabilit(?:y|ies)|emis?)\b/],
  ['goals', /\bgoals?\b/],
  ['transactions', /\b(?:transactions?|spend|spent|spending|expenses?|purchases?)\b/],
];

const CONNECTOR = /^(?:and\s+then|and|then|so|also)\s+/;
// A command embedded after these words is the subject of a question, not a request ("how do i open budgets").
const QUESTION_LEAD_IN = /(?:^|\s)(?:how\s+(?:do|can|should|would)\s+(?:i|we)|how\s+to|where\s+(?:do|can)\s+(?:i|we)|should\s+i|can\s+i|do\s+i|to|i|we|you|not|never|why)$/;

const normalise = (s) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim();

function aliasDestination(captured) {
  const key = captured.replace(/\s+/g, ' ');
  const hit = ALIASES.find(([alias]) => alias === key);
  return hit ? hit[1] : null;
}

// Destination named by the topic of some text, or null when there is none or more than one (ambiguous).
function topicInfo(text) {
  const n = normalise(text || '');
  const found = new Set(TOPICS.filter(([, re]) => re.test(n)).map(([dest]) => dest));
  return { dest: found.size === 1 ? [...found][0] : null, ambiguous: found.size > 1 };
}

export function topicDestination(text) {
  return topicInfo(text).dest;
}

// Classifies one clause that is already isolated: a navigation command, a pronoun command, a scroll command, or null.
function classifyCommand(clause) {
  const n = normalise(clause).replace(CONNECTOR, '');
  if (!n) return null;
  let m = SCROLL_CLAUSE.exec(n);
  if (m) return { kind: 'scroll', direction: m[1] || m[2] || m[3] };
  m = NAV_CLAUSE.exec(n);
  if (m) {
    const dest = aliasDestination(m[1]);
    if (dest) return { kind: 'nav', dest };
  }
  if (PRONOUN_CLAUSE.test(n)) return { kind: 'pronoun' };
  return null;
}

// Splits text into sentence-like segments, keeping each segment's original wording.
function segments(text) {
  return text.split(/(?<=[.?!;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

// Within one unpunctuated segment, finds a command at the end ("how is my budget open it") or at the start
// ("open goals and how am i doing"). Returns { command, rest } with `rest` in original wording, or null.
function splitCommand(segment) {
  const words = segment.split(/\s+/);
  for (let i = 1; i < words.length; i++) {           // longest trailing command first
    const head = words.slice(0, i).join(' ');
    // "how do I open budgets" asks HOW to do something; the trailing words are part of the question.
    if (QUESTION_LEAD_IN.test(normalise(head))) continue;
    const cmd = classifyCommand(words.slice(i).join(' '));
    if (cmd) return { command: cmd, rest: head.replace(/[\s,]*(?:\b(?:and then|and|then|so))?[\s,]*$/i, '') };
  }
  for (let i = words.length - 1; i >= 1; i--) {      // leading command followed by a connector and a question
    const tail = words.slice(i).join(' ');
    if (!/^(?:and|then|also)\b/i.test(tail)) continue;
    const cmd = classifyCommand(words.slice(0, i).join(' '));
    if (cmd) return { command: cmd, rest: tail.replace(/^(?:and\s+then|and|then|also)\s+/i, '') };
  }
  return null;
}

const toNavigation = (dest) => ({ ...DESTINATIONS[dest] });

/**
 * parseAssistantInput(text, { previousUserText }) ->
 *   { question: string | null,
 *     navigation: { type: 'view' | 'section' | 'scroll', target, view?, label } | null,
 *     unresolvedPronoun: boolean }
 *
 * `previousUserText` is the user's previous message in this session; it is only used to resolve "open it" /
 * "show me" when the current message names no topic of its own.
 */
export function parseAssistantInput(text, { previousUserText = '' } = {}) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return { question: null, navigation: null, unresolvedPronoun: false };

  const questionParts = [];
  let command = null;
  for (const seg of segments(raw)) {
    const whole = classifyCommand(seg);
    if (whole) { command = whole; continue; }
    const split = splitCommand(seg.replace(/[.?!;]+$/, ''));
    if (split) {
      command = split.command;
      if (split.rest) questionParts.push(split.rest);
    } else {
      questionParts.push(seg);
    }
  }
  const question = questionParts.length ? questionParts.join(' ').trim() : null;

  let navigation = null;
  let unresolvedPronoun = false;
  if (command?.kind === 'scroll') navigation = { type: 'scroll', target: command.direction, label: `Scroll ${command.direction}` };
  if (command?.kind === 'nav') navigation = toNavigation(command.dest);
  if (command?.kind === 'pronoun') {
    // A pronoun only resolves to a clear destination: the topic of this message's question, otherwise the topic
    // of the previous user message. Ambiguous or missing -> no navigation (never guess).
    const own = question ? topicInfo(question) : { dest: null, ambiguous: false };
    const dest = own.dest ?? (own.ambiguous ? null : topicDestination(previousUserText));
    if (dest) navigation = toNavigation(dest);
    else unresolvedPronoun = true;
  }

  // An unresolved "show me" is not dropped: it goes to the assistant as text so it can ask what to show.
  if (unresolvedPronoun && !question) return { question: raw, navigation: null, unresolvedPronoun };
  return { question, navigation, unresolvedPronoun };
}
