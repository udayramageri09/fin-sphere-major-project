import { CalendarClock, Play, Pause, Trash2 } from 'lucide-react';

function Subscriptions() {
  const subscriptions = [
    { id: 1, name: 'Nifty 50 Index Fund SIP', amount: 15000, date: '10th of every month', status: 'Active', type: 'Investment' },
    { id: 2, name: 'Small Cap Fund SIP', amount: 10000, date: '15th of every month', status: 'Active', type: 'Investment' },
    { id: 3, name: 'Netflix', amount: 649, date: '12th of every month', status: 'Active', type: 'Entertainment' },
    { id: 4, name: 'Gym Membership', amount: 1500, date: '5th of every month', status: 'Paused', type: 'Health' },
  ];

  const handleSipHover = (name) => {
    if (name.includes('Index Fund')) {
      window.dispatchEvent(new CustomEvent('bot-speak', { detail: { message: "Great choice on the Index Fund! Consistent investing is the key to wealth. 📈" }}));
    } else if (name.includes('Netflix')) {
      window.dispatchEvent(new CustomEvent('bot-speak', { detail: { message: "Netflix and chill? Just make sure you're actually using it! 🍿" }}));
    } else {
      window.dispatchEvent(new CustomEvent('bot-speak', { detail: { message: "Auto-payments setup! I'll remind you if your balance ever gets low. 🤖" }}));
    }
  };

  const handleMouseLeave = () => {
    window.dispatchEvent(new CustomEvent('bot-quiet'));
  };

  return (
    <div className="animate-fade-in" style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
      <h2 style={{ marginBottom: '2rem', fontSize: '2rem' }}>SIPs & Subscriptions</h2>

      <div className="glass-panel" style={{ padding: '1.5rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1.5rem' }}>
          {subscriptions.map(sub => (
            <div 
              key={sub.id} 
              className="widget-card" 
              style={{ padding: '1.5rem', background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: '12px' }}
              onMouseEnter={() => handleSipHover(sub.name)}
              onMouseLeave={handleMouseLeave}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <span style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: sub.type === 'Investment' ? 'var(--success)' : 'var(--text-secondary)' }}>
                  {sub.type}
                </span>
                <span style={{ fontSize: '0.8rem', padding: '0.2rem 0.6rem', borderRadius: '12px', background: sub.status === 'Active' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)', color: sub.status === 'Active' ? 'var(--success)' : 'var(--warning)' }}>
                  {sub.status}
                </span>
              </div>
              <h3 style={{ fontSize: '1.1rem', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{sub.name}</h3>
              <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--text-primary)', marginBottom: '1rem' }}>
                ₹{sub.amount.toLocaleString('en-IN')}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
                <CalendarClock size={16} />
                <span>Auto-deduct on {sub.date}</span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {sub.status === 'Active' ? (
                  <button className="icon-btn" style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: '0.5rem', border: '1px solid var(--border-color)' }}>
                    <Pause size={16} /> Pause
                  </button>
                ) : (
                  <button className="icon-btn" style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: '0.5rem', border: '1px solid var(--border-color)', color: 'var(--success)' }}>
                    <Play size={16} /> Resume
                  </button>
                )}
                <button className="icon-btn" style={{ color: 'var(--danger)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default Subscriptions;
