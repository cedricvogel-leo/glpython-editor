import doctestRuntime from './runtime/doctests.py?raw'
import hintsRuntime from './runtime/hints.py?raw'
import turtleModule from './runtime/gturtle.py?raw'
import inputPreamble from './runtime/input_bridge.py?raw'
import sessionRuntime from './runtime/session.py?raw'
import visualizerRuntime from './runtime/visualizer.py?raw'

let pyodideReadyPromise
let mountedFiles = []
// The project files as of the last Run - the REPL namespace was built from
// them, so a visualized REPL input must render its call boxes from these
// rather than from whatever the editor holds now.
let lastRunFiles = {}
let lastRunMainFile = 'main.py'
// What the session since the last Run consists of, so an earlier REPL input
// can be visualized by replaying it (see 'visualize-repl-entry'): whether a
// Run happened, what it printed (traceback included), and every REPL input
// since, with what it printed and evaluated to. Only text is kept, never
// Python objects.
let hasRun = false
let lastRunOutcome = null
let replLog = []
// The same for the last Tests run, whose definitions a failing example is
// visualized against.
let lastTestFiles = {}
let lastTestMainFile = 'main.py'
const REPL_PATH = '<repl>'
let inputControl = null
let inputPayload = null
const INPUT_CANCELLED_MARKER = '__GLPYTHON_INPUT_CANCELLED__'


// Python source shared by both run modes: monkeypatches builtins.input to bridge
// through requestInputFromMainThread (defined further below).


async function getPyodide() {
  if (!pyodideReadyPromise) {
    importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js')
    pyodideReadyPromise = loadPyodide().then(async (pyodide) => {
      await pyodide.runPythonAsync(inputPreamble)
      await pyodide.runPythonAsync(hintsRuntime)
      await pyodide.runPythonAsync(sessionRuntime)
      await pyodide.runPythonAsync(visualizerRuntime)
      await pyodide.runPythonAsync(doctestRuntime)
      return pyodide
    })
  }
  return pyodideReadyPromise
}

function callPython(pyodide, name, ...args) {
  const callable = pyodide.globals.get(name)
  try {
    return callable(...args)
  } finally {
    callable.destroy()
  }
}

// Mounts the project's files into the Pyodide virtual filesystem and forces a
// fresh re-import of any previously-cached student modules, so edits to
// secondary files (e.g. greetings.py) always take effect on the next run.
async function mountProjectFiles(pyodide, files) {
  for (const path of mountedFiles) {
    try { pyodide.FS.unlink(`/${path}`) } catch {}
  }
  mountedFiles = []
  for (const [path, code] of Object.entries(files)) {
    const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    if (directory) pyodide.FS.mkdirTree(`/${directory}`)
    pyodide.FS.writeFile(`/${path}`, code)
    mountedFiles.push(path)
  }
  pyodide.FS.writeFile('/gturtle.py', turtleModule)
  callPython(pyodide, '_glpython_invalidate_modules', JSON.stringify([...mountedFiles, 'gturtle.py'].map((path) => `/${path}`)))
}

// Bridges Python's input() to a dialog on the main page. Blocks this worker
// thread (via Atomics.wait) until the main thread writes a response into the
// shared buffer set up by the 'init-input-channel' message below.
function requestInputFromMainThread(promptText) {
  if (!inputControl || !inputPayload) {
    throw new Error('Program input is not available in this browser session. Reload the page and try again.')
  }
  Atomics.store(inputControl, 0, 1)
  self.postMessage({ type: 'input_request', prompt: promptText })
  Atomics.wait(inputControl, 0, 1)
  const state = Atomics.load(inputControl, 0)
  const length = Atomics.load(inputControl, 1)
  Atomics.store(inputControl, 0, 0)
  if (state === 3) throw new Error(INPUT_CANCELLED_MARKER)
  return new TextDecoder().decode(inputPayload.slice(0, length))
}
self.requestInputFromMainThread = requestInputFromMainThread

// Builds the Python source for a single "visualize" run. Real CPython
// execution (via sys.settrace / sys.monitoring) never exposes the values
// sitting on its internal evaluation stack, so there is no way to observe
// "3 * 4" collapsing to "12" mid-expression by tracing real bytecode. To get
// that (and to make loop bodies visibly "reset" each iteration) this harness
// instead runs a small custom tree-walking interpreter over the student's
// own ast.parse() tree.
//
// Design for extensibility: statements and expressions are dispatched by AST
// node type through two dicts (_STMT_HANDLERS / _EXPR_HANDLERS). Common
// constructs (arithmetic, comparisons, boolean ops, if/while/for, function
// defs/calls, classes, try/except, literals, f-strings) are hand-implemented
// so they report fine-grained per-node "eval" steps with substituted values.
// Anything not yet hand-implemented falls back to compiling+exec'ing/eval'ing
// just that one AST node with Python's real compiler against the
// interpreter's current scope - so the program still runs *correctly*, it
// just replays as a single opaque step instead of a step per sub-expression.
// Moving a construct from generic to fine-grained later only requires adding
// one more handler function.



// Output and values compared with what they were the first time, except
// where Python itself varies between runs: object addresses in default reprs.
const replayComparable = (text) => text.replace(/ at 0x[0-9a-f]+>/g, ' at 0x…>')

// Visualizes REPL input `entryId` by replaying the session up to it (see
// _glpython_replay_begin): the file as it was at the Run, then the inputs
// before it, each checked against what it printed and evaluated to then, and
// finally a trace of the input itself, checked the same way. Answers
// { trace, source }, or { note } when the replay needs input() ('input') or
// doesn't reproduce the session ('differs') - e.g. random numbers - rather
// than show a visualization of something else.
async function replayReplEntry(pyodide, entryId) {
  const index = replLog.findIndex((entry) => entry.id === entryId)
  if (index === -1) return { note: 'differs' }
  const target = replLog[index]
  let output = ''
  const capture = () => {
    output = ''
    pyodide.setStdout({ batched: (text) => { output += `${text}\n` } })
    pyodide.setStderr({ batched: (text) => { output += `${text}\n` } })
  }
  const needsInput = () => callPython(pyodide, '_glpython_replay_needed_input') === true
  const projectPaths = [...Object.keys(lastRunFiles), 'gturtle.py'].map((path) => `/${path}`)
  callPython(pyodide, '_glpython_replay_begin', JSON.stringify(projectPaths))
  try {
    if (hasRun) {
      await mountProjectFiles(pyodide, lastRunFiles)
      capture()
      const traceback = String(callPython(pyodide, '_glpython_replay_file', `/${lastRunMainFile}`))
      if (needsInput()) return { note: 'input' }
      if (lastRunOutcome === null || replayComparable(`${output}${traceback}`) !== replayComparable(lastRunOutcome)) return { note: 'differs' }
    }
    for (const entry of replLog.slice(0, index)) {
      capture()
      const resultJson = String(callPython(pyodide, '_glpython_replay_input', entry.source))
      if (needsInput()) return { note: 'input' }
      if (replayComparable(output) !== replayComparable(entry.output) || replayComparable(resultJson) !== replayComparable(entry.resultJson)) return { note: 'differs' }
    }
    const trace = JSON.parse(String(callPython(pyodide, '_glpython_run_visual_repl', target.source, JSON.stringify(lastRunFiles), lastRunMainFile, 'replay')))
    if (needsInput()) return { note: 'input' }
    // A trace cut off at the step limit says so itself; what it would have
    // ended with can't be compared.
    if (!trace.truncated) {
      const expected = JSON.parse(target.resultJson)
      const printed = (text) => replayComparable(text).replace(/\n+$/, '')
      if ('replError' in trace || printed(trace.output) !== printed(target.output)
        || (trace.errorMessage ?? null) !== (expected.error ?? null)
        || (expected.value !== undefined && replayComparable(trace.value?.value ?? '') !== replayComparable(expected.value))) return { note: 'differs' }
    }
    return { trace, source: target.source }
  } finally {
    callPython(pyodide, '_glpython_replay_end')
  }
}

self.onmessage = async (event) => {
  if (event.data.type === 'init-input-channel') {
    inputControl = new Int32Array(event.data.buffer, 0, 2)
    inputPayload = new Uint8Array(event.data.buffer, 8)
    return
  }

  if (event.data.type === 'run') {
    let runOutput = ''
    try {
      const pyodide = await getPyodide()
      await mountProjectFiles(pyodide, event.data.project.files)
      lastRunFiles = event.data.project.files
      lastRunMainFile = event.data.project.mainFile
      pyodide.setStdout({ batched: (text) => { runOutput += `${text}\n` } })
      pyodide.setStderr({ batched: (text) => { runOutput += `${text}\n` } })
      hasRun = true
      lastRunOutcome = null
      replLog = []
      callPython(pyodide, '_glpython_run_project', `/${event.data.project.mainFile}`)
      lastRunOutcome = runOutput
      const graphicsJson = callPython(pyodide, '_glpython_graphics_json')
      self.postMessage({ type: 'result', output: runOutput.trim(), graphics: JSON.parse(String(graphicsJson)) })
    } catch (error) {
      // What the program printed, then Python's traceback as CPython shows
      // it, plus the hint for its error (see _glpython_traceback_text).
      // Pyodide's own error text only if the program never ran.
      let report = null
      try { report = JSON.parse(String(callPython(await getPyodide(), '_glpython_take_error_report'))) } catch {}
      if (report) lastRunOutcome = `${runOutput}${report.traceback}`
      self.postMessage(report
        ? { type: 'error', output: `${runOutput}${report.traceback}`.trimEnd(), errorHint: report.errorHint }
        : { type: 'error', output: String(error), errorHint: null })
    }
    return
  }

  if (event.data.type === 'test') {
    let output = ''
    try {
      const pyodide = await getPyodide()
      await mountProjectFiles(pyodide, event.data.project.files)
      lastTestFiles = event.data.project.files
      lastTestMainFile = event.data.project.mainFile
      pyodide.setStdout({ batched: (text) => { output += `${text}\n` } })
      pyodide.setStderr({ batched: (text) => { output += `${text}\n` } })
      const result = JSON.parse(String(callPython(pyodide, '_glpython_run_doctests', `/${event.data.project.mainFile}`)))
      self.postMessage({ type: 'test-result', output, ...result })
    } catch (error) {
      self.postMessage({ type: 'test-result', output, error: String(error) })
    }
    return
  }

  if (event.data.type === 'repl') {
    let output = ''
    try {
      const pyodide = await getPyodide()
      pyodide.setStdout({ batched: (text) => { output += `${text}\n` } })
      pyodide.setStderr({ batched: (text) => { output += `${text}\n` } })
      const resultJson = String(callPython(pyodide, '_glpython_repl', event.data.source))
      replLog.push({ id: event.data.id, source: event.data.source, output, resultJson })
      const result = JSON.parse(resultJson)
      const graphicsJson = callPython(pyodide, '_glpython_graphics_json')
      self.postMessage({ type: 'repl-result', id: event.data.id, output, graphics: JSON.parse(String(graphicsJson)), ...result })
    } catch (error) {
      self.postMessage({ type: 'repl-result', id: event.data.id, output, error: String(error) })
    }
    return
  }

  if (event.data.type === 'run-visual-repl') {
    try {
      const pyodide = await getPyodide()
      // Nothing may have been run or visualized yet in this worker.
      if (!pyodide.FS.analyzePath('/gturtle.py').exists) pyodide.FS.writeFile('/gturtle.py', turtleModule)
      const fromTests = event.data.namespace === 'test'
      const files = fromTests ? lastTestFiles : lastRunFiles
      const result = JSON.parse(String(callPython(pyodide, '_glpython_run_visual_repl', event.data.source, JSON.stringify(files), fromTests ? lastTestMainFile : lastRunMainFile, fromTests ? 'test' : 'repl')))
      if ('replError' in result) {
        self.postMessage({ type: 'repl-result', id: event.data.id, output: '', error: result.replError })
        return
      }
      self.postMessage({ type: 'trace-result', ...result, rootPath: REPL_PATH, sources: { ...files, [REPL_PATH]: event.data.source } })
    } catch (error) {
      self.postMessage({ type: 'trace-result', trace: [], ast: {}, output: '', graphics: [], error: String(error), truncated: false })
    }
    return
  }

  if (event.data.type === 'visualize-repl-entry') {
    const entryId = event.data.id
    try {
      const pyodide = await getPyodide()
      const result = await replayReplEntry(pyodide, entryId)
      self.postMessage(result.note
        ? { type: 'repl-replay-note', id: entryId, note: result.note }
        : { type: 'trace-result', ...result.trace, rootPath: REPL_PATH, sources: { ...lastRunFiles, [REPL_PATH]: result.source } })
    } catch (error) {
      self.postMessage({ type: 'trace-result', trace: [], ast: {}, output: '', graphics: [], error: String(error), truncated: false })
    }
    return
  }

  if (event.data.type === 'run-visual') {
    try {
      const pyodide = await getPyodide()
      await mountProjectFiles(pyodide, event.data.project.files)
      const pythonPaths = Object.keys(event.data.project.files).filter((path) => path.endsWith('.py'))
      const resultJson = callPython(pyodide, '_glpython_run_visual', event.data.project.mainFile, JSON.stringify(pythonPaths))
      const result = JSON.parse(String(resultJson))
      self.postMessage({ type: 'trace-result', ...result })
    } catch (error) {
      self.postMessage({ type: 'trace-result', trace: [], ast: {}, output: '', graphics: [], error: String(error), truncated: false })
    }
    return
  }
}

getPyodide().then(() => self.postMessage({ type: 'ready' })).catch(() => self.postMessage({ type: 'error', output: 'Could not load the Python runtime. Check your network connection.' }))
