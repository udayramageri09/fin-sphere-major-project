import { motion } from 'framer-motion';
import { ArrowUpRight, ArrowDownRight, IndianRupee } from 'lucide-react';
import { useFinance } from '../context/FinanceContext';
import { percentChange } from '../utils/finance';

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

const formatChange = (change) => {
  const rounded = Math.round(change * 10) / 10;
  if (rounded === 0) return '0.0%';
  return `${rounded > 0 ? '+' : '-'}${Math.abs(rounded).toFixed(1)}%`;
};

function FinancialSummary() {
  const { balance, currentMonth, previousMonth } = useFinance();

  // `change` is a percentage vs last month, or null when last month has nothing to
  // compare against; `note` is a static caption for cards without a comparison.
  const stats = [
    { label: 'Balance', value: balance, note: 'All-time income minus expenses', icon: IndianRupee },
    { label: 'Income This Month', value: currentMonth.income, change: percentChange(currentMonth.income, previousMonth.income), icon: ArrowUpRight },
    { label: 'Expenses This Month', value: currentMonth.expenses, change: percentChange(currentMonth.expenses, previousMonth.expenses), icon: ArrowDownRight },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
      {stats.map((stat, idx) => {
        const Icon = stat.icon;
        const hasChange = stat.change !== undefined && stat.change !== null;
        return (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', damping: 20, stiffness: 100, delay: idx * 0.08 }}
            className="glass-panel p-5 flex flex-col gap-3 overflow-hidden"
          >
            <div className="flex justify-between items-center gap-2">
              <span className="text-sm text-zinc-500 font-medium truncate">{stat.label}</span>
              <div className="w-9 h-9 shrink-0 rounded-xl bg-zinc-100 flex items-center justify-center text-zinc-700">
                <Icon size={18} />
              </div>
            </div>
            <div className="text-2xl font-bold text-zinc-900 tabular-nums tracking-tight-display truncate">
              {formatCurrency(stat.value)}
            </div>
            <div className="flex items-center gap-1 text-xs font-medium truncate text-zinc-500">
              {hasChange ? (
                <>
                  {stat.change >= 0
                    ? <ArrowUpRight size={14} className="shrink-0" />
                    : <ArrowDownRight size={14} className="shrink-0" />}
                  <span>{formatChange(stat.change)} from last month</span>
                </>
              ) : (
                <span>{stat.note ?? 'No previous-month data to compare'}</span>
              )}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

export default FinancialSummary;
