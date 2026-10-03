let pyodideReadyPromise
let mountedFiles = []
let inputControl = null
let inputPayload = null
const INPUT_CANCELLED_MARKER = '__GLPYTHON_INPUT_CANCELLED__'
const turtleModule = `
import math
commands = []
_x, _y, _angle = 320.0, 210.0, 0.0
_pen_down, _color, _width = True, "#27725c", 2.0

def makeTurtle(*args, **kwargs):
  global _x, _y, _angle
  _x, _y, _angle = 320.0, 210.0, 0.0
  commands.clear()

def clear(*args, **kwargs):
  commands.clear()

def penUp():
  global _pen_down
  _pen_down = False

def penDown():
  global _pen_down
  _pen_down = True

def forward(distance):
  global _x, _y
  next_x = _x + math.cos(math.radians(_angle)) * distance
  next_y = _y + math.sin(math.radians(_angle)) * distance
  if _pen_down:
    commands.append({"type": "line", "x1": _x, "y1": _y, "x2": next_x, "y2": next_y, "color": _color, "width": _width})
  _x, _y = next_x, next_y

def backward(distance):
  forward(-distance)

def left(degrees):
  global _angle
  _angle += degrees

def right(degrees):
  left(-degrees)

def setPenColor(color):
  global _color
  _color = color

def setLineWidth(width):
  global _width
  _width = width
`

// Python source shared by both run modes: monkeypatches builtins.input to bridge
// through requestInputFromMainThread (defined further below).
const inputPreamble = `
import builtins
from js import requestInputFromMainThread

def _glpython_input(prompt=""):
  try:
    return requestInputFromMainThread(str(prompt))
  except Exception as error:
    if "${INPUT_CANCELLED_MARKER}" in str(error):
      raise EOFError("Input was cancelled.") from None
    raise

builtins.input = _glpython_input
`

async function getPyodide() {
  if (!pyodideReadyPromise) {
    importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js')
    pyodideReadyPromise = loadPyodide()
  }
  return pyodideReadyPromise
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
  const mountedPathsJson = JSON.stringify([...mountedFiles, 'gturtle.py'].map((path) => `/${path}`))
  await pyodide.runPythonAsync(`
import sys as _glpython_sys
for _glpython_mounted_path in ${mountedPathsJson}:
  for _glpython_module_name in list(_glpython_sys.modules):
    _glpython_module = _glpython_sys.modules[_glpython_module_name]
    if getattr(_glpython_module, "__file__", None) == _glpython_mounted_path:
      del _glpython_sys.modules[_glpython_module_name]
`)
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
function visualHarnessSource(mainPath, pythonPaths) {
  return `
import ast, sys, json, math, traceback
import types as _glpython_types

_GLPYTHON_MAX_STEPS = 6000

class _GlpythonTraceLimit(BaseException):
  pass

class _GlpythonBreak(Exception):
  pass

class _GlpythonContinue(Exception):
  pass

class _GlpythonReturn(Exception):
  def __init__(self, value):
    self.value = value

_GLPYTHON_OP_SYMBOLS = {
  ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/", ast.FloorDiv: "//", ast.Mod: "%", ast.Pow: "**",
  ast.LShift: "<<", ast.RShift: ">>", ast.BitOr: "|", ast.BitXor: "^", ast.BitAnd: "&", ast.MatMult: "@",
  ast.Eq: "==", ast.NotEq: "!=", ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">=",
  ast.Is: "is", ast.IsNot: "is not", ast.In: "in", ast.NotIn: "not in",
  ast.And: "and", ast.Or: "or", ast.Not: "not", ast.UAdd: "+", ast.USub: "-", ast.Invert: "~",
}

import operator as _op
_GLPYTHON_BINOPS = {
  ast.Add: _op.add, ast.Sub: _op.sub, ast.Mult: _op.mul, ast.Div: _op.truediv, ast.FloorDiv: _op.floordiv,
  ast.Mod: _op.mod, ast.Pow: _op.pow, ast.LShift: _op.lshift, ast.RShift: _op.rshift,
  ast.BitOr: _op.or_, ast.BitXor: _op.xor, ast.BitAnd: _op.and_, ast.MatMult: _op.matmul,
}
_GLPYTHON_COMPARE_OPS = {
  ast.Eq: _op.eq, ast.NotEq: _op.ne, ast.Lt: _op.lt, ast.LtE: _op.le, ast.Gt: _op.gt, ast.GtE: _op.ge,
  ast.Is: _op.is_, ast.IsNot: _op.is_not,
  ast.In: (lambda a, b: a in b), ast.NotIn: (lambda a, b: a not in b),
}
_GLPYTHON_UNARY_OPS = {
  ast.UAdd: _op.pos, ast.USub: _op.neg, ast.Not: _op.not_, ast.Invert: _op.invert,
}

def _glpython_is_uninteresting_for_substitution(value):
  # Callables/modules evaluate to themselves via a bare Name lookup (e.g. the
  # "add" in "add(x, 4)"). Their repr ("<function add at 0x...>") is visual
  # noise inline in the source, so we skip substituting them and let the
  # enclosing Call node's own eval step show the real result instead.
  return callable(value) or isinstance(value, _glpython_types.ModuleType)

def _glpython_safe_repr(value, limit=160):
  try:
    text = repr(value)
  except Exception:
    text = "<unrepresentable>"
  if len(text) > limit:
    text = text[: limit - 1] + "…"
  return text

def _glpython_describe_for_locals_panel(value):
  # Callables/modules/classes have a noisy, memory-address-bearing repr
  # (e.g. "<function fact at 0x7f3a2c0a1b80>") that's irrelevant to a
  # learner - the vars panel only needs to communicate *what kind of thing*
  # the name refers to, not its identity/address.
  if isinstance(value, _GlpythonFunction) or isinstance(value, (_glpython_types.FunctionType, _glpython_types.BuiltinFunctionType, _glpython_types.LambdaType)):
    return "function"
  if isinstance(value, type):
    return "class"
  if isinstance(value, _glpython_types.ModuleType):
    return "module"
  return _glpython_safe_repr(value)

# ---------------------------------------------------------------------------
# Scopes: a simple chain of dict-based frames. Each function call / class body
# pushes a new frame; module-level code uses the bottom-most frame. Name
# resolution walks outward like real Python's LEGB rule (simplified: no
# distinct "enclosing" vs "global" special-casing beyond walking the chain).
# ---------------------------------------------------------------------------
class _GlpythonScope:
  def __init__(self, vars_dict, parent=None, kind="module"):
    self.vars = vars_dict
    self.parent = parent
    self.kind = kind

  def get(self, name):
    scope = self
    while scope is not None:
      if name in scope.vars:
        return scope.vars[name]
      scope = scope.parent if scope.kind != "function" else scope.module_scope
    import builtins
    if hasattr(builtins, name):
      return getattr(builtins, name)
    raise NameError(f"name '{name}' is not defined")

  def set(self, name, value):
    self.vars[name] = value

  def set_nonlocal_or_global(self, name, value, is_global):
    target = self.module_scope if is_global else (self.parent or self)
    target.vars[name] = value

_glpython_module_scope = None

def _glpython_make_function_scope(vars_dict):
  scope = _GlpythonScope(vars_dict, parent=None, kind="function")
  scope.module_scope = _glpython_module_scope
  return scope

# ---------------------------------------------------------------------------
# Step recording. Every recorded step captures a source span (line/col) and,
# for expression steps, the substituted display text to show for that node
# once evaluated (e.g. "3 * 4" -> "12"), which is exactly what lets the UI
# show sub-expressions collapsing into their computed values one at a time.
# ---------------------------------------------------------------------------
_glpython_trace_log = []
_glpython_step_count = 0
_glpython_stdout_len = 0
_glpython_graphics_commands = None
_glpython_call_depth = 0
_GLPYTHON_MAX_CALL_DEPTH = 200
# Node ids whose "eval" step should never be shown as an inline substitution
# even though they're otherwise substitutable (e.g. a for-loop's iterable
# expression "range(3)" - the user should always see the call as written,
# not collapsed to its result "range(0, 3)", since it's the loop-iter step's
# own annotation that communicates the current value instead).
_glpython_suppress_substitution_ids = set()

# Call-frame tracking, used to render a boxed "def foo(a=1):" frame at a
# user-defined function's call site (instead of jumping the highlight to its
# definition elsewhere in the file). Every frame gets a unique, ever-
# increasing id (module scope is frame 0); _glpython_frame_stack is the
# current call chain of frame ids, and every recorded step automatically
# tags itself with the frame it executed in (see _glpython_record), so the
# UI can later filter "just this frame's steps" to render its box content
# and figure out which frames are still open at any point in the trace.
_glpython_frame_id_counter = 0
_glpython_frame_stack = [0]
# Set by _eval_call immediately before invoking a callable, and consumed
# (read once, then cleared) by _GlpythonFunction.__call__ so it can anchor
# its call-enter step at the exact Call node - this only works because
# execution is single-threaded and synchronous, so no other call can be
# "in flight" between the two. Left as None for anything that isn't a
# _GlpythonFunction (builtins never read it), and cleared before it could
# ever be misattributed to some unrelated inner call the builtin makes.
_glpython_pending_call_node = None
# Set by _GlpythonFunction.__call__ right before it returns, so _eval_call
# can tag its own closing "eval" step with the frame id that just finished -
# this is what lets the UI know exactly which step collapses which box.
_glpython_last_call_frame_id = None

class _GlpythonCallDepthExceeded(Exception):
  pass

def _glpython_pos(node):
  return (getattr(node, "lineno", None), getattr(node, "end_lineno", None), getattr(node, "col_offset", None), getattr(node, "end_col_offset", None))

def _glpython_record(node, kind, label, value_text=None, func_name="<module>", extra_locals=None, reset_node_ids=None, annotate_node_id=None, annotate_text=None, closes_frame_id=None):
  global _glpython_step_count
  if getattr(node, "_glpython_id", None) in _glpython_suppress_substitution_ids:
    # These are the sub-expressions of a for-loop's own iterable
    # ("range(3)" in "for i in range(3):") - their substitution is always
    # suppressed (see _exec_for) so the header never collapses to the
    # iterable's value, which means a step recorded here would show
    # literally nothing new: same line, same text, no annotation. Skip
    # recording it rather than giving the learner a no-op step to click
    # through; the loop-iter step right after is what actually changes.
    return
  if _glpython_step_count >= _GLPYTHON_MAX_STEPS:
    raise _GlpythonTraceLimit()
  line, end_line, col, end_col = _glpython_pos(node)
  if line is None:
    return
  entry = {
    "step": _glpython_step_count,
    "path": _glpython_current_path,
    "func": func_name,
    "line": line,
    "endLine": end_line if end_line is not None else line,
    "col": col if col is not None else 0,
    "endCol": end_col if end_col is not None else 0,
    "kind": kind,
    "label": label,
    "nodeId": getattr(node, "_glpython_id", None),
    "valueText": value_text,
    "locals": extra_locals or {},
    "stdoutLen": _glpython_stdout_len,
    "graphicsLen": len(_glpython_graphics_commands) if _glpython_graphics_commands is not None else 0,
    "resetNodeIds": reset_node_ids or [],
    "annotateNodeId": annotate_node_id,
    "annotateText": annotate_text,
    # Which call frame this step executed in (0 = module scope) - see the
    # call-frame tracking globals above.
    "frameId": _glpython_frame_stack[-1],
    "parentFrameId": None,
    "funcDefNodeId": None,
    "funcDefPath": None,
    "paramAnnotations": [],
    "argSources": [],
    # Set only on the "eval" step of a Call node that just finished running
    # a user-defined function - tells the UI which frame's box just closed
    # and should collapse to this step's substituted return value.
    "closesFrameId": closes_frame_id,
    "lookupName": None,
    "lookupFrameId": None,
  }
  _glpython_trace_log.append(entry)
  _glpython_step_count += 1

def _glpython_record_call_pending(call_node, name, scope):
  # Recorded right before a user-defined function call actually enters -
  # once its own function value *and* every argument have already been
  # resolved/substituted (so the call site reads e.g. "fact(2)", not
  # "fact(n - 1)"), but before the callee's own frame box appears. Lets the
  # UI show that fully-substituted call highlighted as plain text first,
  # with an arrow from name's own row in whichever frame defines it
  # (lookupFrameId) into the call - representing "looking up the
  # function" - before the next step opens its frame (see
  # nextStepPendingCall in App.tsx, which still keys off the *following*
  # "call-enter" step and so naturally only kicks in one step later now).
  global _glpython_step_count
  if _glpython_step_count >= _GLPYTHON_MAX_STEPS:
    raise _GlpythonTraceLimit()
  line, end_line, col, end_col = _glpython_pos(call_node)
  if line is None:
    return
  # This interpreter's simplified scope chain (see _GlpythonScope above)
  # only ever has at most two levels for any given name: the current
  # function's own vars, or the module scope - so resolving which frame
  # "owns" name never needs a real walk, just this one check.
  lookup_frame_id = _glpython_frame_stack[-1] if (scope.kind == "function" and name in scope.vars) else 0
  entry = {
    "step": _glpython_step_count,
    "path": _glpython_current_path,
    "func": "<module>",
    "line": line,
    "endLine": end_line if end_line is not None else line,
    "col": col if col is not None else 0,
    "endCol": end_col if end_col is not None else 0,
    "kind": "call-pending",
    "label": f"call {name}(...)",
    "nodeId": getattr(call_node, "_glpython_id", None),
    "valueText": None,
    "locals": {},
    "stdoutLen": _glpython_stdout_len,
    "graphicsLen": len(_glpython_graphics_commands) if _glpython_graphics_commands is not None else 0,
    "resetNodeIds": [],
    "annotateNodeId": None,
    "annotateText": None,
    "frameId": _glpython_frame_stack[-1],
    "parentFrameId": None,
    "funcDefNodeId": None,
    "funcDefPath": None,
    "paramAnnotations": [],
    "argSources": [],
    "closesFrameId": None,
    "lookupName": name,
    "lookupFrameId": lookup_frame_id,
  }
  _glpython_trace_log.append(entry)
  _glpython_step_count += 1

def _glpython_record_call_enter(call_node, glpython_function, frame_id, parent_frame_id, extra_locals, param_annotations, arg_sources=None):
  global _glpython_step_count
  if _glpython_step_count >= _GLPYTHON_MAX_STEPS:
    raise _GlpythonTraceLimit()
  line, end_line, col, end_col = _glpython_pos(call_node)
  if line is None:
    return
  entry = {
    "step": _glpython_step_count,
    "path": _glpython_current_path,
    "func": glpython_function.__name__,
    "line": line,
    "endLine": end_line if end_line is not None else line,
    "col": col if col is not None else 0,
    "endCol": end_col if end_col is not None else 0,
    "kind": "call-enter",
    "label": f"def {glpython_function.__name__}(...)",
    "nodeId": getattr(call_node, "_glpython_id", None),
    "valueText": None,
    "locals": extra_locals or {},
    "stdoutLen": _glpython_stdout_len,
    "graphicsLen": len(_glpython_graphics_commands) if _glpython_graphics_commands is not None else 0,
    "resetNodeIds": [],
    "annotateNodeId": None,
    "annotateText": None,
    "frameId": frame_id,
    "parentFrameId": parent_frame_id,
    "funcDefNodeId": getattr(glpython_function.node, "_glpython_id", None),
    "funcDefPath": glpython_function.def_path,
    "paramAnnotations": param_annotations or [],
    # The name of each plain positionally-passed parameter this call binds.
    # Lets the UI draw an arrow from that parameter's bound value - shown
    # one step early right in the callee's own "def f(n=3):" header via
    # paramAnnotations above - into that parameter's own (one-step-early,
    # valueless) placeholder row in the callee's about-to-open locals panel.
    # See "argSources"/"nextStepPendingCall" on the frontend. Keyword args,
    # *args/**kwargs, and defaulted-but-omitted params are left out, same
    # simplification as paramAnnotations above only covering positional
    # params.
    "argSources": arg_sources or [],
    "closesFrameId": None,
    "lookupName": None,
    "lookupFrameId": None,
  }
  _glpython_trace_log.append(entry)
  _glpython_step_count += 1

def _glpython_snapshot_locals(scope, limit=80):
  # Only the scope's *own* vars are captured - a frame's panel should show
  # exactly what that frame itself holds (e.g. a function's own locals, or
  # the module's own top-level names), not names inherited/visible via LEGB
  # name resolution from an enclosing scope. In particular this keeps a
  # function's own name showing up only in the frame where it was defined
  # (typically the module frame), not re-appearing in every call frame that
  # happens to be able to look it up.
  snapshot = {}
  count = 0
  for name, value in scope.vars.items():
    if count >= limit:
      break
    if name.startswith("_glpython") or (name.startswith("__") and name.endswith("__")):
      continue
    snapshot[name] = _glpython_describe_for_locals_panel(value)
    count += 1
  return snapshot

_glpython_current_path = None
_glpython_current_func_stack = ["<module>"]

def _glpython_current_func():
  return _glpython_current_func_stack[-1]

# ---------------------------------------------------------------------------
# Fallback: compiles/evaluates a single AST node against the current scope
# using the real Python compiler. Used for constructs without a dedicated
# hand-written handler yet (this is the designed extension point - moving a
# node type out of the fallback just means adding a case to _EXPR_HANDLERS /
# _STMT_HANDLERS below).
# ---------------------------------------------------------------------------
def _glpython_flatten_scope(scope):
  merged = {}
  cursor = scope
  chain = []
  while cursor is not None:
    chain.append(cursor)
    cursor = cursor.module_scope if cursor.kind == "function" else cursor.parent
  for frame in reversed(chain):
    merged.update(frame.vars)
  return merged

def _glpython_fallback_eval(node, scope):
  expr = ast.Expression(body=node)
  ast.fix_missing_locations(expr)
  code = compile(expr, "<glpython>", "eval")
  return eval(code, _glpython_flatten_scope(scope))

def _glpython_fallback_exec(node, scope):
  module = ast.Module(body=[node], type_ignores=[])
  ast.fix_missing_locations(module)
  code = compile(module, "<glpython>", "exec")
  env = _glpython_flatten_scope(scope)
  exec(code, env)
  # Write back any names the fallback statement touched so subsequent
  # hand-rolled statements see the effects (best-effort: module-level and
  # local names only, matching this interpreter's simplified scoping model).
  for name, value in env.items():
    if not name.startswith("__") and (name in scope.vars or scope.parent is None):
      scope.vars[name] = value

def _glpython_summary_for_node(node):
  return getattr(node, "_glpython_summary", type(node).__name__)

# ---------------------------------------------------------------------------
# Expression evaluation. Returns the Python value of the node, recording an
# "eval" step (with the substituted display text) for node types that have a
# meaningful standalone value worth showing collapsing in place.
# ---------------------------------------------------------------------------
def _glpython_node_source(node):
  return getattr(node, "_glpython_source", _glpython_summary_for_node(node))

def _glpython_eval(node, scope):
  handler = _EXPR_HANDLERS.get(type(node))
  if handler is None:
    value = _glpython_fallback_eval(node, scope)
    _glpython_record(node, "eval", _glpython_node_source(node), _glpython_safe_repr(value), _glpython_current_func())
    return value
  return handler(node, scope)

def _eval_constant(node, scope):
  return node.value

def _eval_name(node, scope):
  value = scope.get(node.id)
  value_text = None if _glpython_is_uninteresting_for_substitution(value) else _glpython_safe_repr(value)
  _glpython_record(node, "eval", node.id, value_text, _glpython_current_func())
  return value

def _eval_binop(node, scope):
  left = _glpython_eval(node.left, scope)
  right = _glpython_eval(node.right, scope)
  op_func = _GLPYTHON_BINOPS.get(type(node.op))
  value = op_func(left, right) if op_func else _glpython_fallback_eval(node, scope)
  symbol = _GLPYTHON_OP_SYMBOLS.get(type(node.op), "?")
  _glpython_record(node, "eval", f"{_glpython_safe_repr(left, 40)} {symbol} {_glpython_safe_repr(right, 40)}", _glpython_safe_repr(value), _glpython_current_func())
  return value

def _eval_unaryop(node, scope):
  operand = _glpython_eval(node.operand, scope)
  op_func = _GLPYTHON_UNARY_OPS.get(type(node.op))
  value = op_func(operand) if op_func else _glpython_fallback_eval(node, scope)
  symbol = _GLPYTHON_OP_SYMBOLS.get(type(node.op), "?")
  _glpython_record(node, "eval", f"{symbol}{_glpython_safe_repr(operand, 40)}", _glpython_safe_repr(value), _glpython_current_func())
  return value

def _eval_boolop(node, scope):
  symbol = _GLPYTHON_OP_SYMBOLS.get(type(node.op), "?")
  result = None
  evaluated_texts = []
  for index, value_node in enumerate(node.values):
    result = _glpython_eval(value_node, scope)
    evaluated_texts.append(_glpython_safe_repr(result, 40))
    if isinstance(node.op, ast.And) and not result:
      break
    if isinstance(node.op, ast.Or) and result:
      break
  _glpython_record(node, "eval", (" " + symbol + " ").join(evaluated_texts), _glpython_safe_repr(result), _glpython_current_func())
  return result

def _eval_compare(node, scope):
  left = _glpython_eval(node.left, scope)
  parts = [_glpython_safe_repr(left, 40)]
  result = True
  current = left
  for op, comparator_node in zip(node.ops, node.comparators):
    right = _glpython_eval(comparator_node, scope)
    op_func = _GLPYTHON_COMPARE_OPS.get(type(op))
    step_result = op_func(current, right) if op_func else _glpython_fallback_eval(node, scope)
    parts.append(_GLPYTHON_OP_SYMBOLS.get(type(op), "?"))
    parts.append(_glpython_safe_repr(right, 40))
    result = result and step_result
    current = right
    if not result:
      break
  _glpython_record(node, "eval", " ".join(parts), _glpython_safe_repr(result), _glpython_current_func())
  return result

def _eval_ifexp(node, scope):
  condition = _glpython_eval(node.test, scope)
  chosen = node.body if condition else node.orelse
  value = _glpython_eval(chosen, scope)
  _glpython_record(node, "eval", _glpython_node_source(node), _glpython_safe_repr(value), _glpython_current_func())
  return value

def _eval_list(node, scope):
  values = [_glpython_eval(item, scope) for item in node.elts]
  _glpython_record(node, "eval", _glpython_node_source(node), _glpython_safe_repr(values), _glpython_current_func())
  return values

def _eval_tuple(node, scope):
  values = tuple(_glpython_eval(item, scope) for item in node.elts)
  _glpython_record(node, "eval", _glpython_node_source(node), _glpython_safe_repr(values), _glpython_current_func())
  return values

def _eval_set(node, scope):
  values = {_glpython_eval(item, scope) for item in node.elts}
  _glpython_record(node, "eval", _glpython_node_source(node), _glpython_safe_repr(values), _glpython_current_func())
  return values

def _eval_dict(node, scope):
  result = {}
  for key_node, value_node in zip(node.keys, node.values):
    if key_node is None:
      result.update(_glpython_eval(value_node, scope))
    else:
      result[_glpython_eval(key_node, scope)] = _glpython_eval(value_node, scope)
  _glpython_record(node, "eval", _glpython_node_source(node), _glpython_safe_repr(result), _glpython_current_func())
  return result

def _eval_attribute(node, scope):
  target = _glpython_eval(node.value, scope)
  value = getattr(target, node.attr)
  value_text = None if _glpython_is_uninteresting_for_substitution(value) else _glpython_safe_repr(value)
  _glpython_record(node, "eval", f"{_glpython_safe_repr(target, 30)}.{node.attr}", value_text, _glpython_current_func())
  return value

def _eval_subscript(node, scope):
  target = _glpython_eval(node.value, scope)
  index = _glpython_eval(node.slice, scope)
  value = target[index]
  _glpython_record(node, "eval", f"{_glpython_safe_repr(target, 30)}[{_glpython_safe_repr(index, 20)}]", _glpython_safe_repr(value), _glpython_current_func())
  return value

def _eval_slice(node, scope):
  lower = _glpython_eval(node.lower, scope) if node.lower else None
  upper = _glpython_eval(node.upper, scope) if node.upper else None
  step = _glpython_eval(node.step, scope) if node.step else None
  return slice(lower, upper, step)

def _eval_joinedstr(node, scope):
  parts = []
  for value_node in node.values:
    if isinstance(value_node, ast.Constant):
      parts.append(str(value_node.value))
    else:
      parts.append(str(_glpython_eval(value_node, scope)))
  value = "".join(parts)
  _glpython_record(node, "eval", _glpython_node_source(node), _glpython_safe_repr(value), _glpython_current_func())
  return value

def _eval_formattedvalue(node, scope):
  value = _glpython_eval(node.value, scope)
  return format(value, "") if node.format_spec is None else value

def _eval_starred(node, scope):
  return _glpython_eval(node.value, scope)

# ---------------------------------------------------------------------------
# User-defined functions are represented by this small callable wrapper so
# calling them re-enters the interpreter (pushing a fresh scope) instead of
# falling back to real Python - this is what lets steps inside student
# functions show up in the trace with correct locals per call.
# ---------------------------------------------------------------------------
class _GlpythonFunction:
  def __init__(self, node, closure_scope, name=None):
    self.node = node
    self.closure_scope = closure_scope
    self.__name__ = name or node.name
    # The file this "def" itself lives in, so a call-enter step recorded at
    # the *call site* (possibly in a different file, e.g. calling into an
    # imported module) can still tell the UI where to find the function's
    # own source for its box content.
    self.def_path = _glpython_current_path

  def __call__(self, *args, **kwargs):
    global _glpython_call_depth, _glpython_frame_id_counter, _glpython_pending_call_node, _glpython_last_call_frame_id
    # Consumed immediately, before anything else can overwrite it - see the
    # comment on _glpython_pending_call_node above.
    call_node = _glpython_pending_call_node
    _glpython_pending_call_node = None
    _glpython_call_depth += 1
    if _glpython_call_depth > _GLPYTHON_MAX_CALL_DEPTH:
      _glpython_call_depth -= 1
      raise RecursionError("maximum interpreted recursion depth exceeded")
    frame_id = None
    try:
      call_vars = {}
      arguments = self.node.args
      positional_names = [a.arg for a in arguments.args]
      for index, name in enumerate(positional_names):
        if index < len(args):
          call_vars[name] = args[index]
      defaults = arguments.defaults
      if defaults:
        default_offset = len(positional_names) - len(defaults)
        for index, default_node in enumerate(defaults):
          name = positional_names[default_offset + index]
          if name not in call_vars:
            call_vars[name] = _glpython_eval(default_node, self.closure_scope)
      for name, value in kwargs.items():
        call_vars[name] = value
      if arguments.vararg:
        call_vars[arguments.vararg.arg] = args[len(positional_names):]
      if arguments.kwarg:
        call_vars[arguments.kwarg.arg] = {k: v for k, v in kwargs.items() if k not in positional_names}
      scope = _glpython_make_function_scope(call_vars)
      _glpython_current_func_stack.append(self.__name__)
      if call_node is not None:
        _glpython_frame_id_counter += 1
        frame_id = _glpython_frame_id_counter
        parent_frame_id = _glpython_frame_stack[-1]
        _glpython_frame_stack.append(frame_id)
        param_annotations = []
        for arg_node in arguments.args:
          if arg_node.arg in call_vars:
            arg_id = getattr(arg_node, "_glpython_id", None)
            if arg_id is not None:
              # The parameter's own name is carried alongside its node id
              # and "=value" text so the UI can match this annotation back
              # to the matching entry in arg_sources below by name (the two
              # lists aren't necessarily parallel/same-length, e.g. a
              # defaulted-but-omitted param has no arg_sources entry).
              param_annotations.append([arg_id, "=" + _glpython_safe_repr(call_vars[arg_node.arg]), arg_node.arg])
        # The names of the plain positionally-passed parameters this call
        # actually supplies a value for - lets the UI know which parameters
        # to show as one-step-early placeholder rows (and which to draw a
        # connector arrow for, from that parameter's own "=value" annotation
        # in param_annotations above). Starred ("*xs") arguments and
        # anything passed by keyword aren't included, same simplification
        # as elsewhere in this file.
        arg_sources = []
        call_args = getattr(call_node, "args", None) or []
        for index, name in enumerate(positional_names):
          if index >= len(call_args) or isinstance(call_args[index], ast.Starred):
            continue
          arg_sources.append(name)
        _glpython_record_call_enter(call_node, self, frame_id, parent_frame_id, _glpython_snapshot_locals(scope), param_annotations, arg_sources)
      try:
        _glpython_exec_stmts(self.node.body, scope)
        return None
      except _GlpythonReturn as ret:
        return ret.value
      finally:
        _glpython_current_func_stack.pop()
        if call_node is not None:
          _glpython_frame_stack.pop()
    finally:
      _glpython_last_call_frame_id = frame_id
      _glpython_call_depth -= 1

def _eval_call(node, scope, suppress_none_result=False):
  global _glpython_pending_call_node, _glpython_last_call_frame_id
  func_ids = getattr(node, "_glpython_func_ids", None) or []
  _glpython_suppress_substitution_ids.update(func_ids)
  try:
    func = _glpython_eval(node.func, scope)
  finally:
    _glpython_suppress_substitution_ids.difference_update(func_ids)
  args = []
  for arg_node in node.args:
    if isinstance(arg_node, ast.Starred):
      args.extend(_glpython_eval(arg_node, scope))
    else:
      args.append(_glpython_eval(arg_node, scope))
  kwargs = {}
  for kw in node.keywords:
    if kw.arg is None:
      kwargs.update(_glpython_eval(kw.value, scope))
    else:
      kwargs[kw.arg] = _glpython_eval(kw.value, scope)
  # Only recorded for a plain "name(...)" call into a user-defined function
  # (the only case that goes on to open a callee frame box, and the only
  # case where "which row does this name live in" is answerable at all -
  # an arbitrary callable expression like "funcs[0]()" has no single
  # locals-panel row to point an arrow at).
  if isinstance(func, _GlpythonFunction) and isinstance(node.func, ast.Name):
    _glpython_record_call_pending(node, node.func.id, scope)
  _glpython_pending_call_node = node
  _glpython_last_call_frame_id = None
  value = func(*args, **kwargs)
  closes_frame_id = _glpython_last_call_frame_id
  _glpython_pending_call_node = None
  callee_name = getattr(func, "__name__", _glpython_node_source(node.func))
  # A bare "f(...)" statement whose result nobody uses shouldn't have its
  # call text replaced with the word "None" once it finishes - that's just
  # visual noise, not insight (this is the overwhelmingly common case for
  # side-effecting calls like print(...) or a student function with no
  # return). Calls whose value IS used (an assignment, part of a bigger
  # expression, etc.) still show "None" normally, since that's genuinely
  # useful feedback there.
  value_text = None if (suppress_none_result and value is None) else _glpython_safe_repr(value)
  _glpython_record(node, "eval", f"{callee_name}(...)", value_text, _glpython_current_func(), closes_frame_id=closes_frame_id)
  return value

def _eval_lambda(node, scope):
  return _GlpythonFunction(ast.FunctionDef(name="<lambda>", args=node.args, body=[ast.Return(value=node.body)], decorator_list=[], returns=None, type_comment=None, lineno=node.lineno, col_offset=node.col_offset, end_lineno=node.end_lineno, end_col_offset=node.end_col_offset), scope)

_EXPR_HANDLERS = {
  ast.Constant: _eval_constant,
  ast.Name: _eval_name,
  ast.BinOp: _eval_binop,
  ast.UnaryOp: _eval_unaryop,
  ast.BoolOp: _eval_boolop,
  ast.Compare: _eval_compare,
  ast.IfExp: _eval_ifexp,
  ast.List: _eval_list,
  ast.Tuple: _eval_tuple,
  ast.Set: _eval_set,
  ast.Dict: _eval_dict,
  ast.Attribute: _eval_attribute,
  ast.Subscript: _eval_subscript,
  ast.Slice: _eval_slice,
  ast.JoinedStr: _eval_joinedstr,
  ast.FormattedValue: _eval_formattedvalue,
  ast.Starred: _eval_starred,
  ast.Call: _eval_call,
  ast.Lambda: _eval_lambda,
}

# ---------------------------------------------------------------------------
# Statement execution. _glpython_exec_stmts runs a list of statements in
# order (used for module bodies, function bodies, and - importantly - loop
# bodies, which are simply re-run in full for every iteration so the UI
# naturally "resets" the block's steps each time around).
# ---------------------------------------------------------------------------
def _glpython_assign_target(target, value, scope):
  if isinstance(target, ast.Name):
    scope.set(target.id, value)
  elif isinstance(target, (ast.Tuple, ast.List)):
    values = list(value)
    star_index = next((i for i, element in enumerate(target.elts) if isinstance(element, ast.Starred)), None)
    if star_index is None:
      for element, item in zip(target.elts, values):
        _glpython_assign_target(element, item, scope)
    else:
      before = target.elts[:star_index]
      after = target.elts[star_index + 1:]
      for element, item in zip(before, values[:len(before)]):
        _glpython_assign_target(element, item, scope)
      tail_count = len(after)
      _glpython_assign_target(target.elts[star_index].value, values[len(before): len(values) - tail_count], scope)
      for element, item in zip(after, values[len(values) - tail_count:]):
        _glpython_assign_target(element, item, scope)
  elif isinstance(target, ast.Attribute):
    obj = _glpython_eval(target.value, scope)
    setattr(obj, target.attr, value)
  elif isinstance(target, ast.Subscript):
    obj = _glpython_eval(target.value, scope)
    index = _glpython_eval(target.slice, scope)
    obj[index] = value
  else:
    raise NotImplementedError(f"unsupported assignment target: {type(target).__name__}")

def _exec_assign(node, scope):
  value = _glpython_eval(node.value, scope)
  for target in node.targets:
    _glpython_assign_target(target, value, scope)
  names = ", ".join(_glpython_node_source(target) for target in node.targets)
  _glpython_record(node, "exec", f"{names} = {_glpython_safe_repr(value)}", None, _glpython_current_func(), _glpython_snapshot_locals(scope))

def _exec_augassign(node, scope):
  current = _glpython_eval(node.target, scope) if not isinstance(node.target, ast.Name) else scope.get(node.target.id)
  right = _glpython_eval(node.value, scope)
  op_func = _GLPYTHON_BINOPS.get(type(node.op))
  new_value = op_func(current, right) if op_func else _glpython_fallback_eval(ast.BinOp(left=ast.Constant(value=current), op=node.op, right=ast.Constant(value=right), lineno=node.lineno, col_offset=node.col_offset, end_lineno=node.end_lineno, end_col_offset=node.end_col_offset), scope)
  _glpython_assign_target(node.target, new_value, scope)
  symbol = _GLPYTHON_OP_SYMBOLS.get(type(node.op), "?")
  _glpython_record(node, "exec", f"{_glpython_node_source(node.target)} {symbol}= {_glpython_safe_repr(right)}", _glpython_safe_repr(new_value), _glpython_current_func(), _glpython_snapshot_locals(scope))

def _exec_annassign(node, scope):
  if node.value is not None:
    value = _glpython_eval(node.value, scope)
    _glpython_assign_target(node.target, value, scope)
    _glpython_record(node, "exec", f"{_glpython_node_source(node.target)} = {_glpython_safe_repr(value)}", None, _glpython_current_func(), _glpython_snapshot_locals(scope))

def _exec_expr(node, scope):
  # A bare expression statement's value is always discarded by Python
  # itself, so if it's a plain call ("f(...)" on its own line), tell
  # _eval_call not to show "-> None" when that's all it computed - see the
  # comment on _eval_call's suppress_none_result parameter.
  if isinstance(node.value, ast.Call):
    return _eval_call(node.value, scope, suppress_none_result=True)
  return _glpython_eval(node.value, scope)

def _exec_pass(node, scope):
  pass

def _exec_if(node, scope):
  condition = _glpython_eval(node.test, scope)
  _glpython_record(node, "branch", f"if {_glpython_node_source(node.test)}", "true" if condition else "false", _glpython_current_func())
  branch = node.body if condition else node.orelse
  _glpython_exec_stmts(branch, scope)

def _exec_while(node, scope):
  body_ids = getattr(node, "_glpython_body_ids", None) or []
  test_ids = getattr(node, "_glpython_test_ids", None) or []
  reset_ids = body_ids + test_ids
  while True:
    # Reset the condition (and body) back to their un-substituted source
    # right before re-evaluating the condition, so "while x >= 0:" visibly
    # reverts from the previous iteration's "while True:" before collapsing
    # to its new result, the same way the body resets before re-running.
    _glpython_record(node.test, "loop-iter", f"while {_glpython_node_source(node.test)}", None, _glpython_current_func(), reset_node_ids=reset_ids)
    condition = _glpython_eval(node.test, scope)
    _glpython_record(node, "branch", f"while {_glpython_node_source(node.test)}", "true" if condition else "false", _glpython_current_func())
    if not condition:
      break
    try:
      _glpython_exec_stmts(node.body, scope)
    except _GlpythonBreak:
      break
    except _GlpythonContinue:
      continue
  if node.orelse:
    _glpython_exec_stmts(node.orelse, scope)

def _exec_for(node, scope):
  iter_ids = getattr(node, "_glpython_iter_ids", None) or []
  _glpython_suppress_substitution_ids.update(iter_ids)
  try:
    iterable = _glpython_eval(node.iter, scope)
  finally:
    _glpython_suppress_substitution_ids.difference_update(iter_ids)
  body_ids = getattr(node, "_glpython_body_ids", None)
  # Only a plain "for x in ...:" target gets the inline "=value" annotation;
  # tuple/list unpacking targets (e.g. "for k, v in ...") are left alone for
  # now rather than guessing which name to annotate.
  target_id = node.target._glpython_id if isinstance(node.target, ast.Name) else None
  finished_normally = True
  for item in iterable:
    _glpython_assign_target(node.target, item, scope)
    _glpython_record(node, "loop-iter", f"for {_glpython_node_source(node.target)} in {_glpython_node_source(node.iter)}", None, _glpython_current_func(), _glpython_snapshot_locals(scope), reset_node_ids=body_ids, annotate_node_id=target_id, annotate_text=f"={_glpython_safe_repr(item)}")
    try:
      _glpython_exec_stmts(node.body, scope)
    except _GlpythonBreak:
      finished_normally = False
      break
    except _GlpythonContinue:
      continue
  if node.orelse and finished_normally:
    _glpython_exec_stmts(node.orelse, scope)

def _exec_break(node, scope):
  raise _GlpythonBreak()

def _exec_continue(node, scope):
  raise _GlpythonContinue()

def _exec_return(node, scope):
  value = _glpython_eval(node.value, scope) if node.value is not None else None
  # If node.value just got its own "eval" step on this very line (e.g.
  # "return result" substituting "result" -> "'even'"), the box already
  # shows the returned value - recording a second step for the "return"
  # keyword itself would be a no-op click (same line, same text). Only a
  # bare "return" or a value whose evaluation didn't produce a step of its
  # own (e.g. a literal constant) still needs its own record here.
  value_node_id = getattr(node.value, "_glpython_id", None) if node.value is not None else None
  last = _glpython_trace_log[-1] if _glpython_trace_log else None
  already_visible = (
    last is not None
    and value_node_id is not None
    and last["nodeId"] == value_node_id
    and last["line"] == node.lineno
  )
  if not already_visible:
    _glpython_record(node, "exec", "return", _glpython_safe_repr(value), _glpython_current_func())
  raise _GlpythonReturn(value)

def _exec_functiondef(node, scope):
  scope.set(node.name, _GlpythonFunction(node, scope))
  # Attach a locals snapshot so the defining frame's vars panel picks up the
  # newly-bound function name right away, instead of waiting for some later,
  # unrelated statement in that same frame to happen to snapshot locals.
  _glpython_record(node, "exec", f"def {node.name}(...)", None, _glpython_current_func(), _glpython_snapshot_locals(scope))

def _exec_classdef(node, scope):
  # Classes fall back to the real compiler for their whole body: this keeps
  # inheritance/metaclasses/descriptors correct without hand-writing them,
  # at the cost of the class body replaying as a single opaque step. A
  # dedicated handler (interpreting the body statement-by-statement into a
  # constructed type()) is a natural future extension here.
  _glpython_fallback_exec(node, scope)
  _glpython_record(node, "exec", f"class {node.name}", None, _glpython_current_func(), _glpython_snapshot_locals(scope))

def _exec_import(node, scope):
  _glpython_fallback_exec(node, scope)
  _glpython_record(node, "exec", _glpython_node_source(node), None, _glpython_current_func(), _glpython_snapshot_locals(scope))

def _exec_raise(node, scope):
  if node.exc is None:
    raise
  exc_value = _glpython_eval(node.exc, scope)
  _glpython_record(node, "exec", f"raise {_glpython_safe_repr(exc_value)}", None, _glpython_current_func())
  if node.cause is not None:
    cause_value = _glpython_eval(node.cause, scope)
    raise exc_value from cause_value
  raise exc_value

def _exec_try(node, scope):
  try:
    _glpython_exec_stmts(node.body, scope)
  except (_GlpythonBreak, _GlpythonContinue, _GlpythonReturn, _GlpythonTraceLimit):
    raise
  except BaseException as error:
    for handler in node.handlers:
      matches = True
      if handler.type is not None:
        exc_type = _glpython_eval(handler.type, scope)
        matches = isinstance(error, exc_type) if isinstance(exc_type, type) or isinstance(exc_type, tuple) else False
      if matches:
        _glpython_record(node, "exec", f"except {_glpython_node_source(handler.type) if handler.type else ''}", _glpython_safe_repr(error), _glpython_current_func())
        if handler.name:
          scope.set(handler.name, error)
        _glpython_exec_stmts(handler.body, scope)
        break
    else:
      raise
  else:
    if node.orelse:
      _glpython_exec_stmts(node.orelse, scope)
  finally:
    if node.finalbody:
      _glpython_exec_stmts(node.finalbody, scope)

def _exec_with(node, scope):
  _glpython_fallback_exec(node, scope)
  _glpython_record(node, "exec", _glpython_node_source(node), None, _glpython_current_func())

def _exec_global(node, scope):
  for name in node.names:
    if name in _glpython_module_scope.vars:
      scope.vars[name] = _glpython_module_scope.vars[name]

def _exec_delete(node, scope):
  for target in node.targets:
    if isinstance(target, ast.Name) and target.id in scope.vars:
      del scope.vars[target.id]

_STMT_HANDLERS = {
  ast.Assign: _exec_assign,
  ast.AugAssign: _exec_augassign,
  ast.AnnAssign: _exec_annassign,
  ast.Expr: _exec_expr,
  ast.Pass: _exec_pass,
  ast.If: _exec_if,
  ast.While: _exec_while,
  ast.For: _exec_for,
  ast.Break: _exec_break,
  ast.Continue: _exec_continue,
  ast.Return: _exec_return,
  ast.FunctionDef: _exec_functiondef,
  ast.ClassDef: _exec_classdef,
  ast.Import: _exec_import,
  ast.ImportFrom: _exec_import,
  ast.Raise: _exec_raise,
  ast.Try: _exec_try,
  ast.With: _exec_with,
  ast.Global: _exec_global,
  ast.Delete: _exec_delete,
}

def _glpython_exec_stmt(node, scope):
  handler = _STMT_HANDLERS.get(type(node))
  if handler is None:
    _glpython_fallback_exec(node, scope)
    _glpython_record(node, "exec", _glpython_node_source(node), None, _glpython_current_func(), _glpython_snapshot_locals(scope))
    return
  handler(node, scope)

def _glpython_exec_stmts(statements, scope):
  for statement in statements:
    _glpython_exec_stmt(statement, scope)

# ---------------------------------------------------------------------------
# AST preprocessing: assigns every node a stable id (shared between the trace
# steps' "nodeId" and the AST-as-JSON tree sent to the UI) plus a short
# human-readable summary and its exact original source text (used as the
# step label / substituted-value placeholder text).
# ---------------------------------------------------------------------------
def _glpython_summary(node):
  kind = type(node).__name__
  try:
    if kind == "Name":
      return node.id
    if kind == "Constant":
      return _glpython_safe_repr(node.value, 40)
    if kind in ("FunctionDef", "AsyncFunctionDef", "ClassDef"):
      return node.name
    if kind == "Attribute":
      return "." + node.attr
    if kind == "arg":
      return node.arg
    if kind == "Compare":
      return "".join(_GLPYTHON_OP_SYMBOLS.get(type(op), "?") for op in node.ops)
    if kind in ("BinOp", "BoolOp", "UnaryOp", "AugAssign"):
      return _GLPYTHON_OP_SYMBOLS.get(type(node.op), "?")
    if kind == "Import":
      return ", ".join(alias.name for alias in node.names)
    if kind == "ImportFrom":
      return node.module or ""
  except Exception:
    pass
  return ""

def _glpython_preprocess(tree, source, counter):
  for node in ast.walk(tree):
    counter[0] += 1
    node._glpython_id = counter[0]
    node._glpython_summary = _glpython_summary(node)
    try:
      segment = ast.get_source_segment(source, node)
    except Exception:
      segment = None
    node._glpython_source = segment if segment is not None else node._glpython_summary or type(node).__name__
  # For/While loops need to tell the UI which node ids belong to their body,
  # so that starting a fresh iteration can clear any inline value
  # substitutions left over from the previous iteration - this is what makes
  # the loop body visibly "reset" to its original source each time around,
  # instead of staying stuck showing the last iteration's computed values.
  for node in ast.walk(tree):
    if isinstance(node, (ast.For, ast.While)):
      body_ids = []
      for stmt in node.body:
        for child in ast.walk(stmt):
          child_id = getattr(child, "_glpython_id", None)
          if child_id is not None:
            body_ids.append(child_id)
      node._glpython_body_ids = body_ids
    if isinstance(node, ast.While):
      # Every node id inside the loop's condition expression, so it can also
      # be reset to its un-substituted source right before each re-check -
      # otherwise "while x >= 0:" would stay collapsed to "while True:" from
      # the previous iteration until the condition's sub-expressions happen
      # to be re-evaluated, instead of visibly reverting first like the body.
      node._glpython_test_ids = [
        child_id
        for child in ast.walk(node.test)
        if (child_id := getattr(child, "_glpython_id", None)) is not None
      ]
    if isinstance(node, ast.For):
      # Every node id inside the loop's iterable expression, so its "eval"
      # step can be suppressed from inline substitution (see
      # _glpython_suppress_substitution_ids) - "range(3)" must always be
      # shown as written, never collapsed to "range(0, 3)".
      node._glpython_iter_ids = [
        child_id
        for child in ast.walk(node.iter)
        if (child_id := getattr(child, "_glpython_id", None)) is not None
      ]
    if isinstance(node, ast.Call) and not any(isinstance(d, ast.Call) for d in ast.walk(node.func)):
      # Every node id inside the callee expression ("print" in
      # "print(f(4))", or "funcs[0]" in "funcs[0](4)") - resolving a
      # callable never has a substitution worth showing (it's always a
      # function/builtin, never a plain value), so recording a step for it
      # would just be a no-op the learner has to click past (see
      # _glpython_suppress_substitution_ids). Suppressing it also means the
      # "next step" preview no longer collapses to that bare callee token;
      # it stays on the whole call expression until the call is genuinely
      # next (see _eval_call). Skipped entirely when the callee expression
      # itself contains a nested call (e.g. "make_adder(5)(3)") so that
      # inner call's own steps still show normally.
      node._glpython_func_ids = [
        child_id
        for child in ast.walk(node.func)
        if (child_id := getattr(child, "_glpython_id", None)) is not None
      ]

def _glpython_ast_to_dict(node):
  if isinstance(node, ast.AST):
    entry = {"id": node._glpython_id, "type": type(node).__name__, "summary": node._glpython_summary}
    if hasattr(node, "lineno"):
      entry["line"] = node.lineno
      entry["endLine"] = getattr(node, "end_lineno", node.lineno)
      entry["col"] = node.col_offset
      entry["endCol"] = getattr(node, "end_col_offset", node.col_offset)
    fields = {}
    for field_name, value in ast.iter_fields(node):
      if isinstance(value, ast.AST):
        fields[field_name] = _glpython_ast_to_dict(value)
      elif isinstance(value, list):
        fields[field_name] = [
          _glpython_ast_to_dict(item) if isinstance(item, ast.AST) else _glpython_safe_repr(item)
          for item in value
        ]
      elif value is not None:
        fields[field_name] = _glpython_safe_repr(value)
    entry["fields"] = fields
    return entry
  return _glpython_safe_repr(node)

class _GlpythonCapture:
  def __init__(self):
    self._chunks = []
  def write(self, text):
    global _glpython_stdout_len
    text = str(text)
    self._chunks.append(text)
    _glpython_stdout_len += len(text)
    return len(text)
  def flush(self):
    pass
  def getvalue(self):
    return "".join(self._chunks)

def _glpython_run_visual():
  global _glpython_trace_log, _glpython_step_count, _glpython_stdout_len, _glpython_graphics_commands
  global _glpython_module_scope, _glpython_current_path, _glpython_current_func_stack, _glpython_call_depth
  global _glpython_frame_id_counter, _glpython_frame_stack, _glpython_pending_call_node, _glpython_last_call_frame_id
  _glpython_trace_log = []
  _glpython_step_count = 0
  _glpython_stdout_len = 0
  _glpython_call_depth = 0
  _glpython_current_func_stack = ["<module>"]
  _glpython_frame_id_counter = 0
  _glpython_frame_stack = [0]
  _glpython_pending_call_node = None
  _glpython_last_call_frame_id = None

  if "/" not in sys.path:
    sys.path.insert(0, "/")

  file_paths = ${JSON.stringify(pythonPaths)}
  main_path = ${JSON.stringify(mainPath)}
  ast_by_file = {}
  trees = {}
  counter = [0]
  for path in file_paths:
    try:
      with open("/" + path, "r", encoding="utf-8") as handle:
        source = handle.read()
      tree = ast.parse(source, filename=path)
      _glpython_preprocess(tree, source, counter)
      trees[path] = tree
      ast_by_file[path] = _glpython_ast_to_dict(tree)
    except Exception as parse_error:
      ast_by_file[path] = {"error": _glpython_safe_repr(parse_error, 300)}

  import gturtle
  _glpython_graphics_commands = gturtle.commands

  # Swap in a capturing stdout/stderr only for the duration of this trace run
  # - must restore the originals before returning, otherwise a later normal
  # "run" (which drives output via pyodide.setStdout/setStderr, i.e. the
  # underlying IO stream, not the "sys.stdout" attribute itself) would keep
  # writing into this now-abandoned capture object forever, silently
  # swallowing all of that run's output ("Keine Ausgabe" bug).
  original_stdout = sys.stdout
  original_stderr = sys.stderr
  capture = _GlpythonCapture()
  sys.stdout = capture
  sys.stderr = capture

  error_text = None
  truncated = False
  try:
    _glpython_current_path = main_path
    module_vars = {"__name__": "__main__", "__file__": main_path}
    _glpython_module_scope = _GlpythonScope(module_vars, parent=None, kind="module")
    main_tree = trees.get(main_path)
    try:
      if main_tree is None:
        raise SyntaxError(f"could not parse {main_path}")
      _glpython_exec_stmts(main_tree.body, _glpython_module_scope)
    except _GlpythonTraceLimit:
      truncated = True
    except _GlpythonReturn:
      pass
    except BaseException as error:
      error_text = "".join(traceback.format_exception(type(error), error, error.__traceback__))
  finally:
    sys.stdout = original_stdout
    sys.stderr = original_stderr

  return json.dumps({
    "trace": _glpython_trace_log,
    "ast": ast_by_file,
    "output": capture.getvalue(),
    "graphics": gturtle.commands,
    "error": error_text,
    "truncated": truncated,
  })

_glpython_run_visual()
`
}


self.onmessage = async (event) => {
  if (event.data.type === 'init-input-channel') {
    inputControl = new Int32Array(event.data.buffer, 0, 2)
    inputPayload = new Uint8Array(event.data.buffer, 8)
    return
  }

  if (event.data.type === 'run') {
    try {
      const pyodide = await getPyodide()
      await mountProjectFiles(pyodide, event.data.project.files)
      let output = ''
      pyodide.setStdout({ batched: (text) => { output += `${text}\n` } })
      pyodide.setStderr({ batched: (text) => { output += `${text}\n` } })
      await pyodide.runPythonAsync(inputPreamble)
      await pyodide.runPythonAsync(`import runpy\nimport sys\nsys.path.insert(0, "/")\nrunpy.run_path(${JSON.stringify(`/${event.data.project.mainFile}`)}, run_name="__main__")`)
      const graphicsJson = await pyodide.runPythonAsync('import json, gturtle\njson.dumps(gturtle.commands)')
      self.postMessage({ type: 'result', output: output.trim(), graphics: JSON.parse(String(graphicsJson)) })
    } catch (error) {
      self.postMessage({ type: 'error', output: String(error) })
    }
    return
  }

  if (event.data.type === 'run-visual') {
    try {
      const pyodide = await getPyodide()
      await mountProjectFiles(pyodide, event.data.project.files)
      await pyodide.runPythonAsync(inputPreamble)
      const pythonPaths = Object.keys(event.data.project.files).filter((path) => path.endsWith('.py'))
      const resultJson = await pyodide.runPythonAsync(visualHarnessSource(event.data.project.mainFile, pythonPaths))
      const result = JSON.parse(String(resultJson))
      self.postMessage({ type: 'trace-result', ...result })
    } catch (error) {
      self.postMessage({ type: 'trace-result', trace: [], ast: {}, output: '', graphics: [], error: String(error), truncated: false })
    }
    return
  }
}

getPyodide().then(() => self.postMessage({ type: 'ready' })).catch(() => self.postMessage({ type: 'error', output: 'Could not load the Python runtime. Check your network connection.' }))
