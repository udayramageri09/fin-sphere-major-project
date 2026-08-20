import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Force vite restart again
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
})
