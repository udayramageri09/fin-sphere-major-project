import { LayoutDashboard, Wallet, CreditCard, PieChart, Target, CalendarRange, Brain, Menu, X, Settings, Link2 } from 'lucide-react';
import { useState } from 'react';
import BrandMark from './BrandMark';

const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, tip: 'Start here for a snapshot of your cash flow and recent activity.' },
  { id: 'transactions', label: 'Transactions', icon: Wallet, tip: 'Open Transactions to review spending, edit categories, or import a statement.' },
  { id: 'liabilities', label: 'Liabilities', icon: CreditCard, tip: 'Track your loans and record repayments in Liabilities.' },
  { id: 'portfolio', label: 'Portfolio', icon: PieChart, tip: 'Open Portfolio to record holdings and review your allocation.' },
  { id: 'goals', label: 'Goals', icon: Target, tip: 'Open Goals to track savings targets and manage your budgets.' },
  { id: 'subscriptions', label: 'SIPs & Subs', icon: CalendarRange, tip: 'Open SIPs and Subscriptions to review recurring payments.' },
  { id: 'plans', label: 'Financial Intelligence', icon: Brain, tip: 'Get an analysis of your spending and ask the Advisor about the results.' },
  { id: 'connections', label: 'Connections', icon: Link2, tip: 'Open Connections to link accounts and import statements.' },
];
const SETTINGS_TIP = 'Open Settings to manage your profile and accessibility preferences.';

function TopNav({ currentView, setCurrentView }) {
  const [isOpen, setIsOpen] = useState(false);
  const onSettings = currentView === 'settings';

  const handleNav = (id) => {
    setCurrentView(id);
    setIsOpen(false);
  };

  return (
    <>
      {/* Top Bar */}
      <header className="fixed top-0 left-0 right-0 h-16 z-40 glass-panel border-b border-t-0 border-l-0 border-r-0 rounded-none border-zinc-200/50 bg-white/70 backdrop-blur-xl flex items-center justify-between px-4 md:px-8 shadow-sm">
        <div className="flex items-center gap-3">
          <BrandMark />
          <h2 className="text-xl font-bold tracking-tight-display text-zinc-900 hidden sm:block">FinSphere</h2>
        </div>

        {/* Desktop Nav */}
        <nav className="hidden xl:flex items-center gap-0.5 2xl:gap-1 overflow-x-auto whitespace-nowrap px-0 2xl:px-2 scrollbar-hide">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                data-guide-tip={item.tip}
                onClick={() => handleNav(item.id)}
                style={isActive ? { backgroundColor: '#09090b', color: '#ffffff' } : {}}
                className={`flex items-center gap-1.5 2xl:gap-2 px-2.5 2xl:px-3 py-2 rounded-xl text-sm font-medium transition-all duration-200
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
          <button
            onClick={() => setIsOpen(!isOpen)}
            aria-label={isOpen ? 'Close menu' : 'Open menu'}
            data-guide-tip={isOpen ? undefined : 'Open the menu to switch between FinSphere pages.'}
            aria-expanded={isOpen}
            className="xl:hidden p-2 -mr-2 text-zinc-900 hover:bg-zinc-100 rounded-full transition-colors"
          >
            {isOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
          <button
            onClick={() => handleNav('settings')}
            aria-label="Profile and settings"
            data-guide-tip={SETTINGS_TIP}
            aria-current={onSettings ? 'page' : undefined}
            title="Profile and settings"
            data-testid="nav-settings"
            className="hidden xl:inline-flex h-11 w-11 items-center justify-center text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            <Settings size={20} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Mobile/Tablet Drawer Backdrop */}
      {isOpen && (
        <div
          className="xl:hidden fixed inset-0 bg-zinc-900/40 backdrop-blur-sm z-30 transition-opacity pt-16 overflow-y-auto overscroll-contain"
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
                    data-guide-tip={item.tip}
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
              <button
                onClick={() => handleNav('settings')}
                aria-current={onSettings ? 'page' : undefined}
                data-testid="drawer-settings"
                data-guide-tip={SETTINGS_TIP}
                style={onSettings ? { backgroundColor: '#09090b', color: '#ffffff' } : {}}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium w-full text-left transition-all duration-200 ${onSettings ? 'shadow-md' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'}`}
              >
                <Settings size={20} style={onSettings ? { color: '#ffffff' } : {}} className={onSettings ? '' : 'text-zinc-400'} />
                <span>Settings</span>
              </button>

           </div>
        </div>
      )}
    </>
  );
}

export default TopNav;
