/**
 * useVoiceSession - the Financial Companion's voice conversation (Issue #71).
 *
 * A small state machine around the browser's SpeechRecognition and speechSynthesis. It owns NO financial logic:
 * every recognised sentence goes to `runTurn(text, { source: 'voice' })`, the same pipeline the text chat uses
 * (intent parsing, grounded /api/chat answer, navigation). The reply that pipeline returns is shown as a caption and
 * read aloud unchanged (only presentation marks are stripped, see src/utils/speechText.js).
 *
 *   start -> listening -> (transcript) -> thinking -> speaking -> listening ...      (until end)
 *   a navigation-only command      -> navigates (with the companion's short sweep), captions it, listens again
 *   a question + command           -> answer shown and spoken, THEN navigation, then listens again
 *   recognition / request failure  -> "error", stays there (no automatic restart; tapping the orb retries)
 *   silence / stopped              -> "idle" inside the session (tap the orb to speak)
 *
 * Listening only resumes automatically after a completed turn, so the session cannot loop on its own.
 * `start` is the single entry point a future wake-phrase detector would call.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toSpeechText } from '../utils/speechText';
import { NAVIGATION_PULSE_MS } from '../utils/companionState';

const RECOGNITION_ERRORS = {
  'not-allowed': 'Microphone access is blocked. Allow it in your browser settings, or use text chat.',
  'service-not-allowed': 'Microphone access is blocked. Allow it in your browser settings, or use text chat.',
  'no-speech': "I didn't catch that. Tap the orb to try again.",
  'audio-capture': 'No microphone was found. You can use text chat instead.',
  network: 'Voice recognition needs a network connection. You can use text chat instead.',
};
const recognitionMessage = (code) => RECOGNITION_ERRORS[code] ?? 'Voice input stopped. Tap the orb to try again.';

const getRecognitionClass = () => (typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition || null);
const getSynthesis = () => (typeof window !== 'undefined' && window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function'
  ? window.speechSynthesis : null);

// Voice owns recognition/speech lifecycle only. runTurn owns proposals and explicit confirmation;
// a recognition callback must never bypass that path and write financial state directly.
export function useVoiceSession({ runTurn }) {
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState('idle');          // idle | listening | thinking | speaking | error
  const [userCaption, setUserCaption] = useState('');
  const [replyCaption, setReplyCaption] = useState('');
  const [errorText, setErrorText] = useState('');

  const activeRef = useRef(false);
  const recognitionRef = useRef(null);
  const utteranceRef = useRef(null);
  const afterSpeechRef = useRef(null);                  // what runs when the current reply finishes being spoken
  const watchdogRef = useRef(null);
  const runTurnRef = useRef(runTurn);
  useEffect(() => { runTurnRef.current = runTurn; });

  const stopRecognition = useCallback(() => {
    const r = recognitionRef.current;
    recognitionRef.current = null;
    if (!r) return;
    r.onstart = r.onresult = r.onerror = r.onend = null;
    try { (r.abort ?? r.stop).call(r); } catch { /* already stopped */ }
  }, []);

  const stopSpeaking = useCallback(() => {
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    const hadUtterance = utteranceRef.current !== null;
    utteranceRef.current = null;
    afterSpeechRef.current = null;
    const synth = getSynthesis();
    if (synth && hadUtterance) { try { synth.cancel(); } catch { /* nothing to cancel */ } }
  }, []);

  // Reads `text` aloud, then calls `done` (also when speech is unavailable, fails, or never reports its end).
  const speak = useCallback((text, done) => {
    const synth = getSynthesis();
    const spoken = toSpeechText(text);
    if (!synth || !spoken) { done(); return; }
    stopSpeaking();
    const utterance = new window.SpeechSynthesisUtterance(spoken);
    utterance.lang = 'en-IN';
    const finish = () => {
      if (utteranceRef.current !== utterance) return;      // cancelled or superseded: do nothing
      utteranceRef.current = null;
      afterSpeechRef.current = null;
      if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      done();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    utteranceRef.current = utterance;
    afterSpeechRef.current = done;
    setPhase('speaking');
    // Some browsers never fire onend for long utterances; never stay "speaking" forever.
    watchdogRef.current = setTimeout(finish, Math.max(8000, spoken.length * 120));
    try { synth.speak(utterance); } catch { finish(); }
  }, [stopSpeaking]);

  const listenRef = useRef(null);
  const resumeTimerRef = useRef(null);
  const clearResume = useCallback(() => {
    if (resumeTimerRef.current) { clearTimeout(resumeTimerRef.current); resumeTimerRef.current = null; }
  }, []);
  // After a navigation the session rests briefly (the companion's "navigating" sweep is visible), then listens.
  const resumeAfterNavigation = useCallback(() => {
    setPhase('idle');
    clearResume();
    resumeTimerRef.current = setTimeout(() => {
      resumeTimerRef.current = null;
      if (activeRef.current) listenRef.current();
    }, NAVIGATION_PULSE_MS);
  }, [clearResume]);

  const handleTranscript = useCallback(async (transcript, confidence) => {
    setUserCaption(transcript);
    setReplyCaption('');
    setErrorText('');
    setPhase('thinking');
    const result = await runTurnRef.current(transcript, { source: 'voice', confidence });
    if (!activeRef.current) return;                        // the session was closed while waiting
    if (result?.status === 'answered') {
      setReplyCaption(result.reply);
      speak(result.spokenReply || result.reply, () => {
        if (!activeRef.current) return;
        if (result.navigate) {
          result.navigate();                               // question + command: navigate only after the answer
          resumeAfterNavigation();
        } else {
          listenRef.current();
        }
      });
    } else if (result?.status === 'navigated') {
      setReplyCaption(result.note);
      resumeAfterNavigation();
    } else if (result?.status === 'failed') {
      setErrorText(result.error);
      setPhase('error');
    } else {
      setPhase('idle');
    }
  }, [speak, resumeAfterNavigation]);

  const listen = useCallback(() => {
    if (!activeRef.current) return;
    const Recognition = getRecognitionClass();
    if (!Recognition) {
      setErrorText('Voice input is not supported in this browser. You can use text chat instead.');
      setPhase('error');
      return;
    }
    stopRecognition();
    const r = new Recognition();
    r.lang = 'en-IN';
    r.continuous = false;
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (event) => {
      if (recognitionRef.current !== r) return;
      recognitionRef.current = null;
      const alternative = event?.results?.[0]?.[0];
      const transcript = alternative?.transcript?.trim();
      // The recogniser's own confidence (0-1, when the browser reports it) lets a doubtful "yes" be asked again.
      if (transcript) handleTranscript(transcript, alternative.confidence);
      else setPhase('idle');
    };
    r.onerror = (event) => {
      if (recognitionRef.current !== r) return;
      recognitionRef.current = null;
      setErrorText(recognitionMessage(event?.error));
      setPhase('error');
    };
    r.onend = () => {
      if (recognitionRef.current !== r) return;           // a result or error already handled this run
      recognitionRef.current = null;
      setPhase('idle');                                    // ended in silence: wait for the user
    };
    recognitionRef.current = r;
    setErrorText('');
    setPhase('listening');
    try { r.start(); } catch {
      recognitionRef.current = null;
      setErrorText(recognitionMessage());
      setPhase('error');
    }
  }, [handleTranscript, stopRecognition]);
  useEffect(() => { listenRef.current = listen; }, [listen]);

  const start = useCallback(() => {
    activeRef.current = true;
    setActive(true);
    setUserCaption('');
    setReplyCaption('');
    setErrorText('');
    listen();
  }, [listen]);

  const end = useCallback(() => {
    activeRef.current = false;
    clearResume();
    stopRecognition();
    stopSpeaking();
    setActive(false);
    setPhase('idle');
    setUserCaption('');
    setReplyCaption('');
    setErrorText('');
  }, [clearResume, stopRecognition, stopSpeaking]);

  // Sends text through the same path as a spoken sentence (the stage's Confirm / Cancel buttons use it), so a button
  // press and the word "confirm" are handled identically: same pipeline, same caption, same spoken answer.
  const submit = useCallback((text) => {
    if (!activeRef.current) return;
    clearResume();
    stopRecognition();
    stopSpeaking();
    handleTranscript(String(text));
  }, [clearResume, stopRecognition, stopSpeaking, handleTranscript]);

  // The stage orb: listen again, stop listening, or skip the rest of a spoken reply.
  const tapOrb = useCallback(() => {
    if (!activeRef.current) return;
    if (phase === 'listening') { stopRecognition(); setPhase('idle'); return; }
    if (phase === 'thinking') return;
    clearResume();
    if (phase === 'speaking') {
      // Skipping the rest of a reply still completes the turn (e.g. the navigation it asked for), then listens.
      const after = afterSpeechRef.current;
      stopSpeaking();
      if (after) { after(); return; }
    }
    listen();
  }, [phase, listen, clearResume, stopRecognition, stopSpeaking]);

  useEffect(() => () => { activeRef.current = false; clearResume(); stopRecognition(); stopSpeaking(); }, [clearResume, stopRecognition, stopSpeaking]);

  return { active, phase, userCaption, replyCaption, errorText, start, end, tapOrb, submit };
}
