import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { TAGLINES } from '../utils/taglines';


// A short, neutral supporting line under the greeting that changes every few seconds (fade plus a slight slide). It says nothing
// about the user's finances. Only this line moves. The box has a fixed height, so a change never shifts the page. With reduced motion
// (the device setting or the Settings preference) it is one still sentence and no timer exists. Screen readers get the first
// sentence once, in plain text: the rotating copy is hidden from them and is not a live region, so nothing is announced repeatedly.
function RotatingTagline({ reduceMotion = false, phrases = TAGLINES, intervalMs = 5000 }) {
  const [index, setIndex] = useState(0);
  const animate = !reduceMotion && phrases.length > 1;

  useEffect(() => {
    if (!animate) return undefined;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;   // do not animate in a background tab
      setIndex((i) => (i + 1) % phrases.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [animate, phrases.length, intervalMs]);

  if (!animate) {
    return <p data-testid="tagline" className="text-zinc-500 min-h-6 leading-6">{phrases[0]}</p>;
  }
  return (
    <div data-testid="tagline" data-phrase-index={index} className="relative h-6 w-[min(20rem,calc(100vw-9rem))] overflow-hidden text-zinc-500 leading-6">
      <span className="sr-only">{phrases[0]}</span>
      <AnimatePresence initial={false}>
        <motion.p
          key={index}
          aria-hidden="true"
          className="absolute inset-x-0 top-0 truncate"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
        >
          {phrases[index]}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}

export default RotatingTagline;
