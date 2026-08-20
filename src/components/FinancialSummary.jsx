import { motion } from 'framer-motion';
import { ArrowUpRight, ArrowDownRight, IndianRupee, CreditCard } from 'lucide-react';
import { useFinance } from '../context/FinanceContext';

function FinancialSummary() {
  const { netWorth, totalIncome, totalExpenses, activeLiabilities } = useFinance();

  const stats = [
    { label: 'Total Net Worth', value: netWorth, change: '+2.4%', isPositive: true, icon: IndianRupee },
    { label: 'Monthly Income', value: totalIncome, change: '+5.1%', isPositive: true, icon: ArrowUpRight },
    { label: 'Monthly Expenses', value: totalExpenses, change: '-1.2%', isPositive: false, icon: ArrowDownRight },
    { label: 'Active Liabilities', value: activeLiabilities, change: '-3.0%', isPositive: true, icon: CreditCard },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {stats.map((stat, idx) => {
        const Icon = stat.icon;
        return (
          <motion.div
            key={idx}
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
              {stat.value.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}
            </div>
            <div className={`flex items-center gap-1 text-xs font-medium truncate ${stat.isPositive ? 'text-zinc-900' : 'text-zinc-500'}`}>
              {stat.isPositive ? <ArrowUpRight size={14} className="shrink-0" /> : <ArrowDownRight size={14} className="shrink-0" />}
              <span className="text-zinc-500">{stat.change} from last month</span>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

export default FinancialSummary;
