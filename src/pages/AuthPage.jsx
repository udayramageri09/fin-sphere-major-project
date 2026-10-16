import { useState } from 'react';
import BrandMark from '../components/BrandMark';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useAuth, passwordRecovery } from '../context/AuthContext';

function AuthPage({ resetToken = null }) {
  const { login, register, authMessage, clearAuthMessage } = useAuth();
  const [mode, setMode] = useState(resetToken !== null ? 'reset' : 'login');
  const [message, setMessage] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLocalError('');
    setMessage('');
    setIsSubmitting(true);
    try {
      if (mode === 'forgot') {
        setMessage(await passwordRecovery('forgot-password', { email }));
      } else if (mode === 'reset') {
        if (password !== confirmation) throw new Error('Passwords do not match');
        setMessage(await passwordRecovery('reset-password', { token: resetToken, password }));
        setPassword('');
        setConfirmation('');
        setMode('login');
        // Reset revokes this browser's old cookie too; refresh after the user reads success.
      } else if (mode === 'login') {
        await login(email, password);
        if (resetToken !== null) window.location.reload();
      } else {
        await register(email, password);
        if (resetToken !== null) window.location.reload();
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
    setMessage('');
    setPassword('');
    setConfirmation('');
    clearAuthMessage();
  };

  const displayError = localError || authMessage;

  return (
    <div className="flex items-center justify-center min-h-screen w-full bg-zinc-50 px-4">
      <div className="w-full max-w-sm glass-panel widget-card">
        <div className="flex items-center gap-3 mb-6">
          <BrandMark />
          <h1 className="text-xl font-bold tracking-tight-display text-zinc-900">FinSphere</h1>
        </div>

        <h2 className="widget-title">{({ login: 'Log in', register: 'Create an account', forgot: 'Forgot password', reset: 'Reset password' })[mode]}</h2>
        {message && <p role="status" className="mb-4 text-sm text-zinc-700">{message}</p>}

        {displayError && (
          <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-xl bg-zinc-100 border border-zinc-200 text-sm text-zinc-700">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0 text-zinc-500" />
            <span>{displayError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {mode !== 'reset' && <div className="flex flex-col gap-1">
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
          </div>}

          {mode !== 'forgot' && <div className="flex flex-col gap-1">
            <label htmlFor="auth-password" className="text-xs font-medium text-zinc-500">Password</label>
            <input
              id="auth-password"
              type="password"
              required
              minLength={mode === 'register' || mode === 'reset' ? 8 : undefined}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/20"
              placeholder="********"
            />
            {mode === 'register' && (
              <span className="text-xs text-zinc-400">Must be at least 8 characters.</span>
            )}
          </div>}
          {mode === 'reset' && <div className="flex flex-col gap-1">
            <label htmlFor="auth-confirm-password" className="text-xs font-medium text-zinc-500">Confirm new password</label>
            <input id="auth-confirm-password" type="password" required autoComplete="new-password" value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm" />
            <span className="text-xs text-zinc-400">At least 8 characters; maximum 72 UTF-8 bytes.</span>
          </div>}

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-zinc-900 text-white hover:bg-zinc-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isSubmitting && <Loader2 size={16} className="animate-spin" />}
            {({ login: 'Log in', register: 'Register', forgot: 'Send reset link', reset: 'Reset password' })[mode]}
          </button>
        </form>
        {mode === 'login' && <button type="button" disabled={isSubmitting} onClick={() => { setMode('forgot'); setLocalError(''); setMessage(''); setPassword(''); clearAuthMessage(); }}
          className="mt-4 w-full text-center text-sm text-zinc-500 hover:text-zinc-900">Forgot password?</button>}

        <button
          type="button"
          disabled={isSubmitting}
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
