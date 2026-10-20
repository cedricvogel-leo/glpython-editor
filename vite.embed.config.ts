import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: `${rootDir}embed`,
  base: './',
  plugins: [react()],
  build: {
    outDir: `${rootDir}dist-embed`,
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        embed: resolve(rootDir, 'embed/index.html'),
        demo: resolve(rootDir, 'embed/demo.html'),
      },
    },
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
