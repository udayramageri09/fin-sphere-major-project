import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext.jsx'

const DemoPage = import.meta.env.DEV && /^\/sandbox-demo\/?$/.test(window.location.pathname)
  ? lazy(() => import('./pages/AccountAggregatorDemo.jsx'))
  : /^\/webgpu\/?$/.test(window.location.pathname)
  ? lazy(() => import('./pages/WebGpuCheck.jsx'))
  : null

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {DemoPage ? (
      <Suspense fallback={<p role="status">Loading page…</p>}>
        <DemoPage />
      </Suspense>
    ) : (
      <AuthProvider>
        <App />
      </AuthProvider>
    )}
  </StrictMode>,
)

