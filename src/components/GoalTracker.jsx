import { useState } from 'react';
import { Plus, X, Trash2, AlertCircle } from 'lucide-react';
import { motion } from 'framer-motion';
import { useFinance } from '../context/FinanceContext';
import { parseLocalDate } from '../utils/finance';

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

const pad2 = (n) => String(n).padStart(2, '0');

// Today as YYYY-MM-DD in the user's local calendar (toISOString() would give the UTC date).
const todayLocalYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

// Whole days from today to the target date, both at local midnight; null if unreadable.
const daysUntil = (ymd) => {
  const target = parseLocalDate(ymd);
  if (!target) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
};

const dueText = (days) => {
  if (days === null) return '';
  if (days > 1) return `${days} days left`;
  if (days === 1) return '1 day left';
  if (days === 0) return 'due today';
  return `${-days} ${days === -1 ? 'day' : 'days'} overdue`;
};

const inputClass =
  'w-full px-3 py-2 rounded-xl border border-zinc-200 bg-white text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/20';
const labelClass = 'text-xs font-medium text-zinc-500';

const EMPTY_FORM = { title: '', targetAmount: '', currentAmount: '0', targetDate: '' };

function GoalTracker() {
  const { goals, goalsLoading, goalsError, fetchGoals, addGoal, deleteGoal } = useFinance();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [deletingId, setDeletingId] = useState(null);

  const updateField = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const toggleForm = () => {
    setShowForm((open) => !open);
    setFormError('');
  };

  // The server is the validation authority; its message is shown as-is.
  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');
    setIsSubmitting(true);
    try {
      await addGoal({
        title: form.title,
        targetAmount: Number(form.targetAmount),
        currentAmount: form.currentAmount === '' ? 0 : Number(form.currentAmount),
        targetDate: form.targetDate,
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id) => {
    setActionError('');
    setDeletingId(id);
    try {
      await deleteGoal(id);
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
    <div className="glass-panel p-6 flex flex-col">
      <div className="flex justify-between items-center mb-5">
        <h3 className="text-lg font-bold text-zinc-900 tracking-tight">Savings Goals</h3>
        <button
          type="button"
          onClick={toggleForm}
          aria-label={showForm ? 'Cancel adding a goal' : 'Add a goal'}
          aria-expanded={showForm}
          className="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center text-zinc-700 border border-zinc-200 hover:bg-zinc-200"
        >
          {showForm ? <X size={16} /> : <Plus size={16} />}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 mb-5 p-4 rounded-xl bg-zinc-50 border border-zinc-200">
          <div className="flex flex-col gap-1">
            <label htmlFor="goal-title" className={labelClass}>Goal name</label>
            <input
              id="goal-title"
              type="text"
              required
              maxLength={120}
              value={form.title}
              onChange={updateField('title')}
              placeholder="Name your goal"
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="goal-target" className={labelClass}>Target amount (₹)</label>
              <input
                id="goal-target"
                type="number"
                required
                min="0.01"
                step="0.01"
                value={form.targetAmount}
                onChange={updateField('targetAmount')}
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="goal-current" className={labelClass}>Already saved (₹)</label>
              <input
                id="goal-current"
                type="number"
                min="0"
                step="0.01"
                value={form.currentAmount}
                onChange={updateField('currentAmount')}
                className={inputClass}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="goal-date" className={labelClass}>Target date</label>
            <input
              id="goal-date"
              type="date"
              required
              min={todayLocalYmd()}
              value={form.targetDate}
              onChange={updateField('targetDate')}
              className={inputClass}
            />
          </div>

          {formError && errorBox(formError)}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl text-sm font-medium bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Saving...' : 'Add goal'}
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

      {actionError && <div className="mb-4">{errorBox(actionError)}</div>}

      {goalsLoading && goals.length === 0 ? (
        <p className="text-sm text-zinc-500">Loading goals...</p>
      ) : goalsError && goals.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          {errorBox(goalsError)}
          <button
            type="button"
            onClick={fetchGoals}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-zinc-700 border border-zinc-200 bg-white hover:bg-zinc-100"
          >
            Try again
          </button>
        </div>
      ) : goals.length === 0 ? (
        <p className="text-sm text-zinc-500">No goals yet. Use the + button to add your first savings goal.</p>
      ) : (
        <div className="flex flex-col gap-5">
          {goals.map((goal) => {
            // Display-only clamp; the stored values are never altered.
            const percentage = goal.targetAmount > 0 ? (goal.currentAmount / goal.targetAmount) * 100 : 0;
            const shown = Math.max(0, Math.min(100, percentage));
            const reached = goal.currentAmount >= goal.targetAmount;
            const targetDate = parseLocalDate(goal.targetDate);
            const dateLabel = targetDate
              ? targetDate.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })
              : goal.targetDate;

            return (
              <div key={goal.id} className="flex items-start gap-3">
                <div className="flex-1 min-w-0 flex flex-col gap-2">
                  <div className="flex justify-between items-start gap-3">
                    <span className="font-semibold text-sm text-zinc-900 min-w-0 wrap-break-word">{goal.title}</span>
                    <span className="text-xs text-zinc-500 tabular-nums shrink-0">
                      <strong className="text-zinc-900">{formatCurrency(goal.currentAmount)}</strong> / {formatCurrency(goal.targetAmount)}
                    </span>
                  </div>
                  <div className="w-full h-2 bg-zinc-100 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full bg-zinc-900 rounded-full"
                      initial={{ width: 0 }}
                      animate={{ width: `${shown}%` }}
                      transition={{ duration: 1, ease: 'easeOut' }}
                    />
                  </div>
                  <div className="flex flex-wrap justify-between items-center gap-x-3 text-xs">
                    <span className="text-zinc-500">{Math.round(shown)}% completed</span>
                    <span className="text-zinc-500 font-medium">
                      {reached ? 'Goal reached' : `${dateLabel} · ${dueText(daysUntil(goal.targetDate))}`}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(goal.id)}
                  disabled={deletingId === goal.id}
                  aria-label={`Delete goal ${goal.title}`}
                  className="shrink-0 p-1.5 rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default GoalTracker;
