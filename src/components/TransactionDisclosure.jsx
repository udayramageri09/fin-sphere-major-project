import { useId, useState } from 'react';
import './TransactionDisclosure.css';

// Content stays mounted so an OCR review or unsaved entry survives closing the panel.
export default function TransactionDisclosure({ title, hint, guideTip, icon: Icon, children }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className="transaction-disclosure glass-panel" data-testid="transaction-disclosure">
    <button type="button" className="transaction-disclosure-trigger" data-guide-tip={guideTip} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span className="transaction-disclosure-icon" aria-hidden="true"><Icon size={20} strokeWidth={1.7} /></span>
      <span className="transaction-disclosure-copy"><span className="transaction-disclosure-title">{title}</span><span className="transaction-disclosure-hint">{hint}</span></span>
      <span className="transaction-disclosure-toggle" aria-hidden="true"><span /><span className={open ? 'is-open' : ''} /></span>
    </button>
    <div id={id} className={`transaction-disclosure-content ${open ? 'is-open' : ''}`} aria-hidden={!open} inert={!open}>
      <div className="transaction-disclosure-clip"><div className="transaction-disclosure-body">{children}</div></div>
    </div>
  </section>;
}
