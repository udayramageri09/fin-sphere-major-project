import { useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import ProductTour from './ProductTour';

// Mounted only for the server's account-specific pending state created at registration.
// Non-modal so the real page stays visible and usable while the tour changes views.
export default function Onboarding({ onNavigate }) {
  const { setOnboardingState } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const finish = async (state, destination) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError('');
    try {
      await setOnboardingState(state);
      if (destination) onNavigate(destination);
      window.requestAnimationFrame(() => document.querySelector('main')?.focus());
    } catch (err) {
      setError(err.message || 'Could not save your tour progress. Please try again.');
      inFlight.current = false; setBusy(false);
    }
  };
  return (
    <aside role="dialog" aria-modal="false" aria-labelledby="onboarding-title"
      className="fixed bottom-3 right-3 left-3 sm:left-auto sm:w-[26rem] z-[100] max-h-[65dvh] overflow-y-auto rounded-2xl border border-zinc-300 bg-white p-4 shadow-xl"
      data-testid="onboarding">
      <h2 id="onboarding-title" className="text-lg font-semibold text-zinc-900">Welcome to FinSphere</h2>
      <p className="mt-1 text-sm text-zinc-500">Explore the app. Each step opens the page it describes.</p>
      <ProductTour busy={busy} onFinish={finish} onNavigate={onNavigate} />
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <button type="button" disabled={busy} onClick={() => finish('skipped')} data-testid="onboarding-skip"
        className="mt-3 min-h-11 rounded-xl px-3 text-sm font-medium text-zinc-600 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50">Skip tour</button>
    </aside>
  );
}
