import { motion } from 'framer-motion';

function CreditScoreWidget() {
  const score = 785;
  const maxScore = 850;
  const percentage = (score / maxScore) * 100;
  const dashOffset = 125.6 - (125.6 * percentage) / 100;

  return (
    <div className="glass-panel p-6 flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-bold text-zinc-900 tracking-tight">Credit Score</h3>
        <span className="bg-zinc-100 text-zinc-700 px-3 py-1 rounded-full text-xs font-semibold border border-zinc-200">
          Excellent
        </span>
      </div>

      <div className="relative w-full max-w-[280px] mx-auto aspect-[2/1]">
        <svg viewBox="0 0 100 50" className="w-full h-full overflow-visible">
          <path
            d="M 10 50 A 40 40 0 0 1 90 50"
            fill="none"
            stroke="#e4e4e7"
            strokeWidth="10"
            strokeLinecap="round"
          />
          <motion.path
            d="M 10 50 A 40 40 0 0 1 90 50"
            fill="none"
            stroke="#18181b"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray="125.6"
            initial={{ strokeDashoffset: 125.6 }}
            animate={{ strokeDashoffset: dashOffset }}
            transition={{ duration: 1.5, ease: 'easeOut' }}
          />
        </svg>
        <div className="absolute bottom-0 left-0 right-0 text-center translate-y-[20%]">
          <span className="text-4xl font-bold text-zinc-900 tabular-nums tracking-tight-display">{score}</span>
          <span className="text-base text-zinc-400 font-medium ml-1">/ {maxScore}</span>
        </div>
      </div>

      <div className="flex justify-between items-center mt-auto pt-4 border-t border-zinc-100">
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <div className="w-2 h-2 rounded-full bg-zinc-900"></div>
          <span>Linked to PAN</span>
        </div>
        <span className="text-xs text-zinc-400">Updated 2d ago</span>
      </div>
    </div>
  );
}

export default CreditScoreWidget;
