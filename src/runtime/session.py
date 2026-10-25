import builtins
import json
import os
import sys
import traceback

# The namespace the last Run executed the main file in. REPL inputs run in it
# afterwards (like "python -i"), so learners can call the file's functions;
# the next Run replaces it with a fresh one.
_glpython_repl_namespace = {"__name__": "__main__", "__builtins__": builtins}

# The project's files are mounted at "/" (and gturtle.py next to them), so a
# REPL input can import them even before the first Run - e.g. right after a
# stop restarted Python.
if "/" not in sys.path:
  sys.path.insert(0, "/")

_GLPYTHON_REPL_PATH = "<repl>"
_GLPYTHON_REPL_MAX_REPR = 10000

# The exception's last traceback line, exactly as Python prints it (e.g.
# "TypeError: unsupported operand type(s) for +: 'NoneType' and 'NoneType'").
# Shared with visualizer.py, which is loaded after this file.
def _glpython_error_message(error):
  text = error.msg if isinstance(error, SyntaxError) and error.msg else str(error)
  return f"{type(error).__name__}: {text}" if text else type(error).__name__

# Run, Tests and Visualize import the project's files as they are now: the
# modules of every file mounted now and at the time before are dropped, so a
# changed file is read again and a removed or renamed one can't be imported
# under its old name anymore (as in CPython: ModuleNotFoundError) - its old
# module used to stay. The import system's directory caches are cleared too,
# and no bytecode is written, so a file changed within the same second keeps
# no stale .pyc.
sys.dont_write_bytecode = True
_glpython_mounted_paths = set()

def _glpython_invalidate_modules(mounted_paths_json):
  global _glpython_mounted_paths
  import importlib
  mounted_paths = set(json.loads(mounted_paths_json))
  for module_name in list(sys.modules):
    if getattr(sys.modules[module_name], "__file__", None) in mounted_paths | _glpython_mounted_paths:
      del sys.modules[module_name]
  _glpython_mounted_paths = mounted_paths
  importlib.invalidate_caches()

# Python's traceback for an error the program raised, as CPython prints it
# (carets, chained exceptions, a SyntaxError's caret line), without this
# runtime's own frames ("<exec>") and with the project's files named as in
# the editor ("main.py", not "/main.py"); other files (the standard library)
# keep their paths, as in CPython.
def _glpython_traceback_text(error, root):
  prefix = root.rstrip("/") + "/"
  def project_name(path):
    if path and path.startswith(prefix) and not path.startswith("/lib/"):
      return path[len(prefix):]
    return None
  report = traceback.TracebackException.from_exception(error)
  renamed = {}
  parts, seen = [report], set()
  while parts:
    part = parts.pop()
    if part is None or id(part) in seen:
      continue
    seen.add(id(part))
    part.stack = traceback.StackSummary.from_list([frame for frame in part.stack if frame.filename != "<exec>"])
    for path in [frame.filename for frame in part.stack] + [getattr(part, "filename", None)]:
      name = project_name(path)
      if name:
        renamed[path] = name
    parts.extend([part.__cause__, part.__context__, *(part.exceptions or [])])
  text = "".join(report.format())
  for path, name in renamed.items():
    text = text.replace(f'File "{path}"', f'File "{name}"')
  return text

# The error the last Run ended with: Python's traceback (see above) and the
# hint for it (hints.py), for the worker, which only sees a JavaScript
# exception. None if the program never ran (e.g. the file was missing).
_glpython_last_error_report = None

def _glpython_take_error_report():
  global _glpython_last_error_report
  report, _glpython_last_error_report = _glpython_last_error_report, None
  return json.dumps(report)

# Runs the main file in `namespace`. Executed in a plain dict (rather than
# runpy.run_path, which hands back only a copy of the module's globals) so
# that the file's functions and the REPL share one global namespace - e.g. a
# function reading a global the learner assigned in the REPL.
def _glpython_exec_main(main_path, namespace):
  if "/" not in sys.path:
    sys.path.insert(0, "/")
  with open(main_path, "r", encoding="utf-8") as handle:
    source = handle.read()
  exec(compile(source, main_path, "exec"), namespace)

def _glpython_run_project(main_path):
  global _glpython_repl_namespace, _glpython_last_error_report
  # Assigned before running, so a file that fails halfway still leaves its
  # earlier definitions callable.
  _glpython_repl_namespace = {"__name__": "__main__", "__file__": main_path, "__builtins__": builtins}
  _glpython_last_error_report = None
  try:
    _glpython_exec_main(main_path, _glpython_repl_namespace)
  except BaseException as error:
    # Raised on unchanged; the worker shows this report instead of
    # Pyodide's own traceback.
    _glpython_last_error_report = {"traceback": _glpython_traceback_text(error, os.path.dirname(main_path)), "errorHint": _glpython_error_hint(error)}
    raise

def _glpython_graphics_json():
  import gturtle
  return json.dumps(gturtle.commands)

# Runs one REPL input in the namespace of the last Run (or in `namespace`,
# see the replay below). A single expression reports its value - including
# None, which the UI shows on purpose (every call evaluates to a value) -
# while statements report nothing. Definitions are allowed, but flagged so
# the UI can point out that they belong in the file. Errors report only the
# traceback's last line; an input that doesn't compile is flagged, as it has
# nothing to visualize.
def _glpython_repl(source, namespace=None):
  import ast
  if namespace is None:
    namespace = _glpython_repl_namespace
  try:
    tree = ast.parse(source, _GLPYTHON_REPL_PATH, "exec")
    if len(tree.body) == 1 and isinstance(tree.body[0], ast.Expr):
      code, mode = compile(ast.Expression(body=tree.body[0].value), _GLPYTHON_REPL_PATH, "eval"), "eval"
    else:
      code, mode = compile(tree, _GLPYTHON_REPL_PATH, "exec"), "exec"
  except BaseException as error:
    return json.dumps({"error": _glpython_error_message(error), "errorHint": _glpython_error_hint(error), "unparsed": True})
  try:
    if mode == "eval":
      return json.dumps(_glpython_repl_value(eval(code, namespace)))
    exec(code, namespace)
    defines = any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) for node in tree.body)
    return json.dumps({"hint": "definition" if defines else None})
  except BaseException as error:
    return json.dumps({"error": _glpython_error_message(error), "errorHint": _glpython_error_hint(error)})

def _glpython_repl_value(value):
  text = repr(value)
  if len(text) > _GLPYTHON_REPL_MAX_REPR:
    text = text[:_GLPYTHON_REPL_MAX_REPR] + "…"
  return {"value": text, "isNone": value is None}

# Visualizing an earlier REPL input replays the session up to it instead of
# storing Python's state: the worker runs the file as it was at the Run
# (_glpython_replay_file), then the inputs before it (_glpython_replay_input)
# in a namespace of their own, and compares what each printed and evaluated
# to with what it did the first time. The live session stays untouched: the
# project's modules are set aside and put back afterwards. Replaying can't
# answer input(), so it raises instead and the replay is flagged.
_glpython_replay_namespace = None
_glpython_replay_saved = None
_glpython_replay_used_input = False

class _GlpythonReplayInput(BaseException):
  pass

def _glpython_replay_blocked_input(prompt=""):
  global _glpython_replay_used_input
  _glpython_replay_used_input = True
  raise _GlpythonReplayInput("input() is not replayed")

def _glpython_replay_project_modules(paths):
  return {name: module for name, module in list(sys.modules.items()) if getattr(module, "__file__", None) in paths}

def _glpython_replay_begin(project_paths_json):
  global _glpython_replay_namespace, _glpython_replay_saved, _glpython_replay_used_input
  paths = set(json.loads(project_paths_json))
  saved = _glpython_replay_project_modules(paths)
  for name in saved:
    del sys.modules[name]
  _glpython_replay_saved = (saved, paths, builtins.input)
  builtins.input = _glpython_replay_blocked_input
  _glpython_replay_used_input = False
  # Inputs typed before any Run ran in an empty namespace.
  _glpython_replay_namespace = {"__name__": "__main__", "__builtins__": builtins}

# Python's traceback, as the Run reported it, or "" if the file ran through.
def _glpython_replay_file(main_path):
  global _glpython_replay_namespace
  _glpython_replay_namespace = {"__name__": "__main__", "__file__": main_path, "__builtins__": builtins}
  try:
    _glpython_exec_main(main_path, _glpython_replay_namespace)
    return ""
  except BaseException as error:
    return _glpython_traceback_text(error, os.path.dirname(main_path))

def _glpython_replay_input(source):
  return _glpython_repl(source, _glpython_replay_namespace)

def _glpython_replay_needed_input():
  return _glpython_replay_used_input

def _glpython_replay_end():
  global _glpython_replay_namespace, _glpython_replay_saved
  if _glpython_replay_saved is None:
    return
  saved, paths, original_input = _glpython_replay_saved
  for name in _glpython_replay_project_modules(paths):
    del sys.modules[name]
  sys.modules.update(saved)
  builtins.input = original_input
  _glpython_replay_namespace = None
  _glpython_replay_saved = None
