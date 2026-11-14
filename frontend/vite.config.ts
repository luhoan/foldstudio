import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { samplesManifest } from './vite-plugins/samples-manifest.ts'

const src = fileURLToPath(new URL('./src', import.meta.url))
const samplesDir = fileURLToPath(new URL('./public/samples', import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), samplesManifest(samplesDir)],
  resolve: { alias: { '@': src } },
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } },
  },
  build: { chunkSizeWarningLimit: 6000 }, // Mol* is large; it is code-split behind a dynamic import
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}', 'vite-plugins/**/*.test.ts'],
  },
})
