import GoalTracker from '../components/GoalTracker';
import EmergencyFund from '../components/EmergencyFund';
import MonthlyBudgets from '../components/MonthlyBudgets';

function Goals({ onDiscussGoals }) {
  return (
    <div className="animate-fade-in">
      <h2 style={{ marginBottom: '2rem', fontSize: '2rem' }}>Goals &amp; Budgets</h2>
      <div style={{ maxWidth: '800px', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
        {/* data-avatar-target anchors let the assistant open these sections ("open budgets", "go to emergency fund") */}
        <div data-avatar-target="emergency-fund"><EmergencyFund /></div>
        <GoalTracker />
        {onDiscussGoals && <button type="button" className="self-start rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white" data-guide-tip="Review your savings goal progress in Financial Intelligence." onClick={onDiscussGoals}>Discuss my goals</button>}
        <div data-avatar-target="budgets"><MonthlyBudgets /></div>
      </div>
    </div>
  );
}

export default Goals;
