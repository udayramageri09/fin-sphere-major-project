import { useState } from 'react';
import { ArrowLeft, Cpu } from 'lucide-react';

export default function WebGpuCheck() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState('');

  const check = async () => {
    if (!window.isSecureContext || !navigator.gpu) {
      setResult('WebGPU is not available here. Try a supported browser on HTTPS or localhost.');
      return;
    }

    setChecking(true);
    setResult('');
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        setResult('WebGPU is exposed, but the browser did not provide a GPU adapter. Check hardware acceleration and graphics drivers.');
        return;
      }
      const device = await adapter.requestDevice();
      device.destroy();
      setResult('WebGPU is available. The browser created a WebGPU device.');
    } catch {
      setResult('The browser could not initialize a WebGPU device. Check graphics settings or try another supported browser.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="mx-auto max-w-xl px-5 py-10 sm:py-16">
      <title>WebGPU capability check | FinSphere</title>
      <a href="/" className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-blue-800 underline"><ArrowLeft size={16} aria-hidden="true" /> Back to FinSphere</a>
      <section className="rounded-2xl border border-zinc-200 bg-white p-6 sm:p-8" aria-labelledby="webgpu-heading">
        <Cpu className="mb-3 text-blue-800" size={28} aria-hidden="true" />
        <h1 id="webgpu-heading" className="text-2xl font-bold text-zinc-900">WebGPU capability check</h1>
        <p className="mt-2 text-sm text-zinc-600">Test whether your browser can create a WebGPU device. The check runs on this page and does not send data or start a model.</p>
        <button type="button" className="mt-5 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60" onClick={check} disabled={checking}>
          {checking ? 'Checking WebGPU...' : 'Run WebGPU check'}
        </button>
        <p role="status" className={result ? 'mt-4 rounded-lg bg-zinc-100 p-3 text-sm text-zinc-800' : 'sr-only'}>{checking ? 'Checking WebGPU availability.' : result}</p>
      </section>
    </main>
  );
}
