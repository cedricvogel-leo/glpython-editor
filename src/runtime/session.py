import builtins
import json
import os
import sys
import traceback

# The namespace the last Run executed the main file in. REPL inputs run in it
# afterwards (like "python -i"), so learners can call the file's functions;
# the next Run replaces it with a fresh one.
_glpython_repl_namespace = {"__name__": "__main__", "__builtins__": builtins}

_GLPYTHON_REPL_PATH = "<repl>"
_GLPYTHON_REPL_MAX_REPR = 10000

# The exception's last traceback line, exactly as Python prints it (e.g.
# "TypeError: unsupported operand type(s) for +: 'NoneType' and 'NoneType'").
# Shared with visualizer.py, which is loaded after this file.
def _glpython_error_message(error):
  text = error.msg if isinstance(error, SyntaxError) and error.msg else str(error)
  return f"{type(error).__name__}: {text}" if text else type(error).__name__

def _glpython_invalidate_modules(mounted_paths_json):
  for mounted_path in json.loads(mounted_paths_json):
    for module_name in list(sys.modules):
      module = sys.modules[module_name]
      if getattr(module, "__file__", None) == mounted_path:
        del sys.modules[module_name]

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

def _glpython_run_project(main_path):
  global _glpython_repl_namespace, _glpython_last_error_report
  if "/" not in sys.path:
    sys.path.insert(0, "/")
  # Executed in a plain dict (rather than runpy.run_path, which hands back
  # only a copy of the module's globals) so that the file's functions and
  # the REPL share one global namespace - e.g. a function reading a global
  # the learner assigned in the REPL. Assigned before running, so a file
  # that fails halfway still leaves its earlier definitions callable.
  _glpython_repl_namespace = {"__name__": "__main__", "__file__": main_path, "__builtins__": builtins}
  with open(main_path, "r", encoding="utf-8") as handle:
    source = handle.read()
  _glpython_last_error_report = None
  try:
    exec(compile(source, main_path, "exec"), _glpython_repl_namespace)
  except BaseException as error:
    # Raised on unchanged; the worker shows this report instead of
    # Pyodide's own traceback.
    _glpython_last_error_report = {"traceback": _glpython_traceback_text(error, os.path.dirname(main_path)), "errorHint": _glpython_error_hint(error)}
    raise

def _glpython_graphics_json():
  import gturtle
  return json.dumps(gturtle.commands)

# Runs one REPL input in the namespace of the last Run. A single expression
# reports its value - including None, which the UI shows on purpose (every
# call evaluates to a value) - while statements report nothing. Definitions
# are allowed, but flagged so the UI can point out that they belong in the
# file. Errors report only the traceback's last line.
def _glpython_repl(source):
  import ast
  try:
    tree = ast.parse(source, _GLPYTHON_REPL_PATH, "exec")
    defines = any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) for node in tree.body)
    if len(tree.body) == 1 and isinstance(tree.body[0], ast.Expr):
      expression = ast.Expression(body=tree.body[0].value)
      value = eval(compile(expression, _GLPYTHON_REPL_PATH, "eval"), _glpython_repl_namespace)
      text = repr(value)
      if len(text) > _GLPYTHON_REPL_MAX_REPR:
        text = text[:_GLPYTHON_REPL_MAX_REPR] + "…"
      return json.dumps({"value": text, "isNone": value is None})
    exec(compile(tree, _GLPYTHON_REPL_PATH, "exec"), _glpython_repl_namespace)
    return json.dumps({"hint": "definition" if defines else None})
  except BaseException as error:
    return json.dumps({"error": _glpython_error_message(error), "errorHint": _glpython_error_hint(error)})
