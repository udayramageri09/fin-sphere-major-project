import { useEffect, useRef, useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

// First-login setup guide. It only explains where to start and sends the person to Transactions: it never creates a financial record, and
// nothing is saved except the guide's own state (pending, skipped or completed), which the server keeps per account. Choosing an action or
// "Skip for now" saves that state first; if saving fails the guide stays open with the reason so nothing is lost or half done.
function Onboarding({ onNavigate }) {
  const { setOnboardingState } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef(null);
  const heading = useRef(null);
  const inFlight = useRef(false);

  useEffect(() => { heading.current?.focus(); }, []);

  const finish = async (state, destination) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      await setOnboardingState(state);
      if (destination) onNavigate(destination);
    } catch (err) {
      setError(err.message || 'Could not save that. Please try again.');
      inFlight.current = false; setBusy(false);
    }
  };

  // Keyboard: Escape means "skip for now"; Tab stays inside the dialog.
  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); finish('skipped'); return; }
    if (event.key !== 'Tab') return;
    const items = [...dialog.current.querySelectorAll('button:not(:disabled)')];
    if (items.length === 0) { event.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const action = 'flex w-full items-start gap-3 rounded-xl border border-zinc-200 bg-white p-4 text-left min-h-[3.5rem] transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-600 disabled:opacity-60';

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-zinc-900/40 p-3 sm:p-4" data-testid="onboarding-backdrop">
      <section
        ref={dialog} role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-intro" onKeyDown={onKeyDown}
        className="w-full max-w-lg max-h-[calc(100dvh-1.5rem)] overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-5 sm:p-7 shadow-xl min-w-0" data-testid="onboarding"
      >
        <h2 id="onboarding-title" ref={heading} tabIndex={-1} className="text-2xl font-bold tracking-tight text-zinc-900 outline-none">Welcome to FinSphere</h2>
        <p id="onboarding-intro" className="mt-2 text-zinc-600">FinSphere shows where your money goes, using only what you add. Nothing is added for you. Start with one of these:</p>
        <ul className="mt-5 m-0 flex list-none flex-col gap-3 p-0">
          <li>
            <button type="button" className={action} disabled={busy} onClick={() => finish('completed', 'transactions')} data-testid="onboarding-add">
              <span aria-hidden="true" className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-700"><Plus size={18} /></span>
              <span className="min-w-0"><span className="block font-semibold text-zinc-900">Add a transaction</span><span className="block text-sm text-zinc-600">Enter one by hand: the amount, the date and what it was for.</span></span>
            </button>
          </li>
          <li>
            <button type="button" className={action} disabled={busy} onClick={() => finish('completed', 'transactions')} data-testid="onboarding-import">
              <span aria-hidden="true" className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-700"><Upload size={18} /></span>
              <span className="min-w-0"><span className="block font-semibold text-zinc-900">Import a statement</span><span className="block text-sm text-zinc-600">Paste a statement or upload one instead of typing each line.</span></span>
            </button>
          </li>
        </ul>
        {error && <p role="alert" className="mt-4 text-sm text-red-700" data-testid="onboarding-error">{error}</p>}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <button type="button" disabled={busy} onClick={() => finish('skipped')} data-testid="onboarding-skip" className="min-h-11 rounded-lg px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-600 disabled:opacity-60">Skip for now</button>
          <p className="m-0 text-sm text-zinc-500">You can reopen this guide from Settings.</p>
        </div>
      </section>
    </div>
  );
}

export default Onboarding;
