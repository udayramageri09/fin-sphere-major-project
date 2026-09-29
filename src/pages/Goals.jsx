import GoalTracker from '../components/GoalTracker';

function Goals() {
  return (
    <div className="animate-fade-in">
      <h2 style={{ marginBottom: '2rem', fontSize: '2rem' }}>Financial Goals</h2>
      <div style={{ maxWidth: '800px' }}>
        <GoalTracker />
      </div>
    </div>
  );
}

export default Goals;
