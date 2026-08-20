import { useState, useEffect, useRef, Suspense, useCallback } from 'react';
import { X, Send, Bot, Image as ImageIcon, Mic, MicOff } from 'lucide-react';
import { Canvas } from '@react-three/fiber';
import { Environment, ContactShadows, Html, useProgress } from '@react-three/drei';
import { AnimatedAvatar } from './AnimatedAvatar';
import './AIAvatar.css';
import { useFinance } from '../context/FinanceContext';
import { useAvatarActions } from '../hooks/useAvatarActions';

function Loader() {
  const { progress } = useProgress();
  return <Html center><div style={{color: 'var(--text-primary)', fontWeight: 'bold'}}>{progress.toFixed(0)}%</div></Html>;
}

function AIAvatar() {
  const { sendMessageToBot } = useFinance();
  const { executeCommand } = useAvatarActions();

  const [isOpen, setIsOpen] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [messages, setMessages] = useState([
    { id: 1, text: "Hi! I'm your FinSphere AI assistant. Ask me anything or say 'show transactions', 'where is credit score', etc. to navigate!", sender: 'bot' }
  ]);
  const [input, setInput] = useState('');

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

  // ──────────────────────────────────────────────
  // Event Listeners (Speak & Autonomous Actions)
  // ──────────────────────────────────────────────
  useEffect(() => {
    const handleSpeak = (e) => {
      if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
      setSpeech(e.detail.message);
    };
    const handleQuiet = () => {
      if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
      speechTimeoutRef.current = setTimeout(() => setSpeech(null), 2000);
    };

    const handleWalkTo = (e) => {
      const { message, selector } = e.detail;
      setIsOpen(false);
      setSpeech(message || 'Done! ✨');
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
  }, []);

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
      { id: Date.now(), isSnippet: true, text: "Area circled on screen", sender: 'user' },
      { id: Date.now() + 1, text: "I see you circled an area. What would you like to know about it?", sender: 'bot' }
    ]);
  };

  const draw = ({ nativeEvent }) => {
    if (!isDrawing) return;
    const { offsetX, offsetY } = nativeEvent;
    contextRef.current.lineTo(offsetX, offsetY);
    contextRef.current.stroke();
  };

  // ──────────────────────────────────────────────
  // Voice & Text Sending
  // ──────────────────────────────────────────────
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
      const handled = executeCommand(transcript);
      if (handled) {
        setIsOpen(false);
        setSpeech(`"${transcript}" 🎤`);
        if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
        speechTimeoutRef.current = setTimeout(() => setSpeech(null), 3000);
      } else {
        setIsOpen(true);
        setInput(transcript);
        setTimeout(() => handleSendText(transcript), 200);
      }
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
  }, [voiceSupported, executeCommand]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) recognitionRef.current.stop();
    setIsListening(false);
  }, []);

  async function handleSendText(text) {
    if (!text.trim() || isThinking) return;
    setInput('');

    const handled = executeCommand(text);
    if (handled) {
      setIsOpen(false);
      return;
    }

    const newMsg = { id: Date.now(), text, sender: 'user' };
    setMessages(prev => [...prev, newMsg]);
    setIsThinking(true);

    try {
      const history = messages
        .filter(m => !m.isSnippet)
        .map(m => ({ role: m.sender === 'bot' ? 'assistant' : 'user', content: m.text }));
      history.push({ role: 'user', content: text });
      const reply = await sendMessageToBot(history);
      setMessages(prev => [...prev, { id: Date.now() + 1, text: reply, sender: 'bot' }]);
    } catch (err) {
      console.error(err);
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        text: "Oops! I encountered an error connecting to my backend. Please verify your connection.",
        sender: 'bot'
      }]);
    } finally {
      setIsThinking(false);
    }
  }

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

      {/* Floating 3D Orb Button (Bottom Right) */}
      <div className={`ai-orb-button ${isSnipping ? 'hidden' : ''} ${isOpen ? 'docked' : ''}`}>
        
        {/* Speech bubble */}
        {speech && !isOpen && !isSnipping && (
          <div className="bot-speech-bubble" onClick={() => setIsOpen(true)}>
            {speech}
          </div>
        )}

        {/* 3D Orb Canvas */}
        <div 
          className="bot-avatar-3d-container" 
          onClick={() => !isSnipping && setIsOpen(!isOpen)}
        >
          <Canvas camera={{ position: [0, 0, 5], fov: 45 }} shadows>
            <ambientLight intensity={0.8} />
            <directionalLight position={[10, 10, 5]} intensity={2} castShadow />
            <Environment preset="city" />
            <Suspense fallback={<Loader />}>
              <AnimatedAvatar isOpen={isOpen} isSnipping={isSnipping} isMoving={isThinking} />
            </Suspense>
            <ContactShadows position={[0, -2, 0]} opacity={0.5} scale={4} blur={2} far={4} />
          </Canvas>
        </div>

        {/* Floating mic button (when chat is closed) */}
        {!isOpen && !isSnipping && voiceSupported && (
          <button
            className={`floating-mic-btn ${isListening ? 'listening' : ''}`}
            onClick={(e) => { e.stopPropagation(); isListening ? stopListening() : startListening(); }}
            title="Speak a command"
          >
            {isListening ? <MicOff size={20} /> : <Mic size={20} />}
            {isListening && <span className="mic-label">Listening…</span>}
          </button>
        )}
      </div>

      {/* Chat Side Panel (Docked on Right) */}
      <div className={`ai-chat-panel ${isOpen ? 'open' : ''} glass-panel`}>
        <div className="ai-chat-header">
          <div className="ai-header-info">
            <div className="ai-icon-small">
              <Bot size={18} />
            </div>
            <div>
              <span className="ai-title">FinSphere Assistant</span>
              <div className="ai-subtitle">Ask me anything or give commands!</div>
            </div>
          </div>
          <button className="close-btn" onClick={() => setIsOpen(false)}>
            <X size={20} />
          </button>
        </div>

        {/* Command hints */}
        <div className="command-hints">
          <span className="hint-chip" onClick={() => handleSendText('show transactions')}>📊 Transactions</span>
          <span className="hint-chip" onClick={() => handleSendText('where is credit score')}>⭐ Credit Score</span>
          <span className="hint-chip" onClick={() => handleSendText('show portfolio')}>📈 Portfolio</span>
        </div>

        <div className="ai-chat-body" id="ai-chat-body">
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
                <div className="thinking-dots">
                  <span className="thinking-dot"></span>
                  <span className="thinking-dot"></span>
                  <span className="thinking-dot"></span>
                </div>
              </div>
            </div>
          )}
        </div>

        <form className="ai-chat-input" onSubmit={handleSend}>
          <input
            type="text"
            placeholder="Ask or command me..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          {voiceSupported && (
            <button
              type="button"
              className={`voice-btn ${isListening ? 'listening' : ''}`}
              onClick={isListening ? stopListening : startListening}
            >
              {isListening ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
          )}
          <button type="submit" className="send-btn" disabled={!input.trim()}>
            <Send size={18} />
          </button>
        </form>
      </div>
    </>
  );
}

export default AIAvatar;
