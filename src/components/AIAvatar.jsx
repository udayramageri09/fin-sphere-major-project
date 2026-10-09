import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Send, Image as ImageIcon, Mic, MicOff, Keyboard } from 'lucide-react';
import FinancialCompanion from './FinancialCompanion';
import './AIAvatar.css';
import { useFinance } from '../context/FinanceContext';
import { useAvatarActions } from '../hooks/useAvatarActions';
import { useVoiceSession } from '../hooks/useVoiceSession';
import { parseAssistantInput } from '../utils/assistantIntent';
import { buildChatHistory, CHAT_CONTENT_MAX } from '../utils/chatHistory';
import { createPulse, deriveCompanionState, companionLabel, PULSE_MS, NAVIGATION_PULSE_MS } from '../utils/companionState';

const WELCOME = "Hi! I'm your FinSphere assistant. Ask about your own money, like \"How much did I spend this month?\" or \"How is my budget?\". To go somewhere, say \"Open transactions\" or \"Go to budgets\".";
const HINTS = ['How am I doing this month?', 'How much did I spend?', 'How is my budget?', 'Open transactions'];

// The short assistant line recorded for a navigation, so the transcript (and later follow-ups) show what happened.
const navigationNote = (navigation) => (navigation.type === 'scroll' ? `Scrolling ${navigation.target}.` : `Opening ${navigation.label}.`);

function AIAvatar() {
  const { sendMessageToBot } = useFinance();
  const { performNavigation } = useAvatarActions();

  const [isOpen, setIsOpen] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  // `local` messages (welcome, connection errors, the circle-to-ask prompt) are shown but never sent as history.
  const [messages, setMessages] = useState([{ id: 1, text: WELCOME, sender: 'bot', local: true }]);
  const [input, setInput] = useState('');
  // Refs give the send pipeline the latest state even when it is called from the speech-recognition callback.
  const messagesRef = useRef(messages);
  const isOpenRef = useRef(isOpen);
  const busyRef = useRef(false);
  const idRef = useRef(1);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { isOpenRef.current = isOpen; }, [isOpen]);
  const nextId = () => { idRef.current += 1; return idRef.current; };

  // Snippet state
  const [isSnipping, setIsSnipping] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const canvasRef = useRef(null);
  const contextRef = useRef(null);

  // Speech Bubble State
  const [speech, setSpeech] = useState(null);
  const speechTimeoutRef = useRef(null);

  // Voice input
  const [isListening, setIsListening] = useState(false);
  const [voiceSupported] = useState(() => 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window);
  const recognitionRef = useRef(null);

  // Financial Companion (Issue #71): short-lived event pulses on top of the real listening / thinking state.
  // Only real events fire one: a reply arrived or a grounded Plans insight (insight), a request failed (error).
  const [pulse, setPulse] = useState(null);
  const pulseTimerRef = useRef(null);
  const firePulse = useCallback((kind, durationMs = PULSE_MS) => {
    const next = createPulse(kind, Date.now(), durationMs);
    if (!next) return;
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    setPulse(next);
    pulseTimerRef.current = setTimeout(() => { pulseTimerRef.current = null; setPulse(null); }, durationMs);
  }, []);
  // Explicit navigation: play the short directional sweep and switch page in the same moment (no added delay).
  const navigateWithEffect = (navigation) => {
    firePulse('navigating', NAVIGATION_PULSE_MS);
    performNavigation(navigation);
  };
  useEffect(() => () => { if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current); }, []);

  // ──────────────────────────────────────────────
  // Event Listeners (Speak & Autonomous Actions)
  // ──────────────────────────────────────────────
  useEffect(() => {
    // bot-speak / bot-walk-to now come only from the Plans page, which narrates real ML results: shown in the
    // bubble with an insight pulse. "walk-to" no longer moves anything; it only highlights its target.
    const handleSpeak = (e) => {
      if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
      setSpeech(e.detail.message);
      firePulse('insight');
    };
    const handleQuiet = () => {
      if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
      speechTimeoutRef.current = setTimeout(() => setSpeech(null), 2000);
    };

    const handleWalkTo = (e) => {
      const { message, selector } = e.detail;
      setIsOpen(false);
      setSpeech(message || 'Done! ✨');
      firePulse('insight');
      if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
      speechTimeoutRef.current = setTimeout(() => setSpeech(null), 4000);

      if (selector) {
        const el = document.querySelector(selector);
        if (el) {
          el.classList.add('avatar-target-highlight');
          setTimeout(() => el.classList.remove('avatar-target-highlight'), 2000);
        }
      }
    };

    window.addEventListener('bot-speak', handleSpeak);
    window.addEventListener('bot-quiet', handleQuiet);
    window.addEventListener('bot-walk-to', handleWalkTo);

    return () => {
      if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
      window.removeEventListener('bot-speak', handleSpeak);
      window.removeEventListener('bot-quiet', handleQuiet);
      window.removeEventListener('bot-walk-to', handleWalkTo);
    };
  }, [firePulse]);

  // ──────────────────────────────────────────────
  // Snipping Mode Toggle (Double Click)
  // ──────────────────────────────────────────────
  useEffect(() => {
    const handleDblClick = (e) => {
      if (e.target.closest('.ai-chat-panel') || e.target.closest('.ai-orb-button') || e.target.closest('.snippet-overlay-container')) return;
      setIsSnipping(true);
      setIsOpen(false);
    };
    window.addEventListener('dblclick', handleDblClick);
    return () => window.removeEventListener('dblclick', handleDblClick);
  }, []);

  // ──────────────────────────────────────────────
  // Snipping canvas drawing logic
  // ──────────────────────────────────────────────
  useEffect(() => {
    if (isSnipping && canvasRef.current) {
      const canvas = canvasRef.current;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      const context = canvas.getContext('2d');
      context.scale(dpr, dpr);
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.strokeStyle = '#2563eb';
      context.lineWidth = 4;
      context.shadowBlur = 8;
      context.shadowColor = 'rgba(37, 99, 235, 0.4)';
      contextRef.current = context;
    }
  }, [isSnipping]);

  const startDrawing = ({ nativeEvent }) => {
    const { offsetX, offsetY } = nativeEvent;
    contextRef.current.beginPath();
    contextRef.current.moveTo(offsetX, offsetY);
    setIsDrawing(true);
  };

  const finishDrawing = () => {
    if (!isDrawing) return;
    contextRef.current.closePath();
    setIsDrawing(false);
    setIsSnipping(false);
    setIsOpen(true);
    setMessages(prev => [...prev,
      { id: nextId(), isSnippet: true, local: true, text: "Area circled on screen", sender: 'user' },
      { id: nextId(), local: true, text: "I see you circled an area. What would you like to know about it?", sender: 'bot' }
    ]);
  };

  const draw = ({ nativeEvent }) => {
    if (!isDrawing) return;
    const { offsetX, offsetY } = nativeEvent;
    contextRef.current.lineTo(offsetX, offsetY);
    contextRef.current.stroke();
  };

  // ──────────────────────────────────────────────
  // One send pipeline for typed text, voice transcripts and hint chips (Issue #69)
  //   question            -> answered from the user's own data; no navigation
  //   navigation command  -> performed, and recorded in the transcript ("Opening Budgets.")
  //   question + command  -> answered first, then the requested navigation happens
  // ──────────────────────────────────────────────
  const showBubble = (text, ms = 3000) => {
    if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
    setSpeech(text);
    speechTimeoutRef.current = setTimeout(() => setSpeech(null), ms);
  };

  // runTurn is the ONE assistant pipeline. Text chat, panel dictation and the voice session all call it; voice and
  // text share the same transcript, so a follow-up spoken after typing (or the reverse) has the same history.
  //   source 'text'  -> opens the panel for a question, navigates right after the answer, never speaks
  //   source 'voice' -> leaves the panel closed and returns `navigate` so the voice session can run it after the
  //                     answer has been read aloud
  // Returns { status: 'answered', reply, navigate } | { status: 'navigated', note } | { status: 'failed', error }
  //       | { status: 'ignored' }.
  const runTurn = async (rawText, { source = 'text' } = {}) => {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text || busyRef.current) return { status: 'ignored' };
    const voice = source === 'voice';
    if (!voice) setInput('');

    const prior = messagesRef.current;
    const previousUserText = [...prior].reverse().find((m) => m.sender === 'user' && !m.local)?.text ?? '';
    const { question, navigation } = parseAssistantInput(text, { previousUserText });
    const userMsg = { id: nextId(), text, sender: 'user' };

    if (!question) {
      // Navigation only: no assistant call, but the turn is kept so "why?" / "show me" have context afterwards.
      const note = navigationNote(navigation);
      setMessages((prev) => [...prev, userMsg, { id: nextId(), text: note, sender: 'bot' }]);
      navigateWithEffect(navigation);
      if (!voice && !isOpenRef.current) showBubble(note);
      return { status: 'navigated', note };
    }

    busyRef.current = true;
    setMessages((prev) => [...prev, userMsg]);
    if (!voice) setIsOpen(true);
    setIsThinking(true);
    const history = buildChatHistory(
      prior.filter((m) => !m.local).map((m) => ({ role: m.sender === 'bot' ? 'assistant' : 'user', content: m.text })),
      question
    );
    let reply = null;
    let error = null;
    try {
      reply = await sendMessageToBot(history);
      setMessages((prev) => [...prev, { id: nextId(), text: reply, sender: 'bot' }]);
      firePulse('insight');
    } catch (err) {
      error = err.message;
      setMessages((prev) => [...prev, { id: nextId(), text: err.message, sender: 'bot', local: true }]);
      firePulse('error');
    } finally {
      setIsThinking(false);
      busyRef.current = false;
    }
    // The explicit navigation request is honoured after the answer, even if the answer could not be fetched.
    const navigate = navigation
      ? () => {
        setMessages((prev) => [...prev, { id: nextId(), text: navigationNote(navigation), sender: 'bot' }]);
        navigateWithEffect(navigation);
      }
      : null;
    if (navigate && (!voice || error)) navigate();
    if (error) return { status: 'failed', error };
    return { status: 'answered', reply, navigate: voice ? navigate : null };
  };

  const handleSendText = (rawText) => runTurn(rawText, { source: 'text' });
  const voiceSession = useVoiceSession({ runTurn });

  // Companion state from REAL activity only: panel dictation (isListening), a request in flight (isThinking), and the
  // voice session's phase (listening / thinking / speaking a reply / stopped on an error).
  const voicePhase = voiceSession.active ? voiceSession.phase : 'idle';
  const companionState = deriveCompanionState({
    isListening: isListening || voicePhase === 'listening',
    isThinking: isThinking || voicePhase === 'thinking',
    isSpeaking: voicePhase === 'speaking',
    hasError: voicePhase === 'error',
    pulse,
  });
  const stateLabel = companionLabel(companionState);

  const openVoice = () => {
    if (isSnipping) return;
    stopListening();
    setIsOpen(false);
    voiceSession.start();
  };
  const openChat = () => {
    voiceSession.end();
    setIsOpen(true);
  };
  // Escape ends the voice session.
  const { active: voiceActive, end: endVoice } = voiceSession;
  useEffect(() => {
    if (!voiceActive) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') endVoice(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [voiceActive, endVoice]);
  const voiceStageLabel = companionState === 'navigating' ? 'Opening…'
    : voicePhase === 'idle' ? 'Tap the orb to speak'
      : voicePhase === 'error' ? 'Something went wrong' : `${stateLabel}…`;
  const voiceOrbAction = voicePhase === 'listening' ? 'Stop listening'
    : voicePhase === 'speaking' ? 'Skip the spoken answer and listen'
      : voicePhase === 'thinking' ? 'FinSphere is thinking' : 'Start listening';

  const sendRef = useRef(handleSendText);
  useEffect(() => { sendRef.current = handleSendText; });

  const startListening = useCallback(() => {
    if (!voiceSupported) return;
    const SpeechRecognition = window.webkitSpeechRecognition || window.SpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-IN';

    recognition.onstart = () => setIsListening(true);
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      setIsListening(false);
      // Same pipeline as typed text: no separate command handling for voice.
      sendRef.current(transcript);
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
  }, [voiceSupported]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) recognitionRef.current.stop();
    setIsListening(false);
  }, []);

  const handleSend = async (e) => {
    e.preventDefault();
    await handleSendText(input);
  };

  return (
    <>
      {/* Snipping overlay */}
      {isSnipping && (
        <div className="snippet-overlay-container">
          <div className="snippet-instruction">Draw a circle around the item you want to ask about</div>
          <canvas
            onMouseDown={startDrawing}
            onMouseUp={finishDrawing}
            onMouseMove={draw}
            ref={canvasRef}
            className="snippet-canvas"
          />
        </div>
      )}

      {/* Assistant state for screen readers: announced only when the state changes. */}
      <span className="ai-sr-only" role="status" aria-live="polite" data-testid="companion-status">{stateLabel}</span>

      {/* Launcher: the Financial Companion, anchored bottom-right. The orb starts a VOICE conversation; text chat is
          the separate, explicit "Chat" control under it. Both use the same assistant pipeline (runTurn). */}
      <div className={`ai-orb-button ${isSnipping ? 'hidden' : ''} ${isOpen || voiceSession.active ? 'docked' : ''}`}>

        {/* Speech bubble */}
        {speech && !isOpen && !voiceSession.active && !isSnipping && (
          <div className="bot-speech-bubble" onClick={() => setIsOpen(true)}>
            {speech}
          </div>
        )}

        <button
          type="button"
          className="companion-launcher"
          aria-label={`Talk to FinSphere (${stateLabel})`}
          aria-expanded={voiceSession.active}
          aria-controls="ai-voice-stage"
          onClick={openVoice}
        >
          <FinancialCompanion state={companionState} size="launcher" />
        </button>

        <div className="companion-caption">
          <span className="companion-name" aria-hidden="true">Ask FinSphere</span>
          <button
            type="button"
            className="companion-chat-btn"
            aria-label="Open text chat"
            aria-expanded={isOpen}
            aria-controls="ai-chat-panel"
            onClick={openChat}
          >
            <Keyboard size={14} aria-hidden="true" />
            <span>Chat</span>
          </button>
        </div>
      </div>

      {/* Voice conversation stage: the companion expands; captions only, not a chat transcript. */}
      {voiceSession.active && (
        <section id="ai-voice-stage" className="voice-stage" role="dialog" aria-modal="false" aria-label="FinSphere voice assistant">
          <button type="button" className="voice-stage-orb" onClick={voiceSession.tapOrb} aria-label={voiceOrbAction}>
            <FinancialCompanion state={companionState} size="stage" />
          </button>
          <p className="voice-stage-state" aria-hidden="true">{voiceStageLabel}</p>
          {voiceSession.userCaption && (
            <p className="voice-caption voice-caption--user">
              <span className="ai-sr-only">You said: </span>“{voiceSession.userCaption}”
            </p>
          )}
          <div className="voice-caption voice-caption--reply" aria-live="polite">
            {voicePhase === 'error' ? voiceSession.errorText : voiceSession.replyCaption}
          </div>
          <div className="voice-stage-actions">
            <button type="button" className="voice-stage-btn" onClick={openChat} aria-label="Switch to text chat">
              <Keyboard size={16} aria-hidden="true" />
              <span>Chat</span>
            </button>
            <button type="button" className="voice-stage-btn voice-stage-btn--end" onClick={voiceSession.end} aria-label="End voice session">
              <X size={16} aria-hidden="true" />
              <span>End</span>
            </button>
          </div>
        </section>
      )}

      {/* Chat Side Panel (Docked on Right) */}
      <div id="ai-chat-panel" className={`ai-chat-panel ${isOpen ? 'open' : ''} glass-panel`} role="complementary" aria-label="FinSphere assistant">
        <div className="ai-chat-header">
          <div className="ai-header-info">
            {/* The launcher is hidden while the panel is open, so the state shows here too. */}
            <FinancialCompanion state={companionState} size="header" />
            <div>
              <span className="ai-title">FinSphere Assistant</span>
              <div className="ai-subtitle">Answers from your own financial data</div>
            </div>
          </div>
          <button type="button" className="close-btn" aria-label="Close assistant" onClick={() => setIsOpen(false)}>
            <X size={20} />
          </button>
        </div>

        {/* Command hints */}
        <div className="command-hints">
          {HINTS.map((hint) => (
            <span key={hint} className="hint-chip" onClick={() => handleSendText(hint)}>{hint}</span>
          ))}
        </div>

        <div className="ai-chat-body" id="ai-chat-body" aria-live="polite" aria-relevant="additions">
          {messages.map(msg => (
            <div key={msg.id} className={`chat-message ${msg.sender}`}>
              <div className="message-content">
                {msg.isSnippet && <ImageIcon size={16} style={{display: 'inline', marginRight: '6px', verticalAlign: 'text-bottom', color: '#fff'}} />}
                {msg.text}
              </div>
            </div>
          ))}
          {isThinking && (
            <div className="chat-message bot">
              <div className="message-content">
                <div className="thinking-dots" aria-hidden="true">
                  <span className="thinking-dot"></span>
                  <span className="thinking-dot"></span>
                  <span className="thinking-dot"></span>
                </div>
                <span className="ai-sr-only">Assistant is thinking</span>
              </div>
            </div>
          )}
        </div>

        <form className="ai-chat-input" onSubmit={handleSend}>
          <input
            type="text"
            placeholder="Ask about your money, or say “open budgets”…"
            aria-label="Message the FinSphere assistant"
            maxLength={CHAT_CONTENT_MAX}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          {voiceSupported && (
            <button
              type="button"
              className={`voice-btn ${isListening ? 'listening' : ''}`}
              onClick={isListening ? stopListening : startListening}
              aria-label={isListening ? 'Stop voice input' : 'Ask by voice'}
              aria-pressed={isListening}
            >
              {isListening ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
          )}
          <button type="submit" className="send-btn" aria-label="Send message" disabled={!input.trim()}>
            <Send size={18} />
          </button>
        </form>
      </div>
    </>
  );
}

export default AIAvatar;
