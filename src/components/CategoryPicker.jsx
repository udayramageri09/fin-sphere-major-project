import { useEffect, useId, useRef, useState } from 'react';
import './CategoryPicker.css';

export default function CategoryPicker({ label, value, choices, onChange, disabled = false, compact = false, hint = 'Saved with the transaction.', actionLabel = 'Use category' }) {
  const id = useId();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [local, setLocal] = useState([]);
  const opener = useRef(null);
  const input = useRef(null);
  useEffect(() => { if (creating) input.current?.focus(); }, [creating]);
  const available = [...new Set([...choices, ...local, value].filter(Boolean))];
  const apply = () => {
    const name = draft.trim();
    if (!name || name.length > 60 || /[\p{Cc}\p{Cf}]/u.test(name)) { setError('Use 1–60 characters without control characters.'); return; }
    const existing = available.find(c => c.toLowerCase() === name.toLowerCase());
    const category = existing ?? name;
    if (!existing) setLocal(old => [...old, category]);
    onChange(category); setCreating(false); setDraft(''); setError(''); opener.current?.focus();
  };
  return <div className="category-picker">
    <label htmlFor={`${id}-select`} className={compact ? 'sr-only' : 'category-picker-label'}>{label}</label>
    <div className="category-picker-row">
      <select id={`${id}-select`} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>{available.map(name => <option key={name} value={name}>{name}</option>)}</select>
      <button type="button" ref={opener} className="category-create-button" aria-expanded={creating} aria-controls={`${id}-editor`} onClick={() => { setCreating(open => !open); setError(''); }} disabled={disabled}>+ New category</button>
    </div>
    {creating && <div id={`${id}-editor`} className="category-create-editor">
      <label htmlFor={`${id}-name`}>New category name</label>
      <input ref={input} id={`${id}-name`} type="text" value={draft} maxLength={60} onChange={e => { setDraft(e.target.value); setError(''); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } if (e.key === 'Escape') { e.preventDefault(); setCreating(false); opener.current?.focus(); } }} disabled={disabled} aria-invalid={!!error} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`} />
      <p id={`${id}-hint`}>{hint}</p>
      {error && <p role="alert" id={`${id}-error`}>{error}</p>}
      <div className="category-create-actions"><button type="button" onClick={apply} disabled={disabled}>{actionLabel}</button><button type="button" onClick={() => { setCreating(false); setError(''); opener.current?.focus(); }} disabled={disabled}>Cancel</button></div>
    </div>}
  </div>;
}
