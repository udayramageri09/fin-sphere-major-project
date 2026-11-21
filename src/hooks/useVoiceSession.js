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
 * Guide also resumes after silence; the "Hey FinSphere" wake phrase is optional and stripped when present.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toSpeechText } from '../utils/speechText';
import { NAVIGATION_PULSE_MS } from '../utils/companionState';
import { GUIDE_TONES } from '../utils/guideTone';

const GUIDE_LANGUAGE = 'en-US';
// After the browser marks a phrase final we wait briefly for a continuation; an unfinished phrase waits a little longer.
const FINAL_SILENCE_MS = 450;
const INTERIM_SILENCE_MS = 1000;
const SPOKEN_REPLY_MAX = 220;
const SPEECH_RATE_BOOST = 1.12;
const GUIDE_PREFIX = /^(?:(?:hey|hi|okay|ok)\s+)?(?:fin\s*sphere|fin\s+spear)[\s,.:!-]+/i;
const FEMALE_VOICE = /\b(?:female|zira|aria|jenny|samantha|karen|moira|tessa|hazel|sonia|veena)\b/i;

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

// Replies are shown in full but only the first sentences are read aloud, which keeps the conversation quick.
function shortenForSpeech(text) {
  if (text.length <= SPOKEN_REPLY_MAX) return text;
  let spoken = '';
  for (const sentence of text.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? []) {
    if (spoken && (spoken + sentence).length > SPOKEN_REPLY_MAX) break;
    spoken += sentence;
  }
  return (spoken || text).slice(0, SPOKEN_REPLY_MAX * 2).trim();
}

// Voice owns recognition/speech lifecycle only. runTurn owns proposals and explicit confirmation;
// a recognition callback must never bypass that path and write financial state directly.
export function useVoiceSession({ runTurn, guideTone = 'friendly' }) {
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState('idle');          // idle | listening | thinking | speaking | error
  const [userCaption, setUserCaption] = useState('');
  const [replyCaption, setReplyCaption] = useState('');
  const [errorText, setErrorText] = useState('');
  const [heardPending, setHeardPending] = useState(false);   // words were heard and are waiting to be sent

  const activeRef = useRef(false);
  const guideRef = useRef(false);
  const localSpeechRef = useRef(true);
  const sessionId = useRef(0);
  const recognitionRef = useRef(null);
  const utteranceRef = useRef(null);
  const afterSpeechRef = useRef(null);                  // what runs when the current reply finishes being spoken
  const watchdogRef = useRef(null);
  const runTurnRef = useRef(runTurn);
  const toneRef = useRef(guideTone);
  useEffect(() => { runTurnRef.current = runTurn; toneRef.current = guideTone; });

  const silenceTimerRef = useRef(null);
  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
  }, []);

  const finishNowRef = useRef(null);                     // sends whatever has been heard so far, without waiting for silence
  const stopRecognition = useCallback(() => {
    clearSilenceTimer();
    finishNowRef.current = null;
    setHeardPending(false);
    const r = recognitionRef.current;
    recognitionRef.current = null;
    if (!r) return;
    r.onstart = r.onresult = r.onerror = r.onend = null;
    try { (r.abort ?? r.stop).call(r); } catch { /* already stopped */ }
  }, [clearSilenceTimer]);

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
    const spoken = shortenForSpeech(toSpeechText(text));
    if (!synth || !spoken) { done(); return; }
    stopSpeaking();
    const utterance = new window.SpeechSynthesisUtterance(spoken);

    const english = (synth.getVoices?.() ?? []).filter(v => /^en\b/i.test(v.lang));
    const local = english.filter(v => v.localService);
    const preferredVoice = local.find(v => FEMALE_VOICE.test(v.name))
      ?? (guideRef.current ? local[0] ?? english[0] : english.find(v => FEMALE_VOICE.test(v.name)) ?? local[0] ?? english[0]);

    if (preferredVoice) {
      utterance.voice = preferredVoice;
      utterance.lang = preferredVoice.lang;
    } else {
      utterance.lang = 'en-US';
    }

    const tone = GUIDE_TONES[toneRef.current];
    utterance.rate = Math.min(1.4, tone.rate * SPEECH_RATE_BOOST);
    utterance.pitch = tone.pitch;
    utterance.volume = 1;
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
    watchdogRef.current = setTimeout(() => {
      if (utteranceRef.current === utterance) {
        utterance.onend = utterance.onerror = null;
        try { synth.cancel(); } catch { /* the browser may already have cancelled it */ }
        finish();
      }
    }, Math.max(8000, spoken.length * 120));
    try { synth.speak(utterance); } catch { finish(); }
  }, [stopSpeaking]);

  const listenRef = useRef(null);
  const resumeTimerRef = useRef(null);
  const clearResume = useCallback(() => {
    if (resumeTimerRef.current) { clearTimeout(resumeTimerRef.current); resumeTimerRef.current = null; }
  }, []);
  // After a navigation the session rests briefly (the companion's "navigating" sweep is visible), then listens.
  const resumeListening = useCallback((delay) => {
    setPhase('idle');
    clearResume();
    resumeTimerRef.current = setTimeout(() => {
      resumeTimerRef.current = null;
      if (activeRef.current) listenRef.current();
    }, delay);
  }, [clearResume]);

  const handleTranscript = useCallback(async (transcript, confidence) => {
    const turnSession = sessionId.current;
    setUserCaption(transcript);
    setReplyCaption('');
    setErrorText('');
    setPhase('thinking');
    const result = await runTurnRef.current(transcript, { source: 'voice', confidence });
    if (!activeRef.current || sessionId.current !== turnSession) return;
    if (result?.status === 'answered') {
      setReplyCaption(result.reply);
      speak(result.spokenReply || result.reply, () => {
        if (!activeRef.current) return;
        if (result.navigate) {
          result.navigate();                               // question + command: navigate only after the answer
          resumeListening(NAVIGATION_PULSE_MS);
        } else {
          listenRef.current();
        }
      });
    } else if (result?.status === 'navigated') {
      setReplyCaption(result.note);
      resumeListening(NAVIGATION_PULSE_MS);
    } else if (result?.status === 'failed') {
      setErrorText(result.error);
      setPhase('error');
    } else {
      if (guideRef.current) resumeListening(350);
      else setPhase('idle');
    }
  }, [speak, resumeListening]);

  const listen = useCallback(() => {
    if (!activeRef.current) return;
    clearResume();
    const Recognition = getRecognitionClass();
    if (!Recognition) {
      setErrorText('Voice input is not supported in this browser. You can use text chat instead.');
      setPhase('error');
      return;
    }
    stopRecognition();
    const r = new Recognition();
    const guide = guideRef.current;
    // Guide tries on-device recognition first and quietly falls back to the browser's normal recognition (demo-friendly).
    if (guide && localSpeechRef.current && 'processLocally' in r) r.processLocally = true;
    r.lang = guide ? GUIDE_LANGUAGE : 'en-IN';
    // Browsers may finalize an utterance in pieces ("Hey" ... "FinSphere open goals"), so collect everything until a short silence.
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    let heardText = '';
    let heardConfidence;
    const finishUtterance = () => {
      if (recognitionRef.current !== r) return;
      clearSilenceTimer();
      finishNowRef.current = null;
      setHeardPending(false);
      const heard = heardText.trim();
      const transcript = guide ? heard.replace(GUIDE_PREFIX, '').trim() : heard;
      if (guide) stopRecognition();
      else { r.onstart = r.onresult = r.onerror = r.onend = null; try { r.abort(); } catch { /* already stopped */ } recognitionRef.current = null; }
      if (transcript) handleTranscript(transcript, heardConfidence);
      else if (guide) resumeListening(350);
      else setPhase('idle');
    };
    r.onstart = () => { if (recognitionRef.current === r) setPhase('listening'); };
    r.onresult = (event) => {
      if (recognitionRef.current !== r) return;
      const results = Array.from(event?.results ?? []);
      heardText = results.map((result) => result?.[0]?.transcript ?? '').join(' ').replace(/\s+/g, ' ').trim();
      const confidences = results.filter((result) => result.isFinal).map((result) => result?.[0]?.confidence).filter((value) => typeof value === 'number' && value > 0);
      heardConfidence = confidences.length ? Math.min(...confidences) : undefined;
      clearSilenceTimer();
      setHeardPending(Boolean(heardText));
      if (heardText) {
        setUserCaption(heardText);
        const lastIsFinal = results.at(-1)?.isFinal === true;
        silenceTimerRef.current = setTimeout(finishUtterance, lastIsFinal ? FINAL_SILENCE_MS : INTERIM_SILENCE_MS);
      }
    };
    r.onerror = (event) => {
      if (recognitionRef.current !== r) return;
      if (heardText.trim() && event?.error !== 'not-allowed' && event?.error !== 'service-not-allowed') { finishUtterance(); return; }
      clearSilenceTimer();
      recognitionRef.current = null;
      if (guide && event?.error === 'no-speech') {
        resumeListening(350);
        return;
      }
      if (guide && event?.error === 'language-not-supported' && localSpeechRef.current) {
        localSpeechRef.current = false;                   // no on-device pack: use the normal recognizer instead
        resumeListening(0);
        return;
      }
      setErrorText(recognitionMessage(event?.error));
      setPhase('error');
    };
    r.onend = () => {
      if (recognitionRef.current !== r) return;           // a result or error already handled this run
      if (heardText.trim()) { finishUtterance(); return; }
      clearSilenceTimer();
      recognitionRef.current = null;
      if (guide) resumeListening(350);
      else setPhase('idle');
    };
    recognitionRef.current = r;
    finishNowRef.current = finishUtterance;
    setHeardPending(false);
    setUserCaption('');
    setErrorText('');
    setPhase(guide ? 'starting' : 'listening');
    try { r.start(); } catch {
      recognitionRef.current = null;
      setErrorText(recognitionMessage());
      setPhase('error');
    }
  }, [clearResume, clearSilenceTimer, handleTranscript, resumeListening, stopRecognition]);
  useEffect(() => { listenRef.current = listen; }, [listen]);

  const start = useCallback(({ guide = false } = {}) => {
    sessionId.current++;
    guideRef.current = guide;
    localSpeechRef.current = true;
    activeRef.current = true;
    setActive(true);
    setUserCaption('');
    setReplyCaption('');
    setErrorText('');
    listen();
  }, [listen]);

  const end = useCallback(() => {
    activeRef.current = false;
    sessionId.current++;
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
    if (phase === 'listening' || phase === 'starting') { stopRecognition(); setPhase('idle'); return; }
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

  const sendNow = useCallback(() => { finishNowRef.current?.(); }, []);

  useEffect(() => () => { activeRef.current = false; sessionId.current++; clearResume(); stopRecognition(); stopSpeaking(); }, [clearResume, stopRecognition, stopSpeaking]);

  return { active, phase, userCaption, replyCaption, errorText, canSend: phase === 'listening' && heardPending, sendNow, start, end, tapOrb, submit };
}
