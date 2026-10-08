import { useEffect, useState } from 'react';
import { AlertCircle, Pencil, Plus, Trash2, X } from 'lucide-react';
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

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// 'YYYY-MM' -> 'October 2026' by plain text, never through Date (no time zone can shift the month).
const monthLabel = (ym) => {
  const match = /^(\d{4})-(\d{2})$/.exec(ym);
  return match && MONTH_NAMES[Number(match[2]) - 1] ? `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}` : ym;
};

// The user's current local calendar month as 'YYYY-MM'.
const currentLocalMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const inputClass =
  'w-full px-3 py-2 rounded-xl border border-zinc-200 bg-white text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/20';
const labelClass = 'text-xs font-medium text-zinc-500';

const EMPTY_FORM = { category: '', amount: '' };

function MonthlyBudgets() {
  const { budgets, budgetsMonth, budgetsLoading, budgetsError, fetchBudgets, saveBudget, deleteBudget } = useFinance();
  const [month, setMonth] = useState(currentLocalMonth);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [deletingId, setDeletingId] = useState(null);

  // One fetch per chosen month; the context ignores a response that arrives after the month changed again.
  useEffect(() => {
    if (/^\d{4}-\d{2}$/.test(month)) fetchBudgets(month);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const updateField = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
  };

  const openAdd = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (budget) => {
    setEditingId(budget.id);
    setForm({ category: budget.category, amount: String(budget.amount) });
    setFormError('');
    setShowForm(true);
  };

  const changeMonth = (e) => {
    setMonth(e.target.value);
    closeForm();
    setActionError('');
  };

  // The server is the validation authority; its message is shown as-is.
  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');
    setIsSaving(true);
    try {
      await saveBudget({
        month,
        category: form.category,
        // An empty box is "missing" (the server rejects it), never a made-up 0.
        amount: form.amount === '' ? null : Number(form.amount),
      });
      closeForm();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id) => {
    setActionError('');
    setDeletingId(id);
    try {
      await deleteBudget(id);
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

  // Only show a list that belongs to the month in the picker (never a stale one while switching).
  const current = budgetsMonth === month;
  const monthValid = /^\d{4}-\d{2}$/.test(month);

  return (
    <section className="glass-panel p-6 flex flex-col gap-4" aria-labelledby="monthly-budgets-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="monthly-budgets-heading" className="text-lg font-bold text-zinc-900 tracking-tight">Monthly budgets</h3>
        <div className="flex items-center gap-2">
          <label htmlFor="budget-month" className={labelClass}>Month</label>
          <input
            id="budget-month"
            type="month"
            value={month}
            onChange={changeMonth}
            className="px-3 py-1.5 rounded-xl border border-zinc-200 bg-white text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/20"
          />
          <button
            type="button"
            onClick={showForm && !editingId ? closeForm : openAdd}
            disabled={!monthValid}
            aria-label={showForm && !editingId ? 'Cancel adding a budget' : 'Add a budget'}
            aria-expanded={showForm}
            className="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center text-zinc-700 border border-zinc-200 hover:bg-zinc-200 disabled:opacity-50"
          >
            {showForm && !editingId ? <X size={16} /> : <Plus size={16} />}
          </button>
        </div>
      </div>

      {showForm && monthValid && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 p-4 rounded-xl bg-zinc-50 border border-zinc-200">
          <p className="text-xs text-zinc-500">
            {editingId ? 'Update the budget for' : 'Set a budget for'} {monthLabel(month)}. Food, food and &quot; FOOD &quot; are the same category.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="budget-category" className={labelClass}>Category</label>
              <input
                id="budget-category"
                type="text"
                required
                maxLength={60}
                readOnly={Boolean(editingId)}
                value={form.category}
                onChange={updateField('category')}
                placeholder="e.g. Food"
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="budget-amount" className={labelClass}>Monthly limit (₹)</label>
              <input
                id="budget-amount"
                type="number"
                required
                min="0.01"
                step="0.01"
                value={form.amount}
                onChange={updateField('amount')}
                className={inputClass}
              />
            </div>
          </div>
          {formError && errorBox(formError)}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isSaving}
              className="px-4 py-2 rounded-xl text-sm font-medium bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isSaving ? 'Saving...' : editingId ? 'Update budget' : 'Save budget'}
            </button>
            <button
              type="button"
              onClick={closeForm}
              className="px-4 py-2 rounded-xl text-sm font-medium text-zinc-700 border border-zinc-200 bg-white hover:bg-zinc-100"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {actionError && errorBox(actionError)}

      {!monthValid ? (
        <p className="text-sm text-zinc-500">Choose a month to see its budgets.</p>
      ) : budgetsLoading || !current ? (
        !budgetsError || !current ? <p className="text-sm text-zinc-500">Loading budgets...</p> : null
      ) : budgetsError ? (
        <div className="flex flex-col items-start gap-3">
          {errorBox(budgetsError)}
          <button
            type="button"
            onClick={() => fetchBudgets(month)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-zinc-700 border border-zinc-200 bg-white hover:bg-zinc-100"
          >
            Try again
          </button>
        </div>
      ) : budgets.length === 0 ? (
        <p className="text-sm text-zinc-500">No budgets set for {monthLabel(month)}. Use the + button to add a category limit.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-100">
          {budgets.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-3 py-3">
              <span className="font-semibold text-sm text-zinc-900 min-w-0 wrap-break-word">{b.category}</span>
              <div className="flex items-center gap-2 shrink-0">
                <strong className="text-sm text-zinc-900 tabular-nums">{formatCurrency(b.amount)}</strong>
                <button
                  type="button"
                  onClick={() => openEdit(b)}
                  aria-label={`Edit budget ${b.category}`}
                  className="p-1.5 rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                >
                  <Pencil size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(b.id)}
                  disabled={deletingId === b.id}
                  aria-label={`Delete budget ${b.category}`}
                  className="p-1.5 rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50"
                >
                  {deletingId === b.id ? <span className="text-xs">Deleting...</span> : <Trash2 size={16} />}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default MonthlyBudgets;
