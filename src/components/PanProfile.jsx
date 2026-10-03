import { User } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

// Identity chip. Only the authenticated session's email is real data here; there is
// no name, PAN or badge data to show, so none is rendered.
function PanProfile() {
  const { user } = useAuth();

  return (
    <div className="glass-panel px-4 py-2.5 rounded-full inline-flex items-center gap-3 min-w-0 max-w-full">
      <div className="w-9 h-9 shrink-0 rounded-full bg-zinc-100 flex items-center justify-center text-zinc-700 border border-zinc-200">
        <User size={18} />
      </div>
      <div className="flex flex-col min-w-0">
        <span className="text-xs text-zinc-500 font-medium">Signed in as</span>
        <span className="font-semibold text-sm text-zinc-900 truncate">{user?.email || 'Not available'}</span>
      </div>
    </div>
  );
}

export default PanProfile;
