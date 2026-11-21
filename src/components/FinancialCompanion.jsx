// FinancialCompanion - the assistant's compact, state-driven orb (Issue #71).
// Purely presentational: the parent decides the state (see src/utils/companionState.js). Every movement belongs to a
// state; with reduced motion the state is still shown by colour and shape. Inline SVG + CSS only - no canvas, no
// WebGL, no external assets. The SVG is decorative; the parent supplies the accessible name and status text.
import { useId } from 'react';
import { COMPANION_STATES } from '../utils/companionState';
import './FinancialCompanion.css';

const SIZES = ['launcher', 'header', 'stage'];

function FinancialCompanion({ state = 'idle', size = 'launcher' }) {
  const gradient = useId();
  const safeState = COMPANION_STATES[state] ? state : 'idle';
  const safeSize = SIZES.includes(size) ? size : 'launcher';
  return (
    <span className={`fin-companion fin-companion--${safeSize}`} data-state={safeState}>
      <svg className="fc-svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id={gradient} cx="38%" cy="32%" r="70%">
            <stop offset="0%" className="fc-core-stop-1" />
            <stop offset="60%" className="fc-core-stop-2" />
            <stop offset="100%" className="fc-core-stop-3" />
          </radialGradient>
        </defs>
        {/* listening: two expanding rings */}
        <circle className="fc-wave fc-wave--1" cx="32" cy="32" r="20" />
        <circle className="fc-wave fc-wave--2" cx="32" cy="32" r="20" />
        {/* halo: colour carries attention / success / error / insight even without motion */}
        <circle className="fc-halo" cx="32" cy="32" r="25" />
        {/* navigating: a directional arc that sweeps toward the right as a page opens */}
        <circle className="fc-sweep" cx="32" cy="32" r="25" pathLength="100" />
        {/* thinking: three dots orbiting the halo */}
        <g className="fc-orbit">
          <circle className="fc-dot" cx="32" cy="7" r="2.4" />
          <circle className="fc-dot" cx="53.6" cy="44.5" r="2.4" />
          <circle className="fc-dot" cx="10.4" cy="44.5" r="2.4" />
        </g>
        {/* core */}
        <circle className="fc-core" cx="32" cy="32" r="17" fill={`url(#${gradient})`} />
        {/* speaking: a rhythmic inner ring while the voice session reads a reply aloud */}
        <circle className="fc-voice" cx="32" cy="32" r="11" />
        {/* insight: a small sparkle */}
        <path className="fc-spark" d="M44 14 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6z" />
      </svg>
    </span>
  );
}

export default FinancialCompanion;
