import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useFinance } from '../context/FinanceContext';

function CashFlowChart() {
  const { transactions } = useFinance();

  const getMonthsList = () => {
    const list = [];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const d = new Date();
    for (let i = 5; i >= 0; i--) {
      const targetDate = new Date(d.getFullYear(), d.getMonth() - i, 1);
      const mName = months[targetDate.getMonth()];
      const year = targetDate.getFullYear();
      list.push({
        name: `${mName} ${year.toString().slice(-2)}`,
        monthIdx: targetDate.getMonth(),
        year: year,
        income: 0,
        expenses: 0
      });
    }
    return list;
  };

  const chartData = getMonthsList();

  transactions.forEach(t => {
    const tDate = new Date(t.date);
    if (isNaN(tDate.getTime())) return;
    const tMonth = tDate.getMonth();
    const tYear = tDate.getFullYear();
    const match = chartData.find(c => c.monthIdx === tMonth && c.year === tYear);
    if (match) {
      const amt = Math.abs(t.amount);
      if (t.type === 'income' || t.amount > 0) {
        match.income += amt;
      } else {
        match.expenses += amt;
      }
    }
  });

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
    <div className="glass-panel p-6 w-full">
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
