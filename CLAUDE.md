# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A React component library (`GlPythonWorkspace`) providing a Monaco Python editor, a Pyodide-backed run/visualize workflow, a step-by-step AST execution visualizer, and a turtle graphics panel — extracted from the `glpython` app so multiple host "shells" can reuse it. Shell concerns (navigation, file tree, auth, locale, persistence) deliberately stay out of this package. The repo also ships a standalone iframe app (`embed/`) that wraps the workspace behind a `postMessage` protocol, e.g. for LiaScript courses.

## Commands

```bash
npm run build          # tsc -b && vite build && copy src/style.css -> dist/ (library)
npm run dev            # vite build --watch, for use with npm link/yalc in a host shell
npm run lint           # oxlint
npm run test:protocol  # builds the library, then runs scripts/check-embed-protocol.mjs against dist/
npm run build:embed    # builds the iframe app + demo page into dist-embed/
npm run preview:embed  # serves dist-embed/ with COOP/COEP headers; open /demo.html
```

`npm run dev:embed` currently 404s: `embed/index.html` loads `../src/embed/main.tsx`, which lies outside the Vite root, so only the build works. Use `build:embed` + `preview:embed`.

There is no unit test framework; `test:protocol` (plain `node:assert` against the built `dist/index.js`) is the only automated check. Add protocol validation cases there. `npm run lint` has one known warning in `GlPythonWorkspace.tsx` (`react(immutability)` on the `cursor` variable in `Frame`).

**Releases.**
- The package is consumed from git: the glpython IDE (`../glpython`) pins `glpython-editor` by tag in its `package.json`. The `prepare` script builds `dist/` on install.
- To release, put a lightweight tag (`vX.Y.Z`; `package.json` keeps `0.1.0`) on the merge commit in `main`, then bump the tag in the IDE.
- Pushes to `main` deploy `dist-embed/` to GitHub Pages (`.github/workflows/deploy-embed.yml`). That is the embed LiaScript courses load (macro in `../glpython-liascript`), so merging to `main` ships to courses immediately.

## Architecture

**Two Vite builds from one source tree.**
- `vite.config.ts` — library mode, single ESM bundle `dist/index.js` + `.d.ts` via `vite-plugin-dts`. React, Monaco, and lucide-react are externals (peer deps). `base: './'` is required so the worker URL stays relative to the package's install location, not the host app's origin.
- `vite.embed.config.ts` — app mode rooted at `embed/` (`index.html` = iframe, `demo.html` = parent test page). Dev/preview servers set COOP/COEP headers; `embed/public/coi-serviceworker.js` is the fallback for static hosts.
- `src/style.css` is not imported by any module; it's copied to `dist/style.css` by the build script and hosts must import `glpython-editor/style.css` themselves.

**Python execution lives in a web worker.** `src/pyodide-worker.js` loads Pyodide from the jsDelivr CDN and inlines the Python files under `src/runtime/` via `?raw` imports:
- `session.py` — invalidates cached modules between runs and runs the main file by `exec` in a plain dict, `_glpython_repl_namespace`, which REPL inputs (`_glpython_repl`) reuse. It's not `runpy`, so the file's functions and the REPL share one global namespace. Also has `_glpython_error_message` (a Python-style last traceback line), which `visualizer.py` uses too.
- `gturtle.py` — the `gturtle` module students import; it just records drawing commands, which are returned as JSON and rendered by `GraphicsWindow.tsx`.
- `input_bridge.py` — patches `input()` to block the worker via `Atomics.wait` on a `SharedArrayBuffer`. Only works when the whole browsing context is cross-origin isolated, so it's reported as an optional capability (`capabilities.input`) — don't assume it's available.
- `visualizer.py` — a hand-written tree-walking interpreter over `ast.parse()` output. Real CPython tracing can't expose intermediate expression values, so this interpreter records fine-grained trace steps (keyed by AST `nodeId`) for supported node types via `_STMT_HANDLERS` / `_EXPR_HANDLERS` dispatch dicts; unsupported nodes fall back to compiling/exec'ing that single node (correct result, but one opaque step). Adding fine-grained support for a construct = adding one handler.
  - Exceptions get tagged with the innermost student node and frame that raised them. A failed run then ends in one `error` step, and `error` holds a traceback of the learner's own lines (`errorMessage` is its last line).
  - A call into a function from another file switches `_glpython_current_path` while its body runs.
  - `_glpython_short_form` marks functions whose body is a single `return <expr>` (docstring allowed). Their call-enter steps carry `shortForm` for the UI's substitution mode.
  - `_glpython_run_visual_repl` traces a REPL input as the pseudo-file `<repl>` against the REPL namespace. The file's functions are swapped for traced versions of their `def`s, taken from the sources of the last Run. It's a dry run that leaves the namespace unchanged.

Worker messages:
- `run` → `result`/`error`
- `run-visual` → `trace-result` (`{trace, ast, output, graphics, error, errorMessage, truncated}`)
- `repl` → `repl-result`
- `run-visual-repl` → `trace-result` with `rootPath`/`sources`, or `repl-result` if the input doesn't parse
- `init-input-channel`; `input_request`

**UI side.**
- `src/GlPythonWorkspace.tsx` is the single large component: editor, run/visualize state, worker lifecycle, and the visualizer rendering (`Frame`, value substitution, animated value "flights", closing-box ghosts, connector SVG). Much of its JSX is packed onto very long single lines — edit with targeted string replacements rather than reformatting.
- `src/visualizer.ts` holds the shared `TraceStep`/`AstNode` types and helpers that map trace steps back onto source.
  - `computeOpenFramesUpTo`: open call frames always form one chain, the call stack.
  - `collapseDeepCallChain` collapses the middle of 8+ open boxes into a "… N more calls" marker; deeply nested boxes used to freeze the page's layout.
  - `substitutionModeSteps` filters the trace down to visible substitutions.
- **Rendering always replays the full trace up to the current step's `step` number.** In substitution mode the scrubber moves through a filtered step list, so use list indices only for the scrubber, never as step numbers.
- **Visualizer modes:** in `box` mode every call is a `Frame` box at its call site. In `substitution` mode (the default; prop `visualizerMode`, embed `?visualizer=`), a call with `shortForm` renders as `Frame` scope `'inline'`: its return expression with parameters substituted, in parentheses in operator context.
- **Layout and scrolling:** nested boxes show their variables below their code (CSS). The scroll effect follows the active box horizontally. It sets `scrollLeft`/`scrollTop` on the visualizer view only; don't use `scrollIntoView`, which also scrolls the LiaScript page around the embed and moves the step buttons.
- **UI strings** come in via the `t: CoreStrings` prop. `src/i18n.ts` is their single source: `coreStrings` holds German and English, and `resolveUiLocale` picks the language. The embed uses them directly; the glpython IDE imports them and adds only its shell strings. New strings have been added as *optional* `CoreStrings` keys with an English fallback, so older hosts keep compiling; add both languages to `coreStrings`. Python values, reprs and error messages are never translated.
- **Embedded/reduced layouts:** the knobs are `compact`, `capabilities` (`WorkspaceCapabilities`, including `repl`) and `command` (`WorkspaceCommand`, an immutable `{id, type}` used by editor-free hosts to trigger run/visualize). Defaults must preserve the full-workspace behavior.

**Embed protocol.** `src/embedProtocol.ts` defines the versioned message types and validators (`parseParentMessage`, `parseParentOrigin`, `GLPYTHON_EMBED_PROTOCOL_VERSION`, `GLPYTHON_MAX_SOURCE_LENGTH`), all re-exported from `src/index.ts`. The iframe (`src/embed/App.tsx`) requires an exact `parentOrigin` query param, sends `glpython:ready`/`glpython:resize`, and accepts `glpython:load`/`run`/`visualize`/`reset`. `run`/`visualize` carry the source snapshot so the parent remains the authoritative editor. Version 2 adds `files` + `mainFile` for programs of several files; the embed still accepts version 1 and answers each parent in the version it last used, so older (e.g. cached) macros keep working. Modes: `eval` (with REPL), `turtle` (graphics layout), `visual` (visualizer-only, cannot exit). Reset remounts the workspace via a `key` generation counter, which also recreates the worker. Any protocol change should bump/handle the version and be covered in `scripts/check-embed-protocol.mjs`; also update `embed/demo.html` and the README.
