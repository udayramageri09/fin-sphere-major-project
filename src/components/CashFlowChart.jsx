import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useFinance } from '../context/FinanceContext';
import { aggregateMonthlyTransactions, getRecentMonthKeys } from '../utils/finance';
import { formatMoney } from '../utils/spendingAnalytics';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'YYYY-MM' -> 'Oct 26'
const formatMonthLabel = (key) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;

function CashFlowChart() {
  const { transactions } = useFinance();

  // Same classifier, local-date parser and month keys as the summary cards.
  const monthly = aggregateMonthlyTransactions(transactions);
  const chartData = getRecentMonthKeys(6).map((key) => ({
    name: formatMonthLabel(key),
    recorded: Boolean(monthly[key]),
    income: monthly[key]?.income ?? 0,
    expenses: monthly[key]?.expenses ?? 0
  }));
  const latest = chartData.findLast(month => month.recorded);
  const guideTip = latest
    ? `${latest.name} is the latest month with data on this chart: ${formatMoney(latest.income)} income and ${formatMoney(latest.expenses)} net spending.`
    : 'No recorded income or spending in the last six months. Add transactions to see your cash flow here.';

  const customTooltipStyle = {
    backgroundColor: '#ffffff',
    border: '1px solid #e4e4e7',
    borderRadius: '12px',
    color: '#09090b',
    padding: '10px 14px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
    fontSize: '13px',
  };

  return (
    <div className="glass-panel p-6 w-full" data-guide-tip={guideTip}>
      <h3 className="text-lg font-bold text-zinc-900 tracking-tight mb-5">6-Month Cash Flow</h3>
      <div className="w-full h-[300px] md:h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="colorIncome" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#18181b" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#18181b" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="colorExpense" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#a1a1aa" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#a1a1aa" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="name" stroke="#a1a1aa" fontSize={12} tickLine={false} axisLine={false} />
            <YAxis stroke="#a1a1aa" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `₹${(value/1000).toFixed(0)}k`} />
            <Tooltip contentStyle={customTooltipStyle} itemStyle={{ color: '#09090b' }} />
            <Area type="monotone" dataKey="income" stroke="#18181b" strokeWidth={2.5} fillOpacity={1} fill="url(#colorIncome)" name="Income" />
            <Area type="monotone" dataKey="expenses" stroke="#a1a1aa" strokeWidth={2.5} fillOpacity={1} fill="url(#colorExpense)" name="Expenses" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default CashFlowChart;
