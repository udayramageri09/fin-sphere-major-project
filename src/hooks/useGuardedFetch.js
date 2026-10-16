import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { guardedFetch } from '../utils/accountGuard';

// A stable guarded fetch for pages and providers (safe in effect dependency lists). It uses the account the tab is showing and asks the
// session to re-check when the server says that account is no longer the session's. (The signed-in tree is rebuilt for a different account,
// so the account captured at first render is the right one for the life of this hook; the effect keeps the re-check callback current.)
export function useGuardedFetch() {
  const { user, retryIdentityCheck } = useAuth();
  const latest = useRef({ user, recheck: retryIdentityCheck });
  useEffect(() => { latest.current = { user, recheck: retryIdentityCheck }; });
  return useCallback((url, init) => guardedFetch(url, init, latest.current), []);
}
