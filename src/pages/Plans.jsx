/* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
import { useState, useEffect, useRef, useCallback } from 'react';
import './Plans.css';
import { useFinance } from '../context/FinanceContext';
import { buildChatHistory } from '../utils/chatHistory';
import {
  Brain, Send, Mic, MicOff, RefreshCw, AlertTriangle, CheckCircle,
  TrendingUp, TrendingDown, Minus, Activity, Target, Shield,
  BarChart2, Zap, ChevronRight, Info
} from 'lucide-react';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api';

// ── Helpers ──────────────────────────────────────────────────────────────────

function TrendIcon({ direction }) {
  if (direction === 'rising') return <TrendingUp size={14} className="trend-up" />;
  if (direction === 'falling') return <TrendingDown size={14} className="trend-down" />;
  return <Minus size={14} className="trend-stable" />;
}

function HealthGauge({ score, grade }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 85 ? '#18181b' : score >= 70 ? '#3f3f46' : score >= 55 ? '#71717a' : '#a1a1aa';

  return (
    <div className="health-gauge-wrap">
      <svg width="130" height="130" viewBox="0 0 130 130">
        <circle cx="65" cy="65" r={radius} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="12" />
        <circle
          cx="65" cy="65" r={radius} fill="none"
          stroke={color} strokeWidth="12"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 65 65)"
          style={{ transition: 'stroke-dashoffset 1.2s ease-in-out' }}
        />
        <text x="65" y="60" textAnchor="middle" fill={color} fontSize="26" fontWeight="700">{score}</text>
        <text x="65" y="78" textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="12">/100</text>
        <text x="65" y="96" textAnchor="middle" fill={color} fontSize="16" fontWeight="700">{grade?.grade}</text>
      </svg>
      <div className="gauge-label" style={{ color }}>{grade?.label} {grade?.emoji}</div>
    </div>
  );
}

function RatioBar({ label, value, unit, score, benchmark, status }) {
  const color = status === 'good' ? '#18181b' : status === 'fair' ? '#52525b' : '#a1a1aa';
  return (
    <div className="ratio-bar-item">
      <div className="ratio-header">
        <span className="ratio-label">{label}</span>
        <span className="ratio-value" style={{ color }}>{value}{unit}</span>
      </div>
      <div className="ratio-track">
        <div className="ratio-fill" style={{ width: `${Math.min(score, 100)}%`, background: color }} />
      </div>
      <div className="ratio-bench">{benchmark}</div>
    </div>
  );
}

function PlanStep({ step, index, isActive, onClick }) {
  const priorityColor = {
    critical: '#09090b',
    high: '#27272a',
    medium: '#52525b',
    low: '#a1a1aa'
  }[step.priority] || '#71717a';

  const actionIcon = step.action_type === 'alert' ? AlertTriangle :
    step.action_type === 'opportunity' ? TrendingUp : CheckCircle;
  const ActionIcon = actionIcon;

  return (
    <div
      className={`plan-step ${isActive ? 'active' : ''}`}
      data-avatar-target={`plan-step-${step.step_id}`}
      onClick={() => onClick(index)}
    >
      <div className="step-index" style={{ background: priorityColor }}>{index + 1}</div>
      <div className="step-content">
        <div className="step-header">
          <ActionIcon size={14} style={{ color: priorityColor, flexShrink: 0 }} />
          <span className="step-title">{step.title}</span>
          <span className="step-priority-badge" style={{ background: `${priorityColor}20`, color: priorityColor }}>
            {step.priority}
          </span>
        </div>
        {isActive && (
          <div className="step-body animate-fade-in">
            <p className="step-description">{step.description}</p>
            <div className="step-meta">
              <span>⏱ {step.timeline}</span>
              <span>🎯 {step.expected_outcome}</span>
              <span className="step-model-badge">🤖 {step.source_model}</span>
            </div>
          </div>
        )}
      </div>
      <ChevronRight size={14} className={`step-arrow ${isActive ? 'rotated' : ''}`} />
    </div>
  );
}

function ForecastBars({ historical, forecast }) {
  if (!historical?.length) return <div className="no-data">No forecast data</div>;

  const allIncome = [...historical.map(h => h.income), ...(forecast?.income?.predictions || [])];
  const allExpenses = [...historical.map(h => h.expenses), ...(forecast?.expenses?.predictions || [])];
  const maxVal = Math.max(...allIncome, ...allExpenses, 1);

  const histSlice = historical.slice(-4);
  const forecastMonths = forecast?.months || [];
  const forecastIncome = forecast?.income?.predictions || [];
  const forecastExpenses = forecast?.expenses?.predictions || [];

  return (
    <div className="forecast-bars-wrap">
      <div className="forecast-legend">
        <span><span className="legend-dot income" />Income</span>
        <span><span className="legend-dot expense" />Expenses</span>
        <span><span className="legend-dot forecast" />Forecast</span>
      </div>
      <div className="bars-container">
        {histSlice.map((m, i) => (
          <div key={`h-${i}`} className="bar-group">
            <div className="bar-pair">
              <div className="bar income-bar" style={{ height: `${(m.income / maxVal) * 100}%` }} title={`₹${m.income.toLocaleString('en-IN')}`} />
              <div className="bar expense-bar" style={{ height: `${(m.expenses / maxVal) * 100}%` }} title={`₹${m.expenses.toLocaleString('en-IN')}`} />
            </div>
            <div className="bar-label">{m.month_label?.split(' ')[0]}</div>
          </div>
        ))}
        <div className="forecast-divider" title="Forecast starts here" />
        {forecastMonths.map((month, i) => (
          <div key={`f-${i}`} className="bar-group forecast-group">
            <div className="bar-pair">
              <div className="bar income-bar forecast-bar" style={{ height: `${(forecastIncome[i] / maxVal) * 100}%` }} title={`Forecast ₹${(forecastIncome[i] || 0).toLocaleString('en-IN')}`} />
              <div className="bar expense-bar forecast-bar" style={{ height: `${(forecastExpenses[i] / maxVal) * 100}%` }} title={`Forecast ₹${(forecastExpenses[i] || 0).toLocaleString('en-IN')}`} />
            </div>
            <div className="bar-label">{month.split(' ')[0]}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function Plans() {
  const { transactions } = useFinance();

  const [mlData, setMlData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeStep, setActiveStep] = useState(null);

  // Chat state
  const [messages, setMessages] = useState([
    { id: 1, sender: 'bot', text: "Hi! Run the ML analysis and I'll walk you through your personalised financial plan. Every insight here comes directly from our ML models — Linear Regression, Isolation Forest, and Agglomerative Clustering. 🤖" }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef(null);
  const chatBodyRef = useRef(null);
  const voiceSupported = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;

  // Scroll chat to bottom on new messages
  useEffect(() => {
    if (chatBodyRef.current) {
      chatBodyRef.current.scrollTop = chatBodyRef.current.scrollHeight;
    }
  }, [messages, isThinking]);

  const sendToBot = async (text, mlContext = mlData) => {
    if (!text.trim() || isThinking) return;
    const userMsg = { id: Date.now(), sender: 'user', text };
    setMessages(prev => [...prev, userMsg]);
    setChatInput('');
    setIsThinking(true);

    try {
      // Bounded to the server's chat contract (last 12 user/assistant turns, each at most 2000 characters).
      const history = buildChatHistory(
        messages.map(m => ({ role: m.sender === 'bot' ? 'assistant' : 'user', content: m.text })),
        text
      );

      const res = await fetch(`${API}/plan-chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, mlContext })
      });

      const data = await res.json();
      const botMsg = { id: Date.now() + 1, sender: 'bot', text: data.reply };
      setMessages(prev => [...prev, botMsg]);

      // Avatar speak
      window.dispatchEvent(new CustomEvent('bot-speak', {
        detail: { message: data.reply.slice(0, 80) + (data.reply.length > 80 ? '…' : '') }
      }));
    } catch {
      setMessages(prev => [...prev, { id: Date.now() + 1, sender: 'bot', text: 'Error connecting to AI backend.' }]);
    } finally {
      setIsThinking(false);
    }
  };

  const runAnalysis = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/ml/analyze`, { credentials: 'include' });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || errData.error || 'ML service error');
      }
      const data = await res.json();
      setMlData(data);
      setActiveStep(0);

      // Avatar walkthrough — fire walk-to events for each plan step
      const plan = data.plan;
      if (plan?.steps?.length > 0) {
        window.dispatchEvent(new CustomEvent('bot-speak', {
          detail: { message: `ML analysis complete! Found ${plan.step_count} action items. Let me walk you through! 🧠` }
        }));
      }

      // Auto-send a kickoff message
      await sendToBot('Give me a quick summary of what the ML models found.', data);
    } catch (err) {
      setError(err.message);
      setMlData(null);
    } finally {
      setIsLoading(false);
    }
  };

  // Auto-run analysis if transactions exist
  useEffect(() => {
    if (transactions.length > 0 && !mlData && !isLoading) {
      runAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  }, [transactions]);

  const handleStepClick = (idx) => {
    const newActive = activeStep === idx ? null : idx;
    setActiveStep(newActive);

    if (newActive !== null && mlData?.plan?.steps?.[newActive]) {
      const step = mlData.plan.steps[newActive];
      // Avatar walks to this step
      const el = document.querySelector(`[data-avatar-target="plan-step-${step.step_id}"]`);
      if (el) {
        const rect = el.getBoundingClientRect();
        window.dispatchEvent(new CustomEvent('bot-walk-to', {
          detail: {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            message: `Step ${newActive + 1}: ${step.title} 📋`,
            label: `Explaining Step ${newActive + 1}…`
          }
        }));
      }
      sendToBot(`Explain step ${newActive + 1}: ${step.title}`);
    }
  };

  const handleSend = (e) => {
    e.preventDefault();
    sendToBot(chatInput);
  };

  const startListening = useCallback(() => {
    if (!voiceSupported) return;
    const SR = window.webkitSpeechRecognition || window.SpeechRecognition;
    const r = new SR();
    r.lang = 'en-IN';
    r.onstart = () => setIsListening(true);
    r.onresult = (e) => {
      const t = e.results[0][0].transcript;
      setIsListening(false);
      sendToBot(t);
    };
    r.onerror = r.onend = () => setIsListening(false);
    recognitionRef.current = r;
    r.start();
  }, [mlData, messages]);

  const stopListening = () => { recognitionRef.current?.stop(); setIsListening(false); };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="plans-container animate-fade-in">
      {/* Header */}
      <div className="plans-header">
        <div className="plans-title-group">
          <div className="plans-icon-badge"><Brain size={20} /></div>
          <div>
            <h1 className="plans-title">ML Financial Intelligence</h1>
            <p className="plans-subtitle">
              Powered by Linear Regression · Isolation Forest · Agglomerative Clustering · Health Scorer
            </p>
          </div>
        </div>
        <button
          className={`run-ml-btn ${isLoading ? 'loading' : ''}`}
          onClick={runAnalysis}
          disabled={isLoading}
        >
          <RefreshCw size={16} className={isLoading ? 'spinning' : ''} />
          {isLoading ? 'Running ML Models…' : 'Run ML Analysis'}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="plans-error-banner">
          <AlertTriangle size={18} />
          <div>
            <strong>ML Service Unavailable</strong>
            <p>{error}</p>
            <small>Start the Python service: <code>npm run start-ml</code> (in the server folder)</small>
          </div>
        </div>
      )}

      {/* Split panels */}
      <div className="plans-split">

        {/* LEFT PANEL — ML Results */}
        <div className="plans-left">

          {isLoading && (
            <div className="ml-loading">
              <div className="ml-loading-spinner" />
              <div className="ml-loading-text">
                <p>Running ML pipeline…</p>
                <small>LinearRegression → IsolationForest → AgglomerativeClustering → HealthScorer → PlanGenerator</small>
              </div>
            </div>
          )}

          {mlData && !isLoading && (
            <>
              {/* Health Score */}
              <div className="ml-card" data-avatar-target="health-score-section">
                <div className="ml-card-header">
                  <Shield size={16} /><span>Financial Health Score</span>
                  <span className="model-tag">Rule-Based Ratio Engine</span>
                </div>
                <div className="health-score-body">
                  <HealthGauge
                    score={mlData.health?.composite_score || 0}
                    grade={mlData.health?.grade}
                  />
                  <div className="health-ratios">
                    {mlData.health?.ratios && Object.entries(mlData.health.ratios).map(([key, r]) => (
                      <RatioBar key={key}
                        label={r.description || key}
                        value={r.value} unit={r.unit}
                        score={r.score} benchmark={r.benchmark}
                        status={r.status}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Forecast */}
              <div className="ml-card" data-avatar-target="forecast-section">
                <div className="ml-card-header">
                  <BarChart2 size={16} /><span>3-Month Forecast</span>
                  <span className="model-tag">LinearRegression (R²={mlData.forecast?.forecast?.income?.r2})</span>
                </div>
                <div className="forecast-trends">
                  <div className="trend-pill">
                    Income <TrendIcon direction={mlData.forecast?.insights?.income_momentum} />
                    <strong>{mlData.forecast?.insights?.income_momentum}</strong>
                  </div>
                  <div className="trend-pill">
                    Expenses <TrendIcon direction={mlData.forecast?.insights?.expense_momentum} />
                    <strong>{mlData.forecast?.insights?.expense_momentum}</strong>
                  </div>
                  <div className="trend-pill">
                    Projected Savings
                    <strong style={{ color: (mlData.forecast?.insights?.projected_savings_3m || 0) >= 0 ? '#10b981' : '#ef4444' }}>
                      ₹{(mlData.forecast?.insights?.projected_savings_3m || 0).toLocaleString('en-IN')}
                    </strong>
                  </div>
                </div>
                <ForecastBars
                  historical={mlData.forecast?.historical}
                  forecast={mlData.forecast?.forecast}
                />
              </div>

              {/* Anomalies */}
              {mlData.anomalies?.total_flagged > 0 && (
                <div className="ml-card anomaly-card" data-avatar-target="anomaly-section">
                  <div className="ml-card-header">
                    <Activity size={16} /><span>Anomaly Detection</span>
                    <span className="model-tag">IsolationForest (n=100, contamination={mlData.anomalies?.contamination_rate})</span>
                  </div>
                  <div className="anomaly-list">
                    {(mlData.anomalies?.anomalies || []).map((a, i) => (
                      <div key={i} className={`anomaly-item ${a.severity}`}>
                        <div className="anomaly-dot" />
                        <div className="anomaly-info">
                          <span className="anomaly-title">{a.title}</span>
                          <span className="anomaly-amount" style={{ color: a.amount < 0 ? '#ef4444' : '#10b981' }}>
                            ₹{Math.abs(a.amount).toLocaleString('en-IN')}
                          </span>
                        </div>
                        <div className="anomaly-reason">{a.reason}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Clusters */}
              <div className="ml-card" data-avatar-target="cluster-section">
                <div className="ml-card-header">
                  <Target size={16} /><span>Spending Behaviour Clusters</span>
                  <span className="model-tag">AgglomerativeClustering (Ward, sil={mlData.clusters?.model_metrics?.silhouette_score})</span>
                </div>
                <div className="cluster-grid">
                  {(mlData.clusters?.clusters || []).map(cl => (
                    <div key={cl.id} className="cluster-card">
                      <div className="cluster-label">{cl.label}</div>
                      <div className="cluster-pct">{cl.pct_of_total}%</div>
                      <div className="cluster-bar-track">
                        <div className="cluster-bar-fill" style={{ width: `${cl.pct_of_total}%` }} />
                      </div>
                      <div className="cluster-desc">{cl.description}</div>
                      <div className="cluster-count">{cl.transaction_count} transactions · avg ₹{cl.centroid_amount.toLocaleString('en-IN')}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Plan */}
              {mlData.plan?.steps?.length > 0 && (
                <div className="ml-card plan-card" data-avatar-target="plan-section">
                  <div className="ml-card-header">
                    <Zap size={16} /><span>{mlData.plan.plan_title}</span>
                    <span className="model-tag">Rule Engine</span>
                  </div>
                  <p className="plan-summary">{mlData.plan.plan_summary}</p>
                  <div className="plan-steps">
                    {mlData.plan.steps.map((step, i) => (
                      <PlanStep
                        key={step.step_id}
                        step={step}
                        index={i}
                        isActive={activeStep === i}
                        onClick={handleStepClick}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Metadata */}
              <div className="ml-metadata">
                <Info size={12} />
                {mlData.metadata?.transaction_count} transactions analysed ·
                Models: {mlData.metadata?.models_run?.join(', ')} ·
                {mlData.metadata?.elapsed_ms}ms
              </div>
            </>
          )}

          {!mlData && !isLoading && !error && (
            <div className="plans-empty">
              <Brain size={48} className="empty-brain" />
              <h3>ML Analysis Not Run Yet</h3>
              <p>Click <strong>Run ML Analysis</strong> to process your transactions through our ML pipeline.</p>
            </div>
          )}
        </div>

        {/* RIGHT PANEL — Chat */}
        <div className="plans-right">
          <div className="plan-chat-header">
            <div className="plan-chat-title">
              <div className="plan-chat-icon"><Brain size={16} /></div>
              <div>
                <span>AI Plan Advisor</span>
                <small>Narrates ML model output — never invents data</small>
              </div>
            </div>
          </div>

          <div className="plan-chat-body" ref={chatBodyRef}>
            {messages.map(msg => (
              <div key={msg.id} className={`plan-chat-msg ${msg.sender}`}>
                <div className="plan-msg-content">{msg.text}</div>
              </div>
            ))}
            {isThinking && (
              <div className="plan-chat-msg bot">
                <div className="plan-msg-content">
                  <div className="thinking-dots">
                    <span className="thinking-dot" /><span className="thinking-dot" /><span className="thinking-dot" />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Quick prompts */}
          <div className="plan-quick-prompts">
            {[
              'Explain the anomalies',
              'What does my health score mean?',
              'Which step should I do first?',
              'Explain my spending clusters'
            ].map(q => (
              <button key={q} className="quick-prompt-chip" onClick={() => sendToBot(q)} disabled={!mlData || isThinking}>
                {q}
              </button>
            ))}
          </div>

          <form className="plan-chat-input" onSubmit={handleSend}>
            <input
              type="text"
              placeholder={mlData ? 'Ask about your ML analysis…' : 'Run analysis first…'}
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              disabled={!mlData}
            />
            {voiceSupported && (
              <button type="button" className={`plan-voice-btn ${isListening ? 'listening' : ''}`}
                onClick={isListening ? stopListening : startListening} disabled={!mlData}>
                {isListening ? <MicOff size={16} /> : <Mic size={16} />}
              </button>
            )}
            <button type="submit" className="plan-send-btn" disabled={!chatInput.trim() || isThinking || !mlData}>
              <Send size={16} />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
