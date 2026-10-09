// ActionConfirmationCard - the exact preview of something the assistant is about to save, with Confirm / Cancel
// (Issue #73). Presentational: it shows what the SERVER stored for the proposal (`display` rows), so the numbers on
// screen are the numbers that will be written. Nothing happens until the user presses Confirm.
const KIND_TITLE = {
  create_transaction: 'Add transaction',
  contribute_to_goal: 'Add to goal',
};

function ActionConfirmationCard({ action, onConfirm, onCancel, busy = false, compact = false }) {
  if (!action || action.status !== 'pending') return null;
  const title = KIND_TITLE[action.kind] ?? 'Confirm action';
  return (
    <div className={`action-card ${compact ? 'action-card--compact' : ''}`} role="group" aria-label={`Confirm: ${title}`}>
      <div className="action-card-title">{title}</div>
      <dl className="action-card-rows">
        {(action.display ?? []).map((row) => (
          <div key={row.label} className="action-card-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <div className="action-card-buttons">
        <button type="button" className="action-card-btn action-card-btn--confirm" onClick={onConfirm} disabled={busy}>Confirm</button>
        <button type="button" className="action-card-btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

export default ActionConfirmationCard;
