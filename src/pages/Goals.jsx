import GoalTracker from '../components/GoalTracker';
import EmergencyFund from '../components/EmergencyFund';
import MonthlyBudgets from '../components/MonthlyBudgets';

function Goals() {
  return (
    <div className="animate-fade-in">
      <h2 style={{ marginBottom: '2rem', fontSize: '2rem' }}>Goals &amp; Budgets</h2>
      <div style={{ maxWidth: '800px', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
        <EmergencyFund />
        <GoalTracker />
        <MonthlyBudgets />
      </div>
    </div>
  );
}

export default Goals;
