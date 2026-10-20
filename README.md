# glpython-editor

Embeddable Python editor + step-by-step execution visualizer + turtle graphics
panel, extracted from [glpython](https://github.com/cedricvogel-leo/glpython)
so it can be reused in different host applications ("shells").

This package owns:

- The Monaco-based code editor and tabs for a `Project`'s files.
- The "Run" / "Visualize" workflow, backed by a Pyodide web worker.
- The step-by-step AST execution visualizer (`Frame`, substitutions,
  animated value flights, closing boxes, etc).
- The turtle graphics panel (`GraphicsWindow`), shown when the running
  program imports `gturtle`.

It deliberately does **not** own: top bar / navigation, sidebar / file tree,
authentication, locale switching, or project persistence/sharing — those are
shell concerns and stay in the host application.

## Installation

This package is not published to the npm registry. Install it directly from
a tagged commit on GitHub:

```json
{
  "dependencies": {
    "glpython-editor": "github:cedricvogel-leo/glpython-editor#v0.1.0"
  }
}
```

Installing from git automatically runs `npm run build` via the `prepare`
script, so `dist/` is generated on install.

### Peer dependencies

The host application must provide these (they are not bundled):

- `react` / `react-dom` (^19)
- `@monaco-editor/react` (^4.7)
- `lucide-react` (^1.47)

## Usage

```tsx
import { GlPythonWorkspace, initialProject, type CoreStrings } from 'glpython-editor'
import 'glpython-editor/style.css'

function Shell() {
  const [project, setProject] = useState(initialProject)
  const [activeFile, setActiveFile] = useState(project.mainFile)
  const [openFiles, setOpenFiles] = useState([project.mainFile])
  const [isGraphicsOpen, setIsGraphicsOpen] = useState(false)

  return (
    <main className="main-area">
      <GlPythonWorkspace
        project={project}
        activeFile={activeFile}
        openFiles={openFiles}
        onOpenFile={(path) => {
          setActiveFile(path)
          setOpenFiles((files) => (files.includes(path) ? files : [...files, path]))
        }}
        onCloseFile={(path) => {
          setOpenFiles((files) => files.filter((f) => f !== path))
        }}
        onFileCodeChange={(path, code) => {
          setProject((p) => updateProjectFile(p, path, code))
        }}
        isGraphicsOpen={isGraphicsOpen}
        onGraphicsOpenChange={setIsGraphicsOpen}
        t={coreStrings}
      />
    </main>
  )
}
```

`t` must implement the `CoreStrings` interface (all UI strings used inside
the workspace), so the host application controls localization.

### Compact embeds

`GlPythonWorkspace` accepts optional `compact` and `capabilities` props. The
existing behavior remains the default. A compact host can explicitly disable
the editor, built-in action buttons, breadcrumbs, file tabs, output reset,
visualization, or graphics. An editor-free host can send immutable `command`
events to run or visualize a source snapshot supplied by its parent:

```tsx
<GlPythonWorkspace
  {...props}
  compact
  command={{ id: commandId, type: 'run' }}
  capabilities={{
    actions: false,
    editor: false,
    breadcrumbs: false,
    fileTabs: false,
    resetOutput: false,
    visualization: true,
    graphics: false,
  }}
/>
```

This repository also contains a standalone iframe application:

```bash
npm run dev:embed
npm run build:embed
npm run preview:embed
```

The built app is emitted to `dist-embed/`. `embed/demo.html` is a small parent
page that exercises both the eval and turtle modes.

The iframe requires a `parentOrigin` query parameter containing the exact
origin that is allowed to communicate with it:

```text
https://example.test/embed/?parentOrigin=https%3A%2F%2Fcourse.example
```

It sends `glpython:ready` with runtime capabilities, accepts versioned
`glpython:load`, `glpython:run`, `glpython:visualize`, and `glpython:reset`
messages, and sends `glpython:resize` as its content size changes. `run` and
`visualize` carry the current source snapshot so a parent such as LiaScript can
remain the authoritative editor and restore its own PWA state. The public TypeScript types and validators are exported from
`glpython-editor`.

```ts
iframe.contentWindow?.postMessage({
  type: 'glpython:run',
  version: GLPYTHON_EMBED_PROTOCOL_VERSION,
  source: 'print("Hello")',
  mode: 'eval',
}, iframeOrigin)
```

Use `mode: 'turtle'` for the graphics layout. The eval layout does not show or
reserve space for turtle graphics.

## Development

```bash
npm install
npm run build   # tsc -b && vite build, emits dist/
npm run lint     # oxlint
```

`npm run dev` runs `vite build --watch` for iterating against a locally
linked copy (e.g. via `npm link` or a workspace/yalc setup) in a consuming
shell project.

The embed development and preview servers set
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. The production build also ships a
vendored `coi-serviceworker` fallback for static hosts that cannot configure
headers. It registers only when the embed runs as the top-level page, avoiding
reload loops in a cross-origin iframe.

Cross-origin isolation is controlled by the complete browsing context, not only
the iframe response. A glpython iframe inside a non-isolated course host cannot
use `SharedArrayBuffer`, even if the iframe itself ships the service worker.
The `glpython:ready` message therefore reports `capabilities.input`; hosts must
not assume synchronous `input()` support. Normal execution, visualization, and
turtle graphics do not require the synchronous input channel.

## Notes on the build

- The library builds to a single ESM bundle (`dist/index.js`) plus
  per-module `.d.ts` declaration files under `dist/src/`.
- The Pyodide worker (`src/pyodide-worker.js`) is loaded at runtime via
  `new Worker(new URL('./pyodide-worker.js', import.meta.url))`. Vite
  detects this pattern automatically and emits the worker as a
  content-hashed asset under `dist/assets/`, rewriting the reference to
  match — no manual copy step is needed for it.
- `src/style.css` is not imported by any module in the component tree (the
  original app only imported it from its own entry point, not from the
  component itself), so Vite's build never touches it. It's copied verbatim
  to `dist/style.css` by the `build` script and exposed via the
  `glpython-editor/style.css` export; consuming shells must import it
  explicitly.
