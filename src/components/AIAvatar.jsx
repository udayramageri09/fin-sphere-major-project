import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Send, Image as ImageIcon, Mic, MicOff, Keyboard, Compass } from 'lucide-react';
import FinancialCompanion from './FinancialCompanion';
import CompanionGuide from './CompanionGuide';
import ActionConfirmationCard from './ActionConfirmationCard';
import './AIAvatar.css';
import AssistantReply from './AssistantReply';
import { useFinance } from '../context/FinanceContext';
import { useAuth } from '../context/AuthContext';
import { useAvatarActions } from '../hooks/useAvatarActions';
import { useVoiceSession } from '../hooks/useVoiceSession';
import { useReduceMotion } from '../hooks/useMotionPreference';
import { parseAssistantInput } from '../utils/assistantIntent';
import { buildChatHistory, CHAT_CONTENT_MAX } from '../utils/chatHistory';
import { parseConfirmation } from '../utils/actionConfirmation';
import { localCommand } from '../utils/localCommands';
import { boxFromPoints, collectScreenContext } from '../utils/screenCapture';
import { createPulse, deriveCompanionState, companionLabel, PULSE_MS, NAVIGATION_PULSE_MS } from '../utils/companionState';

const WELCOME = "Hi! I'm your FinSphere assistant. Ask about your own money, like \"How much did I spend this month?\" or \"How is my budget?\". To go somewhere, say \"Open transactions\" or \"Go to budgets\".";
const HINTS = ['How am I doing this month?', 'How much did I spend?', 'How is my budget?', 'Open transactions'];
const LOCAL_DEMO_DELAY_MS = 700;

// The short assistant line recorded for a navigation, so the transcript (and later follow-ups) show what happened.
const navigationNote = (navigation) => (navigation.type === 'scroll' ? `Scrolling ${navigation.target}.` : `Opening ${navigation.label}.`);

function AIAvatar({ guideTone = 'friendly' }) {
  const { currentView, sendAssistantMessage, confirmAssistantAction, cancelAssistantAction } = useFinance();
  const { performNavigation } = useAvatarActions();
  const reducedMotion = useReduceMotion();
  const [guideEnabled, setGuideEnabled] = useState(false);

  const [isOpen, setIsOpen] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [modelMode, setModelMode] = useState('cloud');
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
  const nextId = useCallback(() => { idRef.current += 1; return idRef.current; }, []);

  // Snippet state
  const [isSnipping, setIsSnipping] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const canvasRef = useRef(null);
  const contextRef = useRef(null);
  const pointsRef = useRef([]);
  const circledRef = useRef(null);   // what the user last circled; sent with the next question to the server, once

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
  const clearPulse = useCallback(() => {
    if (pulseTimerRef.current) { clearTimeout(pulseTimerRef.current); pulseTimerRef.current = null; }
    setPulse(null);
  }, []);
  // Explicit navigation: play the short directional sweep and switch page in the same moment (no added delay).
  const navigateWithEffect = (navigation) => {
    firePulse('navigating', NAVIGATION_PULSE_MS);
    performNavigation(navigation);
  };
  useEffect(() => () => { if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current); }, []);

  // A financial action the assistant has proposed (Issue #73). The SERVER holds the real proposal; this is only what
  // is needed to show it and to ask the server to confirm or cancel it: { proposalId, kind, status, summary, display,
  // expiresAt }. status is 'pending' (waiting for Confirm) or 'needs_clarification' (a question is open).
  const [pendingAction, setPendingAction] = useState(null);
  const pendingRef = useRef(null);
  const setActive = useCallback((next) => { pendingRef.current = next; setPendingAction(next); }, []);
  const actionFromServer = (action) => (action && (action.status === 'pending' || action.status === 'needs_clarification')
    ? { proposalId: action.proposalId, kind: action.kind, status: action.status, summary: action.summary, display: action.display ?? [], expiresAt: action.expiresAt }
    : null);
  const msUntil = (iso) => Math.max(1000, Date.parse(iso) - Date.now());
  // The confirmation window closes on its own: forget the proposal when it does (the server also refuses it).
  useEffect(() => {
    if (!pendingAction) return undefined;
    const timer = setTimeout(() => {
      if (pendingRef.current?.proposalId !== pendingAction.proposalId) return;
      pendingRef.current = null;
      setPendingAction(null);
      clearPulse();
      idRef.current += 1;
      setMessages((prev) => [...prev, { id: idRef.current, text: 'That request expired, so nothing was saved.', sender: 'bot', local: true }]);
    }, Math.max(0, Date.parse(pendingAction.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [pendingAction, clearPulse]);

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
    const handleEscape = (e) => { if (e.key === 'Escape') setIsSnipping(false); };
    window.addEventListener('keydown', handleEscape);
    return () => { window.removeEventListener('dblclick', handleDblClick); window.removeEventListener('keydown', handleEscape); };
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

  const startDrawing = (event) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointsRef.current = [{ x: event.clientX, y: event.clientY }];
    contextRef.current.beginPath();
    contextRef.current.moveTo(event.clientX, event.clientY);
    setIsDrawing(true);
  };

  const finishDrawing = () => {
    if (!isDrawing) return;
    contextRef.current.closePath();
    setIsDrawing(false);
    setIsSnipping(false);
    const box = boxFromPoints(pointsRef.current);
    pointsRef.current = [];
    if (!box) return;                                   // a tap or a tiny scribble is not a circle
    const { text, hint } = collectScreenContext(box);
    setIsOpen(true);
    if (!text) {
      circledRef.current = null;
      setMessages(prev => [...prev, { id: nextId(), local: true, text: "I couldn't read any text inside that circle. Try circling a number, a label or a whole card.", sender: 'bot' }]);
      return;
    }
    circledRef.current = { text, hint, view: currentView ?? '' };
    setMessages(prev => [...prev,
      { id: nextId(), isSnippet: true, local: true, text: `Circled: “${text.length > 140 ? `${text.slice(0, 140)}…` : text}”`, sender: 'user' },
      { id: nextId(), local: true, text: "Got it. What would you like to know about this?", sender: 'bot' }
    ]);
  };

  const draw = (event) => {
    if (!isDrawing) return;
    pointsRef.current.push({ x: event.clientX, y: event.clientY });
    contextRef.current.lineTo(event.clientX, event.clientY);
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

  // Confirm or cancel the pending proposal. Both go through the server by proposal id only; the card buttons, a typed
  // "yes" and a spoken "yes" all end up here, so text and voice have identical safety.
  const resolvePending = async (choice, { userMsg = null } = {}) => {
    const active = pendingRef.current;
    const lead = userMsg ? [userMsg] : [];
    if (!active || Date.parse(active.expiresAt) <= Date.now()) {
      setActive(null);
      clearPulse();
      const reply = 'That request expired, so nothing was saved. Please ask again.';
      setMessages((prev) => [...prev, ...lead, { id: nextId(), text: reply, sender: 'bot', local: true }]);
      return { status: 'answered', reply, navigate: null };
    }
    busyRef.current = true;
    setIsThinking(true);
    try {
      if (choice === 'no') {
        await cancelAssistantAction(active.proposalId);
        setActive(null);
        clearPulse();
        const reply = 'Okay, I cancelled that. Nothing was saved.';
        setMessages((prev) => [...prev, ...lead, { id: nextId(), text: reply, sender: 'bot' }]);
        return { status: 'answered', reply, navigate: null };
      }
      const done = await confirmAssistantAction(active.proposalId);   // state is updated inside, exactly like a manual write
      setActive(null);
      firePulse('success');
      setMessages((prev) => [...prev, ...lead, { id: nextId(), text: done.message, sender: 'bot' }]);
      return { status: 'answered', reply: done.message, navigate: null };
    } catch (err) {
      // A refusal from the server (expired, already cancelled, over the goal target...) closes the proposal; a network
      // failure leaves it open so the user can try again.
      if (err.actionStatus) setActive(null);
      firePulse('error');
      setMessages((prev) => [...prev, ...lead, { id: nextId(), text: err.message, sender: 'bot', local: true }]);
      return err.actionStatus
        ? { status: 'answered', reply: err.message, navigate: null }
        : { status: 'failed', error: err.message };
    } finally {
      setIsThinking(false);
      busyRef.current = false;
    }
  };

  // runTurn is the ONE assistant pipeline. Text chat, panel dictation and the voice session all call it; voice and
  // text share the same transcript, so a follow-up spoken after typing (or the reverse) has the same history.
  //   source 'text'  -> opens the panel for a question, navigates right after the answer, never speaks
  //   source 'voice' -> leaves the panel closed and returns `navigate` so the voice session can run it after the
  //                     answer has been read aloud
  // While an action is waiting for confirmation, a whole-utterance yes / no confirms or cancels it; anything else goes
  // to the server, which treats it as an edit, a new request, or an unrelated message (cancelling the old proposal).
  // Returns { status: 'answered', reply, navigate } | { status: 'navigated', note } | { status: 'failed', error }
  //       | { status: 'ignored' }.
  const runTurn = async (rawText, { source = 'text', confidence } = {}) => {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text || busyRef.current) return { status: 'ignored' };
    const voice = source === 'voice';
    if (!voice) setInput('');

    const prior = messagesRef.current;
    const userMsg = { id: nextId(), text, sender: 'user' };

    const active = pendingRef.current;
    const choice = active?.status === 'pending' ? parseConfirmation(text) : null;
    if (choice) {
      // Very unclear speech never confirms anything: ask again instead.
      if (choice === 'yes' && voice && typeof confidence === 'number' && confidence > 0 && confidence < 0.5) {
        const reply = "I didn't catch that clearly. Should I go ahead? Say yes or no, or tap Confirm.";
        setMessages((prev) => [...prev, userMsg, { id: nextId(), text: reply, sender: 'bot', local: true }]);
        return { status: 'answered', reply, navigate: null };
      }
      return resolvePending(choice, { userMsg });
    }

    const previousUserText = [...prior].reverse().find((m) => m.sender === 'user' && !m.local)?.text ?? '';
    const { question, navigation } = parseAssistantInput(text, { previousUserText });

    if (!question) {
      // Navigation only: no assistant call, but the turn is kept so "why?" / "show me" have context afterwards.
      let note = navigationNote(navigation);
      if (active) {
        // Moving on cancels an open proposal (best effort; the server also lets it lapse on its own).
        cancelAssistantAction(active.proposalId).catch(() => {});
        setActive(null);
        clearPulse();
        note = `I cancelled that request. Nothing was saved. ${note}`;
      }
      setMessages((prev) => [...prev, userMsg, { id: nextId(), text: note, sender: 'bot' }]);
      navigateWithEffect(navigation);
      if (!voice && !isOpenRef.current) showBubble(note);
      return { status: 'navigated', note };
    }

    const instant = !active && !navigation ? localCommand(question) : null;
    if (instant) {
      setMessages((prev) => [...prev, userMsg, { id: nextId(), text: instant, sender: 'bot', local: true }]);
      if (!voice) setIsOpen(true);
      return { status: 'answered', reply: instant, navigate: null };
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
    let spokenReply = null;
    let error = null;
    try {
      const circled = circledRef.current;
      circledRef.current = null;                          // the circle belongs to this question only
      const answer = await sendAssistantMessage(history, { screenContext: circled });
      if (modelMode === 'local-demo') {
        await new Promise((resolve) => setTimeout(resolve, LOCAL_DEMO_DELAY_MS));
      }
      reply = answer.reply;
      const next = actionFromServer(answer.action);
      setActive(next);                       // no action in the response means nothing is open on the server any more
      setMessages((prev) => [...prev, { id: nextId(), text: reply, sender: 'bot', visualization: answer.visualization }]);
      if (next?.status === 'pending') firePulse('attention', msUntil(next.expiresAt));
      else firePulse('insight');
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
    return { status: 'answered', reply, spokenReply, navigate: voice ? navigate : null };
  };

  const handleSendText = (rawText) => runTurn(rawText, { source: 'text' });
  const voiceSession = useVoiceSession({ runTurn, guideTone });

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
    setGuideEnabled(false);
    voiceSession.end();
    setIsOpen(true);
  };
  const { active: voiceActive, end: endVoice } = voiceSession;
  const stopVoice = useCallback(() => {
    setGuideEnabled(false);
    endVoice();
  }, [endVoice]);
  const startGuide = () => {
    setGuideEnabled(true);
    voiceSession.start({ guide: true });
  };
  const closeGuideMic = () => {
    endVoice();
    window.requestAnimationFrame(() => document.getElementById('guide-reopen-mic')?.focus());
  };
  useEffect(() => {
    if (!voiceActive && !guideEnabled) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') stopVoice(); };
    const onVisibility = () => { if (guideEnabled && document.hidden) stopVoice(); };
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [voiceActive, guideEnabled, stopVoice]);
  const voiceStageLabel = companionState === 'navigating' ? 'Opening…'
    : voicePhase === 'idle' ? 'Tap the orb to speak'
      : voicePhase === 'error' ? 'Something went wrong' : `${stateLabel}…`;
  const voiceOrbAction = voicePhase === 'listening' || voicePhase === 'starting' ? 'Stop listening'
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

  // While another tab may have changed the account, the app is hidden: stop listening and stop any spoken answer at once, so nothing from
  // the previous account is heard (or captured) before the server has said whose session this is.
  const { identityMasked } = useAuth();
  useEffect(() => {
    if (!identityMasked) return;
    stopVoice();
    stopListening();
    setIsOpen(false);
  }, [identityMasked, stopVoice, stopListening]);

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
            onPointerDown={startDrawing}
            onPointerUp={finishDrawing}
            onPointerCancel={finishDrawing}
            onPointerMove={draw}
            ref={canvasRef}
            className="snippet-canvas"
          />
        </div>
      )}

      {/* Assistant state for screen readers: announced only when the state changes. */}
      <span className="ai-sr-only" role="status" aria-live="polite" data-testid="companion-status">{stateLabel}</span>
      {guideEnabled && !identityMasked && !isOpen && !isSnipping && (
        <CompanionGuide key={currentView} reducedMotion={reducedMotion} tone={guideTone} state={companionState} />
      )}

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
          <button type="button" className="companion-chat-btn companion-guide-btn" aria-pressed={guideEnabled} onClick={guideEnabled ? stopVoice : startGuide} aria-describedby="companion-guide-description">
            <Compass size={14} aria-hidden="true" /> Guide
          </button>
          {guideEnabled && !voiceActive && <button id="guide-reopen-mic" type="button" className="companion-chat-btn" onClick={startGuide}><Mic size={14} aria-hidden="true" /> Guide mic</button>}
          <span id="companion-guide-description" className="ai-sr-only">Start hands-free Guide with microphone recognition and silent hover tips.</span>
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
        <section id="ai-voice-stage" className={`voice-stage${guideEnabled ? ' voice-stage--guide' : ''}`} role="dialog" aria-modal="false" aria-label={guideEnabled ? 'FinSphere hands-free Guide' : 'FinSphere voice assistant'}>
          {guideEnabled && <button type="button" className="voice-stage-btn guide-close" onClick={closeGuideMic} aria-label="Close mic panel and keep hover tips" title="Close mic panel; keep hover tips"><X size={16} aria-hidden="true" /></button>}
          <button type="button" className="voice-stage-orb" onClick={voiceSession.tapOrb} aria-label={voiceOrbAction}>
            <FinancialCompanion state={companionState} size="stage" />
          </button>
          <p className="voice-stage-state" aria-hidden={!guideEnabled}>{guideEnabled
            ? voicePhase === 'listening' ? 'Guide mic on' : voicePhase === 'starting' ? 'Starting Guide mic…' : voicePhase === 'error' ? 'Guide mic off' : 'Guide mic paused'
            : voiceStageLabel}</p>
          {guideEnabled && voicePhase === 'listening' && <p className="guide-mic-hint">Say “open transactions” or “Hey FinSphere, how much did I spend?”</p>}
          {voiceSession.userCaption && (
            <p className="voice-caption voice-caption--user">
              <span className="ai-sr-only">You said: </span>“{voiceSession.userCaption}”
            </p>
          )}
          <div className="voice-caption voice-caption--reply" aria-live="polite">
            {voicePhase === 'error' ? voiceSession.errorText : <AssistantReply text={voiceSession.replyCaption} visualization={messages.findLast(m => m.sender === 'bot' && m.text === voiceSession.replyCaption)?.visualization} />}
          </div>
          <ActionConfirmationCard
            compact
            action={pendingAction}
            busy={voicePhase === 'thinking'}
            onConfirm={() => voiceSession.submit('confirm')}
            onCancel={() => voiceSession.submit('cancel')}
          />
          <div className="voice-stage-actions">
            {voiceSession.canSend && (
              <button type="button" className="voice-stage-btn voice-stage-btn--send" onClick={voiceSession.sendNow} aria-label="Send what I said now">
                <Send size={16} aria-hidden="true" />
                <span>Send</span>
              </button>
            )}
            {guideEnabled && voicePhase === 'error' && (
              <button type="button" className="voice-stage-btn" onClick={voiceSession.tapOrb}>Retry mic</button>
            )}
            <button type="button" className="voice-stage-btn" onClick={openChat} aria-label="Switch to text chat">
              <Keyboard size={16} aria-hidden="true" />
              <span>Chat</span>
            </button>
            <button type="button" className="voice-stage-btn voice-stage-btn--end" onClick={stopVoice} aria-label={guideEnabled ? 'End Guide and turn off microphone' : 'End voice session'}>
              <X size={16} aria-hidden="true" />
              <span>{guideEnabled ? 'End Guide' : 'End'}</span>
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

        <div className="ai-model-settings">
          <label htmlFor="ai-model-mode">Model</label>
          <select id="ai-model-mode" value={modelMode} onChange={(event) => setModelMode(event.target.value)} disabled={isThinking} aria-describedby="ai-model-note">
            <option value="cloud">Cloud model</option>
            <option value="local-demo">Local model (demo)</option>
          </select>
          <p id="ai-model-note">Both modes use the server. Without a working cloud connection, it can answer basic financial questions from your records. Local demo adds a short delay; it does not run on this device.</p>
        </div>

        {/* Command hints */}
        <div className="command-hints">
          {HINTS.map((hint) => (
            <button type="button" key={hint} className="hint-chip" onClick={() => handleSendText(hint)}>{hint}</button>
          ))}
        </div>

        <div className="ai-chat-body" id="ai-chat-body" aria-live="polite" aria-relevant="additions">
          {messages.map(msg => (
            <div key={msg.id} className={`chat-message ${msg.sender}`}>
              <div className="message-content">
                {msg.isSnippet && <ImageIcon size={16} style={{display: 'inline', marginRight: '6px', verticalAlign: 'text-bottom', color: '#fff'}} />}
                {msg.sender === 'bot' ? <AssistantReply text={msg.text} visualization={msg.visualization} /> : msg.text}
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

        <ActionConfirmationCard
          action={pendingAction}
          busy={isThinking}
          onConfirm={() => resolvePending('yes')}
          onCancel={() => resolvePending('no')}
        />

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
