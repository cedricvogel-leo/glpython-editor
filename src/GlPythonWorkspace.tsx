import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import Editor, { useMonaco } from '@monaco-editor/react'
import type { Monaco } from '@monaco-editor/react'
import { AlertTriangle, BookOpen, Copy, FileCode2, PanelRightClose, PanelRightOpen, Pause, Play, RotateCcw, SkipBack, SkipForward, Sparkles, SquareTerminal, Terminal, Workflow, X } from 'lucide-react'
import { projectImportsGturtle, type Project } from './project'
import { GraphicsWindow, type TurtleCommand } from './GraphicsWindow'
import { buildAnnotationsUpTo, buildEvaluationChain, buildExecutedLinesUpTo, buildLocalsUpTo, buildSubstitutionsUpTo, collapseDeepCallChain, hasEvaluationChain, computeLineOffsets, computeOpenFramesUpTo, indexAstNodes, lineNumberAtOffset, locateNodeRenderedRange, nodeRange, renderFrameSource, substitutionModeSteps, type AstNode, type CollapsedCalls, type OpenFrame, type TraceResult, type TraceStep, type VisualizerMode } from './visualizer'
import { tokenizePythonFragment } from './pyHighlight'

type CoreStrings = {
  exitVisualizer: string
  readyOutput: string
  resetOutput: string
  visualize: string
  visualizing: string
  runProject: string
  running: string
  runningOutput: (mainFile: string) => string
  visualizerTitle: string
  visualizerBeforeStart: string
  visualizerStepOf: (current: number, total: number) => string
  visualizerNoSteps: string
  visualizerRestart: string
  visualizerPrevStep: string
  visualizerPause: string
  visualizerPlay: string
  visualizerNextStep: string
  visualizerAnimate: string
  visualizerError: (message: string) => string
  visualizerTruncated: string
  // Marker replacing the middle of a deep chain of call boxes, e.g.
  // "… 158 more calls of loop(3) …"; `call` is null when the hidden calls
  // are to different functions. Optional so existing hosts keep compiling -
  // an English fallback is used when it's missing.
  visualizerCollapsedCalls?: (count: number, call: string | null) => string
  // Accessible name of the REPL's input line, and the note shown after a
  // "def"/"class" typed into the REPL. Optional like visualizerCollapsedCalls.
  replInputLabel?: string
  replDefinitionHint?: string
  // The visualizer's mode toggle (its group label and the two modes), and
  // the note in a box shown in the substitution mode. Optional, like
  // visualizerCollapsedCalls.
  visualizerModeLabel?: string
  visualizerModeBox?: string
  visualizerModeSubstitution?: string
  visualizerBoxHint?: string
  // The visualizer's "copy the evaluation as a → chain" button, its
  // confirmation, its failure message, the switch for the chain's reason
  // comments, and those comments ("2 == 0 is False", "body with local
  // variables"). Optional, like visualizerCollapsedCalls.
  copyChain?: string
  copyChainDone?: string
  copyChainFailed?: string
  copyChainComments?: string
  chainConditionComment?: (condition: string, value: string) => string
  chainLocalsComment?: string
  // What the variables panel shows for a function, class or module instead
  // of its value (the runtime describes them as "function", "class" and
  // "module"). Real Python values and reprs are never translated.
  valueKindFunction?: string
  valueKindClass?: string
  valueKindModule?: string
  visualizerNoLocals: string
  closeFile: (path: string) => string
  output: string
  pyodideRuntime: string
  runsFile: (mainFile: string) => string
  noOutput: string
  turtleGraphics: string
  gturtleWindow: string
  collapseGraphics: string
  expandGraphics: string
  graphicsEmptyBefore: string
  graphicsEmptyAfter: string
  graphicsCollapsedLabel: string
  inputDialogTitle: string
  inputDialogFallbackPrompt: string
  inputPlaceholder: string
  inputCancel: string
  inputSubmit: string
}

type WorkspaceCapabilities = {
  actions: boolean
  editor: boolean
  exitVisualizer: boolean
  breadcrumbs: boolean
  fileTabs: boolean
  resetOutput: boolean
  visualization: boolean
  graphics: boolean
  // An input line below the output that runs Python in the namespace of the
  // last Run, e.g. to call the file's functions.
  repl: boolean
}

const defaultWorkspaceCapabilities: WorkspaceCapabilities = {
  actions: true,
  editor: true,
  exitVisualizer: true,
  breadcrumbs: true,
  fileTabs: true,
  resetOutput: true,
  visualization: true,
  graphics: true,
  repl: true,
}

type WorkspaceCommand = {
  id: number
  type: 'run' | 'visualize' | 'reset'
}

type GlPythonWorkspaceProps = {
  project: Project
  activeFile: string
  openFiles: string[]
  onOpenFile: (path: string) => void
  onCloseFile: (path: string) => void
  onFileCodeChange: (path: string, code: string) => void
  isGraphicsOpen: boolean
  onGraphicsOpenChange: (open: boolean) => void
  t: CoreStrings
  capabilities?: Partial<WorkspaceCapabilities>
  compact?: boolean
  command?: WorkspaceCommand | null
  // Presets the visualizer's mode (e.g. from a LiaScript block). Without it
  // the mode last chosen in this browser is used, and «substitution» at first.
  visualizerMode?: VisualizerMode
}

const animationsStorageKey = 'glpython-visualizer-animations'
const visualizerModeStorageKey = 'glpython-visualizer-mode'
const chainCommentsStorageKey = 'glpython-chain-comments'

// Copies text to the clipboard, falling back to the older selection-based
// way where the Clipboard API is unavailable or not allowed (e.g. an iframe
// without clipboard permission).
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.appendChild(field)
    field.select()
    try {
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      field.remove()
    }
  }
}

function storedVisualizerMode(): VisualizerMode {
  try {
    return localStorage.getItem(visualizerModeStorageKey) === 'box' ? 'box' : 'substitution'
  } catch {
    return 'substitution'
  }
}

// One REPL input in the transcript below the program's output. `result` is
// filled in once the worker answers: what the input printed, then either its
// value (None included, see _glpython_repl), Python's last error line, or a
// hint that definitions belong in the file.
type ReplEntry = {
  id: number
  source: string
  result: { output: string; value?: string; isNone?: boolean; error?: string; hint?: 'definition' | null } | null
}

// One highlighted (or plain) run of text within a single rendered line of a
// call-frame box - the plain-DOM equivalent of the inline decorations the
// main Monaco editor gets via deltaDecorations, since a box's content isn't
// a real Monaco model. A 'child' segment replaces its call site's own text
// entirely with a further-nested <CallFrameBox>, rendered inline exactly
// where that text sat (see childRanges in buildLineSegments below).
type LineSegment =
  | { kind: 'text'; text: string; className?: string; annotationNodeId?: number }
  | { kind: 'child'; frame: OpenFrame }
  | { kind: 'group'; className: string; parts: Array<{ text: string; className?: string; annotationNodeId?: number }> }

function buildLineSegments(
  line: string,
  lineStart: number,
  // `nodeId`, when present, identifies exactly which AST node (e.g. a Call
  // node that just got substituted with its return value) this particular
  // highlight belongs to - carried through to a `data-annotation-node-id`
  // attribute below, so a connector/flight can anchor at one specific
  // substitution instead of just "the nearest one on this line" (see
  // nextStepReturnFlight's use of it further down).
  highlights: Array<{ start: number; end: number; nodeId?: number }>,
  // `param` marks a call box's "=value" next to a parameter name in its
  // header, which is styled more prominently than a loop variable's.
  annotationHighlights: Array<{ start: number; end: number; nodeId?: number; param?: boolean }>,
  childRanges: Array<{ start: number; end: number; frame: OpenFrame }>,
  nextStepRanges: Array<{ start: number; end: number }>,
  // The same box-drawing is reused for the failing node at an 'error' step
  // (which has no next step), just with its own class.
  nextStepClassName = 'visual-next-step',
): LineSegment[] {
  const lineEnd = lineStart + line.length
  // A child's own call-site range replaces its text wholesale, so any
  // highlight/annotation mark that falls entirely inside one (e.g. the
  // substituted "2" inside "fact(2)", while that call itself is still open
  // and rendered as a nested box, not yet collapsed into a plain value) is
  // dropped here - otherwise it would be re-inserted as leftover text after
  // the child segment already consumed that whole range.
  const insideChild = (start: number, end: number) => childRanges.some((c) => start >= c.start && end <= c.end)
  // `nextStep` is tracked as its own flag (rather than folded straight into
  // `className`) so that touching next-step marks can later be detected and
  // merged into one continuous box instead of leaving every mark to draw
  // its own outline - see the grouping pass below.
  const marks: Array<{ start: number; end: number; className?: string; frame?: OpenFrame; nextStep?: boolean; annotationNodeId?: number }> = []
  for (const h of highlights) {
    if (insideChild(h.start, h.end)) continue
    const start = Math.max(h.start, lineStart)
    const end = Math.min(h.end, lineEnd)
    if (start < end) marks.push({ start: start - lineStart, end: end - lineStart, className: 'visual-substituted-value', annotationNodeId: h.nodeId })
  }
  for (const h of annotationHighlights) {
    if (insideChild(h.start, h.end)) continue
    const start = Math.max(h.start, lineStart)
    const end = Math.min(h.end, lineEnd)
    if (start < end) marks.push({ start: start - lineStart, end: end - lineStart, className: h.param ? 'visual-param-annotation' : 'visual-loop-annotation', annotationNodeId: h.nodeId })
  }
  for (const c of childRanges) {
    const start = Math.max(c.start, lineStart)
    const end = Math.min(c.end, lineEnd)
    if (start < end) marks.push({ start: start - lineStart, end: end - lineStart, frame: c.frame })
  }
  // The exact AST node the *next* trace step (not yet applied, since
  // rendering is always clamped to uptoStep) is about to evaluate/execute -
  // a preview of what's about to change, distinct from the dimmer
  // already-executed/current-line treatment above. It can partially overlap
  // an already-substituted/annotated sub-range (e.g. "3 <= 1" where "3" was
  // substituted by an earlier step but the comparison itself is what's next)
  // - that overlapping portion is still part of the box, so instead of
  // carving it out we just add the next-step class alongside its existing
  // one. Child-frame boxes are the one exception: they render as their own
  // nested component with no text span to attach a class to, so they're
  // carved out (and the whole range is skipped if it sits entirely inside
  // one, via the insideChild check below).
  const existingMarks = marks.slice()
  for (const r of nextStepRanges) {
    if (insideChild(r.start, r.end)) continue
    const start = Math.max(r.start, lineStart) - lineStart
    const end = Math.min(r.end, lineEnd) - lineStart
    if (start >= end) continue
    let cursor = start
    for (const m of existingMarks) {
      const mStart = Math.max(m.start, cursor)
      const mEnd = Math.min(m.end, end)
      if (mStart >= mEnd) continue
      if (m.frame) {
        if (mStart > cursor) marks.push({ start: cursor, end: mStart, nextStep: true })
        cursor = Math.max(cursor, mEnd)
        continue
      }
      if (mStart > cursor) marks.push({ start: cursor, end: mStart, nextStep: true })
      m.nextStep = true
      cursor = Math.max(cursor, mEnd)
    }
    if (cursor < end) marks.push({ start: cursor, end, nextStep: true })
  }
  marks.sort((a, b) => a.start - b.start)

  // Touching next-step marks (e.g. an already-substituted "3" directly
  // followed by the plain "<= 1" that completes "3 <= 1") are merged into a
  // single group here so they render as one continuous highlighted box
  // instead of two dashed outlines meeting at a seam. Child-frame marks
  // never participate - they're their own nested component, not text.
  const grouped: Array<{ start: number; end: number; className?: string; frame?: OpenFrame; nextStep?: boolean; annotationNodeId?: number; parts?: Array<{ start: number; end: number; className?: string; annotationNodeId?: number }> }> = []
  for (const mark of marks) {
    const prev = grouped[grouped.length - 1]
    if (mark.nextStep && !mark.frame && prev && prev.nextStep && !prev.frame && prev.end === mark.start) {
      if (!prev.parts) prev.parts = [{ start: prev.start, end: prev.end, className: prev.className, annotationNodeId: prev.annotationNodeId }]
      prev.parts.push({ start: mark.start, end: mark.end, className: mark.className, annotationNodeId: mark.annotationNodeId })
      prev.end = mark.end
      continue
    }
    grouped.push({ ...mark })
  }

  const segments: LineSegment[] = []
  let cursor2 = 0
  for (const mark of grouped) {
    if (mark.start > cursor2) segments.push({ kind: 'text', text: line.slice(cursor2, mark.start) })
    if (mark.frame) {
      segments.push({ kind: 'child', frame: mark.frame })
    } else if (mark.parts) {
      segments.push({ kind: 'group', className: nextStepClassName, parts: mark.parts.map((p) => ({ text: line.slice(p.start, p.end), className: p.className, annotationNodeId: p.annotationNodeId })) })
    } else {
      const className = mark.nextStep ? (mark.className ? `${mark.className} ${nextStepClassName}` : nextStepClassName) : mark.className
      segments.push({ kind: 'text', text: line.slice(mark.start, mark.end), className, annotationNodeId: mark.annotationNodeId })
    }
    cursor2 = mark.end
  }
  if (cursor2 < line.length || segments.length === 0) segments.push({ kind: 'text', text: line.slice(cursor2) })
  return segments
}

// A plain (un-substituted, un-annotated) run of source text is further
// split into syntax-colored runs here, using Monaco's own standalone Python
// tokenizer - so highlighting stays consistent with the real editor without
// a separate highlighting library. Substituted-value/annotation spans keep
// their own dedicated color instead (see the `className` branch below) and
// are never re-tokenized.
function TextSegment({ segment, monaco }: { segment: Extract<LineSegment, { kind: 'text' }>; monaco: Monaco | null }) {
  if (segment.className || !monaco || segment.text === '') return <span className={segment.className} data-annotation-node-id={segment.annotationNodeId}>{segment.text}</span>
  const runs = tokenizePythonFragment(monaco, segment.text)
  return <>{runs.map((run, index) => <span key={index} className={run.className}>{run.text}</span>)}</>
}

// Which source span a Frame renders: the outermost module/global scope
// (the whole file, no single AST node to clip to) or one open user-defined
// function call (clipped to its own "def foo(...):" node).
// A third kind, 'inline', is a call shown in the substitution mode: just its
// return expression (see ShortForm), rendered as plain text at the call site
// rather than as a box.
type FrameScope =
  | { kind: 'module' }
  | { kind: 'call'; funcDefNodeId: number }
  | { kind: 'inline'; returnNodeId: number; parens: boolean }

// Where an inline (substitution-mode) call shows up as a line: the nearest
// enclosing box or module frame, and the lines of the outermost inline call
// in it - that line is highlighted while the call runs and gets the error
// message if the call fails, since inline text has no lines of its own.
type InlineHost = { frameId: number; path: string; line: number; endLine: number }

type FrameProps = {
  frameId: number
  path: string
  scope: FrameScope
  openFrames: Map<number, OpenFrame>
  nodeIndexByFile: Map<string, Map<number, AstNode>>
  visualSources: Record<string, string>
  trace: TraceStep[]
  uptoStep: number
  currentStep: TraceStep | null
  nextStep: TraceStep | null
  monaco: Monaco | null
  noLocalsLabel: string
  // The runtime's "function" / "class" / "module" descriptions mapped to
  // the UI language; any other value is shown exactly as Python wrote it.
  valueKindLabels: Record<string, string>
  // A name about to be assigned/defined by `nextStep` (a plain `x = ...`
  // or `def f(...):`) that doesn't exist in this frame's locals yet - shown
  // one step early as a valueless placeholder row, so an arrow can point
  // from the upcoming value/def in the code to where it's about to land.
  declareTarget: { frameId: number; varName: string } | null
  // Parameter names of a user-defined function call about to start running
  // (`nextStep.kind === 'call-enter'`) that don't have values yet - shown
  // one step early as valueless placeholder rows in that about-to-open
  // callee frame (itself already spliced in early via `openFrames`, see
  // `framesForRender`/`nextStepPendingCall`), so an arrow can point from
  // each argument's value at the call site into its own placeholder row.
  pendingCallLocals: { frameId: number; paramNames: string[] } | null
  // The trace's final 'error' step, only while it's the current step: its
  // node is marked red in its frame, with the message right below that line.
  errorStep: TraceStep | null
  // See collapseDeepCallChain - where the middle of a deep chain of boxes is
  // replaced by a marker, and the marker's text.
  collapsedCalls: CollapsedCalls | null
  collapsedCallsLabel: string
  // The visualizer's substitution mode, and the note shown in the outermost
  // box that's still drawn as a box in it (`insideBox` is false there).
  substitutionMode: boolean
  boxHint: string
  insideBox: boolean
  // Set on an inline call that the next step (or the error) covers as a
  // whole, since it isn't text in its parent's line to mark directly.
  inlineMarkClass?: string
  activeHost: InlineHost | null
  errorHost: InlineHost | null
}

// Renders one frame of execution - either the outermost module/global scope
// or one open user-defined function call anchored at its call site - as
// plain HTML driven directly by the trace/AST, instead of as Monaco overlay
// machinery. Every frame, however deeply nested, shares the exact same
// layout: its own source (with computed values substituted inline and its
// own current line highlighted) on the left, a thin divider, and its own
// variables panel on the right - all scoped to this exact invocation via
// its unique frame id, so recursive calls to the same function never mix up
// each other's displayed state. Any further-nested open call inside this
// frame's body renders its own Frame recursively, inline, right at its own
// call site - real DOM in normal flow, so surrounding text/lines reflow
// automatically.
function Frame(props: FrameProps) {
  const { frameId, path, scope, openFrames, nodeIndexByFile, visualSources, trace, uptoStep, currentStep, nextStep, monaco, noLocalsLabel, valueKindLabels, declareTarget, pendingCallLocals, errorStep, collapsedCalls, collapsedCallsLabel, substitutionMode, boxHint, insideBox, inlineMarkClass, activeHost, errorHost } = props
  const nodeIndex = nodeIndexByFile.get(path)
  const source = visualSources[path]
  if (!nodeIndex || source === undefined) return null

  const lineOffsets = computeLineOffsets(source)
  let clipRange: { start: number; end: number } | null = null
  if (scope.kind !== 'module') {
    const clipNode = nodeIndex.get(scope.kind === 'call' ? scope.funcDefNodeId : scope.returnNodeId)
    if (!clipNode) return null
    clipRange = nodeRange(clipNode, lineOffsets)
    if (!clipRange) return null
  }
  const startLine = lineNumberAtOffset(lineOffsets, clipRange?.start ?? 0)

  const openFrame = frameId !== 0 ? openFrames.get(frameId) : undefined
  let substitutions = buildSubstitutionsUpTo(trace, uptoStep, frameId).get(path)
  // An inline call shows every parameter already replaced by its value.
  if (scope.kind === 'inline' && openFrame?.shortForm) {
    substitutions = new Map([...openFrame.shortForm.paramValues, ...(substitutions ?? [])])
  }
  const annotations = new Map(buildAnnotationsUpTo(trace, uptoStep, frameId).get(path) ?? [])
  // A box's header shows each parameter's value ("def f(n=3):"); an inline
  // call has no header, its parameters are already replaced by their values.
  if (openFrame && scope.kind !== 'inline') for (const [nodeId, text] of openFrame.paramAnnotations) annotations.set(nodeId, text)
  const paramNodeIds = new Set(openFrame?.paramAnnotations.map(([nodeId]) => nodeId))

  const rendered = renderFrameSource(source, lineOffsets, nodeIndex, clipRange, substitutions, annotations)
  if (!rendered) return null
  // Must match how renderFrameSource placed the substitutions.
  const substitutionContext = { source, limit: clipRange }

  const executedLines = buildExecutedLinesUpTo(trace, uptoStep, frameId, nodeIndexByFile).get(path)

  const children = [...openFrames.values()].filter((f) => f.parentFrameId === frameId)
  const isFrameActive = currentStep?.frameId === frameId
  const clipStart = clipRange?.start ?? 0

  // Every further-nested open call inside this frame's own body, mapped to
  // where its own call-site text (e.g. "fact(2)") ends up within this
  // frame's *own* rendered text (already-clipped to clipRange, exactly
  // matching rendered.text's coordinates) - so it can be spliced inline,
  // replacing that text, instead of appended as a separate row below it.
  // This includes a call whose own call hasn't actually started yet (the
  // one-step-early preview frame from `nextStepPendingCall`) - its call
  // site is swallowed just like any other child's, since the substituted
  // value it would have shown is instead rendered one step early inside
  // its own box's header (see nextStepPendingCall/paramAnnotations).
  const childRanges: Array<{ start: number; end: number; frame: OpenFrame }> = []
  for (const child of children) {
    const anchorNode = child.anchorPath === path ? nodeIndex.get(child.anchorNodeId) : undefined
    if (!anchorNode) continue
    const range = locateNodeRenderedRange(lineOffsets, nodeIndex, substitutions, annotations, anchorNode, false, substitutionContext)
    if (!range) continue
    childRanges.push({ start: range.start - clipStart, end: range.end - clipStart, frame: child })
  }

  // The AST node the *next* trace step (uptoStep + 1) will touch, if that
  // step belongs to this exact frame - so the learner can see exactly the
  // span of code that's about to be mutated/replaced before clicking
  // "next" (e.g. just the one name about to be substituted, or the one
  // sub-expression about to be reduced to its result). A "call-enter" step
  // is special: its own frameId is the *new* callee frame (which doesn't
  // exist as an open Frame yet), while its nodeId/path describe the
  // call-site sitting in the *caller* frame instead - so it's matched
  // against parentFrameId.
  const nextStepFrameId = nextStep == null ? null : nextStep.kind === 'call-enter' ? (nextStep.parentFrameId ?? 0) : nextStep.frameId
  const nextStepRanges = nextStep !== null && nextStepFrameId === frameId && nextStep.path === path
    ? (() => {
        const nextNode = nodeIndex.get(nextStep.nodeId)
        if (!nextNode) return []
        const range = locateNodeRenderedRange(lineOffsets, nodeIndex, substitutions, annotations, nextNode, true, substitutionContext)
        if (!range) return []
        return [{ start: range.start - clipStart, end: range.end - clipStart }]
      })()
    : []

  const isErrorFrame = errorStep !== null && errorStep.frameId === frameId && errorStep.path === path
  const errorRanges = isErrorFrame
    ? (() => {
        const errorNode = nodeIndex.get(errorStep.nodeId)
        if (!errorNode) return []
        const range = locateNodeRenderedRange(lineOffsets, nodeIndex, substitutions, annotations, errorNode, false, substitutionContext)
        if (!range) return []
        const start = range.start - clipStart
        const end = range.end - clipStart
        // An inline call failing in its "return" statement itself marks its
        // whole expression - that's all of the statement it shows.
        if (scope.kind === 'inline' && (start < 0 || end > rendered.text.length)) return [{ start: 0, end: rendered.text.length }]
        return [{ start, end }]
      })()
    : []

  const isModule = scope.kind === 'module'
  const annotationHighlights = rendered.annotationHighlights.map((h) => ({ ...h, param: h.nodeId !== undefined && paramNodeIds.has(h.nodeId) }))
  const lines = rendered.text.split('\n')
  let cursor = 0
  const localEntries: Array<[string, string | null]> = Object.entries(buildLocalsUpTo(trace, uptoStep, frameId))
  if (declareTarget && declareTarget.frameId === frameId && !localEntries.some(([name]) => name === declareTarget.varName)) {
    localEntries.push([declareTarget.varName, null])
  }
  if (pendingCallLocals && pendingCallLocals.frameId === frameId) {
    for (const paramName of pendingCallLocals.paramNames) {
      if (!localEntries.some(([name]) => name === paramName)) localEntries.push([paramName, null])
    }
  }

  // Children of a box (or of an inline call inside one) are inside a box.
  const childFrameProps = { openFrames, nodeIndexByFile, visualSources, trace, uptoStep, currentStep, nextStep, monaco, noLocalsLabel, valueKindLabels, declareTarget, pendingCallLocals, errorStep, collapsedCalls, collapsedCallsLabel, substitutionMode, boxHint, activeHost, errorHost, insideBox: insideBox || scope.kind === 'call' }
  const markedRanges = errorRanges.length > 0 ? errorRanges : nextStepRanges
  const inlineMarkFor = (frame: OpenFrame) => {
    const range = childRanges.find((child) => child.frame.frameId === frame.frameId)
    if (!range || !markedRanges.some((marked) => marked.start <= range.start && marked.end >= range.end)) return undefined
    return errorRanges.length > 0 ? 'visual-error-node' : 'visual-next-step'
  }
  const renderSegments = (segments: LineSegment[]) => segments.map((segment, segmentIndex) => segment.kind === 'child' && collapsedCalls?.firstHiddenFrameId === segment.frame.frameId ? (
    <span key={segmentIndex} className="frame-child-zone">
      <span className="frame-collapsed-calls">
        <span className="frame-collapsed-calls-label">{collapsedCallsLabel}</span>
        <Frame
          key={collapsedCalls.resumeFrame.frameId}
          frameId={collapsedCalls.resumeFrame.frameId}
          path={collapsedCalls.resumeFrame.funcDefPath}
          scope={{ kind: 'call', funcDefNodeId: collapsedCalls.resumeFrame.funcDefNodeId }}
          {...childFrameProps}
          insideBox
        />
      </span>
    </span>
  ) : segment.kind === 'child' && substitutionMode && segment.frame.shortForm ? (
    <Frame
      key={segmentIndex}
      frameId={segment.frame.frameId}
      path={segment.frame.funcDefPath}
      scope={{ kind: 'inline', returnNodeId: segment.frame.shortForm.returnNodeId, parens: segment.frame.shortForm.parens }}
      inlineMarkClass={inlineMarkFor(segment.frame)}
      {...childFrameProps}
    />
  ) : segment.kind === 'child' ? (
    <span key={segmentIndex} className="frame-child-zone">
      <Frame
        frameId={segment.frame.frameId}
        path={segment.frame.funcDefPath}
        scope={{ kind: 'call', funcDefNodeId: segment.frame.funcDefNodeId }}
        {...childFrameProps}
      />
    </span>
  ) : segment.kind === 'group' ? (
    <span key={segmentIndex} className={segment.className}>
      {segment.parts.map((part, partIndex) => <span key={partIndex} className={part.className} data-annotation-node-id={part.annotationNodeId}>{part.text}</span>)}
    </span>
  ) : (
    <TextSegment key={segmentIndex} segment={segment} monaco={monaco} />
  ))
  const lineSegments = (line: string, lineStart: number) => errorRanges.length > 0
    ? buildLineSegments(line, lineStart, rendered.highlights, annotationHighlights, childRanges, errorRanges, 'visual-error-node')
    : buildLineSegments(line, lineStart, rendered.highlights, annotationHighlights, childRanges, nextStepRanges)

  if (scope.kind === 'inline') {
    // Parentheses only while the expression hasn't become a single value yet.
    const returnNode = nodeIndex.get(scope.returnNodeId)
    const isSingleValue = substitutions?.has(scope.returnNodeId) === true || returnNode?.type === 'Constant'
    const parens = scope.parens && !isSingleValue
    return (
      <span className={`frame-inline${inlineMarkClass ? ` ${inlineMarkClass}` : ''}`} data-inline-frame-id={frameId}>
        {parens && '('}
        {lines.map((line, index) => {
          const lineStart = cursor
          cursor += line.length + 1
          return <Fragment key={index}>{index > 0 && '\n'}{renderSegments(lineSegments(line, lineStart))}</Fragment>
        })}
        {parens && ')'}
      </span>
    )
  }

  const showBoxHint = substitutionMode && scope.kind === 'call' && !insideBox
  return (
    <div className={`frame-box${isModule ? ' frame-box--root' : ''}`} data-frame-id={frameId}>
      <div className="frame-code">
        {lines.map((line, index) => {
          const lineStart = cursor
          cursor += line.length + 1
          const absoluteLine = startLine + index
          const isHostLine = (host: InlineHost | null, hostLine: 'line' | 'endLine') => host !== null && host.frameId === frameId && host.path === path && host[hostLine] === absoluteLine
          const isCurrentLine = (isFrameActive && currentStep?.line === absoluteLine) || isHostLine(activeHost, 'line')
          const isExecutedLine = !isCurrentLine && executedLines?.has(absoluteLine) === true
          const isErrorLine = isCurrentLine && (isErrorFrame || isHostLine(errorHost, 'line'))
          const lineStateClass = isErrorLine ? ' visual-current-line visual-error-line' : isCurrentLine ? ' visual-current-line' : isExecutedLine ? ' visual-executed-line' : ''
          const content = renderSegments(lineSegments(line, lineStart))
          // Python's own message for the failing node, directly below the
          // last line of that node (or of the inline call it failed in).
          const errorMessage = errorStep !== null && ((isErrorFrame && errorStep.endLine === absoluteLine) || isHostLine(errorHost, 'endLine'))
            ? <div className="visual-error-message" role="alert">{errorStep.label}</div>
            : null
          // Only the outermost module frame shows a line-number gutter,
          // matching how Monaco only ever showed line numbers for the main
          // editor and never inside a nested box. The gutter number lives
          // in the same row as its line's content (rather than a separate
          // fixed-height column) so it still lines up correctly even when
          // an embedded nested frame makes that one logical line visually
          // taller than a plain line of text.
          if (isModule) {
            return (
              <Fragment key={index}>
                <div className={`frame-line-row${lineStateClass}`}>
                  <span className="frame-gutter-num">{absoluteLine}</span>
                  <div className={`frame-line${lineStateClass}`}>{content}</div>
                </div>
                {errorMessage && <div className="frame-line-row"><span className="frame-gutter-num" />{errorMessage}</div>}
              </Fragment>
            )
          }
          return (
            <Fragment key={index}>
              <div className={`frame-line${lineStateClass}`}>{content}</div>
              {errorMessage}
            </Fragment>
          )
        })}
        {showBoxHint && <div className="frame-hint">{boxHint}</div>}
      </div>
      <div className="frame-divider" />
      <div className="frame-vars">
        {localEntries.length > 0
          ? localEntries.map(([name, value]) => <div className="locals-row" key={name} data-name={name}><span className="locals-name">{name}</span><span className={`locals-value${value === null ? ' locals-value-pending' : ''}`} key={value ?? 'pending'}>{value === null ? '\u2026' : valueKindLabels[value] ?? value}</span></div>)
          : <p className="frame-vars-empty">{noLocalsLabel}</p>}
      </div>
    </div>
  )
}

// An element's position within the visualizer canvas, from layout offsets
// rather than getBoundingClientRect: a box that just opened is still scaled
// down by its "visual-frame-grow" animation when it's measured.
function canvasOffset(element: HTMLElement, canvas: HTMLElement): { left: number; top: number } {
  let left = 0
  let top = 0
  for (let node: HTMLElement | null = element; node && node !== canvas; node = node.offsetParent as HTMLElement | null) {
    left += node.offsetLeft
    top += node.offsetTop
  }
  return { left, top }
}

function ReplTranscriptEntry({ entry, definitionHint }: { entry: ReplEntry; definitionHint: string }) {
  const result = entry.result
  const printed = result?.output.replace(/\n$/, '')
  return (
    <span className="repl-entry">
      <span className="repl-echo">{'>>> '}{entry.source}</span>
      {printed && <span>{printed}</span>}
      {result?.value !== undefined && <span className={result.isNone ? 'repl-value repl-value--none' : 'repl-value'}>{result.value}</span>}
      {result?.error && <span className="output-error">{result.error}</span>}
      {result?.hint === 'definition' && <span className="repl-hint">{definitionHint}</span>}
    </span>
  )
}

function GlPythonWorkspace(props: GlPythonWorkspaceProps) {
  const {
    project,
    activeFile,
    openFiles,
    onOpenFile,
    onCloseFile,
    onFileCodeChange,
    isGraphicsOpen,
    onGraphicsOpenChange,
    t,
    capabilities,
    compact = false,
    command = null,
    visualizerMode: visualizerModePreset,
  } = props
  const workspaceCapabilities = { ...defaultWorkspaceCapabilities, ...capabilities }
  const [output, setOutput] = useState(() => t.readyOutput)
  const [graphics, setGraphics] = useState<TurtleCommand[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [inputRequest, setInputRequest] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [isVisualizerLoading, setIsVisualizerLoading] = useState(false)
  const [visualTrace, setVisualTrace] = useState<TraceResult | null>(null)
  const [visualSources, setVisualSources] = useState<Record<string, string>>({})
  // -1 is the "before execution" state - nothing substituted, no output, no
  // locals, no current line highlighted - shown right after a trace loads
  // and reachable again via restart/stepping back from the first step.
  const [visualStepIndex, setVisualStepIndex] = useState(-1)
  const [isVisualPlaying, setIsVisualPlaying] = useState(false)
  // Whether step transitions (highlight/background fades, new frames and
  // local rows easing in, value-change flashes) are animated or applied
  // instantly - persisted like the locale choice, defaulting to on.
  const [animationsEnabled, setAnimationsEnabled] = useState<boolean>(() => localStorage.getItem(animationsStorageKey) !== 'false')
  const [visualizerMode, setVisualizerMode] = useState<VisualizerMode>(() => visualizerModePreset ?? storedVisualizerMode())
  const [chainComments, setChainComments] = useState<boolean>(() => {
    try { return localStorage.getItem(chainCommentsStorageKey) !== 'false' } catch { return true }
  })
  const [chainFeedback, setChainFeedback] = useState<'copied' | 'failed' | null>(null)
  const substitutionMode = visualizerMode === 'substitution'
  const valueKindLabels = useMemo(() => ({
    function: t.valueKindFunction ?? 'function',
    class: t.valueKindClass ?? 'class',
    module: t.valueKindModule ?? 'module',
  }), [t])
  const [replEntries, setReplEntries] = useState<ReplEntry[]>([])
  // Every submitted or visualized input, oldest first, for arrow up/down.
  // Unlike the transcript it survives a Run.
  const [replHistory, setReplHistory] = useState<string[]>([])
  const [replHistoryIndex, setReplHistoryIndex] = useState<number | null>(null)
  const [replInput, setReplInput] = useState('')
  const [isReplBusy, setIsReplBusy] = useState(false)
  const replIdRef = useRef(0)
  const replSourcesRef = useRef(new Map<number, string>())
  const outputRef = useRef<HTMLPreElement | null>(null)
  // Set while the visualizer shows a REPL input rather than a project file:
  // the path its own pseudo-file is traced under (see REPL_PATH in the worker).
  const [visualRootPath, setVisualRootPath] = useState<string | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const inputFieldRef = useRef<HTMLInputElement | null>(null)
  // Monaco's own namespace, obtained independent of whether any <Editor> is
  // currently mounted (it loads/caches lazily the first time any component
  // asks for it) - used only to run its standalone Python tokenizer for
  // syntax coloring in the plain-HTML visualizer view below; the real
  // Monaco <Editor> for normal editing is untouched by any of this.
  const monaco = useMonaco()
  // Scrollable container for the plain-HTML visualizer view, used to keep
  // the currently executing line in view as steps advance (see the
  // auto-scroll effect below) with ordinary DOM scrolling instead of
  // Monaco's view-zone/content-widget machinery.
  const visualizerScrollRef = useRef<HTMLDivElement | null>(null)
  const visualizerCanvasRef = useRef<HTMLDivElement | null>(null)
  const inputChannelRef = useRef<{ control: Int32Array; payload: Uint8Array } | null>(null)
  const selectedFile = project.files[activeFile] ?? project.files[project.mainFile]
  const stringsRef = useRef(t)
  stringsRef.current = t

  useEffect(() => {
    localStorage.setItem(animationsStorageKey, String(animationsEnabled))
  }, [animationsEnabled])

  useEffect(() => {
    const worker = new Worker(new URL('./pyodide-worker.js', import.meta.url))
    worker.onmessage = (event: MessageEvent<{ type: string; output?: string; graphics?: TurtleCommand[]; prompt?: string; id?: number; value?: string; isNone?: boolean; hint?: 'definition' | null; rootPath?: string; sources?: Record<string, string> } & Partial<TraceResult>>) => {
      const currentTranslation = stringsRef.current
      if (event.data.type === 'ready') setOutput(currentTranslation.readyOutput)
      if (event.data.type === 'result' || event.data.type === 'error') { setOutput(event.data.output || currentTranslation.noOutput); setGraphics(event.data.graphics ?? []); setIsRunning(false) }
      if (event.data.type === 'input_request') { setInputValue(''); setInputRequest(event.data.prompt ?? '') }
      if (event.data.type === 'repl-result') {
        const { id = -1, output = '', value, isNone, error, hint, graphics } = event.data
        const result = { output, value, isNone, error: error ?? undefined, hint }
        // A visualized input that doesn't parse comes back here too, and has
        // no transcript entry yet.
        setReplEntries((entries) => entries.some((entry) => entry.id === id)
          ? entries.map((entry) => entry.id === id ? { ...entry, result } : entry)
          : [...entries, { id, source: replSourcesRef.current.get(id) ?? '', result }])
        replSourcesRef.current.delete(id)
        if (graphics) setGraphics(graphics)
        setIsReplBusy(false)
        setIsVisualizerLoading(false)
      }
      if (event.data.type === 'trace-result') {
        setIsVisualizerLoading(false)
        setVisualRootPath(event.data.rootPath ?? null)
        if (event.data.sources) setVisualSources(event.data.sources)
        setVisualTrace(event.data as TraceResult)
        setVisualStepIndex(-1)
        setIsVisualPlaying(false)
      }
    }
    if (typeof SharedArrayBuffer !== 'undefined') {
      const buffer = new SharedArrayBuffer(8 + 4096)
      const control = new Int32Array(buffer, 0, 2)
      const payload = new Uint8Array(buffer, 8)
      inputChannelRef.current = { control, payload }
      worker.postMessage({ type: 'init-input-channel', buffer })
    }
    workerRef.current = worker
    return () => worker.terminate()
  }, [])

  useEffect(() => {
    if (inputRequest !== null) inputFieldRef.current?.focus()
  }, [inputRequest])

  const respondToInput = (cancelled: boolean) => {
    const channel = inputChannelRef.current
    if (channel) {
      const encoded = cancelled ? new Uint8Array(0) : new TextEncoder().encode(inputValue).slice(0, channel.payload.length)
      channel.payload.fill(0)
      channel.payload.set(encoded)
      Atomics.store(channel.control, 1, encoded.length)
      Atomics.store(channel.control, 0, cancelled ? 3 : 2)
      Atomics.notify(channel.control, 0)
    }
    setInputRequest(null)
    setInputValue('')
  }

  const updateCode = (code: string | undefined) => {
    onFileCodeChange(activeFile, code ?? '')
  }
  const runCode = () => {
    if (!workerRef.current) return
    if (workspaceCapabilities.graphics && projectImportsGturtle(project)) onGraphicsOpenChange(true)
    setIsRunning(true); setOutput(t.runningOutput(project.mainFile)); setReplEntries([])
    workerRef.current.postMessage({
      type: 'run',
      project: {
        mainFile: project.mainFile,
        files: Object.fromEntries(Object.entries(project.files).map(([path, file]) => [path, file.code])),
      },
    })
  }
  const runVisualize = () => {
    if (!workerRef.current) return
    if (workspaceCapabilities.graphics && projectImportsGturtle(project)) onGraphicsOpenChange(true)
    setIsVisualizerLoading(true)
    setIsVisualPlaying(false)
    const sources = Object.fromEntries(Object.entries(project.files).map(([path, file]) => [path, file.code]))
    setVisualSources(sources)
    workerRef.current.postMessage({
      type: 'run-visual',
      project: { mainFile: project.mainFile, files: sources },
    })
  }
  const exitVisualizer = () => {
    setVisualTrace(null)
    setIsVisualPlaying(false)
    setVisualStepIndex(-1)
    setVisualRootPath(null)
  }
  const rememberReplInput = (source: string) => {
    setReplHistory((history) => history[history.length - 1] === source ? history : [...history, source])
    setReplHistoryIndex(null)
    setReplInput('')
    const id = ++replIdRef.current
    replSourcesRef.current.set(id, source)
    return id
  }
  const submitRepl = () => {
    const source = replInput
    if (!workerRef.current || !source.trim() || isRunning || isReplBusy) return
    if (visualTrace) exitVisualizer()
    const id = rememberReplInput(source)
    setReplEntries((entries) => [...entries, { id, source, result: null }])
    setIsReplBusy(true)
    workerRef.current.postMessage({ type: 'repl', id, source })
  }
  // Traces the input against the REPL's namespace without running it in
  // there (see _glpython_run_visual_repl), so it adds no transcript entry.
  const visualizeRepl = () => {
    const source = replInput
    if (!workerRef.current || !source.trim() || isRunning || isReplBusy || isVisualizerLoading) return
    const id = rememberReplInput(source)
    setIsVisualizerLoading(true)
    setIsVisualPlaying(false)
    workerRef.current.postMessage({ type: 'run-visual-repl', id, source })
  }
  const handleReplKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowUp' && replHistory.length > 0) {
      event.preventDefault()
      const index = replHistoryIndex === null ? replHistory.length - 1 : Math.max(0, replHistoryIndex - 1)
      setReplHistoryIndex(index)
      setReplInput(replHistory[index])
    } else if (event.key === 'ArrowDown' && replHistoryIndex !== null) {
      event.preventDefault()
      const index = replHistoryIndex + 1
      setReplHistoryIndex(index < replHistory.length ? index : null)
      setReplInput(index < replHistory.length ? replHistory[index] : '')
    }
  }
  useEffect(() => {
    const element = outputRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [replEntries])
  useEffect(() => {
    if (!command) return
    // A host's run ends a visualization, so the program's own output shows
    // instead of the visualized run's.
    if (command.type === 'run') {
      exitVisualizer()
      runCode()
    }
    if (command.type === 'visualize') runVisualize()
    if (command.type === 'reset') {
      exitVisualizer()
      setReplEntries([])
      setOutput(t.readyOutput)
      setGraphics([])
    }
    // Commands are immutable events. Their id, rather than render-time callback
    // identities, determines whether the effect should run again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command?.id])
  const isVisualizing = visualTrace !== null
  // The steps the scrubber and the step buttons move through: every step of
  // the trace in the box mode, only the visible substitutions in the
  // substitution mode (see substitutionModeSteps). Rendering always replays
  // the whole trace up to the current step's own step number.
  const visualTraceSteps = useMemo(
    () => !visualTrace ? [] : substitutionMode ? substitutionModeSteps(visualTrace.trace) : visualTrace.trace,
    [visualTrace, substitutionMode],
  )
  // Lower bound of -1 is the "before execution" state; upper bound is the
  // last recorded step (or -1 itself if no steps were recorded at all).
  const clampedStepIndex = Math.min(Math.max(visualStepIndex, -1), Math.max(0, visualTraceSteps.length - 1))
  const currentTraceStep = visualTraceSteps[clampedStepIndex] ?? null
  // The step that will run next if the learner clicks "next" - previewed
  // via highlighting its AST span, including before any step has run yet
  // (clampedStepIndex === -1), so the very first statement is shown too.
  const nextTraceStep = visualTraceSteps[clampedStepIndex + 1] ?? null
  // A run that failed ends in one 'error' step (see TraceStepKind). The
  // visualizer still starts before the first step, so learners step towards
  // the failure; the scrubber marks where it is.
  const lastTraceStep = visualTraceSteps[visualTraceSteps.length - 1]
  const errorTraceStep = lastTraceStep?.kind === 'error' ? lastTraceStep : null
  const isAtErrorStep = errorTraceStep !== null && currentTraceStep === errorTraceStep
  const visualStdout = visualTrace?.output.slice(0, currentTraceStep?.stdoutLen ?? 0) ?? ''

  const astIndexByFile = useMemo(() => {
    const map = new Map<string, ReturnType<typeof indexAstNodes>>()
    if (visualTrace) for (const [path, file] of Object.entries(visualTrace.ast)) map.set(path, indexAstNodes(file))
    return map
  }, [visualTrace])

  // When the pending next step is a bare variable read (e.g. "n" about to
  // be looked up and substituted by its current value), note which frame
  // and name it reads from - so an arrow can be drawn from that variable's
  // row in the locals panel to the highlighted "n" in the code, making the
  // upcoming substitution concrete instead of implicit.
  const nextStepVarSource = useMemo(() => {
    if (!nextTraceStep) return null
    const node = astIndexByFile.get(nextTraceStep.path)?.get(nextTraceStep.nodeId)
    if (!node || node.type !== 'Name') return null
    const frameId = nextTraceStep.kind === 'call-enter' ? (nextTraceStep.parentFrameId ?? 0) : nextTraceStep.frameId
    return { frameId, varName: node.summary }
  }, [nextTraceStep, astIndexByFile])

  // When the pending next step is a plain "x = ..." assignment or a
  // "def f(...):" that's about to bind a name this frame doesn't have yet,
  // note which frame and name it's about to create - so that name can be
  // shown one step early as a valueless placeholder row (see Frame's
  // `declareTarget` prop), with an arrow drawn from the upcoming
  // value/def in the code into that placeholder instead of the other way
  // around.
  const nextStepDeclareTarget = useMemo(() => {
    if (!nextTraceStep || nextTraceStep.kind !== 'exec') return null
    const node = astIndexByFile.get(nextTraceStep.path)?.get(nextTraceStep.nodeId)
    if (!node) return null
    let varName: string | null = null
    if (node.type === 'FunctionDef') {
      varName = node.summary || null
    } else if (node.type === 'Assign') {
      const targets = node.fields.targets
      const onlyTarget = Array.isArray(targets) && targets.length === 1 ? targets[0] : null
      if (onlyTarget && typeof onlyTarget === 'object' && (onlyTarget as AstNode).type === 'Name') varName = (onlyTarget as AstNode).summary
    }
    if (!varName) return null
    const frameId = nextTraceStep.frameId
    const currentLocals = buildLocalsUpTo(visualTraceSteps, currentTraceStep?.step ?? -1, frameId)
    if (varName in currentLocals) return null
    return { frameId, varName }
  }, [nextTraceStep, astIndexByFile, visualTraceSteps, currentTraceStep])

  // When the pending next step is a "call-enter" (a user-defined function
  // about to start running), synthesize that callee frame's OpenFrame
  // entry one step early so it renders inline at its call site exactly
  // like any other open frame (see `framesForRender` below, merged into
  // the `openFrames` map handed down to <Frame>) - since no trace steps
  // exist yet for that frame id, every locals/substitution lookup keyed
  // off it naturally comes back empty, so it renders "for free" as a
  // totally fresh, not-yet-started call - except its header already shows
  // each bound parameter's real value one step early via paramAnnotations
  // (exactly like a real open frame does, see the Frame component's
  // `annotations` map), which is also where the connector arrows below
  // originate from. Also keeps the raw argSources list around (now just
  // each bound parameter's name, in parameter-def order), used to seed
  // this frame's own parameters as valueless placeholder rows
  // (`pendingCallLocals`).
  const nextStepPendingCall = useMemo(() => {
    if (!nextTraceStep || nextTraceStep.kind !== 'call-enter') return null
    // A call shown as its return expression must not be replaced one step early.
    if (substitutionMode && nextTraceStep.shortForm) return null
    if (nextTraceStep.funcDefNodeId === null || nextTraceStep.funcDefPath === null) return null
    const openFrame: OpenFrame = {
      frameId: nextTraceStep.frameId,
      parentFrameId: nextTraceStep.parentFrameId ?? 0,
      funcName: nextTraceStep.func,
      anchorPath: nextTraceStep.path,
      anchorNodeId: nextTraceStep.nodeId,
      funcDefPath: nextTraceStep.funcDefPath,
      funcDefNodeId: nextTraceStep.funcDefNodeId,
      paramAnnotations: nextTraceStep.paramAnnotations,
      shortForm: nextTraceStep.shortForm ?? null,
    }
    return { openFrame, argSources: nextTraceStep.argSources }
  }, [nextTraceStep, substitutionMode])

  // When the pending next step is a "call-pending" (a user-defined call
  // whose callee and arguments are already resolved - the call site reads
  // e.g. "fact(2)" - but whose frame hasn't opened yet, see
  // "call-pending"/`lookupName` on TraceStep), note which frame and name
  // the callee itself is bound under - so an arrow can be drawn from that
  // name's own row in the locals panel (showing "function", see
  // `_glpython_describe_for_locals_panel`) into the highlighted call
  // expression, representing the upcoming function lookup. Deliberately
  // distinct from `nextStepPendingCall` above: that one still only fires
  // for the step *after* this one (its own `call-enter` step), so the
  // callee's frame box correctly stays closed for the one extra step this
  // adds.
  const nextStepFuncLookup = useMemo(() => {
    if (!nextTraceStep || nextTraceStep.kind !== 'call-pending' || nextTraceStep.lookupName === null || nextTraceStep.lookupFrameId === null) return null
    return { frameId: nextTraceStep.lookupFrameId, varName: nextTraceStep.lookupName }
  }, [nextTraceStep])

  // SVG paths (in the coordinate space of .visualizer-canvas) for the
  // arrows above, measured straight from the rendered DOM once per
  // relevant change - there's no other reliable way to know where either
  // endpoint ends up on screen, since both sit inside reflowing,
  // variable-width text. Usually at most one path is active at once, but a
  // function call with several arguments needs one simultaneous arrow per
  // argument, hence an array rather than a single optional path. Each
  // entry also carries the text of its "known" endpoint (where the arrow
  // starts), so that if this very arrow disappears on the next step - i.e.
  // its value just got substituted - a short-lived copy of that text can
  // fly along the same curve into its destination (see `flights` below).
  // `kind` lets the layout effect treat a connector differently depending
  // on what it represents: 'funcLookup' connectors never fly their value as
  // a flight (the about-to-open frame-box flies/grows from that spot
  // instead - see the box-origin logic below), and 'arg' connectors (the
  // per-parameter arrows into a freshly-opened callee frame) aren't even
  // measured until that frame-box's own move+grow animation has finished
  // (see `growListenerRef` below) - measuring any earlier would read back
  // the box's still-shrunken, mid-flight geometry. `x1`/`y1` are the
  // connector's source anchor point (canvas-relative), kept around so the
  // box-origin logic can reuse it without re-measuring the DOM. A return
  // value collapsing into its call site is handled separately, below (see
  // `pendingReturnOriginRef`) - it never draws an arrow at all, instead
  // flying the real destination span in directly, so it has no 'return'
  // entry in this union.
  type Connector = { d: string; value: string; kind: 'var' | 'funcLookup' | 'arg'; x1: number; y1: number }
  const [connectorPaths, setConnectorPaths] = useState<Connector[]>([])

  // Short-lived "value flying along the arrow it just consumed" ghosts,
  // spawned in the layout effect below whenever stepping forward makes a
  // previously-shown connector disappear. Purely decorative (and disabled
  // along with every other animation via `animationsEnabled`), so each one
  // just removes itself again once its CSS motion-path animation ends.
  const [flights, setFlights] = useState<{ id: number; d: string; value: string }[]>([])
  const flightIdRef = useRef(0)
  const prevConnectorsRef = useRef<Connector[]>([])
  // The about-to-close callee frame's own return-line position, measured
  // while the box is still open and stashed here so the *next* effect run -
  // once the frame has actually closed and the parent's substituted-value
  // span for this call has been freshly mounted in its place - can compute
  // how far that real span needs to fly in from (see the 'return value
  // flight' block in the effect below). Unlike `prevConnectorsRef`, this
  // never backs a visible arrow; it's pure bookkeeping for one single
  // pending transition at a time (a frame can only close once).
  const pendingReturnOriginRef = useRef<{ nodeId: number; parentFrameId: number; x: number; y: number } | null>(null)
  // A frozen visual snapshot (geometry + markup) of the about-to-close
  // callee frame-box, taken in the same moment as `pendingReturnOriginRef`
  // above, while the real box still exists in the DOM. React removes the
  // real box the instant the frame actually closes (it's simply no longer
  // in `openFrames`), so there's nothing left to fade out by then - this
  // snapshot is what lets a short-lived ghost copy of it fade out in place
  // afterwards, in parallel with the real return value flying into its
  // destination (see `closingBoxes` below).
  const pendingClosingBoxRef = useRef<{ left: number; top: number; width: number; height: number; html: string } | null>(null)
  // Short-lived ghost copies of just-closed frame-boxes, rendered as plain
  // (non-interactive) markup absolutely positioned over where the real box
  // used to sit, fading out via CSS while the real return value flies into
  // its destination elsewhere. Spawned/removed the same way as `flights`
  // above.
  const [closingBoxes, setClosingBoxes] = useState<{ id: number; left: number; top: number; width: number; height: number; html: string }[]>([])
  const closingBoxIdRef = useRef(0)
  // Tracks the one 'animationend' listener (if any) currently waiting on a
  // freshly-opened callee frame-box's grow animation, so a later effect run
  // (e.g. the user stepping again before it fires) can detach it instead of
  // leaving it to fire against a now-stale step.
  const growListenerRef = useRef<{ el: HTMLElement; handler: (event: AnimationEvent) => void } | null>(null)
  const prevStepIndexRef = useRef(clampedStepIndex)
  const animationsEnabledRef = useRef(animationsEnabled)
  animationsEnabledRef.current = animationsEnabled


  // Keep the open tab in sync with whichever file the trace is currently
  // executing in at module scope (e.g. an import's own top-level code) -
  // but never for code running inside a call frame, since that now renders
  // inline at its own call site instead of jumping the view away to
  // wherever it's defined.
  useEffect(() => {
    if (!currentTraceStep || currentTraceStep.frameId !== 0) return
    if (!project.files[currentTraceStep.path]) return
    onOpenFile(currentTraceStep.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTraceStep?.path, currentTraceStep?.frameId])

  // Every call frame still open at the current step (module scope, frame 0,
  // is implicit and not included here) - drives both the Frame rendering
  // below and which frame's steps "count" for locals/highlighting above.
  const openFrames = useMemo(
    () => visualTrace ? computeOpenFramesUpTo(visualTrace.trace, currentTraceStep?.step ?? -1) : new Map<number, OpenFrame>(),
    [visualTrace, currentTraceStep],
  )

  // When the pending next step closes a callee frame (its own "eval" step
  // for the Call node, once the callee has fully returned - see
  // `closesFrameId` on TraceStep), note which frame is about to collapse,
  // the call node whose substituted-value span will appear in its place
  // once the frame is gone, and which parent frame that span renders
  // inside - so the layout effect below can, once the frame actually
  // closes, find that exact newly-mounted span (via its
  // `data-annotation-node-id`, scoped to the parent frame-box so same-nodeId
  // spans from other simultaneously-open recursive calls aren't matched by
  // mistake) and have it fly in from the collapsing box's old position,
  // rather than drawing a connecting arrow.
  const nextStepReturnFlight = useMemo(() => {
    if (!nextTraceStep || nextTraceStep.closesFrameId === null || nextTraceStep.valueText === null) return null
    const parentFrameId = openFrames.get(nextTraceStep.closesFrameId)?.parentFrameId ?? 0
    return { frameId: nextTraceStep.closesFrameId, nodeId: nextTraceStep.nodeId, parentFrameId }
  }, [nextTraceStep, openFrames])

  // `openFrames` plus, when applicable, the one synthetic "about to open"
  // callee frame from `nextStepPendingCall` above - this is what actually
  // gets handed down to <Frame>, so that pending frame renders inline at
  // its call site one step early, exactly like any other already-open call.
  const framesForRender = useMemo(() => {
    if (!nextStepPendingCall) return openFrames
    const merged = new Map(openFrames)
    merged.set(nextStepPendingCall.openFrame.frameId, nextStepPendingCall.openFrame)
    return merged
  }, [openFrames, nextStepPendingCall])

  const pendingCallLocals = useMemo(() => nextStepPendingCall
    ? { frameId: nextStepPendingCall.openFrame.frameId, paramNames: nextStepPendingCall.argSources }
    : null, [nextStepPendingCall])

  // Inline calls take no extra width, so only boxes count towards collapsing.
  const collapsedCalls = useMemo(
    () => collapseDeepCallChain(substitutionMode ? new Map([...framesForRender].filter(([, frame]) => !frame.shortForm)) : framesForRender, nextStepPendingCall ? 2 : 1),
    [framesForRender, nextStepPendingCall, substitutionMode],
  )
  const collapsedCallsLabel = collapsedCalls
    ? t.visualizerCollapsedCalls?.(collapsedCalls.hiddenCount, collapsedCalls.callText)
      ?? `\u2026 ${collapsedCalls.hiddenCount} more calls${collapsedCalls.callText ? ` of ${collapsedCalls.callText}` : ''} \u2026`
    : ''

  const inlineHostOf = (frameId: number | undefined): InlineHost | null => {
    if (!substitutionMode || frameId === undefined) return null
    let frame = framesForRender.get(frameId)
    if (!frame?.shortForm) return null
    for (let parent = framesForRender.get(frame.parentFrameId); parent?.shortForm; parent = framesForRender.get(frame.parentFrameId)) frame = parent
    const anchor = astIndexByFile.get(frame.anchorPath)?.get(frame.anchorNodeId)
    if (anchor?.line === undefined) return null
    return { frameId: frame.parentFrameId, path: frame.anchorPath, line: anchor.line, endLine: anchor.endLine ?? anchor.line }
  }
  // The visualizer's root file: a visualized REPL input's pseudo-file, or the
  // main file.
  const chainRootPath = visualRootPath ?? project.mainFile
  const canCopyChain = visualTrace !== null && currentTraceStep !== null
    && hasEvaluationChain(visualTrace.trace, visualTrace.ast, astIndexByFile.get(chainRootPath), chainRootPath, currentTraceStep)
  const copyEvaluationChain = async () => {
    if (!visualTrace || !currentTraceStep) return
    const chain = buildEvaluationChain({
      trace: visualTrace.trace,
      ast: visualTrace.ast,
      nodeIndexByFile: astIndexByFile,
      sources: visualSources,
      rootPath: chainRootPath,
      step: currentTraceStep,
      errorMessage: visualTrace.errorMessage ?? null,
      comments: chainComments,
      strings: {
        conditionComment: t.chainConditionComment ?? ((condition, value) => `${condition} is ${value}`),
        localsComment: t.chainLocalsComment ?? 'body with local variables',
      },
    })
    if (chain === null) return
    setChainFeedback(await copyText(chain) ? 'copied' : 'failed')
  }
  const changeChainComments = (enabled: boolean) => {
    setChainComments(enabled)
    try { localStorage.setItem(chainCommentsStorageKey, String(enabled)) } catch { /* the choice just isn't remembered */ }
  }
  useEffect(() => {
    if (chainFeedback === null) return
    const timer = window.setTimeout(() => setChainFeedback(null), 2000)
    return () => window.clearTimeout(timer)
  }, [chainFeedback])
  const activeHost = inlineHostOf(currentTraceStep?.frameId)
  const errorHost = isAtErrorStep ? inlineHostOf(errorTraceStep.frameId) : null
  const changeVisualizerMode = (mode: VisualizerMode) => {
    if (mode === visualizerMode) return
    // Stay at the same point of the program: the last step of the new mode's
    // list that isn't past the current one.
    if (visualTrace) {
      const current = currentTraceStep?.step ?? -1
      const steps = mode === 'substitution' ? substitutionModeSteps(visualTrace.trace) : visualTrace.trace
      let index = -1
      steps.forEach((step, stepIndex) => { if (step.step <= current) index = stepIndex })
      setVisualStepIndex(index)
    }
    setVisualizerMode(mode)
    try { localStorage.setItem(visualizerModeStorageKey, mode) } catch { /* the choice just isn't remembered */ }
  }

  useLayoutEffect(() => {
    const canvas = visualizerCanvasRef.current
    if (!canvas) { setConnectorPaths([]); return }
    const canvasRect = canvas.getBoundingClientRect()

    // One bezier path (in the given canvas-relative coordinate space)
    // between two already-rendered DOM elements, always exiting the source
    // from whichever side faces the target and entering the target from
    // whichever side faces the source - so the curve never has to double
    // back through either endpoint's own text, regardless of which visual
    // direction this particular arrow happens to flow in (locals -> code,
    // code -> locals, or code -> code). `rect` is taken as a parameter
    // (rather than closing over a single canvas rect measured once) so the
    // deferred per-argument measurement below can re-measure the canvas
    // fresh once the callee frame-box's grow animation has actually
    // finished, instead of reusing a rect captured while it was still mid-flight.
    const pathBetween = (sourceEl: Element, targetEl: Element, kind: Connector['kind'], rect: DOMRect): Connector => {
      const sourceRect = sourceEl.getBoundingClientRect()
      const targetRect = targetEl.getBoundingClientRect()
      const y1 = sourceRect.top - rect.top + sourceRect.height / 2
      const y2 = targetRect.top - rect.top + targetRect.height / 2
      const dir = targetRect.left + targetRect.right >= sourceRect.left + sourceRect.right ? 1 : -1
      const x1 = (dir === 1 ? sourceRect.right : sourceRect.left) - rect.left
      const x2 = (dir === 1 ? targetRect.left : targetRect.right) - rect.left
      const dx = Math.max(Math.abs(x2 - x1) * 0.5, 40)
      // Strip a leading "=" from parameter-annotation sources (e.g. the
      // "=3" shown next to "n" in "def fact(n=3):") so the flying copy
      // reads as a plain value, matching what lands in the locals row.
      const value = (sourceEl.textContent?.trim() ?? '').replace(/^=/, '')
      return { d: `M ${x1} ${y1} C ${x1 + dx * dir} ${y1}, ${x2 - dx * dir} ${y2}, ${x2} ${y2}`, value, kind, x1, y1 }
    }

    const paths: Connector[] = []

    // "nextStepVarSource" means a value already known in the locals panel
    // is about to flow out into the code (arrow: locals -> code);
    // "nextStepDeclareTarget" is the opposite - a value already sitting in
    // the code is about to flow into a freshly-declared, still-valueless
    // locals row (arrow: code -> locals). Only one of the two can ever be
    // set at once, since they key off disjoint AST node types.
    const varAnchor = nextStepVarSource ?? nextStepDeclareTarget
    if (varAnchor) {
      const varEl = canvas.querySelector(
        `.frame-box[data-frame-id="${varAnchor.frameId}"] > .frame-vars > .locals-row[data-name="${CSS.escape(varAnchor.varName)}"] .locals-value`,
      )
      const codeEl = canvas.querySelector('.visual-next-step')
      if (varEl && codeEl) paths.push(pathBetween(nextStepVarSource ? varEl : codeEl, nextStepVarSource ? codeEl : varEl, 'var', canvasRect))
    }

    // "nextStepFuncLookup": the about-to-be-called function's own row in
    // whichever frame defines it (showing "function") flowing into the
    // fully-substituted call expression itself (e.g. "fact(2)") - the same
    // locals -> code direction as `nextStepVarSource` above, just keyed off
    // a different step kind, so it's always disjoint from both `varAnchor`
    // cases and can safely add its own path alongside them.
    if (nextStepFuncLookup) {
      const funcEl = canvas.querySelector(
        `.frame-box[data-frame-id="${nextStepFuncLookup.frameId}"] > .frame-vars > .locals-row[data-name="${CSS.escape(nextStepFuncLookup.varName)}"] .locals-value`,
      )
      const codeEl = canvas.querySelector('.visual-next-step')
      if (funcEl && codeEl) paths.push(pathBetween(funcEl, codeEl, 'funcLookup', canvasRect))
    }

    // "nextStepReturnFlight": measure (while the callee frame-box is still
    // open) the canvas-relative point its own current (return) line sits
    // at - this is "the return site" the value is flying from. No arrow is
    // drawn for it; the point is just stashed in `pendingReturnOriginRef`
    // for the *next* effect run to pick up once the frame has actually
    // closed, at which point the parent's freshly-substituted value span
    // for this exact call (found via `nodeId`, scoped to `parentFrameId` -
    // see below) gets flown in from this very point instead. The box's own
    // full geometry + markup is snapshotted into `currentClosingBox` at the
    // same time, for a fade-out ghost of the whole box (see
    // `pendingClosingBoxRef` above).
    let currentReturnOrigin: { nodeId: number; parentFrameId: number; x: number; y: number } | null = null
    let currentClosingBox: { left: number; top: number; width: number; height: number; html: string } | null = null
    if (nextStepReturnFlight) {
      const boxEl = canvas.querySelector(`.frame-box[data-frame-id="${nextStepReturnFlight.frameId}"]`)
      const lineEl = boxEl?.querySelector('.visual-current-line')
      if (lineEl) {
        const lineRect = lineEl.getBoundingClientRect()
        currentReturnOrigin = {
          nodeId: nextStepReturnFlight.nodeId,
          parentFrameId: nextStepReturnFlight.parentFrameId,
          x: lineRect.left - canvasRect.left + lineRect.width / 2,
          y: lineRect.top - canvasRect.top + lineRect.height / 2,
        }
      }
      if (boxEl instanceof HTMLElement) {
        const boxRect = boxEl.getBoundingClientRect()
        // Clone rather than reuse the real node (which is about to be
        // unmounted anyway), and strip every attribute/class any *other*
        // query in this same effect keys off of (data-frame-id,
        // data-annotation-node-id, data-name, the unscoped `.visual-next-step`
        // lookup, ...) - this frozen, inert ghost must never be able to
        // accidentally satisfy a query meant for the live, currently-
        // rendered tree once it lingers on-screen for its fade-out. Also
        // forces off every CSS animation still named on its descendants
        // (grow-in, locals value pop, ...) - this is a static, already-
        // settled snapshot, and being freshly inserted markup would
        // otherwise replay all of those from scratch alongside its own
        // fade-out.
        const clone = boxEl.cloneNode(true) as HTMLElement
        clone.removeAttribute('data-frame-id')
        clone.style.animation = 'none'
        clone.querySelectorAll('[data-frame-id], [data-annotation-node-id], [data-name], .visual-next-step, .visual-current-line').forEach((el) => {
          el.removeAttribute('data-frame-id')
          el.removeAttribute('data-annotation-node-id')
          el.removeAttribute('data-name')
          el.classList.remove('visual-next-step', 'visual-current-line')
        })
        clone.querySelectorAll<HTMLElement>('*').forEach((el) => { el.style.animation = 'none' })
        currentClosingBox = {
          left: boxRect.left - canvasRect.left,
          top: boxRect.top - canvasRect.top,
          width: boxRect.width,
          height: boxRect.height,
          html: clone.outerHTML,
        }
      }
    }

    // One arrow per bound parameter of the about-to-open callee frame:
    // from that parameter's own annotation in the callee's own header
    // (e.g. the "3" in "def fact(n=3):", identified by its AST node id via
    // data-annotation-node-id - matched to this paramName via the callee's
    // own paramAnnotations, since argSources is just a plain name list)
    // into that parameter's placeholder row in the locals panel below it.
    // Takes `rect` as a parameter (see `pathBetween` above) rather than
    // closing over `canvasRect`, since it also gets called later, after a
    // fresh re-measurement, from the deferred grow-animation handler below.
    const buildArgConnectors = (rect: DOMRect): Connector[] => {
      if (!nextStepPendingCall) return []
      const calleeFrameId = nextStepPendingCall.openFrame.frameId
      const result: Connector[] = []
      for (const paramName of nextStepPendingCall.argSources) {
        const annotation = nextStepPendingCall.openFrame.paramAnnotations.find(([, , name]) => name === paramName)
        if (!annotation) continue
        const [nodeId] = annotation
        const argEl = canvas.querySelector(`.frame-box[data-frame-id="${calleeFrameId}"] [data-annotation-node-id="${nodeId}"]`)
        const paramEl = canvas.querySelector(
          `.frame-box[data-frame-id="${calleeFrameId}"] > .frame-vars > .locals-row[data-name="${CSS.escape(paramName)}"] .locals-value`,
        )
        if (argEl && paramEl) result.push(pathBetween(argEl, paramEl, 'arg', rect))
      }
      return result
    }

    // Detach any previously-scheduled grow-animation listener before
    // (possibly) scheduling a new one below - otherwise a listener left over
    // from an earlier step the user has since moved away from could fire
    // later and append a stale arrow for a frame that's no longer pending.
    if (growListenerRef.current) {
      growListenerRef.current.el.removeEventListener('animationend', growListenerRef.current.handler)
      growListenerRef.current.el.removeEventListener('animationcancel', growListenerRef.current.handler)
      growListenerRef.current = null
    }

    if (nextStepPendingCall) {
      const calleeFrameId = nextStepPendingCall.openFrame.frameId

      // Rather than fading/growing in place, the freshly-opened callee
      // frame-box flies in from wherever its own "function" row was sitting
      // in its defining scope a moment ago (the very spot the now-gone
      // 'funcLookup' connector pointed out of) - so stash that point as a
      // translate offset, consumed by the `visual-frame-grow` keyframe in
      // App.css, which animates it back down to (0, 0) while scaling up.
      // Frames with no such predecessor (shouldn't normally happen, but
      // kept as a safe fallback) just scale up in place instead.
      const boxEl = canvas.querySelector(`.frame-box[data-frame-id="${calleeFrameId}"]`)
      if (boxEl instanceof HTMLElement) {
        const origin = prevConnectorsRef.current.find((connector) => connector.kind === 'funcLookup')
        if (origin) {
          const boxRect = boxEl.getBoundingClientRect()
          const cx = boxRect.left - canvasRect.left + boxRect.width / 2
          const cy = boxRect.top - canvasRect.top + boxRect.height / 2
          boxEl.style.setProperty('--grow-dx', `${origin.x1 - cx}px`)
          boxEl.style.setProperty('--grow-dy', `${origin.y1 - cy}px`)
        } else {
          boxEl.style.removeProperty('--grow-dx')
          boxEl.style.removeProperty('--grow-dy')
        }

        if (animationsEnabledRef.current) {
          // This effect runs synchronously before paint, i.e. before the
          // box's own CSS grow animation has had any chance to run - so
          // every element inside it, including the per-argument targets
          // above, would currently measure at the box's shrunken, mid-flight
          // size/position rather than its real, settled one. Measuring now
          // would bake those wrong coordinates straight into the arrow, so
          // instead wait for the box's grow animation to actually finish and
          // only then measure/add the per-argument arrows. Also handles
          // 'animationcancel' (e.g. the user unchecks "animate steps" while
          // the box is still mid-grow, which abruptly removes the
          // animation instead of ever firing 'animationend') the same way,
          // since by that point the box is already at its real final size.
          const handleGrowEnd = (event: AnimationEvent) => {
            if (event.target !== boxEl || event.animationName !== 'visual-frame-grow') return
            boxEl.removeEventListener('animationend', handleGrowEnd)
            boxEl.removeEventListener('animationcancel', handleGrowEnd)
            if (growListenerRef.current?.handler === handleGrowEnd) growListenerRef.current = null
            const argConnectors = buildArgConnectors(canvas.getBoundingClientRect())
            if (argConnectors.length === 0) return
            setConnectorPaths((current) => [...current, ...argConnectors])
            prevConnectorsRef.current = [...prevConnectorsRef.current, ...argConnectors]
          }
          boxEl.addEventListener('animationend', handleGrowEnd)
          boxEl.addEventListener('animationcancel', handleGrowEnd)
          growListenerRef.current = { el: boxEl, handler: handleGrowEnd }
        } else {
          // No animation is going to play at all, so the box is already at
          // its real, final size/position right now - measure immediately.
          paths.push(...buildArgConnectors(canvasRect))
        }
      }
    }

    // Stepping forward past a step that was showing a connector turns that
    // connector's "known" endpoint into the real, now-substituted value -
    // exactly the transition the arrow was foreshadowing - so fly a copy of
    // its text along the very same curve it just traced, into whichever
    // destination it was pointing at. Stepping backward (or sideways, via
    // the scrubber) undoes rather than performs a substitution, so it never
    // spawns flights; it just drops the stale connectors like before. The
    // one exception is a 'funcLookup' connector disappearing because its
    // callee frame-box just opened - that transition is shown by the box
    // itself flying/growing in from that spot (see above) instead of a
    // flying copy of the word "function".
    const steppedForward = clampedStepIndex > prevStepIndexRef.current
    const flightSources = prevConnectorsRef.current.filter((connector) => connector.kind !== 'funcLookup')
    if (steppedForward && animationsEnabledRef.current && flightSources.length > 0) {
      const newFlights = flightSources.map((connector) => ({ id: flightIdRef.current++, ...connector }))
      setFlights((current) => [...current, ...newFlights])
      const ids = newFlights.map((f) => f.id)
      // Matches the `.visual-flight-move` / `.visual-flight-arrow-fade` animation duration in App.css.
      window.setTimeout(() => setFlights((current) => current.filter((f) => !ids.includes(f.id))), 600)
    }

    // The return-flight counterpart of the above: stepping forward past a
    // return-collapse makes the callee frame-box (whose return line we
    // measured and stashed last render) actually disappear, replaced by a
    // plain `.visual-substituted-value` span back in the parent - find that
    // exact freshly-mounted span by its nodeId (scoped to its parent
    // frame-box) and set its own `--return-dx`/`--return-dy` offset to the
    // delta from the stashed return-site point, so the `visual-return-fly-in`
    // keyframe in App.css (applied unconditionally to every substituted
    // value, default offset zero) animates this real element in from there -
    // no arrow, no separate ghost copy, just the actual value sliding into
    // place from where it was computed.
    if (steppedForward && animationsEnabledRef.current && pendingReturnOriginRef.current) {
      const origin = pendingReturnOriginRef.current
      const destEl = canvas.querySelector(
        `.frame-box[data-frame-id="${origin.parentFrameId}"] [data-annotation-node-id="${origin.nodeId}"].visual-substituted-value`,
      )
      if (destEl instanceof HTMLElement) {
        const destRect = destEl.getBoundingClientRect()
        const destX = destRect.left - canvasRect.left + destRect.width / 2
        const destY = destRect.top - canvasRect.top + destRect.height / 2
        destEl.style.setProperty('--return-dx', `${origin.x - destX}px`)
        destEl.style.setProperty('--return-dy', `${origin.y - destY}px`)
      }
    }

    // Spawns the closing-box fade-out ghost (see `pendingClosingBoxRef`
    // above) in lockstep with the return-value fly-in just above, so the
    // old box visibly dissolves in place while the real value it contained
    // slides out of it into its destination, instead of just vanishing.
    if (steppedForward && animationsEnabledRef.current && pendingClosingBoxRef.current) {
      const box = pendingClosingBoxRef.current
      const id = closingBoxIdRef.current++
      setClosingBoxes((current) => [...current, { id, ...box }])
      // Matches the `.visual-closing-box-fade` animation duration in App.css.
      window.setTimeout(() => setClosingBoxes((current) => current.filter((b) => b.id !== id)), 400)
    }

    prevConnectorsRef.current = paths
    prevStepIndexRef.current = clampedStepIndex
    pendingReturnOriginRef.current = currentReturnOrigin
    pendingClosingBoxRef.current = currentClosingBox

    setConnectorPaths(paths)
  }, [nextStepVarSource, nextStepDeclareTarget, nextStepPendingCall, nextStepFuncLookup, nextStepReturnFlight, currentTraceStep, openFrames, clampedStepIndex])

  // Keeps the currently executing line in view as steps advance, with
  // ordinary DOM scrolling - directly replacing the old Monaco
  // view-zone/content-widget machinery, whose geometry bookkeeping across
  // four separate systems was the root cause of the previous scrolling
  // bugs. It only scrolls when the active line would otherwise leave the
  // view (e.g. stepping into/out of a deeply nested call), rather than
  // jumping the view around on every single step.
  //
  // Horizontally, nested call boxes can be wider than the view (each one
  // sits at its call site, indented by the code before it), so it instead
  // follows the box the current step runs in: that box is scrolled fully
  // into view, outer boxes may slide off to the left, and if the box doesn't
  // fit (e.g. it already holds the next call's box) the innermost box wins.
  // Only steps scroll, so the learner can still scroll around in between.
  //
  // Both directions scroll only this view, never the page around it
  // (scrollIntoView would also scroll e.g. a LiaScript course page, even
  // across origins, moving the step buttons out from under the mouse).
  useEffect(() => {
    if (!isVisualizing) return
    const container = visualizerScrollRef.current
    const canvas = visualizerCanvasRef.current
    const root = canvas?.querySelector<HTMLElement>('.frame-box--root')
    if (!container || !canvas || !root) return
    const margin = 12

    let nextTop = container.scrollTop
    const line = root.querySelector<HTMLElement>('.visual-current-line')
    if (line) {
      const canvasTop = canvas.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      const top = canvasTop + canvasOffset(line, canvas).top
      const bottom = top + line.offsetHeight
      if (top - margin < nextTop) nextTop = top - margin
      else if (bottom + margin > nextTop + container.clientHeight) nextTop = bottom + margin - container.clientHeight
    }

    const frameId = currentTraceStep?.frameId ?? 0
    const active = frameId === 0 ? root : root.querySelector<HTMLElement>(`.frame-box[data-frame-id="${frameId}"]`) ?? root
    // Open boxes form one chain, so there's at most one box without boxes inside.
    const innermost = [...root.querySelectorAll<HTMLElement>('.frame-box')].find((box) => !box.querySelector('.frame-box')) ?? null
    const span = (box: HTMLElement) => {
      const left = canvasOffset(box, canvas).left
      return { left, right: left + box.offsetWidth }
    }
    const room = container.clientWidth - 2 * margin
    let target = active !== root ? span(active) : innermost ? span(innermost) : { left: 0, right: 0 }
    if (target.right - target.left > room && innermost) target = span(innermost)
    if (target.right - target.left > room) target = { left: target.left, right: target.left + room }
    let nextLeft = container.scrollLeft
    if (target.left - margin < nextLeft) nextLeft = target.left - margin
    else if (target.right + margin > nextLeft + container.clientWidth) nextLeft = target.right + margin - container.clientWidth
    container.scrollTo({ left: Math.max(0, nextLeft), top: Math.max(0, nextTop), behavior: animationsEnabledRef.current ? 'smooth' : 'auto' })
  }, [isVisualizing, currentTraceStep])

  // Auto-play: advance one step every 500ms while playing, stopping at the
  // end of the trace.
  useEffect(() => {
    if (!isVisualPlaying || !visualTrace) return
    if (clampedStepIndex >= visualTraceSteps.length - 1) { setIsVisualPlaying(false); return }
    const timer = window.setTimeout(() => setVisualStepIndex((index) => Math.min(index + 1, visualTraceSteps.length - 1)), 500)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisualPlaying, clampedStepIndex, visualTrace])

  const visualStepBack = () => { setIsVisualPlaying(false); setVisualStepIndex((index) => Math.max(-1, index - 1)) }
  const visualStepForward = () => { setIsVisualPlaying(false); setVisualStepIndex((index) => Math.min(visualTraceSteps.length - 1, index + 1)) }
  const visualRestart = () => { setIsVisualPlaying(false); setVisualStepIndex(-1) }
  const visualTogglePlay = () => setIsVisualPlaying((playing) => !playing)
  const workspaceClassName = [
    'glpython-workspace',
    isVisualizing ? 'glpython-workspace--visualizing' : '',
    compact ? 'glpython-workspace--compact' : '',
    workspaceCapabilities.actions ? '' : 'glpython-workspace--no-actions',
    workspaceCapabilities.editor ? '' : 'glpython-workspace--no-editor',
    workspaceCapabilities.exitVisualizer ? '' : 'glpython-workspace--no-exit-visualizer',
    workspaceCapabilities.breadcrumbs ? '' : 'glpython-workspace--no-breadcrumbs',
    workspaceCapabilities.fileTabs ? '' : 'glpython-workspace--no-file-tabs',
    workspaceCapabilities.resetOutput ? '' : 'glpython-workspace--no-reset',
    workspaceCapabilities.visualization ? '' : 'glpython-workspace--no-visualization',
    workspaceCapabilities.graphics ? '' : 'glpython-workspace--no-graphics',
  ].filter(Boolean).join(' ')

  return (
    <div className={workspaceClassName}>
              <div className="main-split"><div className="editor-column"><div className="editor-header"><div className="breadcrumbs"><span>{project.name}</span><span>/</span><strong>{selectedFile.path}</strong></div><div className="editor-actions">{isVisualizing ? workspaceCapabilities.exitVisualizer ? <button className="secondary-button" onClick={exitVisualizer}><X size={15} /> {t.exitVisualizer}</button> : null : workspaceCapabilities.actions ? <><button className="secondary-button" onClick={() => { setOutput(t.readyOutput); setReplEntries([]) }}><RotateCcw size={15} /> {t.resetOutput}</button><button className="secondary-button" onClick={runVisualize} disabled={isRunning || isVisualizerLoading}><Workflow size={15} /> {isVisualizerLoading ? t.visualizing : t.visualize}</button><button className="run-button" onClick={runCode} disabled={isRunning}><Play size={15} fill="currentColor" /> {isRunning ? t.running : t.runProject}</button></> : null}</div></div>{isVisualizing && <div className="visualizer-bar"><div className="visualizer-title"><Workflow size={15} /><span>{t.visualizerTitle}</span></div>{visualTraceSteps.length > 0 ? <><span className="visualizer-step-count">{clampedStepIndex === -1 ? t.visualizerBeforeStart : t.visualizerStepOf(clampedStepIndex + 1, visualTraceSteps.length)}</span><div className="visualizer-scrubber-track"><input className="visualizer-scrubber" type="range" min={-1} max={Math.max(0, visualTraceSteps.length - 1)} value={clampedStepIndex} onChange={(event) => { setIsVisualPlaying(false); setVisualStepIndex(Number(event.target.value)) }} />{errorTraceStep && <span className="visualizer-scrubber-error" title={errorTraceStep.label} style={{ '--marker-position': (visualTraceSteps.indexOf(errorTraceStep) + 1) / Math.max(1, visualTraceSteps.length) } as CSSProperties} />}</div>{visualTrace?.truncated && <span className="visualizer-truncated-hint"><AlertTriangle size={13} />{t.visualizerTruncated}</span>}<div className="visualizer-controls"><button className="icon-button small" aria-label={t.visualizerRestart} onClick={visualRestart}><RotateCcw size={15} /></button><button className="icon-button small" aria-label={t.visualizerPrevStep} onClick={visualStepBack} disabled={clampedStepIndex === -1}><SkipBack size={15} /></button><button className="icon-button small" aria-label={isVisualPlaying ? t.visualizerPause : t.visualizerPlay} onClick={visualTogglePlay}>{isVisualPlaying ? <Pause size={15} /> : <Play size={15} />}</button><button className="icon-button small" aria-label={t.visualizerNextStep} onClick={visualStepForward} disabled={clampedStepIndex >= visualTraceSteps.length - 1}><SkipForward size={15} /></button></div></> : <span className="visualizer-step-count">{t.visualizerNoSteps}</span>}<label className="visualizer-animate-toggle"><input type="checkbox" checked={animationsEnabled} onChange={(event) => setAnimationsEnabled(event.target.checked)} /> {t.visualizerAnimate}</label><div className="visualizer-mode" role="group" aria-label={t.visualizerModeLabel ?? 'Display'}><button type="button" aria-pressed={!substitutionMode} onClick={() => changeVisualizerMode('box')}>{t.visualizerModeBox ?? 'Box'}</button><button type="button" aria-pressed={substitutionMode} onClick={() => changeVisualizerMode('substitution')}>{t.visualizerModeSubstitution ?? 'Substitution'}</button></div><div className="visualizer-chain"><button type="button" className="secondary-button visualizer-chain-copy" onClick={copyEvaluationChain} disabled={!canCopyChain}><Copy size={13} /> {chainFeedback === 'copied' ? (t.copyChainDone ?? 'Copied') : chainFeedback === 'failed' ? (t.copyChainFailed ?? 'Could not copy') : (t.copyChain ?? 'Copy \u2192 chain')}</button><label className="visualizer-chain-comments"><input type="checkbox" checked={chainComments} onChange={(event) => changeChainComments(event.target.checked)} /> {t.copyChainComments ?? 'Comments'}</label></div></div>}{isVisualizing && visualTrace?.error && !errorTraceStep && <div className="visualizer-warning"><AlertTriangle size={14} />{t.visualizerError(visualTrace.error)}</div>}{(workspaceCapabilities.editor || isVisualizing) && <section className="editor-panel"><div className="editor-tabs">{openFiles.map((path) => { const file = project.files[path]; return <button className={`editor-tab ${activeFile === path ? 'active' : ''}`} key={path} onClick={() => onOpenFile(path)}><span className={`tab-file-icon ${file.kind === 'python' ? 'python' : 'notes'}`}>{file.kind === 'python' ? <FileCode2 size={14} /> : <BookOpen size={14} />}</span><span>{file.path}</span><span className="tab-close" role="button" aria-label={t.closeFile(file.path)} onClick={(event) => { event.stopPropagation(); onCloseFile(path) }}><X size={13} /></span></button> })}</div><div className="editor-wrap">{isVisualizing ? <div className={`visualizer-view${animationsEnabled ? ' visualizer-animated' : ''}`} ref={visualizerScrollRef}><div className="visualizer-canvas" ref={visualizerCanvasRef}><Frame frameId={0} path={visualRootPath ?? activeFile} scope={{ kind: 'module' }} openFrames={framesForRender} nodeIndexByFile={astIndexByFile} visualSources={visualSources} trace={visualTrace?.trace ?? []} uptoStep={currentTraceStep?.step ?? -1} currentStep={currentTraceStep} nextStep={nextTraceStep} monaco={monaco} noLocalsLabel={t.visualizerNoLocals} valueKindLabels={valueKindLabels} declareTarget={nextStepDeclareTarget} pendingCallLocals={pendingCallLocals} errorStep={isAtErrorStep ? errorTraceStep : null} collapsedCalls={collapsedCalls} collapsedCallsLabel={collapsedCallsLabel} substitutionMode={substitutionMode} boxHint={t.visualizerBoxHint ?? 'The box shows which return is executed.'} insideBox={false} activeHost={activeHost} errorHost={errorHost} />{animationsEnabled && closingBoxes.length > 0 && <div className="visualizer-closing-boxes">{closingBoxes.map((box) => <div key={box.id} className="visual-closing-box-ghost" style={{ left: box.left, top: box.top, width: box.width, height: box.height }} dangerouslySetInnerHTML={{ __html: box.html }} />)}</div>}{(connectorPaths.length > 0 || flights.length > 0) && <svg className="visualizer-connectors"><defs><marker id="visualizer-arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>{connectorPaths.map((connector, index) => <path key={index} d={connector.d} markerEnd="url(#visualizer-arrowhead)" />)}{animationsEnabled && flights.map((flight) => <path key={`flight-${flight.id}`} className="visual-flight-arrow" d={flight.d} markerEnd="url(#visualizer-arrowhead)" />)}</svg>}{animationsEnabled && flights.length > 0 && <div className="visualizer-flights">{flights.map((flight) => <span key={flight.id} className="visual-flight-value" style={{ offsetPath: `path('${flight.d}')` }}>{flight.value}</span>)}</div>}</div></div> : <Editor key="normal-editor" height="100%" language={selectedFile.kind === 'python' ? 'python' : 'markdown'} theme="vs-dark" value={selectedFile.code} onChange={updateCode} options={{ minimap: { enabled: false }, fontSize: 15, lineHeight: 24, padding: { top: 22 }, fontFamily: "'JetBrains Mono', monospace", scrollBeyondLastLine: false, smoothScrolling: true, automaticLayout: true, tabSize: 4, insertSpaces: true, detectIndentation: false }} />}</div></section>}<section className="output-panel"><div className="output-heading"><div className="output-title"><SquareTerminal size={16} /><span>{t.output}</span><span className="runtime-badge"><span className="pulse" /> {t.pyodideRuntime}</span></div><span className="output-hint">{t.runsFile(project.mainFile)}</span></div><pre ref={outputRef}>{isVisualizing ? (isAtErrorStep ? <>{visualStdout && !visualStdout.endsWith('\n') ? `${visualStdout}\n` : visualStdout}<span className="output-error">{visualTrace?.error}</span></> : visualStdout || t.noOutput) : <>{output}{replEntries.map((entry) => <ReplTranscriptEntry key={entry.id} entry={entry} definitionHint={t.replDefinitionHint ?? 'Definitions belong in the file.'} />)}</>}</pre>{workspaceCapabilities.repl && <form className="repl-line" onSubmit={(event) => { event.preventDefault(); submitRepl() }}><span className="repl-prompt" aria-hidden="true">&gt;&gt;&gt;</span><input className="repl-input" value={replInput} onChange={(event) => { setReplInput(event.target.value); setReplHistoryIndex(null) }} onKeyDown={handleReplKeyDown} aria-label={t.replInputLabel ?? 'Python input'} spellCheck={false} autoComplete="off" autoCapitalize="off" />{workspaceCapabilities.visualization && <button type="button" className="secondary-button repl-visualize" onClick={visualizeRepl} disabled={!replInput.trim() || isRunning || isReplBusy || isVisualizerLoading}><Workflow size={14} /> {isVisualizerLoading ? t.visualizing : t.visualize}</button>}</form>}</section></div>{isGraphicsOpen ? <aside className="graphics-panel"><div className="output-heading"><div className="output-title"><Sparkles size={16} /><span>{t.turtleGraphics}</span>{graphics.length > 0 && <span className="runtime-badge"><span className="pulse" /> {t.gturtleWindow}</span>}</div><button className="icon-button small" aria-label={t.collapseGraphics} onClick={() => onGraphicsOpenChange(false)}><PanelRightClose size={15} /></button></div>{(isVisualizing ? (visualTrace?.graphics.slice(0, currentTraceStep?.graphicsLen ?? 0) as TurtleCommand[] ?? []) : graphics).length > 0 ? <GraphicsWindow commands={isVisualizing ? (visualTrace?.graphics.slice(0, currentTraceStep?.graphicsLen ?? 0) as TurtleCommand[] ?? []) : graphics} /> : <p className="graphics-empty">{t.graphicsEmptyBefore} <code>gturtle</code> {t.graphicsEmptyAfter}</p>}</aside> : <button className="graphics-collapsed-toggle" aria-label={t.expandGraphics} onClick={() => onGraphicsOpenChange(true)}><PanelRightOpen size={16} /><span>{t.graphicsCollapsedLabel}</span></button>}</div>
      {inputRequest !== null && <div className="input-dialog-backdrop" role="presentation" onClick={() => respondToInput(true)}><form className="input-dialog" role="dialog" aria-modal="true" aria-label={t.inputDialogTitle} onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); respondToInput(false) }}><div className="input-dialog-heading"><Terminal size={16} /><span>{t.inputDialogTitle}</span></div><p className="input-dialog-prompt">{inputRequest || t.inputDialogFallbackPrompt}</p><input ref={inputFieldRef} className="input-dialog-field" type="text" value={inputValue} onChange={(event) => setInputValue(event.target.value)} placeholder={t.inputPlaceholder} /><div className="input-dialog-actions"><button type="button" className="secondary-button" onClick={() => respondToInput(true)}>{t.inputCancel}</button><button type="submit" className="run-button">{t.inputSubmit}</button></div></form></div>}
    </div>
  )
}

export { GlPythonWorkspace }
export type { GlPythonWorkspaceProps, CoreStrings, WorkspaceCapabilities, WorkspaceCommand }
