/**
 * useAvatarActions — Parses natural language commands and dispatches
 * autonomous actions for the AI avatar to perform.
 */
import { useFinance } from '../context/FinanceContext';

// Navigation destinations
const NAV_COMMANDS = [
  { patterns: ['dashboard', 'home', 'overview', 'main'], view: 'dashboard', label: 'Dashboard', message: "Here's your Dashboard! 🏠" },
  { patterns: ['transaction', 'transactions', 'payment', 'payments', 'spending', 'expense'], view: 'transactions', label: 'Transactions', message: "Let me show you your Transactions! 💳" },
  { patterns: ['liabilit', 'loan', 'debt', 'emi', 'borrow'], view: 'liabilities', label: 'Liabilities', message: "Here are your Liabilities! 🏦" },
  { patterns: ['portfolio', 'invest', 'stock', 'mutual fund', 'shares', 'equity'], view: 'portfolio', label: 'Portfolio', message: "Here's your Portfolio! 📈" },
  { patterns: ['goal', 'goals', 'target', 'saving'], view: 'goals', label: 'Goals', message: "Let me show you your Goals! 🎯" },
  { patterns: ['subscription', 'sip', 'sips', 'sub', 'recurring', 'monthly'], view: 'subscriptions', label: 'SIPs & Subscriptions', message: "Here are your SIPs & Subscriptions! 📅" },
  { patterns: ['plan', 'plans', 'ml', 'analysis', 'forecast', 'anomaly', 'intelligence'], view: 'plans', label: 'ML Plans', message: "Opening your ML Financial Intelligence page! 🧠" },
];

// On-page scroll targets (only valid on dashboard)
const SCROLL_TARGETS = [
  { patterns: ['credit score', 'cibil', 'credit rating', 'score'], selector: '[data-avatar-target="credit-score"]', label: 'Credit Score', message: "Here's your Credit Score widget! ⭐" },
  { patterns: ['cash flow', 'chart', 'cashflow', 'income chart', 'expense chart'], selector: '[data-avatar-target="cash-flow"]', label: 'Cash Flow Chart', message: "Here's your Cash Flow chart! 📊" },
  { patterns: ['goal tracker', 'goal progress', 'track goal'], selector: '[data-avatar-target="goal-tracker"]', label: 'Goal Tracker', message: "Here's your Goal Tracker! 🎯" },
  { patterns: ['financial summary', 'net worth', 'total income', 'total expense', 'summary'], selector: '[data-avatar-target="financial-summary"]', label: 'Financial Summary', message: "Here's your Financial Summary! 💰" },
  { patterns: ['recent transaction', 'latest transaction', 'recent payment'], selector: '[data-avatar-target="recent-transactions"]', label: 'Recent Transactions', message: "Here are your recent transactions! 📋" },
  { patterns: ['alert', 'low balance', 'warning'], selector: '[data-avatar-target="balance-alert"]', label: 'Balance Alert', message: "Watch out — there's a balance alert! 🚨" },
];

// Scroll direction commands
const SCROLL_COMMANDS = [
  { patterns: ['scroll down', 'go down', 'move down'], direction: 'down', amount: 400 },
  { patterns: ['scroll up', 'go up', 'move up'], direction: 'up', amount: 400 },
  { patterns: ['scroll to bottom', 'go to bottom', 'bottom of page'], direction: 'bottom' },
  { patterns: ['scroll to top', 'go to top', 'top of page'], direction: 'top' },
];

function matchPatterns(text, patterns) {
  const lower = text.toLowerCase();
  return patterns.some(p => lower.includes(p.toLowerCase()));
}

export function useAvatarActions() {
  const { setCurrentView, currentView } = useFinance();

  /**
   * Parses the command text and returns an action descriptor, or null if
   * the command should be forwarded to the AI backend.
   */
  function parseCommand(text) {
    if (!text || !text.trim()) return null;
    const lower = text.toLowerCase().trim();

    // 1. Scroll direction commands
    for (const cmd of SCROLL_COMMANDS) {
      if (matchPatterns(lower, cmd.patterns)) {
        return { type: 'scroll', direction: cmd.direction, amount: cmd.amount };
      }
    }

    // 2. On-page element targets
    for (const target of SCROLL_TARGETS) {
      if (matchPatterns(lower, target.patterns)) {
        return {
          type: 'scroll-to-element',
          selector: target.selector,
          label: target.label,
          message: target.message,
          requiresView: 'dashboard',
        };
      }
    }

    // 3. Navigation commands
    for (const nav of NAV_COMMANDS) {
      if (matchPatterns(lower, nav.patterns)) {
        return {
          type: 'navigate',
          view: nav.view,
          label: nav.label,
          message: nav.message,
        };
      }
    }

    return null;
  }

  /**
   * Executes a parsed action. Returns true if handled, false to fall through to AI.
   */
  function executeCommand(text) {
    const action = parseCommand(text);
    if (!action) return false;

    if (action.type === 'scroll') {
      if (action.direction === 'top') window.scrollTo(0, 0);
      else if (action.direction === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
      else if (action.direction === 'down') window.scrollBy(0, action.amount);
      else if (action.direction === 'up') window.scrollBy(0, -action.amount);
      window.dispatchEvent(new CustomEvent('bot-speak', {
        detail: { message: action.direction === 'down' ? "Scrolling down! 👇" : "Scrolling up! 👆" }
      }));
      return true;
    }

    if (action.type === 'navigate') {
      setCurrentView(action.view);
      setTimeout(() => {
        const navBtn = document.querySelector(`[data-avatar-target="nav-${action.view}"]`);
        const rect = navBtn ? navBtn.getBoundingClientRect() : null;
        window.dispatchEvent(new CustomEvent('bot-walk-to', {
          detail: {
            x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
            y: rect ? rect.top + rect.height / 2 : window.innerHeight / 2,
            selector: `[data-avatar-target="nav-${action.view}"]`,
            message: action.message,
            label: `Going to ${action.label}…`,
          }
        }));
      }, 100);
      return true;
    }

    if (action.type === 'scroll-to-element') {
      const needsNav = action.requiresView && currentView !== action.requiresView;
      if (needsNav) {
        setCurrentView(action.requiresView);
      }

      setTimeout(() => {
        const el = document.querySelector(action.selector);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => {
            const updatedRect = el.getBoundingClientRect();
            window.dispatchEvent(new CustomEvent('bot-walk-to', {
              detail: {
                x: updatedRect.left + updatedRect.width / 2,
                y: updatedRect.top + updatedRect.height / 2,
                selector: action.selector,
                message: action.message,
                label: `Walking to ${action.label}…`,
              }
            }));
          }, 400);
        } else {
          window.dispatchEvent(new CustomEvent('bot-speak', {
            detail: { message: `I couldn't find the ${action.label} section! 🤔` }
          }));
        }
      }, needsNav ? 500 : 100);

      return true;
    }

    return false;
  }

  return { executeCommand, parseCommand };
}
