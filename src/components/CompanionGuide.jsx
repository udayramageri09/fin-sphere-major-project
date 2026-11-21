import { useEffect, useRef, useState } from 'react';
import FinancialCompanion from './FinancialCompanion';
import { GUIDE_TONES } from '../utils/guideTone';

const DWELL_MS = 500;
const CAPTION_MS = 3500;

export default function CompanionGuide({ reducedMotion, tone, state }) {
  const orb = useRef(null);
  const [tip, setTip] = useState('');

  useEffect(() => {
    const node = orb.current;
    let target, dwell, expiry, frame, anchor, point;

    const clearDwell = () => {
      clearTimeout(dwell);
      dwell = undefined;
      target = undefined;
    };
    const clearTip = () => {
      clearTimeout(expiry);
      setTip('');
    };
    const park = () => {
      clearDwell();
      clearTip();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
      if (node) node.hidden = !reducedMotion;
    };

    const offerTip = (element, text) => {
      if (!element.isConnected || document.visibilityState === 'hidden') return;
      clearTip();
      setTip(text);
      expiry = setTimeout(clearTip, CAPTION_MS);
    };

    const move = (event) => {
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
      const element = event.target instanceof Element ? event.target : null;
      const x = event.clientX, y = event.clientY;
      if (!element || event.buttons || element.closest('.ai-orb-button, .voice-stage, [contenteditable="true"], input:focus, textarea:focus, select:focus')) {
        park();
        return;
      }
      if (node && !reducedMotion) {
        point = { x, y };
        if (frame === undefined) frame = window.requestAnimationFrame(() => {
          frame = undefined;
          const rightHalf = point.x > window.innerWidth / 2;
          const lowerHalf = point.y > window.innerHeight / 2;
          const left = point.x + (rightHalf ? -74 : 32);
          const top = point.y + (lowerHalf ? -68 : 24);
          node.classList.toggle('companion-tip-left', rightHalf);
          node.classList.toggle('companion-tip-above', lowerHalf);
          node.style.transform = `translate3d(${Math.max(8, Math.min(window.innerWidth - 48, left))}px, ${Math.max(8, Math.min(window.innerHeight - 48, top))}px, 0)`;
          if (node.hidden) node.hidden = false;
        });
      }
      const next = element.closest('[data-guide-tip], button:not(:disabled), a[href], summary, input:not(:disabled), textarea:not(:disabled), select:not(:disabled)');
      if (target === next && (!dwell || Math.hypot(x - anchor.x, y - anchor.y) <= 10)) return;
      if (target !== next) clearTip();
      clearDwell();
      target = next;
      if (!next) return;
      anchor = { x, y };
      dwell = setTimeout(() => {
        dwell = undefined;
        offerTip(next, next.dataset.guideTip ?? (next.matches('a, summary') ? 'Select to open.' : 'Select to use this control.'));
      }, DWELL_MS);
    };

    const leave = event => { if (!event.relatedTarget) park(); };
    const interactions = ['pointerdown', 'keydown', 'scroll', 'wheel'];
    window.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerout', leave);
    document.addEventListener('visibilitychange', park);
    window.addEventListener('blur', park);
    window.addEventListener('resize', park);
    for (const event of interactions) window.addEventListener(event, park, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointermove', move);
      document.removeEventListener('pointerout', leave);
      document.removeEventListener('visibilitychange', park);
      window.removeEventListener('blur', park);
      window.removeEventListener('resize', park);
      for (const event of interactions) window.removeEventListener(event, park, true);
      park();
    };
  }, [reducedMotion]);

  return (
    <div ref={orb} className={reducedMotion ? 'companion-guide-static' : 'companion-roaming-orb'} hidden={!reducedMotion}>
      {!reducedMotion && <span aria-hidden="true"><FinancialCompanion state={state} size="header" /></span>}
      {tip && <p className="companion-guide-tip" role="status"><strong>{GUIDE_TONES[tone].intro}: </strong>{tip}</p>}
    </div>
  );
}
