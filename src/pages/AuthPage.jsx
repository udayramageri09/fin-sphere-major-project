import { useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

function AuthPage() {
  const { login, register, authMessage, clearAuthMessage } = useAuth();
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLocalError('');
    setIsSubmitting(true);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(email, password);
      }
    } catch (err) {
      setLocalError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleMode = () => {
    setMode(mode === 'login' ? 'register' : 'login');
    setLocalError('');
    clearAuthMessage();
  };

  const displayError = localError || authMessage;

  return (
    <div className="flex items-center justify-center min-h-screen w-full bg-zinc-50 px-4">
      <div className="w-full max-w-sm glass-panel widget-card">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 rounded-lg bg-zinc-900 flex-shrink-0" />
          <h1 className="text-xl font-bold tracking-tight-display text-zinc-900">FinSphere</h1>
        </div>

        <h2 className="widget-title">{mode === 'login' ? 'Log in' : 'Create an account'}</h2>

        {displayError && (
          <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-xl bg-zinc-100 border border-zinc-200 text-sm text-zinc-700">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0 text-zinc-500" />
            <span>{displayError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="auth-email" className="text-xs font-medium text-zinc-500">Email</label>
            <input
              id="auth-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/20"
              placeholder="you@example.com"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="auth-password" className="text-xs font-medium text-zinc-500">Password</label>
            <input
              id="auth-password"
              type="password"
              required
              minLength={mode === 'register' ? 8 : undefined}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/20"
              placeholder="********"
            />
            {mode === 'register' && (
              <span className="text-xs text-zinc-400">Must be at least 8 characters.</span>
            )}
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-zinc-900 text-white hover:bg-zinc-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isSubmitting && <Loader2 size={16} className="animate-spin" />}
            {mode === 'login' ? 'Log in' : 'Register'}
          </button>
        </form>

        <button
          type="button"
          onClick={toggleMode}
          className="mt-4 w-full text-center text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
        >
          {mode === 'login' ? "Don't have an account? Register" : 'Already have an account? Log in'}
        </button>
      </div>
    </div>
  );
}

export default AuthPage;
