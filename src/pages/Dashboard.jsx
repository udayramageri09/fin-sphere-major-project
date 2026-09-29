import PanProfile from '../components/PanProfile';
import FinancialSummary from '../components/FinancialSummary';
import CreditScoreWidget from '../components/CreditScoreWidget';
import GoalTracker from '../components/GoalTracker';
import CashFlowChart from '../components/CashFlowChart';
import { AlertTriangle, ShoppingBag, Coffee, ArrowDownCircle, ArrowUpCircle, Award, Star } from 'lucide-react';
import { useFinance } from '../context/FinanceContext';
import { motion } from 'framer-motion';
import confetti from 'canvas-confetti';

function Dashboard() {
  const { transactions } = useFinance();
  const recentTransactions = transactions.slice(0, 3);
  
  const handleClaimXP = () => {
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 },
      colors: ['#09090b', '#52525b', '#a1a1aa', '#e4e4e7'] // Monochrome confetti
    });
  };

  const getCategoryIcon = (cat, txnType) => {
    const c = (cat || '').toLowerCase();
    if (c.includes('coffee') || c.includes('food') || c.includes('eat')) return Coffee;
    if (c.includes('shop') || c.includes('amazon')) return ShoppingBag;
    if (txnType === 'income' || c.includes('salary') || c.includes('dividend')) return ArrowUpCircle;
    return ArrowDownCircle;
  };

  const handleAlertHover = () => {
    window.dispatchEvent(new CustomEvent('bot-speak', { detail: { message: "Yikes! You might want to transfer some funds before your SIP bounces! 🚨" }}));
  };
  const handleAlertLeave = () => {
    window.dispatchEvent(new CustomEvent('bot-quiet'));
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
    <motion.div 
      className="flex flex-col gap-8"
      variants={containerVariants}
      initial="hidden"
      animate="show"
    >
      <motion.div 
        variants={itemVariants}
        className="flex flex-wrap items-center gap-4 bg-zinc-100 border border-zinc-300 p-4 rounded-xl mb-2 text-zinc-800"
        data-avatar-target="balance-alert"
        onMouseEnter={handleAlertHover}
        onMouseLeave={handleAlertLeave}
      >
        <AlertTriangle size={24} className="text-zinc-900" />
        <div className="flex-1 min-w-48">
          <h4 className="m-0 text-base font-bold text-zinc-900 tracking-tight">Low Balance Alert</h4>
          <p className="m-0 text-sm text-zinc-600">Your linked account balance (₹12,500) is insufficient for upcoming SIPs & bills due this week (₹25,649).</p>
        </div>
        <button className="bg-zinc-900 text-zinc-50 border-none px-4 py-2 rounded-lg cursor-pointer font-semibold text-sm hover:bg-zinc-800 transition-colors">
          Transfer Funds
        </button>
      </motion.div>

      <motion.header variants={itemVariants} className="flex flex-col md:flex-row md:flex-wrap justify-between items-start md:items-center gap-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight-display text-zinc-900 mb-1">Welcome back, Alex</h1>
          <p className="text-zinc-500">Here's your financial overview for today.</p>
        </div>
        
        {/* Gamification Level Badge */}
        <div className="flex items-center gap-4 bg-white border border-zinc-200 shadow-sm rounded-xl p-3 pr-5">
          <div className="w-12 h-12 rounded-full bg-zinc-900 text-zinc-50 flex items-center justify-center relative">
            <Award size={24} />
            <div className="absolute -bottom-1 -right-1 bg-white text-zinc-900 text-[10px] font-bold px-1.5 py-0.5 rounded-full border border-zinc-200">
              Lvl 5
            </div>
          </div>
          <div className="flex flex-col">
            <div className="flex justify-between items-center mb-1 w-32">
              <span className="text-xs font-bold text-zinc-900">Master Saver</span>
              <span className="text-[10px] font-medium text-zinc-500 tabular-nums">850/1000 XP</span>
            </div>
            <div className="w-full bg-zinc-100 rounded-full h-1.5 overflow-hidden">
              <motion.div 
                className="bg-zinc-900 h-full" 
                initial={{ width: 0 }}
                animate={{ width: '85%' }}
                transition={{ duration: 1.5, delay: 0.5, ease: 'easeOut' }}
              />
            </div>
          </div>
          <motion.button 
            whileHover={{ scale: 1.1 }} 
            whileTap={{ scale: 0.9 }}
            onClick={handleClaimXP}
            className="ml-2 w-8 h-8 rounded-full bg-zinc-100 text-zinc-900 flex items-center justify-center hover:bg-zinc-200 transition-colors"
            title="Claim Daily XP"
          >
            <Star size={14} />
          </motion.button>
        </div>

        <PanProfile />
      </motion.header>

      <motion.section variants={itemVariants} className="w-full" data-avatar-target="financial-summary">
        <FinancialSummary />
      </motion.section>

      <motion.section variants={itemVariants} className="w-full" data-avatar-target="cash-flow">
        <CashFlowChart />
      </motion.section>

      <motion.section variants={itemVariants} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="flex flex-col gap-6">
          <div data-avatar-target="credit-score">
            <CreditScoreWidget />
          </div>
          
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
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold text-zinc-900 tracking-tight">Portfolio Distribution</h3>
            </div>
            <div className="flex flex-col gap-4">
               <div className="flex justify-between items-center">
                 <div className="flex items-center gap-2 text-sm text-zinc-600">
                   <div className="w-2.5 h-2.5 rounded-full bg-zinc-900"></div>
                   <span>Mutual Funds</span>
                 </div>
                 <span className="font-semibold text-zinc-900 tabular-nums">60%</span>
               </div>
               
               <div className="flex justify-between items-center">
                 <div className="flex items-center gap-2 text-sm text-zinc-600">
                   <div className="w-2.5 h-2.5 rounded-full bg-zinc-400"></div>
                   <span>Direct Stocks</span>
                 </div>
                 <span className="font-semibold text-zinc-900 tabular-nums">40%</span>
               </div>
               
               <div className="flex h-3 rounded-full overflow-hidden mt-2 bg-zinc-100">
                 <div className="h-full bg-zinc-900" style={{ width: '60%' }}></div>
                 <div className="h-full bg-zinc-400" style={{ width: '40%' }}></div>
               </div>
            </div>
          </div>
        </div>
      </motion.section>
    </motion.div>
  );
}

export default Dashboard;
