import { useSyncExternalStore } from 'react';
import { useAuth } from '../context/AuthContext';

const QUERY = '(prefers-reduced-motion: reduce)';
const media = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null);

function subscribe(onChange) {
  const m = media();
  if (!m) return () => {};
  m.addEventListener?.('change', onChange);
  return () => m.removeEventListener?.('change', onChange);
}

// The device's reduced-motion setting, kept live.
export const usePrefersReducedMotion = () => useSyncExternalStore(subscribe, () => Boolean(media()?.matches), () => false);

// true when motion should be minimised: the operating system asks for it OR the signed-in user turned on
// "Reduce dashboard animations" in Settings. The operating-system setting is always honoured.
export function useReduceMotion() {
  const { user } = useAuth();
  const system = usePrefersReducedMotion();
  return system || Boolean(user?.reduceMotion);
}
