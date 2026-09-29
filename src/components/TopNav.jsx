import { LayoutDashboard, Wallet, CreditCard, PieChart, Target, CalendarRange, Brain, Menu, X, Settings, LogOut } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'transactions', label: 'Transactions', icon: Wallet },
  { id: 'liabilities', label: 'Liabilities', icon: CreditCard },
  { id: 'portfolio', label: 'Portfolio', icon: PieChart },
  { id: 'goals', label: 'Goals', icon: Target },
  { id: 'subscriptions', label: 'SIPs & Subs', icon: CalendarRange },
  { id: 'plans', label: 'ML Plans', icon: Brain },
];

function TopNav({ currentView, setCurrentView }) {
  const [isOpen, setIsOpen] = useState(false);
  const { user, logout } = useAuth();

  const handleNav = (id) => {
    setCurrentView(id);
    setIsOpen(false);
  };

  return (
    <>
      {/* Top Bar */}
      <header className="fixed top-0 left-0 right-0 h-16 z-40 glass-panel border-b border-t-0 border-l-0 border-r-0 rounded-none border-zinc-200/50 bg-white/70 backdrop-blur-xl flex items-center justify-between px-4 md:px-8 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-zinc-900 flex-shrink-0" />
          <h2 className="text-xl font-bold tracking-tight-display text-zinc-900 hidden sm:block">FinSphere</h2>
        </div>

        {/* Desktop Nav */}
        <nav className="hidden xl:flex items-center gap-1 overflow-x-auto whitespace-nowrap px-2 scrollbar-hide">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNav(item.id)}
                style={isActive ? { backgroundColor: '#09090b', color: '#ffffff' } : {}}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all duration-200
                  ${isActive ? 'shadow-md' : 'text-gray-500 hover:bg-gray-100 hover:text-black'}
                `}
              >
                <Icon size={16} style={isActive ? { color: '#ffffff' } : {}} className={!isActive ? 'text-gray-400' : ''} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Right side (Desktop Settings / Mobile Hamburger) */}
        <div className="flex items-center gap-2">
          {user?.email && (
            <span className="hidden xl:block text-sm text-zinc-500 max-w-45 truncate">{user.email}</span>
          )}
          <button className="hidden xl:flex p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 rounded-full transition-colors">
            <Settings size={20} />
          </button>
          <button
            onClick={logout}
            title="Log out"
            className="hidden xl:flex p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 rounded-full transition-colors"
          >
            <LogOut size={20} />
          </button>

          <button
            onClick={() => setIsOpen(!isOpen)} 
            className="xl:hidden p-2 -mr-2 text-zinc-900 hover:bg-zinc-100 rounded-full transition-colors"
          >
            {isOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </header>

      {/* Mobile/Tablet Drawer Backdrop */}
      {isOpen && (
        <div 
          className="xl:hidden fixed inset-0 bg-zinc-900/40 backdrop-blur-sm z-30 transition-opacity pt-16"
          onClick={() => setIsOpen(false)}
        >
           {/* Drawer Content */}
           <div 
             className="w-full bg-white glass-panel rounded-t-none shadow-2xl p-4 flex flex-col gap-1.5"
             onClick={e => e.stopPropagation()}
           >
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = currentView === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleNav(item.id)}
                    style={isActive ? { backgroundColor: '#09090b', color: '#ffffff' } : {}}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium w-full text-left transition-all duration-200
                      ${isActive ? 'shadow-md' : 'text-gray-500 hover:bg-gray-100 hover:text-black'}
                    `}
                  >
                    <Icon size={20} style={isActive ? { color: '#ffffff' } : {}} className={!isActive ? 'text-gray-400' : ''} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
              <div className="h-px bg-zinc-200 my-2" />
              {user?.email && (
                <div className="px-4 py-1 text-xs text-zinc-400 truncate">{user.email}</div>
              )}
              <button className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium w-full text-left text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 transition-all duration-200">
                <Settings size={20} className="text-zinc-400" />
                <span>Settings</span>
              </button>
              <button
                onClick={() => { setIsOpen(false); logout(); }}
                className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium w-full text-left text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 transition-all duration-200"
              >
                <LogOut size={20} className="text-zinc-400" />
                <span>Log out</span>
              </button>
           </div>
        </div>
      )}
    </>
  );
}

export default TopNav;
