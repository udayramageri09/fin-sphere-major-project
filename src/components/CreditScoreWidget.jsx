// No credit bureau data exists in FinSphere, so this card states that plainly
// instead of showing a score.
function CreditScoreWidget() {
  return (
    <div className="glass-panel p-6 flex flex-col">
      <h3 className="text-lg font-bold text-zinc-900 tracking-tight mb-4">Credit Score</h3>

      <div className="flex flex-col items-center justify-center text-center gap-1 py-6">
        <span className="text-2xl font-bold text-zinc-600 tracking-tight-display">Not available</span>
        <span className="text-sm text-zinc-500">No credit bureau data is connected to your account.</span>
      </div>
    </div>
  );
}

export default CreditScoreWidget;
