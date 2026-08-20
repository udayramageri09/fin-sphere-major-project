import { useState } from 'react';
import { Plus, TrendingUp } from 'lucide-react';
import confetti from 'canvas-confetti';
import { motion } from 'framer-motion';
import { useFinance } from '../context/FinanceContext';

function GoalTracker() {
  const { totalIncome, totalExpenses } = useFinance();
  const [goals, setGoals] = useState([
    { id: 1, name: 'Emergency Fund', current: 300000, target: 500000, completed: false },
    { id: 2, name: 'Europe Trip', current: 150000, target: 350000, completed: false },
  ]);

  const netSavings = totalIncome - totalExpenses;
  const isDeficit = netSavings <= 0;
  const activeSavingsRate = isDeficit ? 20000 : netSavings;

  const fundGoal = (id) => {
    setGoals(prevGoals => prevGoals.map(goal => {
      if (goal.id === id && !goal.completed) {
        confetti({
          particleCount: 120,
          spread: 70,
          origin: { y: 0.6 },
          colors: ['#09090b', '#52525b', '#a1a1aa', '#d4d4d8', '#fafafa']
        });
        return { ...goal, current: goal.target, completed: true };
      }
      return goal;
    }));
  };

  return (
    <div className="glass-panel p-6 flex flex-col">
      <div className="flex justify-between items-center mb-5">
        <h3 className="text-lg font-bold text-zinc-900 tracking-tight">Savings Goals</h3>
        <button className="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center text-zinc-700 border border-zinc-200 hover:bg-zinc-200">
          <Plus size={16} />
        </button>
      </div>

      <div className="flex flex-col gap-5">
        {goals.map((goal) => {
          const percentage = Math.min(100, Math.round((goal.current / goal.target) * 100));
          const remaining = goal.target - goal.current;
          const monthsLeft = Math.ceil(remaining / activeSavingsRate);

          return (
            <div key={goal.id} className="flex items-center gap-4">
              <div className="flex-1 flex flex-col gap-2">
                <div className="flex justify-between items-center">
                  <span className="font-semibold text-sm text-zinc-900">{goal.name}</span>
                  <span className="text-xs text-zinc-500 tabular-nums">
                    <strong className="text-zinc-900">₹{goal.current.toLocaleString('en-IN')}</strong> / ₹{goal.target.toLocaleString('en-IN')}
                  </span>
                </div>
                <div className="w-full h-2 bg-zinc-100 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-zinc-900 rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${percentage}%` }}
                    transition={{ duration: 1, ease: 'easeOut' }}
                  />
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-zinc-400">{percentage}% completed</span>
                  <span className="text-zinc-500 font-medium flex items-center gap-1">
                    {goal.completed ? (
                      '🎉 Goal reached!'
                    ) : (
                      <>
                        <TrendingUp size={11} />
                        {monthsLeft}mo left
                      </>
                    )}
                  </span>
                </div>
              </div>
              {!goal.completed ? (
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => fundGoal(goal.id)}
                  className="px-3 py-1.5 text-xs font-semibold bg-zinc-900 text-zinc-50 rounded-lg hover:bg-zinc-800"
                >
                  Fund
                </motion.button>
              ) : (
                <span className="text-zinc-900 font-bold text-xs">Done!</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default GoalTracker;
