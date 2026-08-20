import { useState } from 'react';
import { useFinance } from '../context/FinanceContext';
import { 
  ShoppingBag, Coffee, ArrowDownCircle, ArrowUpCircle, 
  Trash2, Plus, FileText, Upload, Sparkles, AlertCircle 
} from 'lucide-react';

function Transactions() {
  const { 
    transactions, loading, addTransaction, deleteTransaction, parseStatement 
  } = useFinance();

  // Manual entry state
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [type, setType] = useState('expense');
  const [category, setCategory] = useState('Shopping');
  const [formSuccess, setFormSuccess] = useState('');

  // Parser state
  const [pasteText, setPasteText] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [activeTab, setActiveTab] = useState('paste'); // 'paste' or 'upload'
  const [parseSuccess, setParseSuccess] = useState('');
  const [parseError, setParseError] = useState('');
  const [isParsing, setIsParsing] = useState(false);

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
        category
      });
      setTitle('');
      setAmount('');
      setFormSuccess('Transaction added successfully!');
      setTimeout(() => setFormSuccess(''), 3000);
    } catch (err) {
      console.error(err);
    }
  };

  const handlePasteParse = async () => {
    if (!pasteText.trim()) return;
    setIsParsing(true);
    setParseSuccess('');
    setParseError('');
    try {
      const res = await parseStatement(pasteText);
      setParseSuccess(`Success! Imported ${res.count} transactions.`);
      setPasteText('');
      setTimeout(() => setParseSuccess(''), 5000);
    } catch (err) {
      setParseError(err.message || 'Failed to parse text statement');
    } finally {
      setIsParsing(false);
    }
  };

  const handleFileParse = async () => {
    if (!uploadFile) return;
    setIsParsing(true);
    setParseSuccess('');
    setParseError('');
    try {
      const res = await parseStatement(uploadFile);
      setParseSuccess(`Success! Imported ${res.count} transactions from ${uploadFile.name}.`);
      setUploadFile(null);
      setTimeout(() => setParseSuccess(''), 5000);
    } catch (err) {
      setParseError(err.message || 'Failed to parse file statement');
    } finally {
      setIsParsing(false);
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setUploadFile(e.target.files[0]);
    }
  };

  return (
    <div className="animate-fade-in" style={{ padding: '2rem', maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h2 style={{ fontSize: '2rem', fontWeight: 700, letterSpacing: '-0.025em' }}>Transactions Center</h2>
          <p style={{ color: 'var(--text-secondary)' }}>Manage your accounts, add transactions manually, or upload a bank statement to parse.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', alignItems: 'start' }}>
        
        {/* Left Column: Input Panel & AI Parser */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          
          {/* Manual Entry Form */}
          <div className="glass-panel" style={{ padding: '1.5rem' }}>
            <h3 style={{ fontSize: '1.25rem', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Plus size={20} color="var(--accent-primary)" />
              Manual Transaction Entry
            </h3>
            
            <form onSubmit={handleManualSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Transaction Type</label>
                  <select 
                    value={type} 
                    onChange={(e) => setType(e.target.value)}
                    style={{ padding: '0.6rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: 'var(--text-primary)' }}
                  >
                    <option value="expense">Expense (-)</option>
                    <option value="income">Income (+)</option>
                  </select>
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Category</label>
                  <select 
                    value={category} 
                    onChange={(e) => setCategory(e.target.value)}
                    style={{ padding: '0.6rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: 'var(--text-primary)' }}
                  >
                    <option value="Shopping">Shopping</option>
                    <option value="Food">Food</option>
                    <option value="Salary">Salary</option>
                    <option value="Investment">Investment</option>
                    <option value="Bills">Bills</option>
                    <option value="Entertainment">Entertainment</option>
                    <option value="Travel">Travel</option>
                    <option value="General">General</option>
                  </select>
                </div>
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

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
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
                  boxShadow: '0 4px 6px -1px rgba(37, 99, 235, 0.2)'
                }}
              >
                <Plus size={18} /> Add Transaction
              </button>

              {formSuccess && <div style={{ color: 'var(--success)', fontSize: '0.9rem', textAlign: 'center', fontWeight: 'bold' }}>{formSuccess}</div>}
            </form>
          </div>

          {/* AI Parser Section */}
          <div className="glass-panel" style={{ padding: '1.5rem' }}>
            <h3 style={{ fontSize: '1.25rem', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Sparkles size={20} color="var(--accent-secondary)" />
              Smart Bank Statement Parser
            </h3>
            
            {/* Tabs */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', marginBottom: '1.25rem' }}>
              <button 
                onClick={() => setActiveTab('paste')}
                style={{ 
                  flex: 1, 
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
                style={{ 
                  flex: 1, 
                  padding: '0.6rem', 
                  fontWeight: 600, 
                  color: activeTab === 'upload' ? 'var(--accent-secondary)' : 'var(--text-secondary)',
                  borderBottom: activeTab === 'upload' ? '2px solid var(--accent-secondary)' : 'none'
                }}
              >
                Upload File (.txt/.csv/.xls/.xlsx)
              </button>
            </div>

            {activeTab === 'paste' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <textarea 
                  rows={5} 
                  placeholder="Paste transaction logs from mail or statement here. E.g.:&#13;05/20/2026 Amazon Spend -1599.00&#13;05/22/2026 Salary Credit +150000.00" 
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
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
                  onClick={handlePasteParse}
                  disabled={isParsing || !pasteText.trim()}
                  style={{ 
                    background: isParsing ? 'var(--text-secondary)' : 'var(--accent-secondary)', 
                    color: 'white', 
                    padding: '0.75rem', 
                    borderRadius: 'var(--radius-md)', 
                    fontWeight: 'bold',
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center', 
                    gap: '0.5rem',
                    cursor: isParsing || !pasteText.trim() ? 'not-allowed' : 'pointer'
                  }}
                >
                  <Sparkles size={18} /> {isParsing ? 'Parsing statement...' : 'Parse Logs (AI-Powered)'}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div style={{ 
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
                  <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                    {uploadFile ? uploadFile.name : 'Select statement file'}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    Supports TXT, CSV, XLS, XLSX formats
                  </span>
                  <input 
                    type="file" 
                    accept=".csv,.txt,.xls,.xlsx"
                    onChange={handleFileChange}
                    style={{ 
                      position: 'absolute', 
                      top: 0, left: 0, width: '100%', height: '100%', 
                      opacity: 0, cursor: 'pointer' 
                    }}
                  />
                </div>
                <button 
                  onClick={handleFileParse}
                  disabled={isParsing || !uploadFile}
                  style={{ 
                    background: isParsing ? 'var(--text-secondary)' : 'var(--accent-secondary)', 
                    color: 'white', 
                    padding: '0.75rem', 
                    borderRadius: 'var(--radius-md)', 
                    fontWeight: 'bold',
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center', 
                    gap: '0.5rem',
                    cursor: isParsing || !uploadFile ? 'not-allowed' : 'pointer'
                  }}
                >
                  <FileText size={18} /> {isParsing ? 'Parsing statement...' : 'Parse File (AI-Powered)'}
                </button>
              </div>
            )}

            {parseSuccess && <div style={{ color: 'var(--success)', fontSize: '0.9rem', textAlign: 'center', fontWeight: 'bold', marginTop: '1rem' }}>{parseSuccess}</div>}
            {parseError && <div style={{ color: 'var(--danger)', fontSize: '0.9rem', textAlign: 'center', fontWeight: 'bold', marginTop: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem' }}><AlertCircle size={16} />{parseError}</div>}
          </div>

        </div>

        {/* Right Column: Transaction History */}
        <div className="glass-panel" style={{ padding: '1.5rem', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <h3 style={{ fontSize: '1.25rem', marginBottom: '1.25rem' }}>Transaction History ({transactions.length})</h3>
          
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '680px', overflowY: 'auto', paddingRight: '0.5rem' }}>
              {transactions.map((t) => {
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
                      justifyContent: 'space-between',
                      alignItems: 'center',
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
                            {new Date(t.date).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })}
                          </span>
                        </div>
                      </div>
                    </div>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexShrink: 0, marginLeft: '1rem' }}>
                      <span style={{ color: color, fontSize: '1.05rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {t.amount > 0 ? '+' : ''}{t.amount.toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}
                      </span>
                      <button 
                        onClick={() => deleteTransaction(t.id)}
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
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

export default Transactions;
