import { lazy, useState, useEffect } from 'react'
import { FinanceProvider } from './context/FinanceContext'
import { useAuth } from './context/AuthContext'
import TopNav from './components/TopNav'
const Dashboard = lazy(() => import('./pages/Dashboard'))
import PageBoundary from './components/PageBoundary'

// Load page code only when selected, including the Dashboard after sign-in.
const Transactions = lazy(() => import('./pages/Transactions'))
const Liabilities = lazy(() => import('./pages/Liabilities'))
const Portfolio = lazy(() => import('./pages/Portfolio'))
const Goals = lazy(() => import('./pages/Goals'))
const Subscriptions = lazy(() => import('./pages/Subscriptions'))
const Plans = lazy(() => import('./pages/Plans'))
const Settings = lazy(() => import('./pages/Settings'))
import AIAvatar from './components/AIAvatar'
import AuthPage from './pages/AuthPage'
import Onboarding from './components/Onboarding'
import { readGuideTone, saveGuideTone } from './utils/guideTone'

// Shown instead of the app while another tab may have changed the account and the server has not yet said whose session this is.
function SessionCheck({ error, onRetry }) {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-zinc-50 p-6" data-testid="identity-check">
      <div role={error ? 'alert' : 'status'} className="max-w-md text-center">
        {error ? (
          <>
            <h1 className="text-xl font-bold tracking-tight text-zinc-900">Could not check your session</h1>
            <p className="mt-2 text-zinc-600">{error}</p>
            <button type="button" onClick={onRetry} className="mt-4 min-h-11 rounded-xl bg-zinc-900 px-5 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-600 focus-visible:ring-offset-2">Retry</button>
          </>
        ) : (
          <p className="text-zinc-600">Checking your session…</p>
        )}
      </div>
    </div>
  );
}

// Everything that belongs to one signed-in account. App keys it by user id, so a different account always gets a brand-new tree: chat,
// pending previews, captions, voice activity, page data and timers of the previous account are gone, and anything still in flight for
// it has no component left to land in.
function AuthenticatedApp({ hidden }) {
  const [currentView, setCurrentView] = useState('dashboard');
  const [discussGoals, setDiscussGoals] = useState(false);
  const { user } = useAuth();
  const [guideTone, setGuideTone] = useState(() => readGuideTone(user?.id));
  const changeGuideTone = (tone) => {
    saveGuideTone(user.id, tone);
    setGuideTone(tone);
  };
  const navigate = (view) => {
    setDiscussGoals(false);
    setCurrentView(view);
  };
  return (
    <div hidden={hidden} style={hidden ? { display: 'none' } : undefined}>
      <FinanceProvider currentView={currentView} setCurrentView={navigate}>
        <div className="flex flex-col min-h-screen w-full bg-zinc-50 relative">
          <TopNav currentView={currentView} setCurrentView={navigate} />

          {/* Main Content Area */}
          <main tabIndex={-1} className="flex-1 w-full pt-24 pb-40 px-4 md:px-8">
            <div className="max-w-7xl mx-auto w-full h-full flex flex-col gap-6">
              <PageBoundary key={currentView}>
                {currentView === 'dashboard' && <Dashboard />}
                {currentView === 'transactions' && <Transactions />}
                {currentView === 'liabilities' && <Liabilities />}
                {currentView === 'portfolio' && <Portfolio />}
                {currentView === 'goals' && <Goals onDiscussGoals={() => { setDiscussGoals(true); setCurrentView('plans'); }} />}
                {currentView === 'subscriptions' && <Subscriptions />}
                {currentView === 'plans' && <Plans discussGoals={discussGoals} />}
                {currentView === 'settings' && <Settings guideTone={guideTone} onGuideToneChange={changeGuideTone} />}
              </PageBoundary>
            </div>
          </main>

          {user?.onboardingState !== 'pending' && <AIAvatar guideTone={guideTone} />}
        </div>
        {user?.onboardingState === 'pending' && <Onboarding onNavigate={navigate} />}
      </FinanceProvider>
    </div>
  )
}

function App() {
  const [resetToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('reset'));
  useEffect(() => {
    if (resetToken !== null) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [resetToken]);
  const { status, user, identityMasked, identityError, retryIdentityCheck } = useAuth();

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
    <>
      {identityMasked && <SessionCheck error={identityError} onRetry={retryIdentityCheck} />}
      <AuthenticatedApp key={user.id} hidden={identityMasked} />
    </>
  )
}

export default App
