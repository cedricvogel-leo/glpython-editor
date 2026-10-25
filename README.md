# glpython-editor

Embeddable Python editor + step-by-step execution visualizer + turtle graphics
panel, extracted from the [glpython IDE](https://glpython-edu.github.io/)
([repo](https://github.com/glpython-edu/glpython-edu.github.io)) so it can be
reused in different host applications ("shells").

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
    "glpython-editor": "git+https://github.com/glpython-edu/glpython-editor.git#v0.1.9"
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
`visualizerCollapsedCalls` is optional; without it, an English fallback is
used.

### Visualizing failing programs

When a program raises an exception, the visualizer still shows every step up
to the failure. The trace ends in one `error` step at the expression that
raised, in the call frame it was raised in. It still starts before the first
step; a red marker on the scrubber shows where the failure is. At that step the
expression is marked red with Python's untranslated last traceback line below
it, and the output panel shows a traceback of the learner's own lines.
`TraceResult` carries that traceback as `error` and its last line as
`errorMessage`. A `SyntaxError` produces no steps and keeps the warning banner.

Deep chains of open calls, such as a recursion without a base case, collapse
their middle boxes into one "… N more calls of f(x) …" marker
(`visualizerCollapsedCalls`), so the layout stays usable.

### Box and substitution mode

The visualizer's toolbar is one line: first step, previous step, next step,
last step, the scrubber, the step counter, the box/substitution switch, the
**⋯ Options** menu (animated steps, and with `export` the → chain's comments and
copy button) and ✕ to exit (`visualizerFirstStep`, `visualizerLastStep`,
`visualizerOptions`; ✕ uses `exitVisualizer`). The variables panel only appears
when there are variables; in a visualizer narrower than 900px it sits below the
code.

The toolbar switches between two ways of showing a function call.
In **substitution** mode (the default), a call to a function whose body is a
single `return <expression>` (optionally after a docstring) is replaced at its
call site by that expression, with its parameters already replaced by their
values, as in the course's paper notation:
`quadrat(a + 2) → quadrat(5 + 2) → quadrat(7) → 7 * 7 → 49`. Every click is one
substitution, and a replacing expression gets parentheses where an operator
works on it (`1 * (3 * 2)`). Any other function still opens a box, and the
outermost box shows `visualizerBoxHint`. In **box** mode every call opens a box.

The mode last chosen is remembered per browser. A host can preset it with the
`visualizerMode` prop (`'box'` or `'substitution'`), and the embed with the
`visualizer=box` or `visualizer=substitution` query parameter. The toggle's
texts are `visualizerModeLabel`, `visualizerModeBox` and
`visualizerModeSubstitution`, all optional like `visualizerBoxHint`.

### Copying the evaluation as a → chain

The **Copy → chain** item in the toolbar's **⋯ Options** menu copies the evaluation of the statement
the scrubber is on (for a visualized REPL entry: that input) in the course's
paper notation: its expression, then one line per change, each starting with
`→`, taking the same steps as the visualizer. A call to a function with a single
`return <expression>` is replaced as in substitution mode. Any other call is
replaced by the expression of the return it executed, with its parameters and
local variables already filled in, and a comment naming the condition that
chose that return (`# 2 == 0 is False`) and whether its body has local
variables. A failing run ends with Python's error line. Definitions are never
exported. The menu's **Comments** item turns the comments off; it is remembered per
browser. Texts: `copyChain`, `copyChainDone`, `copyChainFailed`,
`copyChainComments`, `chainConditionComment`, `chainLocalsComment`.

### Tests (doctests)

The **Tests** button (capability `tests`, a `test` command for editor-free
hosts) runs the doctests in the docstrings of the file that would run, as
`python -m doctest` does: the file is loaded as a module named after it, so an
`if __name__ == "__main__":` block doesn't run. The output panel shows how many
examples passed, then each failing example in doctest's own words (`Failed
example:`, `Expected:`, `Got:` stay untranslated) with a button that visualizes
that example step by step against the same definitions. If the example didn't
raise, the visualization's last step shows the two texts doctest compared next
to the final value (`exampleGotExpected`, e.g. «Erhalten: 4.0 · Erwartet: 4»). An example that printed
what was expected but returned `None` passes, as in doctest, with a separate
glpython hint that it probably should `return` instead. Texts: `runTests`,
`testsRunning`, `testsSummary`, `testsNone`, `testsLoadError`,
`visualizeExample`, `testsPrintHint`.

Call boxes in the visualizer show a function without its comments and
docstring, which don't change what runs; the file itself is shown as written.

### Error hints

Below an error, glpython adds one short hint for the unit's common mistakes:
an undefined name, missing or too many arguments, a `None` operand (a
function that prints instead of returning), text plus a number, a division
by zero, endless recursion, a list index out of range, and a doctest example
without a blank after `>>>`. Python's message and traceback stay exactly as
they are, and a failing test still fails. A hint is matched on the
exception's type and message (`src/runtime/hints.py`); anything else gets no
hint. It shows in the Run output, the REPL, the Tests report and below the
visualizer's error marking, worded by `errorHint` and labelled by
`hintLabel` («Hinweis:» / "Hint:"); a host without `errorHint` shows none.

In the visualizer, a call with the wrong arguments fails as in Python, with
Python's own `TypeError`.

### Console and Stop

The console (`output`: «Konsole») is one chronological transcript, like Python
in a terminal: what the program printed - shown while it runs, not only at the
end - then every REPL input with its answer, every Tests report and every note,
in the order they happened. Errors and their hints stand where they happened.
Run and Reset clear it. It keeps the last 100,000 characters of a long output.

While Python is busy for more than a moment (a program, a REPL input, Tests,
a visualization), the run button becomes **Stop** (`stop`: «Stoppen»). Stopping
ends Python's worker and starts a new one: the code stays, the console keeps
what was printed and adds `stoppedNote`, and the REPL starts in an empty
namespace (earlier entries can't be visualized anymore). Hosts can stop with
the command `{ id, type: 'stop' }`, and learn when Python is busy through the
`onBusyChange` prop.

### REPL

Below the console, a `>>>` input line runs Python in the namespace of the
last Run, so learners can call the file's functions directly. An expression
shows its value (`None` too, greyed out); a statement such as `a = 5` shows
nothing; a `def` runs but adds the hint `replDefinitionHint`; an error shows
Python's last traceback line. Run starts a fresh namespace and clears the
transcript, while arrow up/down still recalls earlier inputs. Every entry of
the transcript has a **Visualize** button (`replVisualizeEntry`) that traces
that input step by step, an entry with an error up to its error, with call
boxes drawn from the file as it was at the last Run. It replays rather than
stores Python's state: the worker runs that file and the inputs before the
entry again, in a namespace of its own, and checks that each prints and
evaluates to what it did the first time. If the replay needs `input()` or
comes out differently (e.g. random numbers), the entry shows a note
(`replReplayNote`) instead of a visualization. The live namespace stays as
it was. An input that doesn't compile has no button. Disable the REPL with
`capabilities={{ repl: false }}`; the embed shows it in `eval` mode only, and
resetting the embed discards the namespace.

### Stacked layout (the IDE)

Without `compact`, the workspace is stacked: the editor (or, while
visualizing, the visualizer) in full width on top, a divider, and the console
in full width below. The divider can be dragged (mouse, pen or finger) or
moved with the arrow keys, Page Up/Down, Home and End (`consoleSize` names
it); the console's share of the height (a third at first) is remembered in
the browser. The file tabs and, while visualizing, the visualizer's bar take
the same strip above the editor, so nothing below moves when switching. The
graphics show beside the editor only while the program draws (for a
visualization: if it draws at all); their ✕ hides them until the next drawing.
An empty editor shows `editorPlaceholder` («Code hier eingeben»).

The buttons come in the embed's order and labels - **▶ Run · Tests ·
Visualize · Reset** (`runProject`, `runTests`, `visualize`, `resetOutput`) -
and stay while visualizing (they leave the visualizer first). **Reset**
restarts Python and clears the console, the visualization and the drawing, as
the embed's Reset does. The run button keeps its width when it becomes
**Stop**. A host can put the buttons into its own bar with
`actionsContainer={element}` (the IDE's top bar); without it they sit above
the editor. `capabilities={{ closeFileTabs: false }}` drops the ✕ on the file
tabs, for a host that shows every file of the project as a tab.

### Compact embeds

`GlPythonWorkspace` accepts optional `compact` and `capabilities` props. The
existing behavior remains the default. A compact host can explicitly disable
the editor, built-in action buttons, breadcrumbs, file tabs, output reset,
visualization, visualizer exit action, or graphics. An editor-free host can
send immutable `command` events to run or visualize a source snapshot supplied
by its parent:

```tsx
<GlPythonWorkspace
  {...props}
  compact
  command={{ id: commandId, type: 'run' }}
  capabilities={{
    actions: false,
    editor: false,
    exitVisualizer: false,
    breadcrumbs: false,
    fileTabs: false,
    resetOutput: false,
    visualization: true,
    graphics: false,
    emptyOutput: false,
  }}
/>
```

With `emptyOutput: false` (the embed's `visual` mode), a visualization whose
program prints nothing and raises no error has no output panel instead of
«(Keine Ausgabe)», so short visualizations take less space. It is decided for
the whole run, so the panel doesn't appear in the middle of stepping. With the
REPL on, the panel always stays, since it holds the REPL's input line.

This repository also contains a standalone iframe application:

```bash
npm run dev:embed
npm run build:embed
npm run preview:embed
```

The built app is emitted to `dist-embed/`. `embed/demo.html` is a small parent
page that exercises the eval, turtle, and visualization-only modes.

The iframe requires a `parentOrigin` query parameter containing the exact
origin that is allowed to communicate with it:

```text
https://example.test/embed/?parentOrigin=https%3A%2F%2Fcourse.example
```

Optional query parameters adapt the embed to a host such as the LiaScript
macro: `features=run,repl,visualize,…` hides the REPL (`repl`), the visualizer
(`visualize`) or its → chain export (`export`) unless listed (capabilities
`repl`, `visualization`, `export`), and `size=large` with
`visualizerHeight=<px>` shows bigger code and a visualizer at least that tall.

The UI language is the optional `lang` query parameter (e.g. the LiaScript
course's language), else the browser's language, else English; only the
primary subtag counts (`de-CH` → German), and an unsupported language (e.g.
`fr`) falls through to the next step. The UI strings live in `src/i18n.ts`
(`coreStrings`, German and English), which the glpython IDE imports too;
`resolveUiLocale` implements this order for any host. Python's own values and
error messages are never translated.

It sends `glpython:ready` with runtime capabilities, accepts versioned
`glpython:load`, `glpython:run`, `glpython:visualize`, and `glpython:reset`
messages, and sends `glpython:resize` as its content size changes. `run` and
`visualize` carry the current source snapshot so a parent such as LiaScript can
remain the authoritative editor and restore its own PWA state. The public TypeScript types and validators are exported from
`glpython-editor`.

Protocol version 2 adds programs of several files: `load`, `run` and `visualize`
may carry `files` (`{ path, source }`, each path a Python module name such as
`parser.py`, at most `GLPYTHON_MAX_FILES`) and `mainFile`, the file to run;
`source` stays the code of that file. Only the file to run is traced; imported
files run as a black box. Version 3 adds `glpython:test` (same fields as
`run`), which runs the doctests of that file. The embed still accepts every
earlier version and answers every parent in the version that parent last used
(version 1 until it hears otherwise), so older parents keep working.
Version 4 adds `glpython:stop`, which stops what Python is running by
restarting it (the source stays), and `glpython:busy` (`busy: true|false`),
which the embed sends to a version 4 parent when Python has been busy for more
than a moment (a program, a REPL input, Tests, a visualization), so the
parent's run button can become a stop button, as the workspace's own does.
`glpython:ready` reports `capabilities.files`, `capabilities.tests` and
`capabilities.stop`.

```ts
iframe.contentWindow?.postMessage({
  type: 'glpython:run',
  version: GLPYTHON_EMBED_PROTOCOL_VERSION,
  source: 'print("Hello")',
  mode: 'eval',
}, iframeOrigin)
```

Use `mode: 'turtle'` for the graphics layout. The eval layout does not show or
reserve space for turtle graphics. Use `mode: 'visual'` with a
`glpython:visualize` message for an editor-free visualizer that cannot exit to
the normal workspace.

### Look

Every colour, font and the corner radius in `style.css` come from CSS
variables defined on `:root` with glpython's own look (the course design:
white panels, light grey code areas, ink accent `#1F3A5F`, the system's UI
and monospace fonts, no web fonts). A host can override any of them:

| Variable | Role |
|---|---|
| `--glp-bg` | panel background |
| `--glp-surface` | code in the visualizer, output, REPL |
| `--glp-border` | decorative borders and separator lines |
| `--glp-border-control` | borders of controls, call boxes in box mode |
| `--glp-text`, `--glp-text-muted` | text and code; line numbers, step counter, secondary info, connector lines |
| `--glp-accent`, `--glp-on-accent` | active mode, scrubber, focus, primary button; text on it |
| `--glp-current`, `--glp-current-outline` | current subexpression and new value, current line; next step (dashed) |
| `--glp-error`, `--glp-error-bg` | errors, failing tests, «Erhalten · Erwartet» |
| `--glp-warning`, `--glp-warning-bg` | hints |
| `--glp-success` | passed tests, runtime ready |
| `--glp-syntax-keyword`, `-string`, `-number`, `-comment` | syntax colours (names, operators, brackets use `--glp-text`) |
| `--glp-font-code`, `--glp-font-ui`, `--glp-radius` | fonts and corner radius |

The embed is flat: no cards, its sections only separated by `--glp-border`
lines, so the host draws the one frame around it.

The Monaco editor uses the theme `glpython` (`src/monacoTheme.ts`), built from
the same tokens when the editor mounts (later changes to the variables need a
reload), and glpython's own Python language `glpython-python`
(`src/pythonLanguage.ts`): Monaco's Python definition, but only Python's
keywords as keywords (not builtins such as `print` or `type`), `True`,
`False` and `None` as values, and comments after code. The visualizer
highlights code with the same language.

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
