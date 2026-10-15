// DuplicateReview - the review step of a duplicate-aware statement import. The server held the import back because some rows look like
// transactions the user already has; nothing has been saved. This shows every row (new / likely duplicate / possible duplicate) with
// the saved transaction it matched, lets the user tick exactly what to import, and hands the decision back. It saves nothing itself.
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Copy } from 'lucide-react';
import { importButtonStyle } from '../utils/statementImportUi';
import { defaultSelection, selectionCounts, formatDay, formatRupees, reviewHeadline } from '../utils/duplicateReview';

const BADGE = {
  new: { text: 'New', style: { background: '#e4e4e7', color: '#3f3f46', border: '1px solid #a1a1aa' } },
  likely: { text: 'Likely duplicate', style: { background: '#27272a', color: '#ffffff', border: '1px solid #27272a' } },
  possible: { text: 'Possible duplicate', style: { background: '#ffffff', color: '#27272a', border: '2px dashed #27272a' } }
};

function Badge({ kind }) {
  const b = BADGE[kind];
  return <span style={{ ...b.style, display: 'inline-block', padding: '0.05rem 0.5rem', borderRadius: '9999px', fontSize: '0.7rem', fontWeight: 700, whiteSpace: 'nowrap' }}>{b.text}</span>;
}

// The parent gives this component a `key` taken from the preview's digest, so a refreshed (stale) preview starts from a clean,
// default selection and a focused heading instead of carrying over choices made against old data.
function DuplicateReview({ preview, stale = false, busy = false, error = '', onImportSelected, onImportAll, onCancel }) {
  const [selected, setSelected] = useState(() => defaultSelection(preview));
  const headingRef = useRef(null);
  useEffect(() => { headingRef.current?.focus(); }, []);

  const { summary } = preview;
  const counts = selectionCounts(preview, selected);
  const toggle = (index) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });
  const canImportSelected = !busy && counts.selected > 0;
  const secondary = busy
    ? importButtonStyle({ disabled: true, busy: false })
    : { background: '#ffffff', color: '#27272a', border: '2px solid #27272a', cursor: 'pointer' };
  const common = { padding: '0.7rem', borderRadius: 'var(--radius-md)', fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', minHeight: '44px' };

  return (
    <section role="region" aria-labelledby="dup-review-title" aria-busy={busy} data-testid="dup-review" style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem', overflowWrap: 'anywhere' }}>
      <div>
        <h4 id="dup-review-title" ref={headingRef} tabIndex={-1} style={{ fontSize: '1.05rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.45rem', outlineOffset: '4px' }}>
          <Copy size={18} aria-hidden="true" /> Review before importing
        </h4>
        <p style={{ margin: '0.3rem 0 0', fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600 }}>
          {reviewHeadline(summary)}. Nothing has been imported yet.
        </p>
      </div>

      {stale && (
        <div data-testid="dup-stale" style={{ padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '2px solid #27272a', fontSize: '0.8rem', color: 'var(--text-primary)', fontWeight: 600 }}>
          Your transactions changed while you were reviewing, so nothing was imported and this list was refreshed. Check it again, then confirm again.
        </div>
      )}

      <ul data-testid="dup-summary" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.8rem' }}>
        <li style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}><Badge kind="new" /> <strong>{summary.new}</strong> <span className="sr-only">new rows</span></li>
        <li style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}><Badge kind="likely" /> <strong>{summary.likely}</strong></li>
        <li style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}><Badge kind="possible" /> <strong>{summary.possible}</strong></li>
      </ul>

      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <div><strong>Likely duplicate:</strong> same date, amount and description as a transaction you already have. Not selected.</div>
        <div><strong>Possible duplicate:</strong> same date and amount but a different description. It may be a different payment, so it stays selected unless you clear it.</div>
        {preview.skipped > 0 && <div>{preview.skipped} other row{preview.skipped === 1 ? ' was' : 's were'} not readable (no clear direction, date or amount) and {preview.skipped === 1 ? 'is' : 'are'} not shown.</div>}
      </div>

      <div role="group" aria-label="Rows to review" tabIndex={0} className="dup-review-list" style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {preview.rows.map((row) => {
            const kind = row.duplicate ? row.duplicate.tier : 'new';
            const isSelected = selected.has(row.index);
            return (
              <li key={row.index} data-testid={`dup-row-${row.index}`} data-tier={kind} style={{ borderBottom: '1px solid var(--border-color)', padding: '0.6rem 0.7rem', background: isSelected ? 'var(--surface-color)' : 'var(--bg-color)' }}>
                <label style={{ display: 'flex', gap: '0.65rem', alignItems: 'flex-start', cursor: busy ? 'not-allowed' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={busy}
                    onChange={() => toggle(row.index)}
                    aria-label={`Import ${row.title}, ${formatDay(row.date)}, ${formatRupees(row.amount)}, ${BADGE[kind].text}`}
                    style={{ width: '1.25rem', height: '1.25rem', marginTop: '0.1rem', flex: '0 0 auto' }}
                  />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', minWidth: 0 }}>
                    <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.4rem' }}>
                      <Badge kind={kind} />
                      <strong style={{ fontSize: '0.85rem' }}>{row.title}</strong>
                    </span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-primary)' }}>{formatDay(row.date)} · {formatRupees(row.amount)}</span>
                    {row.duplicate && (
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        Already saved: {row.duplicate.match.title} · {formatDay(row.duplicate.match.date)} · {formatRupees(row.duplicate.match.amount)}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      <p data-testid="dup-selection" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-primary)', fontWeight: 600 }}>
        Importing {counts.selected} of {summary.total} rows
        {counts.selected > 0 && ` (${counts.new} new, ${counts.possible} possible, ${counts.likely} likely)`}.
      </p>

      <div className="dup-review-actions">
        <button
          type="button" className="statement-action" onClick={() => canImportSelected && onImportSelected(selected)} disabled={!canImportSelected}
          style={{ ...common, ...importButtonStyle({ disabled: !canImportSelected, busy }) }}
        >
          {busy ? 'Importing…' : `Import selected rows (${counts.selected})`}
        </button>
        <button type="button" className="statement-action" onClick={() => !busy && onImportAll()} disabled={busy} style={{ ...common, ...secondary }}>
          Import all {summary.total} anyway
        </button>
        <button type="button" className="statement-action" onClick={() => !busy && onCancel()} disabled={busy} style={{ ...common, ...secondary }}>
          Cancel
        </button>
      </div>

      {error && (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: '0.9rem', fontWeight: 'bold', display: 'flex', gap: '0.3rem', alignItems: 'flex-start' }}>
          <AlertCircle size={16} aria-hidden="true" style={{ flex: '0 0 auto', marginTop: '0.15rem' }} />{error}
        </div>
      )}
      <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
        Cancel leaves your statement text as it is and saves nothing.
      </p>
    </section>
  );
}

export default DuplicateReview;
