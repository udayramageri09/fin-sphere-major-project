/* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
import { useState, useEffect, useRef, useCallback } from 'react';
import './Plans.css';
import { useFinance } from '../context/FinanceContext';
import { useAvatarActions } from '../hooks/useAvatarActions';
import { buildChatHistory } from '../utils/chatHistory';
import { buildCurrentState, groupFindings, sectionFailed } from '../utils/planIntelligence';
import CurrentState from '../components/plans/CurrentState';
import TopFindings from '../components/plans/TopFindings';
import ActionList from '../components/plans/ActionList';
import AnalysisDetails from '../components/plans/AnalysisDetails';
import { Compass, Send, Mic, MicOff, RefreshCw, AlertTriangle, Info } from 'lucide-react';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api';

// Never shown from the server: an upstream message could echo the user's data. The page says what happened in its own words.
const ANALYSIS_ERROR = "We couldn't run the analysis just now. Check that the analytics service is running, then try again.";

const GREETING = 'I explain the results on this page. The health score and plan are rule-based; the forecast, anomalies and clusters come from ML models. I never invent figures.';

export default function Plans() {
  const { transactions } = useFinance();
  const { performNavigation } = useAvatarActions();

  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Chat state
  const [messages, setMessages] = useState([{ id: 1, sender: 'bot', text: GREETING }]);
  const [chatInput, setChatInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef(null);
  const chatBodyRef = useRef(null);
  const voiceSupported = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;

  useEffect(() => {
    if (chatBodyRef.current) chatBodyRef.current.scrollTop = chatBodyRef.current.scrollHeight;
  }, [messages, isThinking]);

  // The advisor narrates the SERVER's snapshot of the last analysis: only the conversation is sent.
  const sendToBot = async (text) => {
    if (!text.trim() || isThinking) return;
    setMessages((prev) => [...prev, { id: Date.now(), sender: 'user', text }]);
    setChatInput('');
    setIsThinking(true);
    try {
      // Bounded to the server's chat contract (last 12 user/assistant turns, each at most 2000 characters).
      const history = buildChatHistory(
        messages.map((m) => ({ role: m.sender === 'bot' ? 'assistant' : 'user', content: m.text })),
        text
      );
      const res = await fetch(`${API}/plan-chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history })
      });
      const body = await res.json().catch(() => ({}));
      const reply = res.ok && typeof body.reply === 'string' ? body.reply : "I couldn't answer that just now.";
      setMessages((prev) => [...prev, { id: Date.now() + 1, sender: 'bot', text: reply }]);
      window.dispatchEvent(new CustomEvent('bot-speak', { detail: { message: reply.slice(0, 80) + (reply.length > 80 ? '…' : '') } }));
    } catch {
      setMessages((prev) => [...prev, { id: Date.now() + 1, sender: 'bot', text: "I couldn't reach the assistant just now." }]);
    } finally {
      setIsThinking(false);
    }
  };

  // A companion bubble is a nicety: it must never turn a successful analysis into an error.
  const announce = (count) => {
    if (count === undefined) return;
    try {
      window.dispatchEvent(new CustomEvent('bot-speak', { detail: { message: `Analysis complete! ${count} action item${count === 1 ? '' : 's'} found.` } }));
    } catch { /* ignored */ }
  };

  const runAnalysis = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/ml/analyze`, { credentials: 'include' });
      if (!res.ok) throw new Error(res.status === 401 ? 'Your session has expired. Please sign in again.' : ANALYSIS_ERROR);
      const body = await res.json();
      setData(body);
      announce(body.plan?.step_count);
    } catch (err) {
      setError(err.message === 'Your session has expired. Please sign in again.' ? err.message : ANALYSIS_ERROR);
      setData(null);
    } finally {
      setIsLoading(false);
    }
  };

  // Analyse automatically once there are transactions to analyse; with none, the page shows an empty state instead.
  useEffect(() => {
    if (transactions.length > 0 && !data && !isLoading) runAnalysis();
  }, [transactions]);

  const startListening = useCallback(() => {
    if (!voiceSupported) return;
    const SR = window.webkitSpeechRecognition || window.SpeechRecognition;
    const r = new SR();
    r.lang = 'en-IN';
    r.onstart = () => setIsListening(true);
    r.onresult = (e) => { setIsListening(false); sendToBot(e.results[0][0].transcript); };
    r.onerror = r.onend = () => setIsListening(false);
    recognitionRef.current = r;
    r.start();
  }, [data, messages]);
  const stopListening = () => { recognitionRef.current?.stop(); setIsListening(false); };

  const state = data ? buildCurrentState(data) : null;
  const findings = data ? groupFindings(data) : null;
  const health = data && !sectionFailed(data, 'health') ? data.health : null;
  const noTransactions = transactions.length === 0 && !data;

  return (
    <div className="plans-container animate-fade-in">
      <div className="plans-header">
        <div className="plans-title-group">
          <div className="plans-icon-badge"><Compass size={20} /></div>
          <div>
            <h1 className="plans-title">Financial Intelligence</h1>
            <p className="plans-subtitle">Your financial position, the biggest risks, and what to do next</p>
          </div>
        </div>
        <button className={`run-ml-btn ${isLoading ? 'loading' : ''}`} onClick={runAnalysis} disabled={isLoading || noTransactions}>
          <RefreshCw size={16} className={isLoading ? 'spinning' : ''} />
          {isLoading ? 'Analysing…' : 'Refresh analysis'}
        </button>
      </div>

      {error && (
        <div className="plans-error-banner" role="alert" data-testid="analysis-error">
          <AlertTriangle size={18} />
          <div>
            <strong>Analysis unavailable</strong>
            <p>{error}</p>
            <button type="button" className="retry-btn" onClick={runAnalysis} disabled={isLoading}>Try again</button>
          </div>
        </div>
      )}

      <div className="plans-split">
        <div className="plans-left">
          {isLoading && (
            <div className="ml-loading">
              <div className="ml-loading-spinner" />
              <div className="ml-loading-text">
                <p>Analysing your transactions…</p>
                <small>Forecast · anomalies · spending clusters · health score · action plan</small>
              </div>
            </div>
          )}

          {data && !isLoading && (
            <>
              <CurrentState state={state} />
              <TopFindings findings={findings} />
              <ActionList plan={data.plan} planFailed={findings.planFailed} health={health} onNavigate={performNavigation} />
              <AnalysisDetails data={data} />
              <div className="ml-metadata">
                <Info size={12} />
                {data.metadata?.transaction_count} transactions analysed
                {data.metadata?.models_run?.length ? ` · ML: ${data.metadata.models_run.join(', ')}` : ''}
                {data.metadata?.rule_engines_run?.length ? ` · Rules: ${data.metadata.rule_engines_run.join(', ')}` : ''}
              </div>
            </>
          )}

          {noTransactions && !isLoading && (
            <div className="plans-empty" data-testid="plans-empty">
              <Compass size={48} className="empty-brain" />
              <h3>No transactions to analyse yet</h3>
              <p>Add or import some transactions on the Transactions page, then come back for your position, risks and next actions.</p>
            </div>
          )}
        </div>

        <div className="plans-right">
          <div className="plan-chat-header">
            <div className="plan-chat-title">
              <div className="plan-chat-icon"><Compass size={16} /></div>
              <div>
                <span>Advisor</span>
                <small>Explains this analysis. It never invents figures.</small>
              </div>
            </div>
          </div>

          <div className="plan-chat-body" ref={chatBodyRef}>
            {messages.map((msg) => (
              <div key={msg.id} className={`plan-chat-msg ${msg.sender}`}>
                <div className="plan-msg-content">{msg.text}</div>
              </div>
            ))}
            {isThinking && (
              <div className="plan-chat-msg bot">
                <div className="plan-msg-content">
                  <div className="thinking-dots"><span className="thinking-dot" /><span className="thinking-dot" /><span className="thinking-dot" /></div>
                </div>
              </div>
            )}
          </div>

          <div className="plan-quick-prompts">
            {['Why is this my top action?', 'How is my health score calculated?', 'What caused my biggest risk?'].map((q) => (
              <button key={q} className="quick-prompt-chip" onClick={() => sendToBot(q)} disabled={!data || isThinking}>{q}</button>
            ))}
          </div>

          <form className="plan-chat-input" onSubmit={(e) => { e.preventDefault(); sendToBot(chatInput); }}>
            <input
              type="text"
              placeholder={data ? 'Ask about this analysis…' : 'Run the analysis first…'}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              disabled={!data}
            />
            {voiceSupported && (
              <button type="button" className={`plan-voice-btn ${isListening ? 'listening' : ''}`}
                onClick={isListening ? stopListening : startListening} disabled={!data} aria-label={isListening ? 'Stop listening' : 'Speak'}>
                {isListening ? <MicOff size={16} /> : <Mic size={16} />}
              </button>
            )}
            <button type="submit" className="plan-send-btn" disabled={!chatInput.trim() || isThinking || !data} aria-label="Send">
              <Send size={16} />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
