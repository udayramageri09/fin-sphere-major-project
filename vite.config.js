/* global process */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Test files start their own Vite servers. They get a separate dependency cache so they can never overwrite the one the
// running dev server (and the browser tab) is using, which showed up as "Failed to fetch dynamically imported module".
const runningUnderTests = /[\\/]tests?[\\/]/i.test(process.argv[1] ?? '')

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  cacheDir: runningUnderTests ? 'node_modules/.vite-tests' : 'node_modules/.vite',
  // pdfjs is loaded on demand when a statement is uploaded; pre-bundling it at start-up avoids a mid-session re-optimization.
  optimizeDeps: { include: ['pdfjs-dist/build/pdf.mjs'] },
})
