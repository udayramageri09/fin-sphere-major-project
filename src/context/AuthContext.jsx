/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { accountHeaders, guardedFetch, refuseIfAccountChanged } from '../utils/accountGuard';

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api';

// Tabs of one browser share the session cookie, so one tab can sign out or switch accounts under another. Every sign-in, sign-out and
// session loss writes a fresh random marker here; other tabs hear it through the `storage` event and ask the server who the session
// belongs to. The marker carries no identity, credential or financial data: it only says "something changed, check".
export const SESSION_EPOCH_KEY = 'finsphere:session-epoch';
// A second marker for changes to the SAME account's profile (display name, setup-guide state): other tabs refresh quietly, with no mask.
export const PROFILE_EPOCH_KEY = 'finsphere:profile-epoch';
const COULD_NOT_CHECK = 'Could not check your session. Your data stays hidden until it can be confirmed.';
const SIGNED_OUT_ELSEWHERE = 'You were signed out in another tab. Please log in again.';
const newMarker = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const readMarker = () => { try { return window.localStorage.getItem(SESSION_EPOCH_KEY); } catch { return undefined; } };   // undefined = storage unusable
const writeMarker = (key = SESSION_EPOCH_KEY) => { try { const value = newMarker(); window.localStorage.setItem(key, value); return value; } catch { return undefined; } };
const sameProfile = (a, b) => Object.keys({ ...a, ...b }).every((key) => a?.[key] === b?.[key]);

export async function passwordRecovery(endpoint, body) {
  const res = await fetch(`${API_URL}/auth/${endpoint}`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Password recovery failed');
  return data.message;
}

export const AuthProvider = ({ children }) => {
  // 'checking' | 'authenticated' | 'unauthenticated'
  const [status, setStatus] = useState('checking');
  const [user, setUser] = useState(null);
  const [authMessage, setAuthMessage] = useState('');
  // While another tab may have changed the account, nothing of the previous account is shown (identityMasked) until the server says whose
  // session this is. identityError is set when that cannot be found out.
  const [identityMasked, setIdentityMasked] = useState(false);
  const [identityError, setIdentityError] = useState('');
  const statusRef = useRef('checking');
  const knownMarker = useRef(readMarker());
  const checkSeq = useRef(0);
  const lastCheckAt = useRef(0);
  const maskedRef = useRef(false);
  const recheckRef = useRef(() => {});   // asks the server whose session this is (set once checkIdentity exists)
  useEffect(() => { statusRef.current = status; });
  useEffect(() => { maskedRef.current = identityMasked; });
  // The signed-in user's photo as a local blob URL, fetched with the session cookie. It is tied to the user id AND the photo version it
  // was fetched for, so a previous account's photo (or an older version) is never shown for the current one while a fetch is pending.
  const [avatar, setAvatar] = useState({ key: null, url: null });
  const avatarKey = user?.id != null && user?.avatarVersion != null ? `${user.id}:${user.avatarVersion}` : null;
  const avatarUrl = avatarKey && avatar.key === avatarKey ? avatar.url : null;

  useEffect(() => {
    if (!avatarKey) return undefined;
    let cancelled = false;
    let objectUrl = null;
    (async () => {
      try {
        // Names the account this photo is for; if the session now belongs to someone else the server refuses and their photo is never fetched.
        const res = await guardedFetch(`${API_URL}/auth/avatar`, { credentials: 'include', cache: 'no-store' }, { user: { id: avatarKey.split(':')[0] }, recheck: () => recheckRef.current() });
        if (!res.ok) return;
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setAvatar({ key: avatarKey, url: objectUrl });
      } catch {
        // No photo is shown; initials or the person icon stay in place.
      }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [avatarKey]);

  useEffect(() => {
    const verifySession = async () => {
      try {
        const res = await fetch(`${API_URL}/auth/verify`, { credentials: 'include' });
        if (!res.ok) {
          setStatus('unauthenticated');
          return;
        }
        const data = await res.json();
        setUser(data.user);
        setStatus('authenticated');
        knownMarker.current = readMarker();
        lastCheckAt.current = Date.now();
      } catch {
        // Network/server error on startup - treat as unauthenticated, not a crash.
        setStatus('unauthenticated');
      }
    };
    verifySession();
  }, []);

  // Asks the server whose session this tab holds and applies the answer. Only the newest check may change anything, so an older answer
  // can never overwrite a newer one. mask: hide the signed-in screen until the answer arrives.
  const checkIdentity = useCallback(async ({ mask }) => {
    const seq = ++checkSeq.current;
    if (mask) { setIdentityMasked(true); setIdentityError(''); }
    const failed = () => { if (maskedRef.current || mask) setIdentityError(COULD_NOT_CHECK); };
    let res;
    try {
      res = await fetch(`${API_URL}/auth/verify`, { credentials: 'include', cache: 'no-store' });
    } catch {
      if (seq === checkSeq.current) failed();
      return;
    }
    if (seq !== checkSeq.current) return;
    if (res.status === 401) {
      if (statusRef.current === 'authenticated') {
        setUser(null);
        setAuthMessage(SIGNED_OUT_ELSEWHERE);
        setStatus('unauthenticated');
      }
    } else if (!res.ok) {
      failed();
      return;
    } else {
      let data;
      try { data = await res.json(); } catch { if (seq === checkSeq.current) failed(); return; }
      if (seq !== checkSeq.current) return;
      // The same account keeps its screen; a different account gets a new one (App keys the signed-in tree by user id).
      setUser((previous) => (previous && sameProfile(previous, data.user) ? previous : data.user));
      setAuthMessage('');
      setStatus('authenticated');
    }
    setIdentityMasked(false);
    setIdentityError('');
    knownMarker.current = readMarker();
    lastCheckAt.current = Date.now();
  }, []);
  useEffect(() => { recheckRef.current = () => checkIdentity({ mask: true }); }, [checkIdentity]);

  useEffect(() => {
    const stale =() => { const marker = readMarker(); return marker === undefined || marker !== knownMarker.current; };
    const onStorage = (event) => {
      if (statusRef.current === 'checking') return;
      if (event.key === PROFILE_EPOCH_KEY) { if (statusRef.current === 'authenticated') checkIdentity({ mask: false }); return; }
      if (event.key !== null && event.key !== SESSION_EPOCH_KEY) return;
      checkIdentity({ mask: statusRef.current === 'authenticated' });
    };
    // Backup for a missed signal: when the tab is shown again, re-check if the marker moved (behind the mask) or if it has been a while.
    const onReturn = () => {
      if (document.visibilityState === 'hidden' || statusRef.current === 'checking') return;
      const changed = stale();
      if (!changed && Date.now() - lastCheckAt.current < 30000) return;
      checkIdentity({ mask: changed && statusRef.current === 'authenticated' });
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onReturn);
    window.addEventListener('online', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('online', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [checkIdentity]);

  const announceChange = () => { const marker = writeMarker(); if (marker !== undefined) knownMarker.current = marker; };

  const login = async (email, password) => {
    setAuthMessage('');
    const res = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      setAuthMessage(data.error || 'Login failed');
      throw new Error(data.error || 'Login failed');
    }
    setUser(data.user);
    setStatus('authenticated');
    setIdentityMasked(false);
    setIdentityError('');
    announceChange();
    lastCheckAt.current = Date.now();
    return data.user;
  };

  const register = async (email, password) => {
    setAuthMessage('');
    const res = await fetch(`${API_URL}/auth/register`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      setAuthMessage(data.error || 'Registration failed');
      throw new Error(data.error || 'Registration failed');
    }
    // Registration does not issue a session cookie - log in immediately after.
    await login(email, password);
  };

  // One request to a profile endpoint. A 401 ends the session (the user returns to the login page); other failures become a message
  // that can be shown as is. Nothing about the profile or the photo is logged.
  const profileRequest = async (path, init) => {
    let res;
    try {
      res = await fetch(API_URL + path, { credentials: 'include', ...init, headers: { ...accountHeaders(user), ...(init?.headers ?? {}) } });
    } catch {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
    let data = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    await refuseIfAccountChanged(res, () => checkIdentity({ mask: true }));
    if (res.status === 401) {
      invalidateSession();
      throw new Error('Your session expired. Please log in again.');
    }
    if (!res.ok) throw new Error(data.error || 'Could not save your changes. Please try again.');
    setUser(data.user);
    writeMarker(PROFILE_EPOCH_KEY);
    return data.user;
  };

  // patch: { displayName?: string, reduceMotion?: boolean }. Resolves the saved public profile.
  const updateProfile = (patch) => profileRequest('/auth/profile', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
  });
  // blob: the already-prepared (square, small, WebP/JPEG) image from prepareAvatarImage().
  const uploadAvatar = (blob) => {
    const form = new FormData();
    form.append('avatar', blob, 'avatar');
    return profileRequest('/auth/avatar', { method: 'PUT', body: form });
  };
  const removeAvatar = () => profileRequest('/auth/avatar', { method: 'DELETE' });
  // state: 'pending' | 'skipped' | 'completed'. The server keeps it per account; it never creates financial records.
  const setOnboardingState = (state) => updateProfile({ onboardingState: state });

  const logout = async () => {
    try {
      await fetch(`${API_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch {
      // Even if the request fails, drop the local session so the UI doesn't
      // strand the user in an authenticated state against a dead session.
    } finally {
      setUser(null);
      setAuthMessage('');
      setStatus('unauthenticated');
      setIdentityMasked(false);
      setIdentityError('');
      announceChange();
    }
  };

  // Called by other contexts (e.g. FinanceContext) when a request returns 401
  // mid-session, so an expired/invalid cookie sends the user back to AuthPage.
  const invalidateSession = () => {
    setUser(null);
    setAuthMessage('Your session expired. Please log in again.');
    setStatus('unauthenticated');
    setIdentityMasked(false);
    setIdentityError('');
    announceChange();
  };

  // Lets callers (e.g. AuthPage on a mode switch) discard a stale message
  // without reaching into the raw state setter.
  const clearAuthMessage = () => setAuthMessage('');

  return (
    <AuthContext.Provider value={{
      status,
      user,
      authMessage,
      login,
      register,
      updateProfile,
      uploadAvatar,
      removeAvatar,
      setOnboardingState,
      avatarUrl,
      logout,
      invalidateSession,
      identityMasked,
      identityError,
      retryIdentityCheck: () => checkIdentity({ mask: true }),
      clearAuthMessage
    }}>
      {children}
    </AuthContext.Provider>
  );
};
