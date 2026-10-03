import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

// Library build: emits a single ESM bundle (dist/index.js) + rolled-up type
// declarations (dist/index.d.ts). The stylesheet (src/style.css) has no JS
// import pointing to it (same as the original app, which only imported it
// from its entry point, not from the component tree), so Vite never touches
// it as part of this build; it's copied to dist/style.css verbatim by the
// "build" npm script instead, and exposed via the "./style.css" export.
// The Pyodide worker script is loaded at runtime via
// `new Worker(new URL('./pyodide-worker.js', import.meta.url))`; Vite detects
// that pattern and automatically emits it as a content-hashed asset under
// dist/assets/, rewriting the URL reference to match - no manual copy needed.
//
// `base: './'` is required so that rewritten reference is a *relative*
// "./assets/pyodide-worker-<hash>.js" rather than a root-absolute
// "/assets/pyodide-worker-<hash>.js". This package is consumed as a
// dependency from inside another app's build (or straight out of
// node_modules in dev), so it has no way of knowing what the final site's
// root path is - a root-absolute reference would resolve against the
// *consuming app's* origin instead of this package's own install location,
// breaking worker loading. A relative reference resolves against
// `import.meta.url` (this module's own location) wherever it ends up, which
// works consistently in all contexts.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    dts({
      include: ['src'],
      exclude: ['src/pyodide-worker.js'],
      tsconfigPath: 'tsconfig.app.json',
    }),
  ],
  build: {
    lib: {
      entry: `${rootDir}src/index.ts`,
      formats: ['es'],
      fileName: () => 'index.js',
    },
    sourcemap: true,
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime', '@monaco-editor/react', 'lucide-react'],
    },
  },
})
