import { TrendingUp } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

function Portfolio() {
  const assets = [
    { id: 1, name: 'Mutual Funds', value: 2850000, allocation: 63, color: '#18181b' },
    { id: 2, name: 'Direct Stocks', value: 1700000, allocation: 37, color: '#a1a1aa' },
  ];
  
  const total = assets.reduce((acc, a) => acc + a.value, 0);

  const trendData = [
    { month: 'Jul', value: 3800000 },
    { month: 'Aug', value: 3950000 },
    { month: 'Sep', value: 3900000 },
    { month: 'Oct', value: 4100000 },
    { month: 'Nov', value: 4350000 },
    { month: 'Dec', value: 4550000 },
  ];

  const handleMouseEnter = () => {
    window.dispatchEvent(new CustomEvent('bot-speak', { detail: { message: "Look at that profit climb! 🚀 Your compounding strategy is working perfectly." }}));
  };
  const handleMouseLeave = () => {
    window.dispatchEvent(new CustomEvent('bot-quiet'));
  };

  return (
    <div className="animate-fade-in">
      <h2 style={{ marginBottom: '2rem', fontSize: '2rem' }}>Your Portfolio</h2>
      
      <div className="glass-panel" style={{ padding: '2rem', marginBottom: '2rem', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <span style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>Total Portfolio Value</span>
          <h3 style={{ fontSize: 'clamp(1.75rem, 9vw, 2.5rem)', color: 'var(--text-primary)', marginTop: '0.5rem' }}>₹{total.toLocaleString('en-IN')}</h3>
        </div>
        <div style={{ padding: '1rem', background: 'rgba(16, 185, 129, 0.2)', color: 'var(--success)', borderRadius: '50%' }}>
          <TrendingUp size={40} />
        </div>
      </div>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(400px, 100%), 1fr))', gap: '2rem' }}>
        
        {/* Asset Allocation Widget */}
        <div className="glass-panel widget-card">
          <div className="widget-header">
            <h3 className="widget-title" style={{marginBottom: 0}}>Asset Allocation</h3>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginTop: '1.5rem' }}>
            {assets.map((a) => (
               <div key={a.id} style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem 1rem' }}>
                 <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                   <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: a.color }}></div>
                   <span style={{ fontSize: '1.1rem', color: 'var(--text-primary)' }}>{a.name}</span>
                 </div>
                 <div style={{ display: 'flex', gap: '2rem', alignItems: 'center', marginLeft: 'auto' }}>
                   <span style={{ fontWeight: '600', color: 'var(--text-primary)' }}>₹{a.value.toLocaleString('en-IN')}</span>
                   <span style={{ color: 'var(--text-secondary)', width: '40px', textAlign: 'right' }}>{a.allocation}%</span>
                 </div>
               </div>
            ))}
            <div style={{ display: 'flex', height: '16px', borderRadius: '8px', overflow: 'hidden', marginTop: '0.5rem' }}>
              {assets.map((a) => (
                <div key={a.id} style={{ width: `${a.allocation}%`, background: a.color }}></div>
              ))}
            </div>
          </div>
        </div>

        {/* Profit Trend Chart Widget */}
        <div 
          className="glass-panel widget-card" 
          onMouseEnter={handleMouseEnter} 
          onMouseLeave={handleMouseLeave}
        >
          <div className="widget-header">
            <h3 className="widget-title" style={{marginBottom: 0}}>6-Month Growth Trend</h3>
          </div>
          <div style={{ width: '100%', height: '300px', marginTop: '1rem' }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <XAxis dataKey="month" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis 
                  stroke="var(--text-secondary)" 
                  fontSize={12} 
                  tickLine={false} 
                  axisLine={false} 
                  domain={['dataMin - 5000', 'dataMax + 5000']}
                  tickFormatter={(value) => `₹${(value/100000).toFixed(1)}L`} 
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)' }}
                  itemStyle={{ color: 'var(--accent-primary)', fontWeight: 'bold' }}
                  formatter={(value) => [`₹${value.toLocaleString('en-IN')}`, 'Portfolio Value']}
                />
                <Line 
                  type="monotone" 
                  dataKey="value" 
                  stroke="var(--accent-primary)" 
                  strokeWidth={4} 
                  dot={{ r: 4, fill: 'var(--surface-color)', strokeWidth: 2 }} 
                  activeDot={{ r: 6, fill: 'var(--accent-primary)' }} 
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

      </div>
    </div>
  );
}
export default Portfolio;
