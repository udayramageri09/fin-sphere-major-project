import { useAuth } from '../context/AuthContext';
import { useReduceMotion } from '../hooks/useMotionPreference';
import Avatar from './Avatar';
import RotatingTagline from './RotatingTagline';

// "Welcome back, {name}" with the user's avatar and a short rotating line. Uses only the chosen display name (never the email): with no
// name it is simply "Welcome back".
function DashboardGreeting() {
  const { user, avatarUrl } = useAuth();
  const reduceMotion = useReduceMotion();
  const name = (user?.displayName ?? '').trim();
  return (
    <div className="flex items-center gap-4 min-w-0 max-w-full">
      <Avatar size={56} name={name} src={avatarUrl} />
      <div className="min-w-0 flex-1">
        <h1 className="text-3xl font-bold tracking-tight-display text-zinc-900 mb-1 [overflow-wrap:anywhere]" data-testid="greeting">
          {name ? `Welcome back, ${name}` : 'Welcome back'}
        </h1>
        <RotatingTagline reduceMotion={reduceMotion} />
      </div>
    </div>
  );
}

export default DashboardGreeting;
