/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api';

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
      } catch {
        // Network/server error on startup - treat as unauthenticated, not a crash.
        setStatus('unauthenticated');
      }
    };
    verifySession();
  }, []);

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
    }
  };

  // Called by other contexts (e.g. FinanceContext) when a request returns 401
  // mid-session, so an expired/invalid cookie sends the user back to AuthPage.
  const invalidateSession = () => {
    setUser(null);
    setAuthMessage('Your session expired. Please log in again.');
    setStatus('unauthenticated');
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
      logout,
      invalidateSession,
      clearAuthMessage
    }}>
      {children}
    </AuthContext.Provider>
  );
};
