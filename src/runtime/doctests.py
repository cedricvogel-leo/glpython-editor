import ast
import contextlib
import doctest
import json
import re
import sys
import textwrap
import traceback
import types

# The namespace of the file the last Tests run loaded, so a failing example
# can be visualized against exactly those definitions (see
# _glpython_run_visual_repl).
_glpython_test_namespace = {}

class _GlpythonDocTestRunner(doctest.DocTestRunner):
  # Records each failing example with doctest's own report text ("Failed
  # example:", "Expected:", "Got:" - never translated), and notes examples
  # that printed what was expected while the call itself returned None: they
  # pass in doctest, but usually mean print was used instead of return.
  def __init__(self):
    super().__init__(verbose=False)
    self.failed_examples = []
    self.print_hints = []
    self._displayed = []
    self._original_display = sys.__displayhook__

  def display(self, value):
    self._displayed.append(value)
    self._original_display(value)

  def _example_record(self, test, example, text, got=None, error=None):
    record = {
      "name": test.name,
      "line": (test.lineno or 0) + example.lineno + 1,
      "source": example.source.rstrip("\n"),
      "text": text,
    }
    # An example that raised: the hint for its error (hints.py).
    if error is not None:
      record["errorHint"] = _glpython_error_hint(error)
    # For an example whose output didn't match: the two texts doctest
    # compared, so the visualizer can show them next to the final value.
    if got is not None:
      record["want"] = example.want
      record["got"] = got
    return record

  def report_success(self, out, test, example, got):
    if self._displayed == [None] and got.strip():
      self.print_hints.append({"source": example.source.rstrip("\n"), "output": got.strip()})
    self._displayed = []

  def report_failure(self, out, test, example, got):
    text = self._failure_header(test, example) + self._checker.output_difference(example, got, self.optionflags)
    self.failed_examples.append(self._example_record(test, example, text, got))
    self._displayed = []

  def report_unexpected_exception(self, out, test, example, exc_info):
    text = self._failure_header(test, example) + "Exception raised:\n" + doctest._indent(doctest._exception_traceback(exc_info))
    self.failed_examples.append(self._example_record(test, example, text, error=exc_info[1]))
    self._displayed = []

# The hint for doctest's "line 2 of the docstring for main.f lacks blank
# after >>>: '>>>f(1)'", with the line as the editor counts it: doctest counts
# from the docstring's first line, so the line its docstring starts at in the
# file is added. None if the docstring can't be found (no hint rather than a
# wrong line).
def _glpython_doctest_blank_hint(error, module, module_name, source):
  match = re.match(r"line (\d+) of the docstring for (\S+) lacks blank after >>>: ", str(error))
  if not match:
    return None
  name = match.group(2)
  target = module
  try:
    if name != module_name:
      for part in name.removeprefix(module_name + ".").split("."):
        target = getattr(target, part)
    start = doctest.DocTestFinder()._find_lineno(target, source.splitlines(True))
  except Exception:
    return None
  if start is None:
    return None
  return {"kind": "doctest-blank", "line": start + int(match.group(1))}

# Coverage (the "coverage" capability): the statements in the functions of
# the tested file that no example executed, counted by line as Python's own
# trace module counts them. Not counted: def lines, decorators, docstrings,
# class bodies and code outside functions, and statements without bytecode of
# their own (e.g. "global x"). A statement counts as executed when any line of
# it ran; of a compound statement only its header ("if note >= 4:"), since
# its body's statements count for themselves.
def _glpython_statement_header_end(statement):
  if isinstance(statement, (ast.If, ast.While)):
    return statement.test.end_lineno
  if isinstance(statement, (ast.For, ast.AsyncFor)):
    return statement.iter.end_lineno
  if isinstance(statement, (ast.With, ast.AsyncWith)):
    return max(item.context_expr.end_lineno for item in statement.items)
  if isinstance(statement, ast.Match):
    return statement.subject.end_lineno
  if isinstance(statement, (ast.Try, ast.TryStar)):
    return statement.lineno
  return statement.end_lineno

def _glpython_code_lines(code):
  lines = set()
  for constant in code.co_consts:
    if isinstance(constant, types.CodeType):
      lines.update(line for _, _, line in constant.co_lines() if line is not None)
      lines.update(_glpython_code_lines(constant))
  return lines

# The statements to count, as (function, first line, last line), in the
# file's order; `function` tells the functions apart (nested ones too).
def _glpython_coverage_statements(tree, code):
  executable = _glpython_code_lines(code)
  statements = []
  def visit(body, function):
    for index, statement in enumerate(body):
      if index == 0 and isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str):
        continue
      if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
        visit(statement.body, statement)
        continue
      if isinstance(statement, ast.ClassDef):
        visit_outside(statement.body)
        continue
      end = _glpython_statement_header_end(statement)
      if any(line in executable for line in range(statement.lineno, end + 1)):
        statements.append((function, statement.lineno, end))
      for field in ("body", "orelse", "finalbody"):
        inner = getattr(statement, field, None)
        if isinstance(inner, list) and inner and isinstance(inner[0], ast.stmt):
          visit(inner, function)
      for handler in getattr(statement, "handlers", []):
        visit(handler.body, function)
      for case in getattr(statement, "cases", []):
        visit(case.body, function)
  # Outside functions only the definitions in it matter.
  def visit_outside(body):
    for statement in body:
      if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
        visit(statement.body, statement)
      elif isinstance(statement, ast.ClassDef):
        visit_outside(statement.body)
      else:
        for field in ("body", "orelse", "finalbody"):
          inner = getattr(statement, field, None)
          if isinstance(inner, list) and inner and isinstance(inner[0], ast.stmt):
            visit_outside(inner)
        for handler in getattr(statement, "handlers", []):
          visit_outside(handler.body)
  visit_outside(tree.body)
  return statements

# The statements no example executed, grouped: consecutive ones of the same
# function form one entry, with their lines (dedented) as code.
def _glpython_uncovered(source, statements, executed):
  lines = source.splitlines()
  groups = []
  previous = None
  for function, start, end in statements:
    covered = any(line in executed for line in range(start, end + 1))
    if covered:
      previous = None
      continue
    if previous is not None and previous[0] is function:
      previous[2] = end
    else:
      previous = [function, start, end]
      groups.append(previous)
  return [{"start": start, "end": end, "code": textwrap.dedent("\n".join(lines[start - 1:end])).strip("\n")} for _, start, end in groups]

# Records the lines of `path` that run while the context is open, with
# sys.monitoring (Python 3.12): each line reports once and is then switched
# off, so a loop costs nothing more. None if sys.monitoring is taken.
@contextlib.contextmanager
def _glpython_record_lines(path):
  monitoring = sys.monitoring
  tool = monitoring.COVERAGE_ID
  try:
    monitoring.use_tool_id(tool, "glpython coverage")
  except ValueError:
    yield None
    return
  executed = set()
  def on_line(code, line):
    if code.co_filename == path:
      executed.add(line)
    return monitoring.DISABLE
  try:
    monitoring.register_callback(tool, monitoring.events.LINE, on_line)
    monitoring.set_events(tool, monitoring.events.LINE)
    monitoring.restart_events()
    yield executed
  finally:
    monitoring.set_events(tool, 0)
    monitoring.register_callback(tool, monitoring.events.LINE, None)
    monitoring.free_tool_id(tool)

# Runs the doctests of one file the way "python -m doctest" does: the file is
# loaded as a module named after it (so "if __name__ == '__main__':" blocks
# don't run), then every example in its docstrings runs in order. With
# `coverage`, the report also lists what no example executed ("uncovered").
def _glpython_run_doctests(main_path, coverage=False):
  global _glpython_test_namespace
  if "/" not in sys.path:
    sys.path.insert(0, "/")
  display_name = main_path.lstrip("/")
  module_name = display_name.rsplit("/", 1)[-1].removesuffix(".py")
  module = types.ModuleType(module_name)
  module.__file__ = main_path
  _glpython_test_namespace = module.__dict__
  try:
    with open(main_path, "r", encoding="utf-8") as handle:
      source = handle.read()
    code = compile(source, main_path, "exec")
    exec(code, module.__dict__)
  except BaseException as error:
    return json.dumps({"error": "".join(traceback.format_exception_only(type(error), error)).strip(), "errorHint": _glpython_error_hint(error)})

  runner = _GlpythonDocTestRunner()
  # doctest's parser rejects malformed examples (e.g. no blank after ">>>")
  # for the whole file, before any example runs.
  try:
    tests = sorted(doctest.DocTestFinder().find(module, module_name), key=lambda test: test.lineno or 0)
  except ValueError as error:
    return json.dumps({"examplesError": f"ValueError: {error}", "errorHint": _glpython_doctest_blank_hint(error, module, module_name, source)})
  # DocTestRunner.run resets sys.displayhook to sys.__displayhook__ for every
  # test, so the runner's hook goes there for the duration.
  original_displayhook = sys.__displayhook__
  runner._original_display = original_displayhook
  sys.__displayhook__ = runner.display
  executed = None
  try:
    with _glpython_record_lines(main_path) if coverage else contextlib.nullcontext() as executed:
      for test in tests:
        test.filename = display_name
        runner.run(test, out=lambda text: None, clear_globs=False)
  finally:
    sys.__displayhook__ = original_displayhook
  report = {
    "attempted": runner.tries,
    "failed": runner.failures,
    "failures": runner.failed_examples,
    "printHints": runner.print_hints,
  }
  if executed is not None:
    report["uncovered"] = _glpython_uncovered(source, _glpython_coverage_statements(ast.parse(source), code), executed)
  return json.dumps(report)
