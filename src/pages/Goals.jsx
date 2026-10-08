import GoalTracker from '../components/GoalTracker';
import EmergencyFund from '../components/EmergencyFund';

function Goals() {
  return (
    <div className="animate-fade-in">
      <h2 style={{ marginBottom: '2rem', fontSize: '2rem' }}>Financial Goals</h2>
      <div style={{ maxWidth: '800px', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
        <EmergencyFund />
        <GoalTracker />
      </div>
    </div>
  );
}

export default Goals;
