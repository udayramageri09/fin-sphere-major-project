import DashboardGreeting from '../components/DashboardGreeting';
import FinancialSummary from '../components/FinancialSummary';
import GoalTracker from '../components/GoalTracker';
import CashFlowChart from '../components/CashFlowChart';
import { ShoppingBag, Coffee, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import { useFinance } from '../context/FinanceContext';
import { MotionConfig, motion } from 'framer-motion';
import { useReduceMotion } from '../hooks/useMotionPreference';

function Dashboard() {
  const { transactions } = useFinance();
  const reduceMotion = useReduceMotion();
  const recentTransactions = transactions.slice(0, 3);

  const getCategoryIcon = (cat, txnType) => {
    const c = (cat || '').toLowerCase();
    if (c.includes('coffee') || c.includes('food') || c.includes('eat')) return Coffee;
    if (c.includes('shop') || c.includes('amazon')) return ShoppingBag;
    if (txnType === 'income' || c.includes('salary') || c.includes('dividend')) return ArrowUpCircle;
    return ArrowDownCircle;
  };

  const containerVariants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.1 }
    }
  };

  const itemVariants = {
    hidden: { y: 20, opacity: 0 },
    show: { y: 0, opacity: 1, transition: { type: 'spring', damping: 15, stiffness: 100 } }
  };

  return (
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'user'}>
    <motion.div
      className="flex flex-col gap-8"
      variants={containerVariants}
      initial="hidden"
      animate="show"
    >
      <motion.header variants={itemVariants} className="flex flex-col md:flex-row md:flex-wrap justify-between items-start md:items-center gap-6">
        <DashboardGreeting />
      </motion.header>

      <motion.section variants={itemVariants} className="w-full" data-avatar-target="financial-summary">
        <FinancialSummary />
      </motion.section>

      <motion.section variants={itemVariants} className="w-full" data-avatar-target="cash-flow">
        <CashFlowChart />
      </motion.section>

      <motion.section variants={itemVariants} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="flex flex-col gap-6">
          
          <div className="glass-panel p-6" data-avatar-target="recent-transactions">
            <h3 className="text-xl font-bold text-zinc-900 mb-6 tracking-tight">Recent Transactions</h3>
            <div className="flex flex-col gap-4">
              {recentTransactions.length === 0 ? (
                <div className="p-6 text-center text-zinc-500">
                  No recent transactions yet.
                </div>
              ) : (
                recentTransactions.map((t, idx) => {
                  const Icon = getCategoryIcon(t.category, t.type);
                  const isIncome = t.type === 'income';
                  return (
                    <div key={t.id} className={`flex justify-between items-center py-3 ${idx !== recentTransactions.length - 1 ? 'border-b border-zinc-100' : ''}`}>
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="w-10 h-10 shrink-0 rounded-full flex items-center justify-center bg-zinc-100 text-zinc-900">
                          <Icon size={18} />
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-sm font-semibold text-zinc-900 mb-0.5 truncate">{t.title}</h4>
                          <small className="text-xs text-zinc-500 truncate block">{t.category || 'General'}</small>
                        </div>
                      </div>
                      <div className={`font-semibold tabular-nums shrink-0 ml-4 ${isIncome ? 'text-zinc-900' : 'text-zinc-500'}`}>
                        {isIncome ? '+' : ''}{t.amount.toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
        
        <div className="flex flex-col gap-6">
          <div data-avatar-target="goal-tracker">
            <GoalTracker />
          </div>
          
          <div className="glass-panel p-6">
            <h3 className="text-xl font-bold text-zinc-900 tracking-tight mb-3">Your investments</h3>
            <p className="text-sm text-zinc-600">Open Portfolio to record your holdings and view allocation based on your own valuations.</p>
          </div>
        </div>
      </motion.section>
    </motion.div>
    </MotionConfig>
  );
}

export default Dashboard;
