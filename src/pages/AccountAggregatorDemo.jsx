import { ArrowUpRight, Landmark } from 'lucide-react';
import AccountAggregatorSandbox from '../components/AccountAggregatorSandbox';
import { demoOverview } from '../../server/accountAggregatorDemoData.js';

export default function AccountAggregatorDemo() {
  return (
    <div className="aa-demo-page">
      <title>Account Aggregator Sandbox | FinSphere</title>
      <div className="aa-demo-shell">
        <header className="aa-demo-header">
          <div className="aa-demo-brand"><Landmark aria-hidden="true" size={22} /> FinSphere</div>
          <a href="/">Open FinSphere <ArrowUpRight aria-hidden="true" size={15} /></a>
        </header>
        <main>
          <div className="aa-demo-intro">
            <span>Interactive demo</span>
            <h1>Account Aggregator Sandbox</h1>
            <p>Try a mock consent flow and explore a sample financial overview. No sign-in or personal information required.</p>
          </div>
          <div className="aa-demo-panel"><AccountAggregatorSandbox sample={demoOverview} /></div>
        </main>
      </div>
    </div>
  );
}
