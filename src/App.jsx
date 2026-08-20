import { useState } from 'react'
import { FinanceProvider } from './context/FinanceContext'
import TopNav from './components/TopNav'
import Dashboard from './pages/Dashboard'
import Transactions from './pages/Transactions'
import Liabilities from './pages/Liabilities'
import Portfolio from './pages/Portfolio'
import Goals from './pages/Goals'
import Subscriptions from './pages/Subscriptions'
import Plans from './pages/Plans'
import AIAvatar from './components/AIAvatar'

function App() {
  const [currentView, setCurrentView] = useState('dashboard');

  return (
    <FinanceProvider currentView={currentView} setCurrentView={setCurrentView}>
      <div className="flex flex-col min-h-screen w-screen overflow-hidden bg-zinc-50 relative">
        <TopNav currentView={currentView} setCurrentView={setCurrentView} />

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden w-full pt-24 pb-24 px-4 md:px-8">
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
