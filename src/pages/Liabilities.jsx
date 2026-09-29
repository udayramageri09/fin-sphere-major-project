import { Home, Car, CreditCard } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

function Liabilities() {
  const liabilities = [
    { id: 1, title: 'Home Loan', amount: 1850000, emi: 35000, bank: 'HDFC Bank', icon: Home },
    { id: 2, title: 'Car Loan', amount: 500000, emi: 15500, bank: 'SBI', icon: Car },
    { id: 3, title: 'Credit Card', amount: 100000, emi: 5000, bank: 'ICICI Bank', icon: CreditCard },
  ];

  const paydownData = [
    { year: '2026', debt: 2450000 },
    { year: '2027', debt: 1950000 },
    { year: '2028', debt: 1300000 },
    { year: '2029', debt: 650000 },
    { year: '2030', debt: 0 },
  ];

  const handleMouseEnter = () => {
    window.dispatchEvent(new CustomEvent('bot-speak', { detail: { message: "Debt free by 2030? That's what I like to see! Keep making those EMIs on time. 💪" }}));
  };
  const handleMouseLeave = () => {
    window.dispatchEvent(new CustomEvent('bot-quiet'));
  };

  return (
    <div className="animate-fade-in">
      <h2 style={{ marginBottom: '2rem', fontSize: '2rem' }}>Active Liabilities</h2>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '1.5rem', marginBottom: '3rem' }}>
        {liabilities.map((l) => {
          const Icon = l.icon;
          return (
            <div key={l.id} className="glass-panel" style={{ padding: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ padding: '0.5rem', background: 'rgba(239, 68, 68, 0.2)', color: 'var(--danger)', borderRadius: '8px' }}>
                    <Icon size={24} />
                  </div>
                  <div>
                    <h3 style={{ fontSize: '1.2rem', color: 'var(--text-primary)' }}>{l.title}</h3>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{l.bank}</span>
                  </div>
                </div>
              </div>
              <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Outstanding</span>
                  <strong style={{ fontSize: '1.2rem', color: 'var(--text-primary)' }}>₹{l.amount.toLocaleString('en-IN')}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Monthly EMI</span>
                  <strong style={{ color: 'var(--warning)' }}>₹{l.emi.toLocaleString('en-IN')}</strong>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Paydown Projection Chart Widget */}
      <div 
        className="glass-panel widget-card" 
        onMouseEnter={handleMouseEnter} 
        onMouseLeave={handleMouseLeave}
      >
        <div className="widget-header" style={{ marginBottom: '1.5rem' }}>
          <h3 className="widget-title" style={{marginBottom: 0}}>Debt Paydown Projection (Towards ₹0)</h3>
        </div>
        <div style={{ width: '100%', height: '350px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={paydownData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="colorDebt" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--danger)" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="var(--danger)" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <XAxis dataKey="year" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
              <YAxis 
                stroke="var(--text-secondary)" 
                fontSize={12} 
                tickLine={false} 
                axisLine={false} 
                tickFormatter={(value) => `₹${(value/100000).toFixed(1)}L`} 
              />
              <Tooltip 
                contentStyle={{ backgroundColor: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)' }}
                itemStyle={{ color: 'var(--danger)', fontWeight: 'bold' }}
                formatter={(value) => [`₹${value.toLocaleString('en-IN')}`, 'Total Debt']}
              />
              <Area 
                type="monotone" 
                dataKey="debt" 
                stroke="var(--danger)" 
                strokeWidth={3} 
                fillOpacity={1} 
                fill="url(#colorDebt)" 
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
export default Liabilities;
