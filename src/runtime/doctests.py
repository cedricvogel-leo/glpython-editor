import doctest
import json
import re
import sys
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

# Runs the doctests of one file the way "python -m doctest" does: the file is
# loaded as a module named after it (so "if __name__ == '__main__':" blocks
# don't run), then every example in its docstrings runs in order.
def _glpython_run_doctests(main_path):
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
    exec(compile(source, main_path, "exec"), module.__dict__)
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
  try:
    for test in tests:
      test.filename = display_name
      runner.run(test, out=lambda text: None, clear_globs=False)
  finally:
    sys.__displayhook__ = original_displayhook
  return json.dumps({
    "attempted": runner.tries,
    "failed": runner.failures,
    "failures": runner.failed_examples,
    "printHints": runner.print_hints,
  })
