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
npm run test:runtime   # the runtime under CPython: scripts/check-runtime-{columns,values,doctests,calls,hints,fidelity,replay}.py
npm run test:hints     # the error hints' wording (de/en) against the built dist/ (run a build first)
npm run build:embed    # builds the iframe app + demo page into dist-embed/
npm run preview:embed  # serves dist-embed/ with COOP/COEP headers; open /demo.html
```

`npm run dev:embed` currently 404s: `embed/index.html` loads `../src/embed/main.tsx`, which lies outside the Vite root, so only the build works. Use `build:embed` + `preview:embed`.

There is no unit test framework. The automated checks are `test:protocol` (plain `node:assert` against the built `dist/index.js`; add protocol validation cases there) and `test:runtime` (plain Python scripts that exec `src/runtime/` under CPython 3.12, Pyodide's version; add runtime regression cases there). `.github/workflows/ci.yml` runs lint, both builds and the checks on every pull request and on pushes to `main`. Nothing that needs Pyodide in a browser (the worker, the UI) is checked automatically. `npm run lint` has one known warning in `GlPythonWorkspace.tsx` (`react(immutability)` on the `cursor` variable in `Frame`).

**Releases.**
- The package is consumed from git: the glpython IDE (`../glpython`) pins `glpython-editor` by tag in its `package.json`. The `prepare` script builds `dist/` on install.
- To release, put a lightweight tag (`vX.Y.Z`; `package.json` keeps `0.1.0`) on the merge commit in `main`, then bump the tag in the IDE.
- Pushes to `main` deploy `dist-embed/` to GitHub Pages (`.github/workflows/deploy-embed.yml`). That is the embed LiaScript courses load (macro in `../glpython-liascript`), so merging to `main` ships to courses immediately.

## Architecture

**Two Vite builds from one source tree.**
- `vite.config.ts` — library mode, single ESM bundle `dist/index.js` + `.d.ts` via `vite-plugin-dts`. React, Monaco, and lucide-react are externals (peer deps). `base: './'` is required so the worker URL stays relative to the package's install location, not the host app's origin.
- `vite.embed.config.ts` — app mode rooted at `embed/` (`index.html` = iframe, `demo.html` = parent test page). Dev/preview servers set COOP/COEP headers; `embed/public/coi-serviceworker.js` is the fallback for static hosts.
- `src/style.css` is not imported by any module; it's copied to `dist/style.css` by the build script and hosts must import `glpython-editor/style.css` themselves. All its colours, fonts and radii are `--glp-*` tokens defined on `:root` (README «Look»; values from the course design). The Monaco editor's theme (`src/monacoTheme.ts`) is built from the same tokens, and editor and visualizer tokenize with `glpython-python` (`src/pythonLanguage.ts`, Monaco's Python definition with Python's real keyword list). Use a token, never a new literal colour; shadows only for floating elements. The embed's flat section layout lives in `src/embed/style.css`.

**Error hints.** `src/runtime/hints.py` (loaded first) maps an exception to a hint for the unit's common mistakes, matched on type *and* message; anything else gets none. Run, REPL, the visualizer (`errorHint`) and the doctest runner report it as data (`{kind, ...names}`); `CoreStrings.errorHint` words it, `ErrorHintNote` shows it below Python's unchanged message. New kinds need a case in `check-runtime-hints.py` and `check-error-hints.mjs`.

**Python execution lives in a web worker.** `src/pyodide-worker.js` loads Pyodide from the jsDelivr CDN and inlines the Python files under `src/runtime/` via `?raw` imports:
- `session.py` — invalidates cached modules between runs and runs the main file by `exec` in a plain dict, `_glpython_repl_namespace`, which REPL inputs (`_glpython_repl`) reuse. It's not `runpy`, so the file's functions and the REPL share one global namespace. Also has `_glpython_error_message` (a Python-style last traceback line), which `visualizer.py` uses too.
- `gturtle.py` — the `gturtle` module students import; it just records drawing commands, which are returned as JSON and rendered by `GraphicsWindow.tsx`.
- `input_bridge.py` — patches `input()` to block the worker via `Atomics.wait` on a `SharedArrayBuffer`. Only works when the whole browsing context is cross-origin isolated, so it's reported as an optional capability (`capabilities.input`) — don't assume it's available.
- `visualizer.py` — a hand-written tree-walking interpreter over `ast.parse()` output. Real CPython tracing can't expose intermediate expression values, so this interpreter records fine-grained trace steps (keyed by AST `nodeId`) for supported node types via `_STMT_HANDLERS` / `_EXPR_HANDLERS` dispatch dicts; unsupported nodes fall back to compiling/exec'ing that single node (correct result, but one opaque step). Adding fine-grained support for a construct = adding one handler.
  - Exceptions get tagged with the innermost student node and frame that raised them. A failed run then ends in one `error` step, and `error` holds a traceback of the learner's own lines (`errorMessage` is its last line).
  - A call into a function from another file switches `_glpython_current_path` while its body runs.
  - `_glpython_short_form` marks functions whose body is a single `return <expr>` (docstring allowed). Their call-enter steps carry `shortForm` for the UI's substitution mode.
  - `_glpython_run_visual_repl` traces a REPL input as the pseudo-file `<repl>` against a namespace (`replay`, or the Tests run's for a failing doctest example). The file's functions are swapped for traced versions of their `def`s, taken from the sources of the last Run. It's a dry run that leaves the namespace unchanged.
- **Visualizing a REPL entry replays the session** (`session.py`'s `_glpython_replay_*`, driven by the worker's `replayReplEntry`): the worker keeps only text (the last Run's files and output, each input since with what it printed and its result JSON), reruns the file and the earlier inputs in a namespace of their own and compares each with the original (object addresses masked); then it traces the entry and compares its output, error and value too. `input()` raises during a replay. Any difference, or `input()`, ends in a `repl-replay-note` instead of a trace. The project's modules are set aside and restored, so the live session is untouched. `check-runtime-replay.py` checks this under CPython.
  - `_GlpythonFunction` calls a stub with the same parameters first, so a call with wrong arguments raises Python's own `TypeError` (same message) at the call site.
  - Columns: `ast` counts UTF-8 bytes, `tokenize` characters, the UI UTF-16 code units. Every offset into a line goes through `_glpython_text_before` (the text in front of it, for slicing) or `_glpython_ui_column` (a column for the UI); never slice a line by an `ast` offset directly.
  - Values are shown through `_glpython_safe_repr`, which writes types as learners do (`int`, not `<class 'int'>`); the program's own output keeps Python's repr.

Worker messages:
- `run` → `result`/`error`; while it runs, `output` messages (`{id, text}`, `id` undefined for a program, the input's id for a REPL input) stream what was printed, at most 50 per 50 ms. The final message brings the whole output again.
- `run-visual` → `trace-result` (`{trace, ast, output, graphics, error, errorMessage, truncated}`)
- `repl` → `repl-result`
- `run-visual-repl` (a doctest example) → `trace-result` with `rootPath`/`sources`, or `repl-result` if the input doesn't parse
- `visualize-repl-entry` (`id` of a REPL input) → `trace-result` with `rootPath`/`sources`, or `repl-replay-note` (`note: 'input' | 'differs'`)
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
- **Console and Stop:** output, REPL inputs, Tests reports and notes form one transcript (`ConsoleEntry` list after `output`). While Python is busy for more than `STOP_BUTTON_DELAY`, the run button is **Stop**: `stopPython` terminates the worker and calls `startWorker` again, so the REPL namespace is gone after a stop. The embed reports this to its parent (protocol version 4, `glpython:busy`/`glpython:stop`).
- **UI strings** come in via the `t: CoreStrings` prop. `src/i18n.ts` is their single source: `coreStrings` holds German and English, and `resolveUiLocale` picks the language. The embed uses them directly; the glpython IDE imports them and adds only its shell strings. New strings have been added as *optional* `CoreStrings` keys with an English fallback, so older hosts keep compiling; add both languages to `coreStrings`. Python values, reprs and error messages are never translated.
- **Two layouts:** with `compact` (the embed) the original tree (`main-split` > `editor-column` + graphics aside), unchanged and styled by `src/embed/style.css`; without it (the IDE) the stacked layout (`workspace-stack`: `stack-top` with the editor panel and, while drawing, the graphics, then `stack-divider` and `stack-console`). Both are assembled from the same JSX pieces (`actionsNode`, `visualizerBarNode`, `editorWrapNode`, `consoleNode`, …) just before the return. The buttons can be portaled into the host's bar (`actionsContainer`).
- **Embedded/reduced layouts:** the knobs are `compact`, `capabilities` (`WorkspaceCapabilities`, including `repl`) and `command` (`WorkspaceCommand`, an immutable `{id, type}` used by hosts to trigger run/visualize/test/stop/reset without the workspace's own buttons; `reset` restarts Python and clears the console). Defaults must preserve the full-workspace behavior.

**Embed protocol.** `src/embedProtocol.ts` defines the versioned message types and validators (`parseParentMessage`, `parseParentOrigin`, `GLPYTHON_EMBED_PROTOCOL_VERSION`, `GLPYTHON_MAX_SOURCE_LENGTH`), all re-exported from `src/index.ts`. The iframe (`src/embed/App.tsx`) requires an exact `parentOrigin` query param, sends `glpython:ready`/`glpython:resize`, and accepts `glpython:load`/`run`/`visualize`/`reset`. `run`/`visualize` carry the source snapshot so the parent remains the authoritative editor. Version 2 adds `files` + `mainFile` for programs of several files, version 3 adds `glpython:test` (doctests); version 4 adds `glpython:stop` and `glpython:busy`; the embed still accepts every earlier version and answers each parent in the version it last used, so older (e.g. cached) macros keep working. Modes: `eval` (with REPL), `turtle` (graphics layout), `visual` (visualizer-only, cannot exit). Reset remounts the workspace via a `key` generation counter, which also recreates the worker. Any protocol change should bump/handle the version and be covered in `scripts/check-embed-protocol.mjs`; also update `embed/demo.html` and the README.
