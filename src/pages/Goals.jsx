import GoalTracker from '../components/GoalTracker';
import EmergencyFund from '../components/EmergencyFund';
import MonthlyBudgets from '../components/MonthlyBudgets';

function Goals() {
  return (
    <div className="animate-fade-in">
      <h2 style={{ marginBottom: '2rem', fontSize: '2rem' }}>Goals &amp; Budgets</h2>
      <div style={{ maxWidth: '800px', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
        {/* data-avatar-target anchors let the assistant open these sections ("open budgets", "go to emergency fund") */}
        <div data-avatar-target="emergency-fund"><EmergencyFund /></div>
        <GoalTracker />
        <div data-avatar-target="budgets"><MonthlyBudgets /></div>
      </div>
    </div>
  );
}

export default Goals;
