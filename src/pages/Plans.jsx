/* eslint-disable react-hooks/exhaustive-deps */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './Plans.css';
import AssistantReply from '../components/AssistantReply';
import { useFinance } from '../context/FinanceContext';
import { useAvatarActions } from '../hooks/useAvatarActions';
import { useGuardedFetch } from '../hooks/useGuardedFetch';
import { ACCOUNT_CHANGED_MESSAGE } from '../utils/accountGuard';
import { buildChatHistory } from '../utils/chatHistory';
import { buildCurrentState, groupFindings, sectionFailed } from '../utils/planIntelligence';
import CurrentState from '../components/plans/CurrentState';
import TopFindings from '../components/plans/TopFindings';
import ActionList from '../components/plans/ActionList';
import AnalysisDetails from '../components/plans/AnalysisDetails';
import { Compass, Send, Mic, MicOff, RefreshCw, AlertTriangle } from 'lucide-react';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api';

// Never shown from the server: an upstream message could echo the user's data. The page says what happened in its own words.
const ANALYSIS_ERROR = "We couldn't run the analysis just now. Check that the analytics service is running, then try again.";

const GREETING = 'Ask me about your results or what to focus on next.';

function GoalDiscussion({ sendMessage }) {
  const heading = useRef(null);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { heading.current?.focus(); }, []);

  const review = async () => {
    setBusy(true);
    setError('');
    setReply('');
    try {
      setReply(await sendMessage([{ role: 'user', content: 'How are my savings goals progressing? Summarize my saved goals and what is left to save.' }]));
    } catch (err) {
      setError(err.message || 'Could not review your goals.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="glass-panel my-4 p-5" aria-labelledby="goal-discussion-heading">
      <h2 id="goal-discussion-heading" ref={heading} tabIndex={-1} className="text-xl font-semibold">Discuss my goals</h2>
      <p className="my-2 text-sm text-zinc-600">Ask the assistant for a summary of your saved goals. You do not need to run a transaction analysis first.</p>
      <button type="button" className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={review} disabled={busy}>{busy ? 'Reviewing goals…' : 'Review my goal progress'}</button>
      {reply && <div role="status" className="mt-3"><AssistantReply text={reply} /></div>}
      {error && <p role="alert" className="mt-3 text-red-800">{error}</p>}
    </section>
  );
}

export default function Plans({ discussGoals = false }) {
  const { transactions, sendMessageToBot } = useFinance();
  const { performNavigation } = useAvatarActions();
  const guardedFetch = useGuardedFetch();   // names the account this tab shows; a refusal re-checks the session

  const [months, setMonths] = useState(3);
  const analysisRequest = useRef(null);
  useEffect(() => () => {
    const request = analysisRequest.current;
    analysisRequest.current = null;
    request?.abort();
  }, []);
  const advisorInput = useRef(null);
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
      const res = await guardedFetch(`${API}/plan-chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history })
      });
      const body = await res.json().catch(() => ({}));
      const reply = res.ok && typeof body.reply === 'string' ? body.reply
        : res.status === 401 ? 'Your session expired. Sign in again to use the Advisor.'
        : res.status === 429 ? 'Too many requests. Wait a minute before trying again.'
        : "I couldn't answer that just now.";
      setMessages((prev) => [...prev, { id: Date.now() + 1, sender: 'bot', text: reply }]);
      window.dispatchEvent(new CustomEvent('bot-speak', { detail: { message: reply.slice(0, 80) + (reply.length > 80 ? '…' : '') } }));
    } catch (err) {
      setMessages((prev) => [...prev, { id: Date.now() + 1, sender: 'bot', text: err?.message === ACCOUNT_CHANGED_MESSAGE ? err.message : "I couldn't reach the assistant just now." }]);
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

  const runAnalysis = async (period = months) => {
    if (analysisRequest.current || isThinking) return;
    const controller = new AbortController();
    analysisRequest.current = controller;
    const timeout = setTimeout(() => controller.abort(), 75_000);
    setMonths(period);
    setIsLoading(true);
    setError(null);
    try {
      const res = await guardedFetch(`${API}/ml/analyze${period === 3 ? '' : `?months=${period}`}`, { credentials: 'include', signal: controller.signal });
      if (!res.ok) throw new Error(res.status === 401 ? 'Your session has expired. Please sign in again.' : res.status === 422 ? 'Analysis supports up to 3000 transactions per account. Your saved transactions have not changed.' : ANALYSIS_ERROR);
      const body = await res.json();
      if (analysisRequest.current !== controller) return;
      const returnedMonths = body.forecast?.forecast?.months;
      if (Array.isArray(returnedMonths) && returnedMonths.length !== period) throw new Error(ANALYSIS_ERROR);
      setData(body);
      if (period !== months) setMessages([{ id: Date.now(), sender: 'bot', text: GREETING }]);
      announce(body.plan?.step_count);
    } catch (err) {
      if (analysisRequest.current !== controller) return;
      if (controller.signal.aborted) {
        setError('Analysis is taking too long. Check that the API and analytics service are running, then try again.');
        setData(null);
        return;
      }
      setError(err.message === 'Your session has expired. Please sign in again.' || err.message.startsWith('Analysis supports up to 3000 transactions') || err.message === ACCOUNT_CHANGED_MESSAGE ? err.message : ANALYSIS_ERROR);
      setData(null);
    } finally {
      clearTimeout(timeout);
      if (analysisRequest.current === controller) {
        analysisRequest.current = null;
        setIsLoading(false);
      }
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

  const state = useMemo(() => data ? buildCurrentState(data) : null, [data]);
  const findings = useMemo(() => data ? groupFindings(data) : null, [data]);
  const health = data && !sectionFailed(data, 'health') ? data.health : null;
  const noTransactions = transactions.length === 0 && !data;

  return (
    <div className="plans-container animate-fade-in">
      <div className="plans-header">
        <div className="plans-title-group">
          <div className="plans-icon-badge"><Compass size={20} /></div>
          <div>
            <h1 className="plans-title">Financial Intelligence</h1>
            <p className="plans-subtitle">Your outlook. Your next move.</p>
          </div>
        </div>
        <button className={`run-ml-btn ${isLoading ? 'loading' : ''}`} data-guide-tip="Refresh the forecast and insights using your latest transactions." onClick={() => runAnalysis()} disabled={isLoading || isThinking || noTransactions}>
          <RefreshCw size={16} className={isLoading ? 'spinning' : ''} />
          {isLoading ? 'Analysing…' : 'Refresh analysis'}
        </button>
      </div>

      {discussGoals && <GoalDiscussion sendMessage={sendMessageToBot} />}

      <div className="forecast-period-control">
        <label htmlFor="forecast-period">Forecast period</label>
        <select id="forecast-period" value={months} disabled={isLoading || isThinking || noTransactions} onChange={event => runAnalysis(Number(event.target.value))}>
          {[3, 6, 12].map(period => <option key={period} value={period}>{period} months</option>)}
        </select>
      </div>
      {error && (
        <div className="plans-error-banner" role="alert" data-testid="analysis-error">
          <AlertTriangle size={18} />
          <div>
            <strong>Analysis unavailable</strong>
            <p>{error}</p>
            <button type="button" className="retry-btn" onClick={() => runAnalysis()} disabled={isLoading}>Try again</button>
          </div>
        </div>
      )}

      <div className="plans-split">
        <div className="plans-left" aria-busy={isLoading}>
          {isLoading && (
            <div className="ml-loading" role="status" aria-live="polite">
              <div className="ml-loading-spinner" aria-hidden="true" />
              <div className="ml-loading-text">
                <p>Analysing your transactions…</p>
                <small>This may take a moment.</small>
              </div>
            </div>
          )}

          {data && !isLoading && (
            <>
              <div className="advisor-invitation">
                <div><strong>Not sure where to start?</strong><p>Ask your advisor to turn these results into a practical next step.</p></div>
                <button type="button" onClick={() => advisorInput.current?.focus()}>Ask advisor</button>
              </div>
              <CurrentState state={state} />
              <ActionList plan={data.plan} planFailed={findings.planFailed} health={health} onNavigate={performNavigation} />
              <AnalysisDetails data={data} months={months} />
              <details className="intelligence-disclosure">
                <summary>More insights</summary>
                <div className="intelligence-disclosure-body">
                  <TopFindings findings={findings} />

                </div>
              </details>
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

        <section className="intelligence-disclosure advisor-panel" aria-labelledby="advisor-heading">
          <div className="plans-right">
          <div className="plan-chat-header">
            <div className="plan-chat-title">
              <div className="plan-chat-icon"><Compass size={16} /></div>
              <div>
                <h2 id="advisor-heading" className="text-base font-semibold">Advisor</h2>
                <small>Answers based on your latest analysis.</small>
              </div>
            </div>
          </div>

          <div className="plan-chat-body" ref={chatBodyRef}>
            {messages.map((msg) => (
              <div key={msg.id} className={`plan-chat-msg ${msg.sender}`}>
                <div className="plan-msg-content">{msg.sender === 'bot' ? <AssistantReply text={msg.text} /> : msg.text}</div>
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
            {['What should I do first?', 'How can I save more?', 'Explain my forecast'].map((q) => (
              <button key={q} className="quick-prompt-chip" onClick={() => sendToBot(q)} disabled={!data || isThinking || isLoading}>{q}</button>
            ))}
          </div>

          <form className="plan-chat-input" onSubmit={(e) => { e.preventDefault(); sendToBot(chatInput); }}>
            <input
              ref={advisorInput}
              type="text"
              aria-label="Ask the advisor about this analysis"
              placeholder={data ? 'Ask about this analysis…' : 'Run the analysis first…'}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              disabled={!data || isLoading}
            />
            {voiceSupported && (
              <button type="button" className={`plan-voice-btn ${isListening ? 'listening' : ''}`}
                onClick={isListening ? stopListening : startListening} disabled={!data || isLoading} aria-label={isListening ? 'Stop listening' : 'Speak'}>
                {isListening ? <MicOff size={16} /> : <Mic size={16} />}
              </button>
            )}
            <button type="submit" className="plan-send-btn" disabled={!chatInput.trim() || isThinking || isLoading || !data} aria-label="Send">
              <Send size={16} />
            </button>
          </form>
          </div>
        </section>
      </div>
    </div>
  );
}
