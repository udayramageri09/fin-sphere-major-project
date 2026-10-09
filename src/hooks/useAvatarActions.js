/**
 * useAvatarActions - performs an explicit navigation request for the assistant (Issue #69).
 *
 * Deciding WHETHER a message asks for navigation is not done here: src/utils/assistantIntent.js parses the text and
 * only returns a navigation descriptor for explicit action language ("open budgets", "go to transactions"). This hook
 * just carries a descriptor out: switch page, scroll to a section, or scroll the window.
 */
import { useFinance } from '../context/FinanceContext';

const HIGHLIGHT_CLASS = 'avatar-target-highlight';

function scrollToTarget(target, attempt = 0) {
  const el = document.querySelector(`[data-avatar-target="${target}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add(HIGHLIGHT_CLASS);
    setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), 2000);
    return;
  }
  // The page may still be rendering right after a view switch.
  if (attempt < 10) setTimeout(() => scrollToTarget(target, attempt + 1), 100);
}

export function useAvatarActions() {
  const { setCurrentView, currentView } = useFinance();

  // navigation: { type: 'view' | 'section' | 'scroll', target, view? } from parseAssistantInput. Returns true if done.
  function performNavigation(navigation) {
    if (!navigation) return false;
    if (navigation.type === 'scroll') {
      if (navigation.target === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
      else if (navigation.target === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      else window.scrollBy({ top: navigation.target === 'up' ? -400 : 400, behavior: 'smooth' });
      return true;
    }
    if (navigation.type === 'view') {
      setCurrentView(navigation.view);
      window.scrollTo({ top: 0 });
      return true;
    }
    if (navigation.type === 'section') {
      if (currentView !== navigation.view) setCurrentView(navigation.view);
      scrollToTarget(navigation.target);
      return true;
    }
    return false;
  }

  return { performNavigation };
}
