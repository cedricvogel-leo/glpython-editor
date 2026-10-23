import builtins
import json
import sys

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

def _glpython_run_project(main_path):
  global _glpython_repl_namespace
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
  exec(compile(source, main_path, "exec"), _glpython_repl_namespace)

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
    return json.dumps({"error": _glpython_error_message(error)})
