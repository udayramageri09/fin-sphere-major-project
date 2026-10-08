import { useState } from 'react';
import { AlertCircle, Pencil, ShieldCheck, X } from 'lucide-react';
import { useFinance } from '../context/FinanceContext';

// Whole rupees print without decimals; anything with paise prints both digits.
const formatCurrency = (value) => {
  const fractionDigits = Number.isInteger(value) ? 0 : 2;
  return value.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
};

const inputClass =
  'w-full px-3 py-2 rounded-xl border border-zinc-200 bg-white text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/20';
const labelClass = 'text-xs font-medium text-zinc-500';

// Form text for a saved fund; numbers are shown as the server stored them.
const toForm = (fund) => ({
  currentAmount: fund?.configured ? String(fund.currentAmount) : '',
  targetAmount: fund?.configured && fund.targetAmount !== null ? String(fund.targetAmount) : '',
});

function EmergencyFund() {
  const { emergencyFund, emergencyFundLoading, emergencyFundError, fetchEmergencyFund, saveEmergencyFund } = useFinance();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ currentAmount: '', targetAmount: '' });
  const [formError, setFormError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const openForm = () => {
    setForm(toForm(emergencyFund));
    setFormError('');
    setEditing(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');
    setIsSubmitting(true);
    try {
      await saveEmergencyFund({
        // An empty box is "missing" (the server rejects it), never a made-up 0.
        currentAmount: form.currentAmount === '' ? null : Number(form.currentAmount),
        // The target is optional: an empty box means "no target".
        targetAmount: form.targetAmount === '' ? null : Number(form.targetAmount),
      });
      setEditing(false);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const errorBox = (message) => (
    <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-xl bg-zinc-100 border border-zinc-200 text-sm text-zinc-700">
      <AlertCircle size={16} className="mt-0.5 shrink-0 text-zinc-500" />
      <span className="min-w-0 wrap-break-word">{message}</span>
    </div>
  );

  const configured = emergencyFund?.configured === true;
  const hasTarget = configured && emergencyFund.targetAmount !== null && emergencyFund.targetAmount > 0;
  // Progress toward the target the user chose; it can pass 100%.
  const percent = hasTarget ? Math.round((emergencyFund.currentAmount / emergencyFund.targetAmount) * 100) : null;

  return (
    <section className="glass-panel p-6 flex flex-col gap-4" aria-labelledby="emergency-fund-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="emergency-fund-heading" className="flex items-center gap-2 text-lg font-semibold text-zinc-900">
          <ShieldCheck size={20} className="text-zinc-700" /> Emergency fund
        </h3>
        {!editing && !emergencyFundLoading && !emergencyFundError && emergencyFund && (
          <button
            type="button"
            onClick={openForm}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-medium text-zinc-700 border border-zinc-200 bg-white hover:bg-zinc-100"
          >
            {configured ? <Pencil size={14} /> : null}
            {configured ? 'Edit' : 'Set up emergency fund'}
          </button>
        )}
      </div>

      {editing ? (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="ef-current" className={labelClass}>Currently saved (₹)</label>
              <input
                id="ef-current"
                type="number"
                required
                min="0"
                step="0.01"
                value={form.currentAmount}
                onChange={updateField('currentAmount')}
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="ef-target" className={labelClass}>Target (₹, optional)</label>
              <input
                id="ef-target"
                type="number"
                min="0.01"
                step="0.01"
                value={form.targetAmount}
                onChange={updateField('targetAmount')}
                className={inputClass}
              />
            </div>
          </div>
          {formError && errorBox(formError)}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl text-sm font-medium bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="inline-flex items-center gap-1 px-4 py-2 rounded-xl text-sm font-medium text-zinc-700 border border-zinc-200 bg-white hover:bg-zinc-100"
            >
              <X size={14} /> Cancel
            </button>
          </div>
        </form>
      ) : emergencyFundLoading && !emergencyFund ? (
        <p className="text-sm text-zinc-500">Loading emergency fund...</p>
      ) : emergencyFundError && !emergencyFund ? (
        <div className="flex flex-col items-start gap-3">
          {errorBox(emergencyFundError)}
          <button
            type="button"
            onClick={fetchEmergencyFund}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-zinc-700 border border-zinc-200 bg-white hover:bg-zinc-100"
          >
            Try again
          </button>
        </div>
      ) : !configured ? (
        <p className="text-sm text-zinc-500">
          No emergency fund set up yet. Enter what you have saved so far to see how many months of expenses it covers in your health analysis.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex justify-between gap-3 flex-wrap">
            <span className="text-zinc-500">Saved</span>
            <strong className="text-lg text-zinc-900 wrap-break-word min-w-0">{formatCurrency(emergencyFund.currentAmount)}</strong>
          </div>
          {hasTarget ? (
            <>
              <div className="flex justify-between gap-3 flex-wrap">
                <span className="text-zinc-500">Target</span>
                <strong className="text-zinc-900 wrap-break-word min-w-0">{formatCurrency(emergencyFund.targetAmount)}</strong>
              </div>
              <div
                role="progressbar"
                aria-label="Emergency fund progress toward target"
                aria-valuemin={0}
                aria-valuenow={Math.min(percent, 100)}
                aria-valuemax={100}
                className="h-2 rounded-full bg-zinc-100 overflow-hidden"
              >
                <div className="h-full bg-zinc-900" style={{ width: `${Math.min(percent, 100)}%` }} />
              </div>
              <span className="text-sm text-zinc-500">{percent}% of target</span>
            </>
          ) : (
            <span className="text-sm text-zinc-500">No target set.</span>
          )}
        </div>
      )}
    </section>
  );
}

export default EmergencyFund;
