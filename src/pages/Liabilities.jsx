import { useState } from 'react';
import { Home, Car, CreditCard, GraduationCap, Wallet, Landmark, Plus, X, Trash2, AlertCircle } from 'lucide-react';
import { useFinance } from '../context/FinanceContext';
import AccountAggregatorSandbox from '../components/AccountAggregatorSandbox';

// Same set the server accepts; the server is the validation authority.
const LIABILITY_TYPES = [
  { value: 'home_loan', label: 'Home loan', icon: Home },
  { value: 'personal_loan', label: 'Personal loan', icon: Wallet },
  { value: 'vehicle_loan', label: 'Vehicle loan', icon: Car },
  { value: 'education_loan', label: 'Education loan', icon: GraduationCap },
  { value: 'credit_card', label: 'Credit card', icon: CreditCard },
  { value: 'other', label: 'Other', icon: Landmark },
];
const typeInfo = (value) => LIABILITY_TYPES.find((t) => t.value === value) ?? { label: value, icon: Landmark };

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

// An empty box must reach the server as "missing" (null), never as a made-up 0.
const toNumberOrNull = (text) => (text === '' ? null : Number(text));

const inputClass =
  'w-full px-3 py-2 rounded-xl border border-zinc-200 bg-white text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/20';
const labelClass = 'text-xs font-medium text-zinc-500';

const EMPTY_FORM = { name: '', type: '', outstandingAmount: '', interestRate: '', monthlyPayment: '' };

function Liabilities() {
  const { liabilities, liabilitiesLoading, liabilitiesError, fetchLiabilities, addLiability, deleteLiability, addLiabilityRepayment, accountAggregatorRequest } = useFinance();
  const [showForm, setShowForm] = useState(false);
  const [showSandbox, setShowSandbox] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [deletingId, setDeletingId] = useState(null);
  // Only one liability has its repayment form open at a time.
  const [repayingId, setRepayingId] = useState(null);
  const [repaymentAmount, setRepaymentAmount] = useState('');
  const [repaymentError, setRepaymentError] = useState('');
  const [isRepaying, setIsRepaying] = useState(false);

  const updateField = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const toggleForm = () => {
    setShowForm((open) => !open);
    setFormError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');
    setIsSubmitting(true);
    try {
      await addLiability({
        name: form.name,
        type: form.type,
        outstandingAmount: toNumberOrNull(form.outstandingAmount),
        interestRate: toNumberOrNull(form.interestRate),
        monthlyPayment: toNumberOrNull(form.monthlyPayment),
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const openRepayment = (id) => {
    setRepayingId(id);
    setRepaymentAmount('');
    setRepaymentError('');
  };

  // The server is the authority (positive amount, never more than the outstanding balance); its message is shown as-is.
  const handleRepay = async (e, liabilityId) => {
    e.preventDefault();
    setRepaymentError('');
    setIsRepaying(true);
    try {
      await addLiabilityRepayment(liabilityId, toNumberOrNull(repaymentAmount));
      setRepayingId(null);
      setRepaymentAmount('');
    } catch (err) {
      setRepaymentError(err.message);
    } finally {
      setIsRepaying(false);
    }
  };

  const handleDelete = async (id) => {
    setActionError('');
    setDeletingId(id);
    try {
      await deleteLiability(id);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const errorBox = (message) => (
    <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-xl bg-zinc-100 border border-zinc-200 text-sm text-zinc-700">
      <AlertCircle size={16} className="mt-0.5 shrink-0 text-zinc-500" />
      <span className="min-w-0 wrap-break-word">{message}</span>
    </div>
  );

  return (
    <div className="animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-8">
        <h2 style={{ fontSize: '2rem' }}>Active Liabilities</h2>
        {import.meta.env.DEV && accountAggregatorRequest && !showForm && (
          <button type="button" className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium" aria-expanded={showSandbox} onClick={() => setShowSandbox(open => !open)}>Add loan from sandbox</button>
        )}
        <button
          type="button"
          onClick={toggleForm}
          aria-expanded={showForm}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-zinc-900 text-white hover:bg-zinc-800"
        >
          {showForm ? <X size={16} /> : <Plus size={16} />}
          {showForm ? 'Cancel' : 'Add liability'}
        </button>
      </div>

      {import.meta.env.DEV && accountAggregatorRequest && showSandbox && !showForm && (
        <div className="glass-panel mb-8 max-w-2xl p-6">
          <AccountAggregatorSandbox request={accountAggregatorRequest} selection="loans" onSelect={record => {
            setForm({ name: `[Sandbox] ${record.name}`, type: 'education_loan', outstandingAmount: String(record.amount), interestRate: '8.5', monthlyPayment: '3500' });
            setFormError('');
            setShowSandbox(false);
            setShowForm(true);
          }} />
        </div>
      )}
      {showForm && (
        <form onSubmit={handleSubmit} className="glass-panel p-6 mb-8 max-w-2xl flex flex-col gap-4">
          {form.name.startsWith('[Sandbox] ') && <p className="text-sm text-zinc-600">Fictional loan. The rate and payment are demo values. Review them before saving.</p>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="liability-name" className={labelClass}>Name</label>
              <input
                id="liability-name"
                type="text"
                required
                maxLength={120}
                value={form.name}
                onChange={updateField('name')}
                placeholder="Name this liability"
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="liability-type" className={labelClass}>Type</label>
              <select
                id="liability-type"
                required
                value={form.type}
                onChange={updateField('type')}
                className={inputClass}
              >
                <option value="">Select a type</option>
                {LIABILITY_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="liability-outstanding" className={labelClass}>Outstanding amount (₹)</label>
              <input
                id="liability-outstanding"
                type="number"
                required
                min="0.01"
                step="0.01"
                value={form.outstandingAmount}
                onChange={updateField('outstandingAmount')}
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="liability-rate" className={labelClass}>Interest rate (% per year)</label>
              <input
                id="liability-rate"
                type="number"
                required
                min="0"
                max="100"
                step="any"
                value={form.interestRate}
                onChange={updateField('interestRate')}
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="liability-payment" className={labelClass}>Monthly payment (₹)</label>
              <input
                id="liability-payment"
                type="number"
                required
                min="0"
                step="0.01"
                value={form.monthlyPayment}
                onChange={updateField('monthlyPayment')}
                className={inputClass}
              />
            </div>
          </div>
          <p className="text-xs text-zinc-500">Enter 0 where a rate or payment genuinely is zero; every field is required so nothing is guessed.</p>

          {formError && errorBox(formError)}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl text-sm font-medium bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Saving...' : 'Add liability'}
            </button>
            <button
              type="button"
              onClick={toggleForm}
              className="px-4 py-2 rounded-xl text-sm font-medium text-zinc-700 border border-zinc-200 bg-white hover:bg-zinc-100"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {actionError && <div className="mb-6">{errorBox(actionError)}</div>}

      {liabilitiesLoading && liabilities.length === 0 ? (
        <p className="text-sm text-zinc-500">Loading liabilities...</p>
      ) : liabilitiesError && liabilities.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          {errorBox(liabilitiesError)}
          <button
            type="button"
            onClick={fetchLiabilities}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-zinc-700 border border-zinc-200 bg-white hover:bg-zinc-100"
          >
            Try again
          </button>
        </div>
      ) : liabilities.length === 0 ? (
        <p className="text-sm text-zinc-500">No liabilities saved yet. Use Add liability to record a loan or card balance.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {liabilities.map((l) => {
            const { label, icon: Icon } = typeInfo(l.type);
            const paidOff = l.outstandingAmount === 0;
            return (
              <div key={l.id} className="glass-panel p-6 flex flex-col gap-4 min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-2 rounded-lg bg-zinc-100 text-zinc-700 shrink-0">
                      <Icon size={24} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold text-zinc-900 wrap-break-word">{l.name}</h3>
                      <span className="text-sm text-zinc-500">{label}</span>
                      {paidOff && <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-semibold bg-zinc-100 text-zinc-700 border border-zinc-200">Paid off</span>}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDelete(l.id)}
                    disabled={deletingId === l.id}
                    aria-label={`Delete liability ${l.name}`}
                    className="shrink-0 p-1.5 rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <div className="flex flex-col gap-2 pt-4 border-t border-zinc-100">
                  <div className="flex justify-between gap-3">
                    <span className="text-zinc-500">Outstanding</span>
                    <strong className="text-lg text-zinc-900 text-right wrap-break-word min-w-0">{formatCurrency(l.outstandingAmount)}</strong>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-zinc-500">Interest rate</span>
                    <strong className="text-zinc-900">{l.interestRate}% per year</strong>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-zinc-500">Monthly payment</span>
                    {paidOff
                      ? <strong className="text-zinc-900 text-right">None due</strong>
                      : <strong className="text-zinc-900 text-right wrap-break-word min-w-0">{formatCurrency(l.monthlyPayment)}</strong>}
                  </div>
                </div>
                {!paidOff && repayingId !== l.id && (
                  <button
                    type="button"
                    onClick={() => openRepayment(l.id)}
                    aria-label={`Add repayment to ${l.name}`}
                    className="self-start px-3 py-1 rounded-lg text-xs font-semibold text-zinc-700 border border-zinc-200 bg-white hover:bg-zinc-100"
                  >
                    Add repayment
                  </button>
                )}
                {!paidOff && repayingId === l.id && (
                  <form onSubmit={(e) => handleRepay(e, l.id)} className="flex flex-col gap-2 p-3 rounded-xl bg-zinc-50 border border-zinc-200">
                    <label htmlFor={`repayment-${l.id}`} className={labelClass}>Repayment (₹)</label>
                    <input
                      id={`repayment-${l.id}`}
                      type="number"
                      required
                      min="0.01"
                      step="0.01"
                      value={repaymentAmount}
                      onChange={(e) => setRepaymentAmount(e.target.value)}
                      className={inputClass}
                    />
                    {repaymentError && errorBox(repaymentError)}
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        disabled={isRepaying}
                        className="px-3 py-1.5 rounded-xl text-xs font-medium bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {isRepaying ? 'Saving...' : 'Add'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRepayingId(null)}
                        className="px-3 py-1.5 rounded-xl text-xs font-medium text-zinc-700 border border-zinc-200 bg-white hover:bg-zinc-100"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default Liabilities;
