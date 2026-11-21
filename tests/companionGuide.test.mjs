import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Guide shows quiet, styled hover tips and respects reduced motion', async () => {
  const dom = new JSDOM('<div id="root"></div><button data-guide-tip="Review your transactions.">Transactions</button>', {
    url: 'http://localhost/', pretendToBeVisual: true
  });
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document, Element: window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  const spoken = [];
  window.speechSynthesis = {
    getVoices: () => [{ lang: 'en-IN', localService: false }, { lang: 'en-GB', localService: true }],
    speak: utterance => spoken.push(utterance),
  };
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' });
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const host = document.getElementById('root');
  const root = createRoot(host);
  const { default: Guide } = await vite.ssrLoadModule('/src/components/CompanionGuide.jsx');
  const target = document.querySelector('[data-guide-tip]');
  const render = (reducedMotion, tone) => act(async () => root.render(createElement(Guide, { reducedMotion, tone })));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const move = (pointerType, x) => {
    const event = new window.MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: 40 });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    target.dispatchEvent(event);
  };
  const orb = () => host.querySelector('.companion-roaming-orb');
  const caption = () => host.querySelector('[role=status]')?.textContent;
  try {
    await render(false, 'friendly');
    await act(async () => { move('touch', 80); await wait(550); });
    assert.equal(caption(), undefined);
    assert.equal(orb().hidden, true);

    await act(async () => { move('mouse', 60); move('mouse', 90); await wait(150); });
    assert.equal(caption(), undefined, 'a brief pass does not show a tip');
    assert.equal(orb().hidden, false);
    assert.match(orb().style.transform, /122px/);
    await act(async () => { await wait(450); });
    assert.equal(caption(), 'Quick tip: Review your transactions.');
    assert.ok(orb().contains(host.querySelector('[role=status]')), 'the caption moves with the avatar');
    assert.equal(spoken.length, 0, 'hover never plays audio even when a voice is installed');

    await act(async () => window.dispatchEvent(new window.Event('blur')));
    assert.equal(caption(), undefined);
    await render(true, 'funny');
    await act(async () => { move('pen', 80); await wait(550); });
    assert.equal(orb(), null, 'reduced motion turns off the follower');
    assert.equal(caption(), 'Tiny side quest: Review your transactions.');

    const { useVoiceSession } = await vite.ssrLoadModule('/src/hooks/useVoiceSession.js');
    let session;
    const recognizers = [];
    window.SpeechRecognition = class {
      processLocally = false;
      start() { recognizers.push(this); this.onstart?.(); }
      abort() { this.aborted = true; }
      // say() is a finished utterance (the browser ends the run); hear() is a partial one that only the silence timer can finish.
      hear(...parts) { this.onresult?.({ results: parts.map(transcript => Object.assign([{ transcript, confidence: 1 }], { isFinal: true })) }); }
      say(...parts) { this.hear(...parts); this.onend?.(); }
    };
    window.speechSynthesis.getVoices = () => [
      { name: 'Google UK English Female', lang: 'en-GB', localService: false },
      { name: 'Microsoft David', lang: 'en-US', localService: true },
      { name: 'Microsoft Zira', lang: 'en-US', localService: true },
    ];
    window.speechSynthesis.cancel = () => {};
    const turns = [];
    const runTurn = async text => { turns.push(text); return { status: 'answered', reply: 'Here are your transactions.' }; };
    function VoiceHarness() {
      session = useVoiceSession({ runTurn, guideTone: 'friendly' });
      return null;
    }
    await act(async () => root.render(createElement(VoiceHarness)));
    await act(async () => session.start({ guide: true }));
    assert.equal(session.phase, 'listening');
    assert.equal(recognizers[0].processLocally, true);
    await act(async () => recognizers[0].say('Hey FinSphere, open transactions'));
    assert.deepEqual(turns, ['open transactions']);
    assert.equal(recognizers[0].aborted, true);
    assert.equal(session.phase, 'speaking');
    assert.equal(spoken[0].voice.name, 'Microsoft Zira');
    await act(async () => spoken[0].onend());
    assert.equal(recognizers.length, 2, 'Guide resumes after the reply finishes');
    await act(async () => {
      recognizers[1].hear('Hey');
      recognizers[1].hear('Hey', 'FinSphere open goals');
      await wait(1600);
    });
    assert.deepEqual(turns, ['open transactions', 'open goals'], 'an utterance finalized in pieces is joined before the wake phrase is checked');
    await act(async () => spoken[1].onend());
    assert.equal(recognizers.length, 3);
    await act(async () => {
      recognizers[2].onend();
      session.end();
      await wait(400);
    });
    assert.equal(recognizers.length, 3, 'End cancels a scheduled restart');

    // No on-device speech pack: the Guide falls back to the browser's normal recognizer instead of stopping.
    window.SpeechRecognition = class {
      processLocally = false;
      start() { recognizers.push(this); this.onstart?.(); if (this.processLocally) this.onerror?.({ error: 'language-not-supported' }); }
      abort() { this.aborted = true; }
      hear(...parts) { this.onresult?.({ results: parts.map(transcript => Object.assign([{ transcript, confidence: 1 }], { isFinal: true })) }); }
      say(...parts) { this.hear(...parts); this.onend?.(); }
    };
    const before = recognizers.length;
    await act(async () => { session.start({ guide: true }); await wait(50); });
    assert.equal(recognizers.length, before + 2, 'the failed on-device attempt is retried without it');
    assert.equal(recognizers.at(-1).processLocally, false);
    assert.equal(session.phase, 'listening');
    await act(async () => recognizers.at(-1).say('open budgets'));
    assert.equal(turns.at(-1), 'open budgets', 'the wake phrase is optional');
    await act(async () => spoken.at(-1).onend());
    await act(async () => { recognizers.at(-1).hear('open goals'); });
    assert.equal(session.canSend, true);
    await act(async () => session.sendNow());
    assert.equal(turns.at(-1), 'open goals', 'Send submits what was heard without waiting for silence');
    assert.equal(session.canSend, false);  } finally {
    await act(async () => root.unmount());
    await vite.close();
    window.close();
  }
});
