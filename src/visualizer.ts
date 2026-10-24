// Shared types and helpers for the step-by-step execution visualizer. The
// worker (public/pyodide-worker.js) runs a small hand-written tree-walking
// interpreter over the student's own ast.parse() tree (real CPython tracing
// APIs never expose values sitting on the internal bytecode evaluation
// stack, so there is no way to observe e.g. "3 * 4" collapsing to "12"
// mid-expression without controlling the evaluator). Each recorded step
// carries the `nodeId` of the exact AST node it corresponds to - the same
// stable id embedded in the AST-as-JSON tree - so the UI can substitute that
// node's original source with the step's computed value inline.

// 'error' is only ever the very last step: the node the uncaught exception
// was raised at, in the frame it was raised in, with Python's own last
// traceback line as its label/valueText.
export type TraceStepKind = 'eval' | 'exec' | 'branch' | 'loop-iter' | 'call-enter' | 'call-pending' | 'error'

export type TraceStep = {
  step: number
  path: string
  func: string
  line: number
  endLine: number
  col: number
  endCol: number
  kind: TraceStepKind
  label: string
  nodeId: number
  // The computed value's repr (for "eval"/"loop-iter"), "true"/"false" (for
  // "branch"), or null (for plain "exec" steps with no single result value,
  // e.g. a bare `pass` or an assignment target already covered by locals).
  valueText: string | null
  locals: Record<string, string>
  stdoutLen: number
  graphicsLen: number
  // Only present on "loop-iter" steps: every node id inside the loop body,
  // to be cleared from the substitution state so the body's source visibly
  // resets to its un-substituted form at the start of each new iteration.
  resetNodeIds: number[]
  // Only present on "loop-iter" steps for a simple "for x in ...:" target:
  // the node id of the target name, and the text to show *appended right
  // after* it (e.g. "=0"), without replacing/hiding the target's own source
  // text the way a normal substitution would. Lets "for i in range(3):"
  // render as "for i=0 in range(3):" during the first iteration while
  // leaving "range(3)" completely untouched.
  annotateNodeId: number | null
  annotateText: string | null
  // Which call frame this step executed in (0 = module scope). Lets the UI
  // isolate exactly the steps belonging to one open function-call box, even
  // across recursive calls that reuse the same AST nodes.
  frameId: number
  // Only present on "call-enter" steps (the moment a user-defined function
  // starts running): the frame that opened, its caller's frame, the
  // FunctionDef node whose source is the box's content, which file that
  // def lives in, and the "=value" annotations to show next to each bound
  // parameter name in the box's header (same mechanism as loop-variable
  // annotations).
  parentFrameId: number | null
  funcDefNodeId: number | null
  funcDefPath: string | null
  // [param name node id, "=value" text, bound parameter name] per plain
  // positional parameter. The name rides along so the UI can match an
  // entry here back to the matching parameter name in argSources below
  // (the two arrays aren't necessarily parallel/same-length).
  paramAnnotations: Array<[number, string, string]>
  // Only present on "call-enter" steps: the name of each plain
  // positionally-passed parameter this call binds - lets the UI draw an
  // arrow from that parameter's bound value (shown one step early right in
  // the callee's own header via paramAnnotations above) into that
  // parameter's own placeholder row, shown one step early in the
  // about-to-open callee frame (see nextStepPendingCall in App.tsx).
  argSources: Array<string>
  // Only present on the "eval" step of a Call node that just finished
  // running a user-defined function: the frame id that just closed, so the
  // UI knows this is the step where that frame's box collapses into this
  // step's own substituted return value.
  closesFrameId: number | null
  // Only present on "call-pending" steps (the moment right before a
  // user-defined call enters, once the callee and every argument are
  // already resolved - e.g. the call site now reads "fact(2)" - but its
  // frame hasn't opened yet): the name being called, and which frame's
  // locals panel holds it (0 for a module-level function, this step's own
  // `frameId` for one looked up in the current call's own locals) - lets
  // the UI draw an arrow from that name's row into the highlighted call.
  lookupName: string | null
  lookupFrameId: number | null
  // Only on "call-enter" steps of a function that qualifies for the
  // substitution mode (a single "return <expression>"): see ShortForm.
  shortForm?: ShortForm | null
  // For the evaluation chain export (see buildEvaluationChain). On
  // "call-enter": whether an operator works on the call's value, and whether
  // the function has local variables or loops.
  inOperator?: boolean
  hasLocals?: boolean
  // On the closing "eval" step of a call: the value node of the return that
  // ran (null for a bare return; absent if the function ended without one),
  // and [name node id, value text] for the call's own variables read in it.
  returnNodeId?: number | null
  returnNames?: Array<[number, string]>
  // On an "if" statement's "branch" step: its condition with the names
  // replaced by their values, e.g. "2 == 0".
  conditionText?: string | null
}

// How a qualifying call is shown in the substitution mode: replaced at its
// call site by its return expression, with each parameter name in it
// already replaced by its value, and in parentheses where an operator works
// on the call's value (e.g. "1 * (3 * 2)").
export type ShortForm = {
  returnNodeId: number
  // [node id of a parameter name in the return expression, value text]
  paramValues: Array<[number, string]>
  parens: boolean
}

export type VisualizerMode = 'box' | 'substitution'

export type AstNode = {
  id: number
  type: string
  summary: string
  line?: number
  endLine?: number
  col?: number
  endCol?: number
  fields: Record<string, AstNode | AstNode[] | string | null>
}

export type AstFile = AstNode | { error: string }

export type TraceResult = {
  trace: TraceStep[]
  ast: Record<string, AstFile>
  output: string
  graphics: unknown[]
  // The traceback when the program failed - in the learner's own terms
  // (their files/lines only) whenever the trace ends in an 'error' step,
  // otherwise the raw traceback (e.g. the main file doesn't parse).
  error: string | null
  // Just the traceback's last line, e.g. "ZeroDivisionError: division by zero".
  errorMessage?: string | null
  truncated: boolean
  // Per file, what call boxes leave out: comments and docstrings, as
  // [line, col, end line, end col] (see _glpython_hidden_ranges).
  hidden?: Record<string, Array<[number, number, number, number]>>
}

// A file's hidden ranges (see TraceResult.hidden) as character ranges that
// lie entirely inside `within`, ready to be removed from a call box's text.
export function hiddenRangesWithin(ranges: Array<[number, number, number, number]> | undefined, lineOffsets: number[], sourceLength: number, within: { start: number; end: number }): Array<{ start: number; end: number }> {
  const offsetOf = (line: number, col: number) => line - 1 < lineOffsets.length ? Math.min(sourceLength, lineOffsets[line - 1] + col) : sourceLength
  return (ranges ?? [])
    .map(([line, col, endLine, endCol]) => ({ start: offsetOf(line, col), end: offsetOf(endLine, endCol) }))
    .filter((range) => range.start < range.end && range.start >= within.start && range.end <= within.end)
}

// The lines that removals take out completely (from their start up to the
// next line's start), so a call box can map its rendered lines back to the
// original line numbers.
export function removedLines(removals: Array<{ start: number; end: number }>, lineOffsets: number[], sourceLength: number): Set<number> {
  const removed = new Set<number>()
  lineOffsets.forEach((start, index) => {
    const end = index + 1 < lineOffsets.length ? lineOffsets[index + 1] : sourceLength
    if (removals.some((range) => range.start <= start && range.end >= end && end > start)) removed.add(index + 1)
  })
  return removed
}

// Builds a nodeId -> AstNode index for one parsed file, so steps can be
// matched back to their AST node in O(1) instead of walking the tree per
// step (a trace can contain thousands of steps).
export function indexAstNodes(root: AstFile | undefined): Map<number, AstNode> {
  const index = new Map<number, AstNode>()
  if (!root || 'error' in root) return index

  const visit = (node: AstNode) => {
    index.set(node.id, node)
    for (const value of Object.values(node.fields)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === 'object') visit(item as AstNode)
      } else if (value && typeof value === 'object') {
        visit(value as AstNode)
      }
    }
  }

  visit(root as AstNode)
  return index
}

// Every AST node touched by any step up to and including `uptoStep` (across
// all files), keyed by path -> nodeId -> the value to substitute its source
// with. Used to build the "original code with computed values inlined"
// rendering for a given point in the trace.
export type SubstitutionState = Map<string, Map<number, string>>

// Like SubstitutionState, but for the loop-variable "=value" annotations:
// path -> nodeId (of the loop target) -> text to append right after it.
// Unlike substitutions, these are never cleared by resetNodeIds - each new
// iteration simply overwrites the previous one's annotation for the same
// target node id, and the last iteration's annotation is left in place
// afterwards (matching how substituted values elsewhere in the trace stay
// visible once computed, e.g. `total = 14` doesn't revert after the loop).
export type AnnotationState = Map<string, Map<number, string>>

// Replays the trace from the start up to (and including) `uptoStep`,
// producing the substitution state to render. Each "loop-iter" step carries
// `resetNodeIds` (every node id inside that loop's body, plus - for "while"
// loops - every node id inside the condition expression too) which is
// cleared from the state *before* applying the step's own value - this is
// what makes a loop body (and, for "while" loops, its condition) visibly
// "reset" to its original source at the start of every iteration instead of
// staying stuck showing the previous iteration's substituted values.
//
// `frameId` scopes the replay to steps that executed in exactly one call
// frame (0 = module scope). This is what keeps recursive/nested calls from
// clobbering each other's displayed values even though they share the exact
// same AST node ids: each invocation's own steps are tagged with its own
// unique frame id (see public/pyodide-worker.js), so filtering by frame id
// isolates "this specific call's" substitutions from any other open call to
// the same function.
export function buildSubstitutionsUpTo(trace: TraceStep[], uptoStep: number, frameId = 0): SubstitutionState {
  const state: SubstitutionState = new Map()

  for (const step of trace) {
    if (step.step > uptoStep) break
    if (step.frameId !== frameId) continue

    if (step.kind === 'loop-iter' && step.resetNodeIds?.length) {
      const byNode = state.get(step.path)
      if (byNode) for (const id of step.resetNodeIds) byNode.delete(id)
    }

    if (step.valueText === null) continue
    if (step.kind !== 'eval') continue

    let byNode = state.get(step.path)
    if (!byNode) {
      byNode = new Map()
      state.set(step.path, byNode)
    }
    byNode.set(step.nodeId, step.valueText)
  }

  return state
}

// Replays the trace up to (and including) `uptoStep`, producing the
// loop-variable annotation state (see AnnotationState) to render, scoped to
// one call frame (see buildSubstitutionsUpTo).
export function buildAnnotationsUpTo(trace: TraceStep[], uptoStep: number, frameId = 0): AnnotationState {
  const state: AnnotationState = new Map()

  for (const step of trace) {
    if (step.step > uptoStep) break
    if (step.frameId !== frameId) continue
    if (step.kind !== 'loop-iter' || step.annotateNodeId === null || step.annotateText === null) continue

    let byNode = state.get(step.path)
    if (!byNode) {
      byNode = new Map()
      state.set(step.path, byNode)
    }
    byNode.set(step.annotateNodeId, step.annotateText)
  }

  return state
}

// path -> every source line number that has already executed at some point
// up to (but not including) `uptoStep`, scoped to one call frame. Used to
// render a dimmer "already executed" treatment on past lines, distinct from
// the brighter "current line" treatment `uptoStep`'s own line gets instead
// (see App.tsx's Frame component).
export type ExecutedLinesState = Map<string, Set<number>>

// Replays the trace up to (but not including) `uptoStep`, collecting each
// step's own `line` only - deliberately never the node's full `line..endLine`
// span, even though that's readily available. Several statement kinds carry
// an AST node whose own span covers far more than what has actually run so
// far: an `if`/`while` node's span covers its *entire* body (both branches,
// for an `if`), and a `def`'s span covers its *entire* function body. Using
// `endLine` here would therefore immediately mark an untaken `if`/`else`
// branch, or a function's whole body, as "already executed" the moment its
// header/signature line itself runs - which is exactly backwards. Marking
// only `step.line` naturally keeps this correct for free: an `if`'s branch
// step only marks its own header line (the branch's own body lines get
// marked separately, by their own per-statement steps, only for whichever
// branch was actually taken), and a `def`'s step - which only ever fires
// once, when the function is *defined*, not when it's later called - only
// marks its header line, never any line of its body.
//
// "call-enter" steps are skipped entirely: their `line`/`path` describe the
// *call site* (in the caller's own file/frame), not any line of the callee's
// own body, even though the step itself is tagged with the callee's new
// frame id - folding it in here would risk mislabelling a line in the new
// frame's own source (most visibly for a recursive call, where caller and
// callee share the exact same file and line numbers).
//
// Mirrors buildSubstitutionsUpTo's loop-reset behaviour: a "loop-iter"
// step's `resetNodeIds` are cleared from the set right before that step's
// own line is (re-)marked - using each reset node's own `line`/`endLine`
// (from `nodeIndexByFile`, since resetNodeIds are AST node ids, not lines)
// to know which lines to drop - so a loop body's (and, for `while` loops,
// its condition's) execution trail visibly restarts at the top of every new
// iteration instead of just accumulating across the whole loop's run.
export function buildExecutedLinesUpTo(
  trace: TraceStep[],
  uptoStep: number,
  frameId: number,
  nodeIndexByFile: Map<string, Map<number, AstNode>>,
): ExecutedLinesState {
  const state: ExecutedLinesState = new Map()

  for (const step of trace) {
    if (step.step > uptoStep) break
    if (step.frameId !== frameId) continue
    if (step.kind === 'call-enter') continue

    if (step.kind === 'loop-iter' && step.resetNodeIds?.length) {
      const nodeIndex = nodeIndexByFile.get(step.path)
      const lines = state.get(step.path)
      if (lines && nodeIndex) {
        for (const id of step.resetNodeIds) {
          const node = nodeIndex.get(id)
          if (!node || node.line === undefined) continue
          const endLine = node.endLine ?? node.line
          for (let line = node.line; line <= endLine; line++) lines.delete(line)
        }
      }
    }

    if (step.step === uptoStep) continue

    let lines = state.get(step.path)
    if (!lines) {
      lines = new Set()
      state.set(step.path, lines)
    }
    lines.add(step.line)
  }

  return state
}

// One user-defined function call whose box is (or was, up to the replayed
// step) open: which frame it is, where its call site is (the box's anchor
// position), and where its own def's source lives (the box's content).
export type OpenFrame = {
  frameId: number
  parentFrameId: number
  funcName: string
  // Call site (in the *caller's* file) the box is anchored at.
  anchorPath: string
  anchorNodeId: number
  // Where the "def ...:" itself lives - may be a different file than the
  // call site (e.g. calling into an imported module).
  funcDefPath: string
  funcDefNodeId: number
  paramAnnotations: Array<[number, string, string]>
  shortForm: ShortForm | null
}

// Replays the trace up to (and including) `uptoStep`, returning every call
// frame that is still "open" at that point (i.e. its call-enter step has
// been reached but the step that closes it has not), keyed by frame id.
// Frame 0 (module scope) is never included - it's always implicitly open.
export function computeOpenFramesUpTo(trace: TraceStep[], uptoStep: number): Map<number, OpenFrame> {
  const open = new Map<number, OpenFrame>()

  for (const step of trace) {
    if (step.step > uptoStep) break

    if (step.kind === 'call-enter' && step.funcDefNodeId !== null && step.funcDefPath !== null) {
      open.set(step.frameId, {
        frameId: step.frameId,
        parentFrameId: step.parentFrameId ?? 0,
        funcName: step.func,
        anchorPath: step.path,
        anchorNodeId: step.nodeId,
        funcDefPath: step.funcDefPath,
        funcDefNodeId: step.funcDefNodeId,
        paramAnnotations: step.paramAnnotations ?? [],
        shortForm: step.shortForm ?? null,
      })
    }

    if (step.closesFrameId !== null && step.closesFrameId !== undefined) {
      open.delete(step.closesFrameId)
    }
  }

  return open
}

// The steps the substitution mode clicks through: every step of the trace
// except those that wouldn't change what's shown once qualifying calls are
// replaced by their return expressions - looking up a parameter name (its
// value is already in place), the moment before such a call starts, any
// statement step inside it, and its final "returned" step (the expression
// has already become that value). Each remaining click is one substitution.
export function substitutionModeSteps(trace: TraceStep[]): TraceStep[] {
  const paramNodeIdsByFrame = new Map<number, Set<number>>()
  const pendingIndexByCall = new Map<string, number>()
  const hidden = new Set<number>()
  trace.forEach((step, index) => {
    if (step.kind === 'call-pending') pendingIndexByCall.set(`${step.frameId}:${step.nodeId}`, index)
    if (step.kind === 'call-enter' && step.shortForm) {
      paramNodeIdsByFrame.set(step.frameId, new Set(step.shortForm.paramValues.map(([nodeId]) => nodeId)))
      const pendingIndex = pendingIndexByCall.get(`${step.parentFrameId ?? 0}:${step.nodeId}`)
      if (pendingIndex !== undefined) hidden.add(pendingIndex)
      return
    }
    const paramNodeIds = paramNodeIdsByFrame.get(step.frameId)
    if (paramNodeIds && (step.kind === 'exec' || (step.kind === 'eval' && paramNodeIds.has(step.nodeId)))) hidden.add(index)
    if (step.closesFrameId !== null && step.closesFrameId !== undefined && paramNodeIdsByFrame.has(step.closesFrameId)) hidden.add(index)
  })
  return trace.filter((_, index) => !hidden.has(index))
}

// A deep chain of open call boxes (e.g. a recursion without a base case)
// shows only its outermost few boxes and its innermost one(s) in full: the
// boxes in between are replaced by a single "... N more calls of f(x) ..."
// marker, which itself contains the first box shown again. Without this,
// every extra level of nesting makes the boxes' layout more expensive, until
// the page stops responding (well before the 200-call limit).
export type CollapsedCalls = {
  // The outermost hidden frame - its parent renders the marker in its place.
  firstHiddenFrameId: number
  // The first frame shown again, nested inside the marker.
  resumeFrame: OpenFrame
  hiddenCount: number
  // "loop(3)" when every hidden call is the same call, "f(…)" when they share
  // only the function, null when they're calls to different functions.
  callText: string | null
}

const COLLAPSE_KEEP_OUTER = 3
const COLLAPSE_MIN_HIDDEN = 4
const COLLAPSE_MAX_CALL_TEXT = 40

// `keepInner` is how many of the innermost boxes stay visible - callers pass
// 2 while a one-step-early "about to open" box is the innermost one, so the
// box that's actually running stays visible next to it.
export function collapseDeepCallChain(openFrames: Map<number, OpenFrame>, keepInner: number): CollapsedCalls | null {
  // Open call frames always form a single chain (the call stack), so each
  // frame has at most one open child.
  const childOf = new Map<number, OpenFrame>()
  for (const frame of openFrames.values()) childOf.set(frame.parentFrameId, frame)
  const chain: OpenFrame[] = []
  for (let frame = childOf.get(0); frame; frame = childOf.get(frame.frameId)) chain.push(frame)

  const hidden = chain.slice(COLLAPSE_KEEP_OUTER, chain.length - keepInner)
  if (hidden.length < COLLAPSE_MIN_HIDDEN) return null

  const argsText = (frame: OpenFrame) => frame.paramAnnotations.map(([, text]) => text.replace(/^=/, '')).join(', ')
  const funcName = hidden[0].funcName
  const firstArgs = argsText(hidden[0])
  let callText: string | null = null
  if (hidden.every((frame) => frame.funcName === funcName)) {
    const sameArgs = hidden.every((frame) => argsText(frame) === firstArgs)
    callText = sameArgs && firstArgs.length <= COLLAPSE_MAX_CALL_TEXT ? `${funcName}(${firstArgs})` : `${funcName}(\u2026)`
  }
  return { firstHiddenFrameId: hidden[0].frameId, resumeFrame: chain[chain.length - keepInner], hiddenCount: hidden.length, callText }
}

// Absolute character offset (into the whole source string) of the start of
// each line, so an AST node's (line, col) - both from Python's ast module,
// 1-based line / 0-based column - can be converted to a plain [start, end)
// character range for string splicing.
export function computeLineOffsets(source: string): number[] {
  const offsets = [0]
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') offsets.push(i + 1)
  }
  return offsets
}

export function nodeRange(node: AstNode, lineOffsets: number[]): { start: number; end: number } | null {
  if (node.line === undefined || node.endLine === undefined || node.col === undefined || node.endCol === undefined) return null
  const start = (lineOffsets[node.line - 1] ?? 0) + node.col
  const end = (lineOffsets[node.endLine - 1] ?? 0) + node.endCol
  return { start, end }
}

// Compound statements (function defs, for/while loops, if statements) carry
// their whole nested body in their own source span, since that's simply
// where their first/last token sit. For a preview highlight, though,
// showing the entire body as "about to run" reads as if the whole block
// were one atomic step, when really only the def/for/while/if's own
// header line(s) are what that particular trace step evaluates - the body
// only runs as its own later steps. This trims the span down to just the
// header: from the node's own start up to (not including) wherever its
// first body statement begins.
const HEAD_ONLY_NODE_TYPES = new Set(['FunctionDef', 'AsyncFunctionDef', 'For', 'While', 'If'])

export function nodeHeadRange(node: AstNode, lineOffsets: number[]): { start: number; end: number } | null {
  const full = nodeRange(node, lineOffsets)
  if (!full || !HEAD_ONLY_NODE_TYPES.has(node.type)) return full
  const body = node.fields.body
  const firstBodyStatement = Array.isArray(body) ? body.find((item): item is AstNode => item !== null && typeof item === 'object') : undefined
  if (!firstBodyStatement || firstBodyStatement.line === undefined) return full
  const bodyStart = lineOffsets[firstBodyStatement.line - 1]
  // A one-line suite (e.g. "if x: y = 1") has no separate header line to
  // trim down to - fall back to the whole node in that case.
  if (bodyStart === undefined || bodyStart <= full.start || bodyStart >= full.end) return full
  return { start: full.start, end: bodyStart }
}

// Produces the source text for one file with every currently-substituted
// AST node's original text replaced by its computed value, plus the
// character ranges (in the *new* text) that are substituted values, for
// highlighting. When both a node and one of its descendants are
// substituted (e.g. `2 + 3 * 4` mid-evaluation: the `3 * 4` sub-expression
// resolves before the outer `+` does), only the outermost substitution is
// applied - the inner one is naturally superseded once the outer node's own
// step fires, which is exactly what produces the requested one-step-at-a-
// time collapse (`2 + 3 * 4` -> `2 + 12` -> `14`).
// `nodeId` is only ever set on 'annotation' inserts - it's the annotated
// node's own id (e.g. a function parameter name's node in its "def ...:"),
// carried through so the UI can later single out exactly this one
// annotation's rendered span (e.g. to anchor a connector arrow at a
// specific bound parameter's "=3", not just "some annotation on this
// line").
type MergedInsert = { start: number; end: number; value: string; kind: 'substitution' | 'annotation' | 'removal'; nodeId?: number }

// The source the substitutions apply to, and the part of it being rendered
// (null: all of it) - needed to drop grouping parentheses, see below - plus
// ranges to leave out entirely (a call box's comments and docstring).
export type SubstitutionContext = { source: string; limit: { start: number; end: number } | null; removals?: Array<{ start: number; end: number }> }

const PYTHON_KEYWORDS_BEFORE_PARENS = new Set(['and', 'or', 'not', 'in', 'is', 'if', 'elif', 'else', 'while', 'for', 'return', 'yield', 'lambda', 'await', 'assert', 'del', 'with', 'from', 'import', 'raise'])

// Once a value replaces an expression that its own parentheses group, as in
// "1 / (2 + x)" -> "1 / 0", the parentheses go with it - as in the course's
// paper notation. Call and subscript parentheses ("f(2 + x)") stay, and so do
// the parentheses around a negative value ("(-2) ** 2" means something
// else without them). Never reaches outside the rendered part.
function widenOverGroupingParens(context: SubstitutionContext, range: { start: number; end: number }, value: string): { start: number; end: number } {
  if (value.startsWith('-')) return range
  const { source, limit } = context
  let { start, end } = range
  for (;;) {
    let before = start - 1
    while (before >= 0 && /\s/.test(source[before])) before--
    let after = end
    while (after < source.length && /\s/.test(source[after])) after++
    if (source[before] !== '(' || source[after] !== ')') return { start, end }
    if (limit && (before < limit.start || after + 1 > limit.end)) return { start, end }
    // What precedes the "(": a name, closing bracket or string ends a call
    // or subscript, unless the name is a keyword ("return (x + 1)").
    let previous = before - 1
    while (previous >= 0 && /[ \t]/.test(source[previous])) previous--
    const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(source.slice(Math.max(0, previous - 40), previous + 1))?.[0]
    const isCallOrSubscript = previous >= 0 && (word ? !PYTHON_KEYWORDS_BEFORE_PARENS.has(word) : /[)\]'"0-9]/.test(source[previous]))
    if (isCallOrSubscript) return { start, end }
    start = before
    end = after + 1
  }
}

// Shared by applySubstitutions and locateNodeRenderedRange: the sorted list
// of every text replacement/insert that would be spliced into `source`,
// without actually building the resulting string yet - so both "produce the
// rendered text" and "find where some other node's span ends up in that
// rendered text" can walk the exact same splice plan.
function buildMergedInserts(
  lineOffsets: number[],
  nodeIndex: Map<number, AstNode>,
  substitutions: Map<number, string> | undefined,
  annotations: Map<number, string> | undefined,
  context?: SubstitutionContext,
): MergedInsert[] {
  const candidates: Array<{ start: number; end: number; value: string; nodeId: number }> = []
  for (const [nodeId, value] of substitutions ?? []) {
    const node = nodeIndex.get(nodeId)
    if (!node) continue
    const range = nodeRange(node, lineOffsets)
    if (!range) continue
    candidates.push({ ...(context ? widenOverGroupingParens(context, range, value) : range), value, nodeId })
  }

  // Larger spans first, so a containing node is selected before any
  // descendant node whose span it fully covers.
  candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start))

  // `nodeId` rides along on each selected substitution (not just
  // annotations) so the UI can later find exactly which rendered span holds
  // one particular substituted value - e.g. to animate a function's return
  // value flying straight into the span that's about to show it, instead of
  // a disconnected floating copy (see nextStepReturnFlight in App.tsx).
  const selected: Array<{ start: number; end: number; value: string; nodeId: number }> = []
  for (const candidate of candidates) {
    const overlapsSelected = selected.some((s) => candidate.start >= s.start && candidate.end <= s.end)
    if (!overlapsSelected) selected.push(candidate)
  }

  // Annotations are zero-width inserts placed right after their node's
  // source span (e.g. the "=0" after a for-loop's target name "i") rather
  // than replacements, so the original text they're attached to is never
  // hidden. Skip any annotation whose position falls inside a substituted
  // span, since that source text isn't visible to attach the annotation to
  // anymore.
  const inserts: Array<{ start: number; end: number; value: string; kind: 'annotation'; nodeId: number }> = []
  for (const [nodeId, text] of annotations ?? []) {
    const node = nodeIndex.get(nodeId)
    if (!node) continue
    const range = nodeRange(node, lineOffsets)
    if (!range) continue
    const hiddenBySubstitution = selected.some((s) => range.end > s.start && range.end < s.end)
    if (hiddenBySubstitution) continue
    inserts.push({ start: range.end, end: range.end, value: text, kind: 'annotation', nodeId })
  }

  // Removals (comments, docstrings) never overlap evaluated code; skip any
  // that would, rather than garble a substituted value.
  const removals = (context?.removals ?? [])
    .filter((removal) => !selected.some((s) => removal.start < s.end && removal.end > s.start))
    .sort((a, b) => a.start - b.start)
    .filter((removal, index, all) => index === 0 || removal.start >= all[index - 1].end)
    .map((removal) => ({ ...removal, value: '', kind: 'removal' as const }))

  return [
    ...selected.map((s) => ({ ...s, kind: 'substitution' as const })),
    ...inserts,
    ...removals,
  ].sort((a, b) => a.start - b.start || (a.kind === 'substitution' ? -1 : 1))
}

// Maps one offset in the *original* source to where it ends up in the
// rendered text produced by splicing in `merged`'s inserts. Only valid for
// offsets that don't fall strictly inside a splice's original span (true
// for any AST node's own start/end as long as that exact node isn't itself
// being substituted - its descendants being substituted is fine).
function locateOffset(merged: MergedInsert[], offset: number): number {
  let cursor = 0
  let renderedLen = 0
  for (const item of merged) {
    if (item.start >= offset) break
    renderedLen += (item.start - cursor) + item.value.length
    cursor = item.end
  }
  return renderedLen + (offset - cursor)
}

// Finds where `node`'s own span (untouched, i.e. assuming `node` itself is
// not among the substituted nodes) ends up in the text applySubstitutions
// would produce for the same source/substitutions/annotations - e.g. so a
// call-frame box can be positioned exactly where its call site's `fact(2)`
// text sits within its *parent* frame's already-substituted rendering, in
// order to render the nested box inline there instead of the plain text.
export function locateNodeRenderedRange(
  lineOffsets: number[],
  nodeIndex: Map<number, AstNode>,
  substitutions: Map<number, string> | undefined,
  annotations: Map<number, string> | undefined,
  node: AstNode,
  useHeadOnly = false,
  context?: SubstitutionContext,
): { start: number; end: number } | null {
  const range = useHeadOnly ? nodeHeadRange(node, lineOffsets) : nodeRange(node, lineOffsets)
  if (!range) return null
  const merged = buildMergedInserts(lineOffsets, nodeIndex, substitutions, annotations, context)
  return { start: locateOffset(merged, range.start), end: locateOffset(merged, range.end) }
}

export function applySubstitutions(
  source: string,
  lineOffsets: number[],
  nodeIndex: Map<number, AstNode>,
  substitutions: Map<number, string> | undefined,
  annotations?: Map<number, string>,
  limit: { start: number; end: number } | null = null,
  removals: Array<{ start: number; end: number }> = [],
): { text: string; highlights: Array<{ start: number; end: number; nodeId?: number }>; annotationHighlights: Array<{ start: number; end: number; nodeId?: number }> } {
  if ((!substitutions || substitutions.size === 0) && (!annotations || annotations.size === 0) && removals.length === 0) {
    return { text: source, highlights: [], annotationHighlights: [] }
  }

  const merged = buildMergedInserts(lineOffsets, nodeIndex, substitutions, annotations, { source, limit, removals })

  let text = ''
  let cursor = 0
  const highlights: Array<{ start: number; end: number; nodeId?: number }> = []
  const annotationHighlights: Array<{ start: number; end: number; nodeId?: number }> = []
  for (const { start, end, value, kind, nodeId } of merged) {
    if (start < cursor) continue
    text += source.slice(cursor, start)
    const highlightStart = text.length
    text += value
    if (kind === 'substitution') highlights.push({ start: highlightStart, end: text.length, nodeId })
    else if (kind === 'annotation') annotationHighlights.push({ start: highlightStart, end: text.length, nodeId })
    cursor = end
  }
  text += source.slice(cursor)

  return { text, highlights, annotationHighlights }
}

// Like applySubstitutions, but clips the result down to just one span of
// the source (used to render a call-frame's box: only the "def foo(...):"
// node's own text, not the rest of the file it lives in) - or, when
// `clipRange` is null, returns the whole file untouched, which is what
// lets the exact same renderer draw both a function call's box and the
// outermost module/global frame.
//
// This works by running the normal whole-file substitution pass and then
// trimming the result down, rather than re-implementing the splicing logic
// on a pre-sliced string, which is what makes it safe: as long as every
// substitution/annotation passed in belongs to a node *inside* `clipRange`
// (true here, since callers scope them to one call frame - see
// buildSubstitutionsUpTo's `frameId` parameter - and a frame's own steps
// can only ever touch nodes inside its own function body), the text before
// clipRange's start and after its end is guaranteed untouched/same-length
// in the rendered output, so the original character offsets still line up.
export function renderFrameSource(
  source: string,
  lineOffsets: number[],
  nodeIndex: Map<number, AstNode>,
  clipRange: { start: number; end: number } | null,
  substitutions: Map<number, string> | undefined,
  annotations: Map<number, string> | undefined,
  removals: Array<{ start: number; end: number }> = [],
): { text: string; highlights: Array<{ start: number; end: number; nodeId?: number }>; annotationHighlights: Array<{ start: number; end: number; nodeId?: number }> } | null {
  const { text, highlights, annotationHighlights } = applySubstitutions(source, lineOffsets, nodeIndex, substitutions, annotations, clipRange, removals)
  if (!clipRange) return { text, highlights, annotationHighlights }

  const tailLength = source.length - clipRange.end
  const clippedEnd = text.length - tailLength
  const inClip = (r: { start: number; end: number }) => r.start >= clipRange.start && r.end <= clippedEnd
  const shift = <T extends { start: number; end: number }>(r: T) => ({ ...r, start: r.start - clipRange.start, end: r.end - clipRange.start })

  return {
    text: text.slice(clipRange.start, clippedEnd),
    highlights: highlights.filter(inClip).map(shift),
    annotationHighlights: annotationHighlights.filter(inClip).map(shift),
  }
}

// Binary-searches `lineOffsets` (see computeLineOffsets) for the 1-based
// line number containing a given character offset - used to figure out
// which source line a clipped frame's first rendered line corresponds to,
// without needing the clipping AST node's own `.line` field (so the same
// code path works for the module/global frame, whose clip range is just
// "the whole file" with no single AST node to read a line number from).
export function lineNumberAtOffset(lineOffsets: number[], offset: number): number {
  let lo = 0
  let hi = lineOffsets.length - 1
  let line = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lineOffsets[mid] <= offset) { line = mid; lo = mid + 1 } else hi = mid - 1
  }
  return line + 1
}

// Returns the most recent non-empty locals snapshot recorded for one call
// frame (0 = module scope) at or before `uptoStep` - i.e. "what this
// frame's own variables currently look like", persisted across any later
// steps that don't themselves carry a fresh snapshot (most step kinds only
// attach one on assignment/loop-iter/call-enter, see
// public/pyodide-worker.js's _glpython_record call sites - every other
// step kind, e.g. a plain "eval" or "branch" step, would otherwise blank
// the panel out on every single expression/condition evaluation).
export function buildLocalsUpTo(trace: TraceStep[], uptoStep: number, frameId = 0): Record<string, string> {
  let locals: Record<string, string> = {}
  for (const step of trace) {
    if (step.step > uptoStep) break
    if (step.frameId !== frameId) continue
    if (Object.keys(step.locals).length > 0) locals = step.locals
  }
  return locals
}

// The texts the evaluation chain export needs, see buildEvaluationChain.
export type EvaluationChainStrings = {
  conditionComment: (condition: string, value: string) => string
  localsComment: string
}

const CHAIN_NOT_EXPORTED = new Set(['FunctionDef', 'AsyncFunctionDef', 'ClassDef', 'Import', 'ImportFrom'])

const nodeContains = (outer: AstNode, inner: AstNode) =>
  outer.line !== undefined && outer.endLine !== undefined && inner.line !== undefined && inner.endLine !== undefined &&
  (inner.line > outer.line || (inner.line === outer.line && (inner.col ?? 0) >= (outer.col ?? 0))) &&
  (inner.endLine < outer.endLine || (inner.endLine === outer.endLine && (inner.endCol ?? 0) <= (outer.endCol ?? 0)))

// The top-level statement of the root file (the main file, or a REPL
// input's pseudo-file) that a step belongs to: the step's own statement if
// it ran at module level, otherwise the statement whose call (or a call
// inside it) the step ran in.
function rootStatementOf(step: TraceStep, enterByFrame: Map<number, TraceStep>, rootPath: string, root: AstFile | undefined, nodeIndex: Map<number, AstNode> | undefined): AstNode | null {
  if (!root || 'error' in root || !nodeIndex) return null
  let frameId = step.frameId
  let nodeId = step.nodeId
  let path = step.path
  if (step.kind === 'call-enter') frameId = step.parentFrameId ?? 0
  while (frameId !== 0) {
    const enter = enterByFrame.get(frameId)
    if (!enter) return null
    nodeId = enter.nodeId
    path = enter.path
    frameId = enter.parentFrameId ?? 0
  }
  if (path !== rootPath) return null
  const node = nodeIndex.get(nodeId)
  const body = root.fields.body
  if (!node || !Array.isArray(body)) return null
  return body.find((statement): statement is AstNode => statement !== null && typeof statement === 'object' && nodeContains(statement as AstNode, node)) ?? null
}

// The expression of a statement that the chain shows: an expression
// statement's own expression, or the value of an assignment or return.
function chainExpressionOf(statement: AstNode): AstNode | null {
  if (CHAIN_NOT_EXPORTED.has(statement.type)) return null
  if (!['Expr', 'Assign', 'AugAssign', 'AnnAssign', 'Return'].includes(statement.type)) return null
  const value = statement.fields.value
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

// The evaluation of the statement the given step belongs to, written in the
// course's paper notation: its expression, then one line per change, each
// starting with "→". A call to a function with a single "return <expr>" is
// replaced exactly as the substitution mode shows it; any other call by the
// expression of the return it executed, with its parameters and local
// variables already replaced by their values, plus a comment naming the
// condition that chose that return (and that its body has local variables).
// A new line starts whenever the text changes, so the chain takes the same
// steps as the visualizer. A run that fails ends with Python's error line.
// Returns null for a definition or a statement without an expression.
export function buildEvaluationChain(options: {
  trace: TraceStep[]
  ast: Record<string, AstFile>
  nodeIndexByFile: Map<string, Map<number, AstNode>>
  sources: Record<string, string>
  rootPath: string
  step: TraceStep
  errorMessage: string | null
  comments: boolean
  strings: EvaluationChainStrings
}): string | null {
  const { trace, ast, nodeIndexByFile, sources, rootPath, step, errorMessage, comments, strings } = options
  const enterByFrame = new Map<number, TraceStep>()
  const closeByFrame = new Map<number, TraceStep>()
  const ifBranchesByFrame = new Map<number, TraceStep[]>()
  // Each call's own steps, so replaying one call's values doesn't scan the
  // whole trace (a deep recursion has hundreds of calls open at once).
  const stepsByFrame = new Map<number, TraceStep[]>()
  const lineOffsetsByPath = new Map<string, number[]>()
  const lineOffsetsOf = (path: string, source: string) => {
    let offsets = lineOffsetsByPath.get(path)
    if (!offsets) lineOffsetsByPath.set(path, offsets = computeLineOffsets(source))
    return offsets
  }
  for (const s of trace) {
    const frameSteps = stepsByFrame.get(s.frameId)
    if (frameSteps) frameSteps.push(s)
    else stepsByFrame.set(s.frameId, [s])
    if (s.kind === 'call-enter') enterByFrame.set(s.frameId, s)
    if (s.closesFrameId !== null && s.closesFrameId !== undefined) closeByFrame.set(s.closesFrameId, s)
    if (s.kind === 'branch' && s.conditionText) {
      const branches = ifBranchesByFrame.get(s.frameId)
      if (branches) branches.push(s)
      else ifBranchesByFrame.set(s.frameId, [s])
    }
  }

  const rootIndex = nodeIndexByFile.get(rootPath)
  const statement = rootStatementOf(step, enterByFrame, rootPath, ast[rootPath], rootIndex)
  const expression = statement ? chainExpressionOf(statement) : null
  if (!statement || !expression) return null
  const steps = trace.filter((s) => rootStatementOf(s, enterByFrame, rootPath, ast[rootPath], rootIndex) === statement)
  if (steps.length === 0) return null

  // `clip`'s text in `path` as of `uptoStep`, with `frameId`'s substituted
  // values (plus `preset` ones) and every call open inside it replaced in turn.
  const render = (path: string, frameId: number, clip: AstNode, preset: Array<[number, string]>, uptoStep: number, openFrames: Map<number, OpenFrame>): { text: string; isSingleValue: boolean } | null => {
    const nodeIndex = nodeIndexByFile.get(path)
    const source = sources[path]
    const lineOffsets = source !== undefined ? lineOffsetsOf(path, source) : null
    const clipRange = nodeIndex && lineOffsets ? nodeRange(clip, lineOffsets) : null
    if (!nodeIndex || source === undefined || !lineOffsets || !clipRange) return null
    // Only values inside the clipped expression: a value substituted earlier
    // in the same file (e.g. an "if" in the box above) would shift the clip.
    const inClip = (nodeId: number) => {
      const node = nodeIndex.get(nodeId)
      const range = node ? nodeRange(node, lineOffsets) : null
      return range !== null && range.start >= clipRange.start && range.end <= clipRange.end
    }
    const substitutions = new Map<number, string>(preset.filter(([nodeId]) => inClip(nodeId)))
    for (const [nodeId, value] of buildSubstitutionsUpTo(stepsByFrame.get(frameId) ?? [], uptoStep, frameId).get(path) ?? []) if (inClip(nodeId)) substitutions.set(nodeId, value)
    const rendered = renderFrameSource(source, lineOffsets, nodeIndex, clipRange, substitutions, undefined)
    if (!rendered) return null
    let text = rendered.text
    const children = [...openFrames.values()]
      .filter((frame) => frame.parentFrameId === frameId && frame.anchorPath === path)
      .map((frame) => {
        const anchor = nodeIndex.get(frame.anchorNodeId)
        const range = anchor && inClip(anchor.id) ? locateNodeRenderedRange(lineOffsets, nodeIndex, substitutions, undefined, anchor, false, { source, limit: clipRange }) : null
        return range ? { frame, start: range.start - clipRange.start, end: range.end - clipRange.start } : null
      })
      .filter((child): child is { frame: OpenFrame; start: number; end: number } => child !== null)
      .sort((a, b) => b.start - a.start)
    for (const child of children) {
      const replacement = callText(child.frame, uptoStep, openFrames)
      if (replacement !== null) text = text.slice(0, child.start) + replacement + text.slice(child.end)
    }
    return { text, isSingleValue: substitutions.has(clip.id) || clip.type === 'Constant' }
  }

  // What an open call is replaced by (null keeps the call as written, e.g. a
  // call that failed before reaching a return).
  const callText = (frame: OpenFrame, uptoStep: number, openFrames: Map<number, OpenFrame>): string | null => {
    const enter = enterByFrame.get(frame.frameId)
    const nodeIndex = nodeIndexByFile.get(frame.funcDefPath)
    if (!enter || !nodeIndex) return null
    let clipId: number | null | undefined
    let preset: Array<[number, string]>
    if (enter.shortForm) {
      clipId = enter.shortForm.returnNodeId
      preset = enter.shortForm.paramValues
    } else {
      const close = closeByFrame.get(frame.frameId)
      if (!close || close.returnNodeId === undefined) return null
      if (close.returnNodeId === null) return 'None'
      clipId = close.returnNodeId
      preset = close.returnNames ?? []
    }
    const clip = clipId !== null && clipId !== undefined ? nodeIndex.get(clipId) : undefined
    const rendered = clip ? render(frame.funcDefPath, frame.frameId, clip, preset, uptoStep, openFrames) : null
    if (!rendered) return null
    return enter.inOperator && !rendered.isSingleValue ? `(${rendered.text})` : rendered.text
  }

  const textAt = (uptoStep: number) => {
    const rendered = render(rootPath, 0, expression, [], uptoStep, computeOpenFramesUpTo(trace, uptoStep))
    return rendered ? rendered.text.replace(/\s*\n\s*/g, ' ') : null
  }

  const commentFor = (s: TraceStep) => {
    if (!comments || s.kind !== 'call-enter' || s.shortForm) return null
    const parts: string[] = []
    const decidingIf = ifBranchesByFrame.get(s.frameId)?.at(-1)
    if (decidingIf?.conditionText) parts.push(strings.conditionComment(decidingIf.conditionText, decidingIf.valueText === 'true' ? 'True' : 'False'))
    if (s.hasLocals) parts.push(strings.localsComment)
    return parts.length > 0 ? parts.join('; ') : null
  }

  const first = textAt(steps[0].step - 1)
  if (first === null) return null
  const lines: Array<{ text: string; comment: string | null }> = [{ text: first, comment: null }]
  for (const s of steps) {
    const text = textAt(s.step)
    if (text === null || text === lines[lines.length - 1].text) continue
    lines.push({ text, comment: commentFor(s) })
  }
  const lastStep = trace[trace.length - 1]
  if (errorMessage && lastStep?.kind === 'error' && steps.includes(lastStep)) lines.push({ text: errorMessage, comment: null })

  const written = lines.map((line, index) => ({ text: index === 0 ? line.text : `\u2192 ${line.text}`, comment: line.comment }))
  const commentColumn = Math.max(0, ...written.filter((line) => line.comment !== null).map((line) => line.text.length)) + 4
  return written.map((line) => line.comment === null ? line.text : `${line.text.padEnd(commentColumn)}# ${line.comment}`).join('\n')
}

// Whether buildEvaluationChain has something to export for this step -
// cheap enough to decide on every step whether the copy button is enabled.
export function hasEvaluationChain(trace: TraceStep[], ast: Record<string, AstFile>, nodeIndexByFile: Map<number, AstNode> | undefined, rootPath: string, step: TraceStep): boolean {
  const enterByFrame = new Map<number, TraceStep>()
  for (const s of trace) if (s.kind === 'call-enter') enterByFrame.set(s.frameId, s)
  const statement = rootStatementOf(step, enterByFrame, rootPath, ast[rootPath], nodeIndexByFile)
  return statement !== null && chainExpressionOf(statement) !== null
}
