import { useState, useEffect } from 'react'
import { FinanceProvider } from './context/FinanceContext'
import { useAuth } from './context/AuthContext'
import TopNav from './components/TopNav'
import Dashboard from './pages/Dashboard'
import Transactions from './pages/Transactions'
import Liabilities from './pages/Liabilities'
import Portfolio from './pages/Portfolio'
import Goals from './pages/Goals'
import Subscriptions from './pages/Subscriptions'
import Plans from './pages/Plans'
import AIAvatar from './components/AIAvatar'
import AuthPage from './pages/AuthPage'

function App() {
  const [resetToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('reset'));
  useEffect(() => {
    if (resetToken !== null) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [resetToken]);
  const [currentView, setCurrentView] = useState('dashboard');
  const { status } = useAuth();

  if (status === 'checking') {
    return (
      <div className="flex items-center justify-center min-h-screen w-full bg-zinc-50">
        <div className="w-8 h-8 rounded-lg bg-zinc-900 animate-pulse" />
      </div>
    );
  }

  if (status === 'unauthenticated' || resetToken !== null) {
    return <AuthPage resetToken={resetToken} />;
  }

  return (
    <FinanceProvider currentView={currentView} setCurrentView={setCurrentView}>
      <div className="flex flex-col min-h-screen w-full bg-zinc-50 relative">
        <TopNav currentView={currentView} setCurrentView={setCurrentView} />

        {/* Main Content Area */}
        <main className="flex-1 w-full pt-24 pb-40 px-4 md:px-8">
          <div className="max-w-7xl mx-auto w-full h-full flex flex-col gap-6">
            {currentView === 'dashboard' && <Dashboard />}
            {currentView === 'transactions' && <Transactions />}
            {currentView === 'liabilities' && <Liabilities />}
            {currentView === 'portfolio' && <Portfolio />}
            {currentView === 'goals' && <Goals />}
            {currentView === 'subscriptions' && <Subscriptions />}
            {currentView === 'plans' && <Plans />}
          </div>
        </main>

        <AIAvatar />
      </div>
    </FinanceProvider>
  )
}

export default App
