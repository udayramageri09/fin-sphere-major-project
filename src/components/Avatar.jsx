import { User } from 'lucide-react';
import { initialsFor } from '../utils/avatarImage';

// A circular avatar: the user's photo (cropped to fill the circle) when there is one, otherwise initials from their chosen name,
// otherwise a neutral person icon. Initials are never taken from an email address. Decorative unless a `label` is given.
function Avatar({ name = '', src = null, size = 40, label, className = '' }) {
  const initials = initialsFor(name);
  const box = { width: size, height: size };
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-zinc-200 bg-zinc-100 text-zinc-700 select-none ${className}`}
      style={box}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })}
      data-avatar={src ? 'photo' : initials ? 'initials' : 'icon'}
    >
      {src ? (
        <img src={src} alt="" draggable="false" style={{ ...box, objectFit: 'cover', display: 'block' }} />
      ) : initials ? (
        <span style={{ fontSize: Math.round(size * 0.38), fontWeight: 600, letterSpacing: '0.02em', lineHeight: 1 }}>{initials}</span>
      ) : (
        <User size={Math.round(size * 0.5)} aria-hidden="true" />
      )}
    </span>
  );
}

export default Avatar;
