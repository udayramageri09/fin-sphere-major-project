import { useState } from 'react';
import CategoryPicker from './CategoryPicker';
import { formatRupees } from '../utils/duplicateReview';
import { needsPdfReview, validPdfRow, PDF_CLASSIFICATIONS, pdfRuleKey } from '../utils/pdfImportReview';

const classificationLabels = {
  income: 'Income — salary, interest, dividends',
  refund: 'Refund — money returned',
  expense: 'Expense — money spent',
  transfer: 'Transfer — between your accounts'
};

function PdfRow({ row, categories, busy, onChange }) {
  const [details, setDetails] = useState(!row.title || !row.date || !row.amount || !row.type);
  const pending = needsPdfReview(row);
  const patch = (changes) => onChange(row.id, changes);
  const edit = (changes) => patch({ ...changes, reviewed: false, edited: true });
  const status = row.excluded ? 'Excluded' : row.reviewed ? 'Confirmed' : pending ? 'Needs review' : row.provisional ? 'Auto-confirmed' : 'Auto-classified';
  return (
    <fieldset className="pdf-review-row" data-pending={pending} disabled={busy}>
      <legend className="sr-only">Transaction {row.id + 1}</legend>
      <div className="pdf-row-heading">
        <div>
          <strong>{row.title || `Transaction ${row.id + 1}`}</strong>
          <p>{row.date || 'Date missing'} · {row.type === 'expense' ? 'Money out' : row.type === 'income' ? 'Money in' : 'Direction missing'}</p>
        </div>
        <div className="pdf-row-amount">
          <strong>{row.amount ? formatRupees(Number(row.amount) * (row.type === 'expense' ? -1 : 1)) : 'Amount missing'}</strong>
          <span className="pdf-row-status" data-pending={pending}>{status}</span>
        </div>
      </div>

      {!row.excluded && <>
        <p className="pdf-review-muted">{row.edited ? 'Edited by you' : [row.reason, `${row.confidence}/100 rule score`].filter(Boolean).join(' · ')}</p>
        <div className="pdf-review-fields">
          <CategoryPicker label="Category" value={row.category} choices={categories}
            placeholder="Choose a category" onChange={(category) => edit({ category })}
            hint="Use this category for the current transaction." />
          <label>Classification<select value={row.classification} disabled={!row.type} onChange={(event) => {
            const classification = event.target.value;
            edit({ classification, ...(!row.category && classification === 'transfer' ? { category: 'Transfers' } : {}) });
          }}>
            <option value="">{row.type ? 'Choose a classification' : 'Set money direction first'}</option>
            {(PDF_CLASSIFICATIONS[row.type] ?? []).map((name) => <option key={name} value={name}>{classificationLabels[name]}</option>)}
          </select></label>
        </div>
        {details && <div className="pdf-review-fields pdf-review-details">
          <label>Description<input value={row.title} maxLength={120} onChange={(event) => edit({ title: event.target.value })} /></label>
          <label>Date<input type="date" value={row.date} onChange={(event) => edit({ date: event.target.value })} /></label>
          <label>Amount<input inputMode="decimal" value={row.amount} onChange={(event) => edit({ amount: event.target.value })} /></label>
          <label>Direction<select value={row.type} onChange={(event) => edit({ type: event.target.value, classification: '' })}>
            <option value="">Choose direction</option><option value="expense">Money out</option><option value="income">Money in</option>
          </select></label>
        </div>}
        {(pending || row.reviewed) && <label className="pdf-remember">
          <input type="checkbox" checked={row.remember} disabled={!pdfRuleKey(row.title, row.type)} onChange={(event) => patch({ remember: event.target.checked })} />
          Remember this for matching descriptions
        </label>}
      </>}

      <div className="pdf-review-actions pdf-row-actions">
        {!row.excluded && <button type="button" className="transaction-edit-button" aria-expanded={details} onClick={() => setDetails(!details)}>{details ? 'Hide details' : 'Edit details'}</button>}
        <button type="button" className="transaction-edit-button" onClick={() => patch({ excluded: !row.excluded })}>{row.excluded ? 'Restore row' : 'Exclude row'}</button>
        {pending && <button type="button" className="transaction-edit-button pdf-primary" disabled={!validPdfRow(row)} onClick={() => patch({ reviewed: true })}>Confirm row</button>}
      </div>
      {row.source && <details className="pdf-source"><summary>Original statement line</summary><pre>{row.source}</pre></details>}
    </fieldset>
  );
}

export default function PdfImportReview({ draft, categories, onChange, onAdd, onCancel, onImport, busy }) {
  const [filter, setFilter] = useState(null);
  const included = draft.rows.filter((row) => !row.excluded);
  const pending = included.filter(needsPdfReview);
  const automatic = included.filter((row) => !needsPdfReview(row) && !row.reviewed);
  const provisional = automatic.filter((row) => row.provisional).length;
  const confirmed = included.filter((row) => row.reviewed).length;
  const excluded = draft.rows.length - included.length;
  const currentFilter = filter ?? (pending.length ? 'pending' : 'all');
  const visible = currentFilter === 'pending' ? pending : draft.rows;
  const blocked = pending.length > 0 || !included.length || included.length > 500;
  return (
    <section className="pdf-import-review" aria-label="PDF transaction review">
      <header className="pdf-review-header">
        <h3>Review PDF transactions</h3>
        <p className="pdf-review-muted">{draft.fileName}</p>
        <p>Prefilled rows are ready to import. Unclear or edited rows still need review.</p>
        <div className="pdf-review-counts" role="status">
          <span><strong>{pending.length}</strong> need review</span>
          <span><strong>{automatic.length}</strong> ready automatically</span>
          {confirmed > 0 && <span><strong>{confirmed}</strong> confirmed</span>}
          {excluded > 0 && <span><strong>{excluded}</strong> excluded</span>}
        </div>
      </header>
      {draft.warnings.length > 0 && <ul className="pdf-review-warnings">{draft.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {provisional > 0 && <p className="pdf-review-empty">
        Some rows are ready with low-confidence suggestions. Check them under <strong>All rows</strong>, especially for transfers and refunds.
      </p>}
      <div className="pdf-review-actions">
        <button type="button" className="transaction-edit-button" aria-pressed={currentFilter === 'pending'} onClick={() => setFilter('pending')} disabled={busy}>Needs review ({pending.length})</button>
        <button type="button" className="transaction-edit-button" aria-pressed={currentFilter === 'all'} onClick={() => setFilter('all')} disabled={busy}>All rows ({draft.rows.length})</button>
        <button type="button" className="transaction-edit-button" onClick={onAdd} disabled={busy}>Add missing row</button>
      </div>
      {!visible.length && <p className="pdf-review-empty">{draft.rows.length ? 'No rows need review. Use All rows to check the suggestions or restore an excluded transaction.' : 'No transactions detected. Check the extracted text or add a row.'}</p>}
      {visible.map((row) => <PdfRow key={row.id} {...{ row, categories, busy, onChange }} />)}
      <details className="pdf-source"><summary>View extracted statement text</summary><pre>{draft.text}</pre></details>
      <footer className="pdf-review-footer">
        {included.length > 500 ? <p role="alert">Import at most 500 rows at a time. Split the PDF into smaller files.</p>
          : pending.length > 0 && <p className="pdf-review-muted">Confirm or exclude the {pending.length} remaining {pending.length === 1 ? 'row' : 'rows'} to continue.</p>}
        <div className="pdf-review-actions">
          <button type="button" className="transaction-edit-button pdf-primary" disabled={blocked || busy} onClick={onImport}>{busy ? 'Checking and importing…' : `Import ${included.length} ${included.length === 1 ? 'row' : 'rows'}`}</button>
          <button type="button" className="transaction-edit-button" disabled={busy} onClick={onCancel}>Cancel review</button>
        </div>
      </footer>
    </section>
  );
}
