import { useEffect, useRef, useState } from 'react';

const STEPS = [
  { title: 'Dashboard', view: 'dashboard', text: 'Start with your financial overview. The dashboard brings together your recorded income, spending, cash flow and recent transactions. Your profile photo appears beside your welcome message.' },
  { title: 'Transactions', view: 'transactions', text: 'Add income and expenses by hand, or import a statement. Review imported entries and possible duplicates before saving. These records are the starting point for your dashboard and analysis.' },
  { title: 'Liabilities', view: 'liabilities', text: 'Keep track of your debts and repayment commitments. Review the amounts you owe alongside your other financial priorities.' },
  { title: 'Portfolio', view: 'portfolio', text: 'Record your holdings and review the investment information you have added. Check the dates and values of your entries to keep your overview useful.' },
  { title: 'Goals', view: 'goals', text: 'Set savings targets and track your progress. Use goals to make your priorities clear and decide what to work toward next.' },
  { title: 'SIPs & Subs', view: 'subscriptions', text: 'Track recurring investment plans and subscriptions. Review these regular commitments when planning your monthly spending.' },
  { title: 'Financial Intelligence', view: 'plans', text: 'Analyse your recorded transactions to review your financial position and practical next actions. Expand supporting details when needed. Ask the visible Advisor to explain your latest results. Analysis is guidance and depends on the data you provide.' },
  { title: 'Settings', view: 'settings', text: 'Update your display name and profile photo, request a password reset link, reduce animations, or log out. On a phone, open the three-line menu and choose Settings at the bottom.' },
];
const BUTTON = 'min-h-11 rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50';

export default function ProductTour({ busy, onFinish, onNavigate }) {
  const [step, setStep] = useState(null);
  const [audio, setAudio] = useState(false);
  const [notice, setNotice] = useState('');
  const title = useRef(null);
  const speech = useRef(null);
  const generation = useRef(0);

  const stop = () => {
    generation.current++;
    if (speech.current) {
      speech.current.onend = null;
      speech.current.onerror = null;
      window.speechSynthesis?.cancel();
      speech.current = null;
    }
  };
  useEffect(() => () => {
    generation.current++;
    if (speech.current) {
      speech.current.onend = null;
      speech.current.onerror = null;
      window.speechSynthesis?.cancel();
    }
  }, []);
  useEffect(() => { if (step !== null) title.current?.focus(); }, [step]);

  const narrate = (index) => {
    stop();
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      setAudio(false);
      setNotice('Audio is unavailable in this browser. You can read every step below.');
      return;
    }
    const token = generation.current;
    const item = STEPS[index];
    const utterance = new window.SpeechSynthesisUtterance(`${item.title}. ${item.text}`);
    utterance.lang = 'en-IN';
    utterance.rate = 0.95;
    utterance.onend = () => { if (token === generation.current) speech.current = null; };
    utterance.onerror = () => {
      if (token !== generation.current) return;
      speech.current = null;
      setAudio(false);
      setNotice('Audio could not play. Read this step or try Listen to this step again.');
    };
    speech.current = utterance;
    try { window.speechSynthesis.speak(utterance); }
    catch { utterance.onerror(); }
  };
  const move = (index, withAudio = audio) => {
    stop();
    onNavigate?.(STEPS[index].view);
    setStep(index);
    setNotice('');
    if (withAudio) narrate(index);
  };
  const start = (withAudio) => { setAudio(withAudio); move(0, withAudio); };
  const finish = (destination) => { stop(); setAudio(false); onFinish('completed', destination); };

  return (
    <div className="mt-5 rounded-xl border border-zinc-200 bg-zinc-50 p-4" data-testid="product-tour">
      {step === null ? (
        <>
          <p className="text-sm text-zinc-600 mb-3">New here? Explore all eight features with a short tour.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON} disabled={busy} onClick={() => start(false)}>Start feature tour</button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => start(true)}>Start audio tour</button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs font-medium text-zinc-500" data-testid="tour-progress">Step {step + 1} of {STEPS.length}</p>
          <h3 ref={title} tabIndex={-1} className="mt-2 text-lg font-semibold text-zinc-900 focus-visible:outline-none" data-testid="tour-title">{STEPS[step].title}</h3>
          <p className="mt-2 text-sm leading-6 text-zinc-600" data-testid="tour-transcript">{STEPS[step].text}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={BUTTON} disabled={busy} onClick={() => { setAudio(true); setNotice(''); narrate(step); }}>Listen to this step</button>
            {audio && <button type="button" className={BUTTON} disabled={busy} onClick={() => { stop(); setAudio(false); }}>Turn audio off</button>}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={BUTTON} disabled={busy || step === 0} onClick={() => move(step - 1)}>Back</button>
            {step < STEPS.length - 1 ? (
              <button type="button" className={BUTTON} disabled={busy} onClick={() => move(step + 1)}>Next</button>
            ) : (
              <button type="button" className={BUTTON} disabled={busy} onClick={() => finish('dashboard')}>Finish tour</button>
            )}
          </div>
        </>
      )}
      {notice && <p role="status" className="mt-3 text-sm text-zinc-600">{notice}</p>}
    </div>
  );
}
