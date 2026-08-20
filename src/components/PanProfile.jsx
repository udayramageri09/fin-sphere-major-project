import { BadgeCheck, User, Award } from 'lucide-react';

function PanProfile() {
  return (
    <div className="glass-panel px-4 py-2.5 rounded-full inline-flex items-center gap-4 flex-wrap">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-zinc-100 flex items-center justify-center text-zinc-700 border border-zinc-200">
          <User size={18} />
        </div>
        <div className="flex flex-col">
          <span className="font-semibold text-sm text-zinc-900">Alex M.</span>
          <div className="flex items-center gap-1 text-zinc-500 text-xs font-medium">
            <BadgeCheck size={12} />
            <span>PAN Linked (ABCDE1234F)</span>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <div className="bg-zinc-100 text-zinc-700 px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-1 border border-zinc-200">
          <Award size={12} /> Frugal Master
        </div>
        <div className="bg-zinc-100 text-zinc-700 px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-1 border border-zinc-200">
          <Award size={12} /> 700+ Club
        </div>
      </div>
    </div>
  );
}

export default PanProfile;
