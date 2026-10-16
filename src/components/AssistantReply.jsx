import './AssistantReply.css';

// A small presentation-only subset of Markdown. React escapes all source text;
// HTML, images and executable links are never interpreted. Raw replies/history/speech stay unchanged.
function inline(text) {
  return String(text).split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|[-−]?₹\s?[\d,]+(?:\.\d+)?)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (/^\[/.test(part)) return <span key={i}>{part.match(/^\[([^\]]+)\]/)?.[1] ?? part}</span>;
    if (/^[-−]?₹/.test(part)) return <strong key={i} className="assistant-amount">{part}</strong>;
    return part;
  });
}
const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
const isDivider = line => line.includes('|') && cells(line).every(c => /^:?-{3,}:?$/.test(c));
const isList = line => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line);

export default function AssistantReply({ text = '', visualization = null }) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) { blocks.push(<h4 key={i}>{inline(heading[1])}</h4>); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const headers = cells(line), rows = []; const key = i;
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(cells(lines[i])); i++; }
      blocks.push(<div key={key} className="assistant-table-scroll" role="region" aria-label="Answer data table" tabIndex={0}><table><caption className="assistant-sr-only">Answer breakdown</caption><thead><tr>{headers.map((h, n) => <th scope="col" key={n}>{inline(h)}</th>)}</tr></thead><tbody>{rows.map((r, n) => <tr key={n}>{Array.from({ length: Math.max(headers.length, r.length) }, (_, c) => <td key={c}>{inline(r[c] ?? '')}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (isList(line)) {
      const ordered = /^\d+[.)]/.test(line), key = i, items = [];
      const firstNumber = ordered ? Number(line.match(/^\d+/)[0]) : undefined;
      while (i < lines.length && isList(lines[i]) && /^\s*\d+[.)]/.test(lines[i]) === ordered) { items.push(lines[i].replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')); i++; }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(<List key={key} start={firstNumber}>{items.map((item, n) => <li key={n}>{inline(item)}</li>)}</List>);
      continue;
    }
    const key = i, paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s+/.test(lines[i].trim()) && !isList(lines[i].trim()) && !(lines[i].includes('|') && i + 1 < lines.length && isDivider(lines[i + 1]))) { paragraph.push(lines[i].trim()); i++; }
    const prose = paragraph.join(' ');
    // Existing deterministic replies are plain prose. Separate long answers at sentence boundaries
    // without summarising, recalculating figures, changing caveats or adding financial claims.
    const sentences = prose.length > 220 ? prose.split(/(?<=[.!?])\s+(?=[A-Z₹])/u) : [prose];
    blocks.push(<div key={key} className="assistant-prose">{sentences.map((sentence, n) => <p key={n} className={n === 0 && key === 0 ? 'assistant-answer-lead' : undefined}>{inline(sentence)}</p>)}</div>);
  }
  const rows = visualization?.rows;
  const valid = typeof visualization?.title === 'string' && Array.isArray(rows) && rows.length > 0 && rows.length <= 10
    && rows.every(row => typeof row.label === 'string' && typeof row.amount === 'number' && Number.isFinite(row.amount));
  const maximum = valid ? Math.max(1, ...rows.map(row => Math.abs(row.amount))) : 1;
  const money = amount => amount.toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
  return <div className="assistant-reply">{blocks}{valid && <section className="assistant-data" aria-label={visualization.title}>
    <h4>{visualization.title}</h4>
    {visualization.provisional && <p>Provisional: includes unclassified transactions.</p>}
    <dl className="assistant-data-cards">{rows.map((row, i) => <div key={i}><dt>{row.label}</dt><dd>{money(row.amount)}</dd></div>)}</dl>
    <div className="assistant-bars" aria-hidden="true">{rows.map((row, i) => <div key={i}><span>{row.label}</span><div className="assistant-bar" style={{ width: `${Math.abs(row.amount) / maximum * 100}%` }} /></div>)}</div>
    <details><summary>View exact figures</summary><div className="assistant-table-scroll" role="region" aria-label="Recorded cash flow table" tabIndex={0}><table><caption>{visualization.title}</caption><thead><tr><th scope="col">Measure</th><th scope="col">Amount</th></tr></thead><tbody>{rows.map((row, i) => <tr key={i}><th scope="row">{row.label}</th><td>{money(row.amount)}</td></tr>)}</tbody></table></div></details>
  </section>}</div>;
}
