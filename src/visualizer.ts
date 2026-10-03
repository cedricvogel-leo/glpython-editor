// Shared types and helpers for the step-by-step execution visualizer. The
// worker (public/pyodide-worker.js) runs a small hand-written tree-walking
// interpreter over the student's own ast.parse() tree (real CPython tracing
// APIs never expose values sitting on the internal bytecode evaluation
// stack, so there is no way to observe e.g. "3 * 4" collapsing to "12"
// mid-expression without controlling the evaluator). Each recorded step
// carries the `nodeId` of the exact AST node it corresponds to - the same
// stable id embedded in the AST-as-JSON tree - so the UI can substitute that
// node's original source with the step's computed value inline.

export type TraceStepKind = 'eval' | 'exec' | 'branch' | 'loop-iter' | 'call-enter' | 'call-pending'

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
}

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
  error: string | null
  truncated: boolean
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
      })
    }

    if (step.closesFrameId !== null && step.closesFrameId !== undefined) {
      open.delete(step.closesFrameId)
    }
  }

  return open
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
type MergedInsert = { start: number; end: number; value: string; kind: 'substitution' | 'annotation'; nodeId?: number }

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
): MergedInsert[] {
  const candidates: Array<{ start: number; end: number; value: string; nodeId: number }> = []
  for (const [nodeId, value] of substitutions ?? []) {
    const node = nodeIndex.get(nodeId)
    if (!node) continue
    const range = nodeRange(node, lineOffsets)
    if (!range) continue
    candidates.push({ ...range, value, nodeId })
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

  return [
    ...selected.map((s) => ({ ...s, kind: 'substitution' as const })),
    ...inserts,
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
): { start: number; end: number } | null {
  const range = useHeadOnly ? nodeHeadRange(node, lineOffsets) : nodeRange(node, lineOffsets)
  if (!range) return null
  const merged = buildMergedInserts(lineOffsets, nodeIndex, substitutions, annotations)
  return { start: locateOffset(merged, range.start), end: locateOffset(merged, range.end) }
}

export function applySubstitutions(
  source: string,
  lineOffsets: number[],
  nodeIndex: Map<number, AstNode>,
  substitutions: Map<number, string> | undefined,
  annotations?: Map<number, string>,
): { text: string; highlights: Array<{ start: number; end: number; nodeId?: number }>; annotationHighlights: Array<{ start: number; end: number; nodeId?: number }> } {
  if ((!substitutions || substitutions.size === 0) && (!annotations || annotations.size === 0)) {
    return { text: source, highlights: [], annotationHighlights: [] }
  }

  const merged = buildMergedInserts(lineOffsets, nodeIndex, substitutions, annotations)

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
): { text: string; highlights: Array<{ start: number; end: number; nodeId?: number }>; annotationHighlights: Array<{ start: number; end: number; nodeId?: number }> } | null {
  const { text, highlights, annotationHighlights } = applySubstitutions(source, lineOffsets, nodeIndex, substitutions, annotations)
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
