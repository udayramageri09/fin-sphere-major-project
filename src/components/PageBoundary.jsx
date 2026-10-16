import { Component, Suspense } from 'react';

// Holds one page of the app. Pages other than the Dashboard are loaded on demand, so this shows a short loading line while a page's code
// arrives, and a plain message with a Reload button if it cannot (for example offline, or after the site was updated while the tab was
// open). It also keeps one page's rendering error from blanking the whole app. It never touches financial data.
class Catcher extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('Page failed to load:', error?.name ?? 'Error'); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="glass-panel p-6 max-w-lg" data-testid="page-failed">
        <h2 className="text-xl font-bold tracking-tight text-zinc-900">This page could not load</h2>
        <p className="mt-2 text-zinc-600">Check your connection and reload. Your data is safe.</p>
        <button type="button" onClick={() => window.location.reload()} className="mt-4 min-h-11 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-600 focus-visible:ring-offset-2">Reload</button>
      </div>
    );
  }
}

export default function PageBoundary({ children }) {
  return (
    <Catcher>
      <Suspense fallback={<p role="status" className="text-zinc-500" data-testid="page-loading">Loading…</p>}>{children}</Suspense>
    </Catcher>
  );
}
