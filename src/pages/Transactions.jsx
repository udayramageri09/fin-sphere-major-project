import { useEffect, useRef, useState } from 'react';
import { useFinance } from '../context/FinanceContext';
import DuplicateReview from '../components/DuplicateReview';
import SpendingAnalytics from '../components/analytics/SpendingAnalytics';
import TransactionDisclosure from '../components/TransactionDisclosure';
import CategoryPicker from '../components/CategoryPicker';
import TransactionEditor from '../components/TransactionEditor';
import AccountAggregatorSandbox from '../components/AccountAggregatorSandbox';
import { categoryChoices } from '../utils/spendingAnalytics';
import { isOcrImageFile } from '../utils/imageOcr';
import { extractPdfStatement, isPdfStatement } from '../utils/pdfStatement';
import { buildConfirmRequest, confirmSuccessMessage, reviewHeadline } from '../utils/duplicateReview';
import { explainImportError, importSuccessMessage, importButtonStyle } from '../utils/statementImportUi';
import PdfImportReview from '../components/PdfImportReview';
import { aiCandidates, applyAiSuggestions, buildPdfDraft, emptyPdfRow, needsPdfReview, PDF_CATEGORIES, pdfHistoryRules, pdfImportValue } from '../utils/pdfImportReview';
import './PdfImportReview.css';
import { 
  ShoppingBag, Coffee, ArrowDownCircle, ArrowUpCircle, 
  Trash2, Plus, FileText, Upload, Sparkles, AlertCircle, ScanText, BarChart3, Landmark
} from 'lucide-react';

// Which analytical classifications each direction can carry (mirrors the server and the database).
const CLASSIFICATION_OPTIONS = {
  income: [['income', 'Income'], ['refund', 'Refund'], ['transfer', 'Transfer'], ['unknown', 'Unknown']],
  expense: [['expense', 'Expense'], ['transfer', 'Transfer'], ['unknown', 'Unknown']],
};
const CLASSIFICATION_LABEL = { income: 'Income', expense: 'Expense', refund: 'Refund', transfer: 'Transfer', unknown: 'Unclassified' };

function Transactions() {
  const { 
    transactions, loading, addTransaction, deleteTransaction, parseStatement, confirmImport, extractTextFromImage, updateTransaction, accountAggregatorRequest,
    importReviewedPdf, getPdfRules, rememberReviewedPdf, classifyNarrations
  } = useFinance();

  const [view, setView] = useState('activity');
  const [insightsVisited, setInsightsVisited] = useState(false);
  // Manual entry state
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [type, setType] = useState('expense');
  const [category, setCategory] = useState('Shopping');
  // Pre-selected to match the direction (visible and changeable); imports and old rows are 'unknown'.
  const [classification, setClassification] = useState('expense');
  const [formSuccess, setFormSuccess] = useState('');

  // Parser state
  const [pasteText, setPasteText] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [activeTab, setActiveTab] = useState('paste'); // 'paste' or 'upload'
  const [parseSuccess, setParseSuccess] = useState('');
  const [parseError, setParseError] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  // Image upload: OCR only fills the paste editor; the user reviews it and imports it themselves.
  const [isExtracting, setIsExtracting] = useState(false);
  const [ocrNotice, setOcrNotice] = useState(null); // { fileName, confidence, warnings } for the text currently in the editor
  const [pdfDraft, setPdfDraft] = useState(null);
  const ocrInFlight = useRef(false); // synchronous guard: a second click in the same tick cannot start a second request
  // After a successful extraction the paste editor gets keyboard focus (once). The tick re-runs the effect when the editor was
  // already showing; the flag makes sure later tab switches never steal focus.
  const editorRef = useRef(null);
  const pendingEditorFocus = useRef(false);
  const [editorFocusTick, setEditorFocusTick] = useState(0);
  // Duplicate review: the server held an import back because some rows look like transactions that are already saved. Nothing has
  // been saved yet. { preview, stale, source: 'paste' | 'file', fileName }; the statement text / chosen file stays where it is.
  const [review, setReview] = useState(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const importInFlight = useRef(false); // one import request (parse or confirm) at a time, even for two clicks in the same tick
  const parseLogsRef = useRef(null);
  const parseFileRef = useRef(null);
  const fileInputRef = useRef(null);
  const focusAfterReview = useRef(null); // where focus goes when the review closes

  useEffect(() => {
    if (review || !focusAfterReview.current) return;
    const target = { paste: parseLogsRef, file: parseFileRef, editor: editorRef, picker: fileInputRef }[focusAfterReview.current];
    focusAfterReview.current = null;
    target?.current?.focus();
  }, [review]);

  useEffect(() => {
    if (!pendingEditorFocus.current || activeTab !== 'paste') return;
    const editor = editorRef.current;
    if (!editor) return;
    pendingEditorFocus.current = false;
    editor.focus();
    editor.setSelectionRange(0, 0); // caret at the start, nothing selected, text untouched: review reads from the first line
    editor.scrollTop = 0;
  }, [editorFocusTick, activeTab]);

  // Map category to icon
  const getCategoryIcon = (cat, txnType) => {
    const c = (cat || '').toLowerCase();
    if (c.includes('coffee') || c.includes('food') || c.includes('eat')) return Coffee;
    if (c.includes('shop') || c.includes('amazon')) return ShoppingBag;
    if (txnType === 'income' || c.includes('salary') || c.includes('dividend')) return ArrowUpCircle;
    return ArrowDownCircle;
  };

  const getCategoryColor = (cat, txnType) => {
    const c = (cat || '').toLowerCase();
    if (txnType === 'income' || c.includes('salary')) return '#18181b';
    return '#71717a';
  };

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    if (!title || !amount || !date) return;

    try {
      // If type is expense, make amount negative
      const parsedAmount = Math.abs(parseFloat(amount)) * (type === 'expense' ? -1 : 1);
      await addTransaction({
        title,
        amount: parsedAmount,
        date,
        type,
        category,
        classification
      });
      setTitle('');
      setAmount('');
      setFormSuccess('Transaction added successfully!');
      setTimeout(() => setFormSuccess(''), 3000);
    } catch (err) {
      console.error(err);
    }
  };

  const openReview = (preview, source, fileName) => {
    setReview({ preview, stale: false, source, fileName });
    setReviewError('');
  };

  const cancelReview = () => {
    if (isConfirming) return;
    if (review?.source !== 'pdf') focusAfterReview.current = review?.source === 'file' ? 'file' : 'paste';
    setReview(null);
    setReviewError('');
  };

  // The user's decision on a held-back import. The ORIGINAL previewed rows and digest are sent: nothing is parsed again.
  const runConfirm = async (mode, selected) => {
    if (!review || importInFlight.current) return;
    importInFlight.current = true;
    setIsConfirming(true);
    setReviewError('');
    try {
      const outcome = await confirmImport(buildConfirmRequest(review.preview, selected, mode));
      if (outcome.stale) {
        // Nothing was saved: show the refreshed review and require a new, explicit confirmation.
        setReview((current) => ({ ...current, preview: outcome.preview, stale: true }));
        return;
      }
      setParseSuccess(confirmSuccessMessage(outcome.result, review.source === 'file' ? review.fileName : undefined));
      if (review.source === 'pdf') finishPdf(outcome.result);
      else if (review.source === 'file') setUploadFile(null); else setPasteText('');
      setOcrNotice(null);
      focusAfterReview.current = review.source === 'paste' ? 'editor' : 'picker';
      setReview(null);
      setTimeout(() => setParseSuccess(''), 5000);
    } catch (err) {
      setReviewError(err.message || 'The import could not be completed. Check your transactions before trying again.');
    } finally {
      importInFlight.current = false;
      setIsConfirming(false);
    }
  };

  const handlePasteParse = async () => {
    if (!pasteText.trim() || importInFlight.current || review) return;
    importInFlight.current = true;
    setIsParsing(true);
    setParseSuccess('');
    setParseError('');
    try {
      const res = await parseStatement(pasteText);
      if (res.review) { openReview(res.preview, 'paste'); return; }
      setParseSuccess(importSuccessMessage(res));
      setPasteText('');
      setOcrNotice(null);
      setTimeout(() => setParseSuccess(''), 5000);
    } catch (err) {
      setParseError(explainImportError(err.message) || 'Failed to parse text statement');
    } finally {
      importInFlight.current = false;
      setIsParsing(false);
    }
  };

  // JPG/JPEG/PNG go to the OCR endpoint (never to parse-statement) and only fill the paste editor. Nothing is saved here.
  const handleImageExtract = async () => {
    if (!uploadFile || ocrInFlight.current) return;
    ocrInFlight.current = true;
    const file = uploadFile;
    setIsExtracting(true);
    setParseSuccess('');
    setParseError('');
    setOcrNotice(null);
    try {
      if (isPdfStatement(file)) {
        const { text, warnings, usedOcr, pages } = await extractPdfStatement(file, extractTextFromImage);
        let rules = [];
        try { rules = getPdfRules(); } catch (error) { warnings.push(error.message); }
        let rows = buildPdfDraft(text, { rules, usedOcr, pages, history: pdfHistoryRules(transactions) });
        rows = applyAiSuggestions(rows, await classifyNarrations(aiCandidates(rows)));
        if (!rows.length) warnings.push('No transaction rows could be identified. Check the extracted text and add missing rows manually.');
        setPdfDraft({ fileName: file.name, text, warnings, rows });
        setUploadFile(null);
        return;
      }
      const { text, confidence, warnings } = await extractTextFromImage(file);
      // Text already in the editor is kept (the new text goes below it) so nothing the user typed is lost.
      setPasteText((current) => (current.trim() ? `${current.replace(/\s+$/, '')}\n\n${text}` : text));
      setOcrNotice({ fileName: file.name, confidence, warnings });
      setUploadFile(null);
      pendingEditorFocus.current = true;
      setEditorFocusTick((n) => n + 1);
      setActiveTab('paste');
    } catch (err) {
      setParseError(err.message || 'Could not read the selected statement.');
    } finally {
      ocrInFlight.current = false;
      setIsExtracting(false);
    }
  };

  const finishPdf = (result) => {
    const key = ({ title, date, type, amount, category, classification }) => JSON.stringify([title, date, type, Number(amount), category, classification]);
    const imported = new Set((result.transactions ?? []).map(key));
    try {
      rememberReviewedPdf(pdfDraft.rows.filter((row) => row.remember && !row.excluded)
        .map(pdfImportValue).filter((row) => imported.has(key(row))));
    } catch (error) {
      setParseError(error.message);
    }
    setPdfDraft(null);
  };

  const savePdf = async () => {
    if (!pdfDraft || importInFlight.current) return;
    const included = pdfDraft.rows.filter((row) => !row.excluded);
    if (!included.length || included.length > 500 || included.some(needsPdfReview)) return;
    importInFlight.current = true;
    setIsParsing(true);
    setParseError('');
    setParseSuccess('');
    try {
      const result = await importReviewedPdf(included.map(pdfImportValue));
      if (result.review) { openReview(result.preview, 'pdf', pdfDraft.fileName); return; }
      finishPdf(result);
      setParseSuccess(importSuccessMessage(result, pdfDraft.fileName));
    } catch (error) {
      setParseError(error.message || 'Could not import the PDF. Check your transaction history before retrying.');
    } finally {
      setIsParsing(false);
      importInFlight.current = false;
    }
  };

  const handleFileParse = async () => {
    if (!uploadFile) return;
    if (isOcrImageFile(uploadFile) || isPdfStatement(uploadFile)) return handleImageExtract();
    if (importInFlight.current || review) return;
    importInFlight.current = true;
    setIsParsing(true);
    setParseSuccess('');
    setParseError('');
    try {
      const res = await parseStatement(uploadFile);
      if (res.review) { openReview(res.preview, 'file', uploadFile.name); return; }
      setParseSuccess(importSuccessMessage(res, uploadFile.name));
      setUploadFile(null);
      setTimeout(() => setParseSuccess(''), 5000);
    } catch (err) {
      setParseError(explainImportError(err.message) || 'Failed to parse file statement');
    } finally {
      importInFlight.current = false;
      setIsParsing(false);
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) {
      setUploadFile(file);
      // A new choice starts a new attempt: earlier errors and the earlier image's warnings no longer apply.
      setParseError('');
      setParseSuccess('');
      setOcrNotice(null);
    }
    e.target.value = ''; // so choosing the same file again still fires onChange
  };

  return (
    <div className="animate-fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h2 style={{ fontSize: '2rem', fontWeight: 700, letterSpacing: '-0.025em' }}>Transactions</h2>
        </div>
      </div>

      <nav aria-label="Transactions views" className="transaction-view-nav">
        <button type="button" aria-current={view === 'activity' ? 'page' : undefined} onClick={() => setView('activity')} className={`transaction-view-button ${view === 'activity' ? 'is-active' : ''}`}><FileText size={19} aria-hidden="true" />Activity</button>
        <button type="button" aria-current={view === 'insights' ? 'page' : undefined} onClick={() => { setView('insights'); setInsightsVisited(true); }} className={`transaction-view-button transaction-view-insights ${view === 'insights' ? 'is-active' : ''} ${!insightsVisited ? 'is-discoverable' : ''}`}><BarChart3 size={19} aria-hidden="true" />Insights</button>
      </nav>
      <div hidden={view !== 'insights'} className="mb-8 transaction-insights-panel">
        <SpendingAnalytics transactions={transactions} />
      </div>
      <div hidden={view !== 'activity'}>
      <div className="flex flex-col gap-6 items-stretch">

        {/* Left Column: Input Panel & AI Parser */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start min-w-0">
          
          {/* Manual Entry Form */}
          <TransactionDisclosure title="Add a transaction" icon={Plus} guideTip="Add a transaction manually when it isn't in your statement.">
            
            <form onSubmit={handleManualSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Transaction Type</label>
                  <select 
                    value={type} 
                    onChange={(e) => {
                      const nextType = e.target.value;
                      setType(nextType);
                      // Keep the selection if it is still valid for the new direction, otherwise fall back to the matching one.
                      setClassification((current) => (CLASSIFICATION_OPTIONS[nextType].some(([value]) => value === current) ? current : nextType));
                    }}
                    style={{ padding: '0.6rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: 'var(--text-primary)' }}
                  >
                    <option value="expense">Expense (-)</option>
                    <option value="income">Income (+)</option>
                  </select>
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <CategoryPicker label="Category" value={category} choices={[...categoryChoices(transactions), 'General']} onChange={setCategory} hint="Saved when you save the transaction." />
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <label htmlFor="tx-classification" style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Classification</label>
                <select
                  id="tx-classification"
                  value={classification}
                  onChange={(e) => setClassification(e.target.value)}
                  style={{ padding: '0.6rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: 'var(--text-primary)' }}
                >
                  {CLASSIFICATION_OPTIONS[type].map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Description</label>
                <input 
                  type="text" 
                  placeholder="e.g. Amazon Shopping, Rent, Starbuck's" 
                  value={title} 
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  style={{ padding: '0.6rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: 'var(--text-primary)' }}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Amount (₹)</label>
                  <input 
                    type="number" 
                    placeholder="0.00" 
                    value={amount} 
                    onChange={(e) => setAmount(e.target.value)}
                    required
                    min="0.01"
                    step="0.01"
                    style={{ padding: '0.6rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: 'var(--text-primary)' }}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Date</label>
                  <input 
                    type="date" 
                    value={date} 
                    onChange={(e) => setDate(e.target.value)}
                    required
                    style={{ padding: '0.6rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: 'var(--text-primary)' }}
                  />
                </div>
              </div>

              <button 
                type="submit" 
                style={{ 
                  background: 'var(--accent-primary)', 
                  color: 'white', 
                  padding: '0.75rem', 
                  borderRadius: 'var(--radius-md)', 
                  fontWeight: 'bold',
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  gap: '0.5rem',
                  marginTop: '0.5rem',
                  boxShadow: '0 4px 6px -1px rgba(64, 86, 109, 0.12)'
                }}
              >
                <Plus size={18} /> Add Transaction
              </button>

              {formSuccess && <div style={{ color: 'var(--success)', fontSize: '0.9rem', textAlign: 'center', fontWeight: 'bold' }}>{formSuccess}</div>}
            </form>
          </TransactionDisclosure>

          {/* AI Parser Section */}
          <TransactionDisclosure title="Import a statement" icon={Upload} guideTip="Upload a statement and review the extracted transactions before saving.">
            
            {/* Tabs */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', marginBottom: '1.25rem' }}>
              <button
                onClick={() => setActiveTab('paste')}
                disabled={!!review}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '0.6rem',
                  fontWeight: 600,
                  color: activeTab === 'paste' ? 'var(--accent-secondary)' : 'var(--text-secondary)',
                  borderBottom: activeTab === 'paste' ? '2px solid var(--accent-secondary)' : 'none'
                }}
              >
                Paste Text Log
              </button>
              <button
                onClick={() => setActiveTab('upload')}
                disabled={!!review}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '0.6rem',
                  fontWeight: 600,
                  color: activeTab === 'upload' ? 'var(--accent-secondary)' : 'var(--text-secondary)',
                  borderBottom: activeTab === 'upload' ? '2px solid var(--accent-secondary)' : 'none',
                  wordBreak: 'break-word'
                }}
              >
                Upload File
              </button>
            </div>

            {review ? (
              <DuplicateReview
                key={review.preview.reviewDigest}
                preview={review.preview}
                stale={review.stale}
                busy={isConfirming}
                error={reviewError}
                onImportSelected={(selected) => runConfirm('selected', selected)}
                onImportAll={() => runConfirm('all', new Set())}
                onCancel={cancelReview}
              />
            ) : pdfDraft ? (
              <PdfImportReview draft={pdfDraft} categories={[...categoryChoices(transactions), ...PDF_CATEGORIES]} busy={isParsing} onImport={savePdf}
                onCancel={() => { setPdfDraft(null); setParseError(''); }}
                onAdd={() => setPdfDraft((draft) => ({ ...draft, rows: [...draft.rows, emptyPdfRow(draft.rows.length)] }))}
                onChange={(id, patch) => setPdfDraft((draft) => ({
                  ...draft, rows: draft.rows.map((row) => row.id === id ? { ...row, ...patch } : row)
                }))} />
            ) : activeTab === 'paste' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {ocrNotice && (
                  <div role="group" id="ocr-notice" aria-labelledby="ocr-notice-title" data-testid="ocr-notice" style={{ padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-color)', fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.4rem', overflowWrap: 'anywhere' }}>
                    <div id="ocr-notice-title" style={{ fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <ScanText size={16} aria-hidden="true" /> Text read from {ocrNotice.fileName}
                    </div>
                    <div>Review and correct it below. Nothing has been imported or saved yet; it is only imported when you press &ldquo;Parse Logs&rdquo;.</div>
                    {ocrNotice.confidence !== null && (
                      <div>Recognition confidence: {ocrNotice.confidence}%. This is only an estimate, not proof the text is right: check every date and amount.</div>
                    )}
                    {ocrNotice.warnings.length > 0 && (
                      <ul style={{ margin: 0, paddingLeft: '1.1rem', color: 'var(--text-primary)' }}>
                        {ocrNotice.warnings.map((warning, i) => <li key={i}>{warning}</li>)}
                      </ul>
                    )}
                    <div>Every line needs a date and an amount with a +/&minus; sign or a DR/CR marker, otherwise it is skipped.</div>
                    <div>{/\.pdf$/i.test(ocrNotice.fileName) ? 'PDF text was read in your browser; scanned pages were sent to the server for OCR.' : 'The image was read by OCR on this server and is not stored.'} When you press &ldquo;Parse Logs&rdquo;, the text may be sent to Groq (an external AI service) if it is configured; otherwise a built-in parser is used.</div>
                  </div>
                )}
                <textarea 
                  ref={editorRef}
                  aria-label="Statement text to import"
                  aria-describedby={ocrNotice ? 'ocr-notice' : undefined}
                  rows={5} 
                  placeholder="Paste transaction logs from mail or statement here. E.g.:&#13;20/05/2026 Amazon Spend -1599.00&#13;22/05/2026 Salary Credit +150000.00"
                  value={pasteText}
                  onChange={(e) => { setPasteText(e.target.value); if (!e.target.value.trim()) setOcrNotice(null); }}
                  style={{ 
                    padding: '0.75rem', 
                    borderRadius: 'var(--radius-sm)', 
                    border: '1px solid var(--border-color)', 
                    background: 'var(--surface-color)', 
                    color: 'var(--text-primary)', 
                    fontFamily: 'monospace',
                    fontSize: '0.85rem',
                    resize: 'vertical'
                  }}
                />
                <button 
                  ref={parseLogsRef}
                  className="statement-action"
                  onClick={handlePasteParse}
                  disabled={isParsing || isExtracting || !pasteText.trim()}
                  style={{ 
                    padding: '0.75rem', 
                    borderRadius: 'var(--radius-md)', 
                    fontWeight: 'bold',
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center', 
                    gap: '0.5rem',
                    ...importButtonStyle({ disabled: isParsing || isExtracting || !pasteText.trim(), busy: isParsing })
                  }}
                >
                  <Sparkles size={18} /> {isParsing ? 'Parsing statement...' : 'Parse Logs'}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="upload-dropzone" style={{
                  border: '2px dashed var(--border-color)', 
                  borderRadius: 'var(--radius-md)', 
                  padding: '2rem', 
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '0.5rem',
                  cursor: 'pointer',
                  position: 'relative'
                }}>
                  <Upload size={32} color="var(--text-secondary)" />
                  <span style={{ fontSize: '0.9rem', fontWeight: 600, overflowWrap: 'anywhere' }}>
                    {uploadFile ? uploadFile.name : 'Select statement file'}
                  </span>
                  <span id="statement-upload-hint" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    Supports TXT, CSV, XLS, XLSX, PDF, JPG, JPEG and PNG
                  </span>
                  <input 
                    type="file" 
                    ref={fileInputRef}
                    aria-label="Choose a statement file: TXT, CSV, XLS, XLSX, PDF, JPG, JPEG or PNG"
                    aria-describedby="statement-upload-hint ocr-privacy-note"
                    accept=".csv,.txt,.xls,.xlsx,.pdf,.jpg,.jpeg,.png"
                    onChange={handleFileChange}
                    disabled={isExtracting}
                    style={{ 
                      position: 'absolute', 
                      top: 0, left: 0, width: '100%', height: '100%', 
                      opacity: 0, cursor: 'pointer' 
                    }}
                  />
                </div>
                <p id="ocr-privacy-note" data-testid="ocr-privacy-note" style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
                  Images are read with OCR on this server and are not stored. PDF text is read in your browser and scanned pages also use this server's OCR. You can review and edit PDF rows before saving; unfamiliar descriptions may be categorised with AI (Groq).
                </p>
                <button 
                  ref={parseFileRef}
                  className="statement-action"
                  onClick={handleFileParse}
                  disabled={isParsing || isExtracting || !uploadFile}
                  style={{ 
                    padding: '0.75rem', 
                    borderRadius: 'var(--radius-md)', 
                    fontWeight: 'bold',
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center', 
                    gap: '0.5rem',
                    ...importButtonStyle({ disabled: isParsing || isExtracting || !uploadFile, busy: isParsing || isExtracting })
                  }}
                >
                  {uploadFile && (isOcrImageFile(uploadFile) || isPdfStatement(uploadFile))
                    ? <><ScanText size={18} /> {isExtracting ? (isPdfStatement(uploadFile) ? 'Reading PDF...' : 'Reading image... (up to 30 s)') : isPdfStatement(uploadFile) ? 'Read PDF and review transactions' : 'Extract Text from Image'}</>
                    : <><FileText size={18} /> {isParsing ? 'Parsing statement...' : 'Parse File'}</>}
                </button>
              </div>
            )}

            {/* One live region that is always in the page, so screen readers announce changes reliably (a region inserted together with
                its text is often missed). Visually hidden; the visible notice above the editor carries the same information. */}
            <div role="status" aria-live="polite" className="sr-only" data-testid="ocr-live">
              {isExtracting
                ? 'Reading the image. This can take up to 30 seconds.'
                : isConfirming
                  ? 'Importing the selected rows.'
                  : review
                    ? (review.stale
                      ? 'Your transactions changed, so nothing was imported. The review was refreshed. Check it and confirm again.'
                      : `${reviewHeadline(review.preview.summary)}. Nothing has been imported yet. Review the rows, then choose Import selected rows, Import all anyway or Cancel.`)
                    : ocrNotice
                  ? `Text read from ${ocrNotice.fileName}. Nothing has been imported yet. Review and correct the text before importing.${ocrNotice.warnings.length ? ` ${ocrNotice.warnings.length} warning${ocrNotice.warnings.length === 1 ? '' : 's'} shown above the text.` : ''}`
                  : ''}
            </div>

            {parseSuccess && <div style={{ color: 'var(--success)', fontSize: '0.9rem', textAlign: 'center', fontWeight: 'bold', marginTop: '1rem', overflowWrap: 'anywhere' }}>{parseSuccess}</div>}
            {parseError && <div role="alert" style={{ color: 'var(--danger)', fontSize: '0.9rem', textAlign: 'center', fontWeight: 'bold', marginTop: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', overflowWrap: 'anywhere' }}><AlertCircle size={16} />{parseError}</div>}
          </TransactionDisclosure>

          {import.meta.env.DEV && accountAggregatorRequest && (
            <TransactionDisclosure title="Account Aggregator Sandbox" hint="Preview demo financial records and optionally import sample transactions" icon={Landmark}>
              <AccountAggregatorSandbox request={accountAggregatorRequest} />
            </TransactionDisclosure>
          )}
        </div>

        {/* Right Column: Transaction History */}
        <TransactionDisclosure title={`Transaction history (${transactions.length})`} icon={FileText} guideTip="Open your history to review transactions or correct their categories.">
          {loading && transactions.length === 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '300px', color: 'var(--text-secondary)' }}>
              Loading transactions...
            </div>
          ) : transactions.length === 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '300px', color: 'var(--text-secondary)', flexDirection: 'column', gap: '0.5rem' }}>
              <FileText size={40} color="var(--border-color)" />
              No transactions yet. Add one above!
            </div>
          ) : (
            <div className="lg:max-h-170 lg:overflow-y-auto lg:pr-2" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {[...transactions].sort((a, b) => String(b.date).localeCompare(String(a.date))).map((t) => {
                const Icon = getCategoryIcon(t.category, t.type);
                const color = getCategoryColor(t.category, t.type);
                
                return (
                  <div 
                    key={t.id} 
                    className="transaction-item" 
                    style={{
                      padding: '1rem',
                      background: 'var(--bg-color)',
                      borderRadius: 'var(--radius-md)',
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      rowGap: '0.5rem',
                      columnGap: '0.75rem',
                      border: '1px solid var(--border-color)',
                      transition: 'transform 0.2s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: 0 }}>
                      <div style={{ 
                        background: `${color}20`, 
                        color: color,
                        width: '40px',
                        height: '40px',
                        flexShrink: 0,
                        borderRadius: '50%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>
                        <Icon size={20} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <h4 style={{ fontSize: '1rem', fontWeight: 600, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</h4>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.1rem' }}>
                          <span style={{ fontSize: '0.75rem', background: 'var(--border-color)', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>
                            {t.category || 'General'}
                          </span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            {CLASSIFICATION_LABEL[t.classification ?? 'unknown']}
                          </span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            {new Date(t.date).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })}
                          </span>
                        </div>
                      </div>
                    </div>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexShrink: 0, marginLeft: 'auto' }}>
                      <span style={{ color: color, fontSize: '1.05rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {t.amount > 0 ? '+' : ''}{t.amount.toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}
                      </span>
                      <button 
                        onClick={() => deleteTransaction(t.id)}
                        aria-label={`Delete transaction ${t.title}`}
                        style={{ 
                          color: 'var(--text-secondary)',
                          cursor: 'pointer',
                          padding: '0.3rem',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          transition: 'background 0.2s'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.color = 'var(--danger)'}
                        onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-secondary)'}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <TransactionEditor transaction={t} choices={categoryChoices(transactions)} onSave={updateTransaction} />
                  </div>
                );
              })}
            </div>
          )}
        </TransactionDisclosure>

      </div>
      </div>
    </div>
  );
}

export default Transactions;
