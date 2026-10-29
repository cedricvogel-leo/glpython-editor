"""Regression test: coverage after Tests (src/runtime/doctests.py, the
"coverage" capability) - which statements in the functions of the tested file
no doctest example executed. Each case is also checked against Python's own
trace module: the lines it counts as executed must leave exactly the same
statements uncovered.

Runs the runtime with CPython (no Pyodide needed):
    python3 -B scripts/check-runtime-coverage.py
"""
import contextlib
import doctest
import io
import json
import os
import sys
import tempfile
import trace
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "src", "runtime")

namespace = {"__name__": "glpython_runtime"}
for name in ("hints.py", "doctests.py"):
    with open(os.path.join(RUNTIME, name), encoding="utf-8") as handle:
        exec(compile(handle.read(), name, "exec"), namespace)
run_doctests = namespace["_glpython_run_doctests"]
coverage_statements = namespace["_glpython_coverage_statements"]
uncovered_from = namespace["_glpython_uncovered"]

failures = []
folder = tempfile.mkdtemp(prefix="glpython-coverage-")
sys.path.insert(0, folder)  # the worker mounts a project's files next to each other


def write(name, source):
    path = os.path.join(folder, name)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(source)
    return path


def run(source, name="main.py", coverage=True):
    path = write(name, source)
    with contextlib.redirect_stdout(io.StringIO()):
        return json.loads(run_doctests(path, coverage))


def by_trace(source, name="main.py"):
    """The uncovered statements when Python's trace module counts the lines
    the examples executed."""
    import ast
    path = write(name, source)
    module_name = name.removesuffix(".py")
    module = types.ModuleType(module_name)
    module.__file__ = path
    code = compile(source, path, "exec")
    with contextlib.redirect_stdout(io.StringIO()):
        exec(code, module.__dict__)
    tracer = trace.Trace(count=1, trace=0)
    runner = doctest.DocTestRunner(verbose=False)
    with contextlib.redirect_stdout(io.StringIO()):
        for test in doctest.DocTestFinder().find(module, module_name):
            tracer.runfunc(runner.run, test, out=lambda text: None, clear_globs=False)
    executed = {line for (filename, line) in tracer.results().counts if filename == path}
    return uncovered_from(source, coverage_statements(ast.parse(source), code), executed)


def expect(label, source, expected, name="main.py"):
    """`expected`: the uncovered entries as (start, end, code)."""
    report = run(source, name)
    got = [(entry["start"], entry["end"], entry["code"]) for entry in report.get("uncovered", [])]
    if got != expected:
        failures.append(f"{label}: got {got!r}, expected {expected!r}")
    reference = [(entry["start"], entry["end"], entry["code"]) for entry in by_trace(source, name)]
    if got != reference:
        failures.append(f"{label}: got {got!r}, but Python's trace module counts {reference!r}")
    return report


# The reference cases. Fully covered, though 4 is missing as an example.
report = expect("ist_genuegend", '''def ist_genuegend(note):
    """
    >>> ist_genuegend(5.5)
    True
    >>> ist_genuegend(3.5)
    False
    """
    return note >= 4
''', [])
if report.get("failed") != 0 or report.get("attempted") != 2:
    failures.append(f"ist_genuegend: report {report!r}")

expect("bewertung", '''def bewertung(note):
    """
    >>> bewertung(5)
    'genügend'
    >>> bewertung(6)
    'genügend'
    """
    if note >= 4:
        return "genügend"
    else:
        return "ungenügend"
''', [(11, 11, 'return "ungenügend"')])

expect("vorzeichen", '''def vorzeichen(x):
    """
    >>> vorzeichen(3)
    1
    >>> vorzeichen(-2)
    -1
    """
    if x > 0:
        return 1
    elif x < 0:
        return -1
    return 0
''', [(12, 12, "return 0")])

# A library (another file of the project) is never reported, even where no
# example reaches it.
write("noten.py", '''def runde(note):
    if note < 1:
        return 1
    return round(note * 2) / 2
''')
expect("library", '''from noten import runde

def schnitt(noten):
    """
    >>> schnitt([4, 5])
    4.5
    """
    return runde(sum(noten) / len(noten))
''', [])

# Only the examples count: the file's own top-level code calling a function
# doesn't, and neither does the code outside functions.
expect("top-level code", '''def gross(x):
    """
    >>> gross(5)
    True
    """
    if x > 3:
        return True
    return False

print(gross(1))
for i in range(2):
    pass
''', [(8, 8, "return False")])

# A function no example reaches: its whole body as one entry (def line and
# docstring left out); consecutive uncovered statements are grouped, a
# covered one in between splits them.
expect("whole function", '''def doppelt(x):
    """
    >>> doppelt(2)
    4
    """
    return 2 * x

def hilfe(x):
    """Ohne Beispiele."""
    y = x + 1
    if y > 2:
        y = y * 2
    return y
''', [(10, 13, "y = x + 1\nif y > 2:\n    y = y * 2\nreturn y")])

expect("groups", '''def stufe(x):
    """
    >>> stufe(1)
    'klein'
    """
    if x > 10:
        a = "gross"
        return a
    b = "klein"
    if x < 0:
        b = "negativ"
    return b
''', [(7, 8, 'a = "gross"\nreturn a'), (11, 11, 'b = "negativ"')])

# A statement over several lines counts when any of its lines ran; the
# header of a compound statement counts for itself, its body separately.
expect("several lines", '''def summe(werte,
          start=0):
    """
    >>> summe([1, 2])
    3
    """
    total = (
        start
    )
    for wert in (
        werte
    ):
        total = total + wert
    while (total
           < 0):
        total = (total
                 + 1)
    return total
''', [(16, 17, "total = (total\n         + 1)")])

# Statements without bytecode of their own are never reported; neither is
# the docstring, nor a nested function's def line (its body counts).
expect("no bytecode", '''zaehler = 0

def zaehle(n):
    """
    >>> zaehle(1)
    1
    """
    global zaehler
    zaehler = zaehler + n
    while True:
        break
    def innen():
        return 0
    return zaehler
''', [(13, 13, "return 0")])

# try/except, methods, decorators and lambdas.
expect("try and methods", '''import functools

class Konto:
    """
    >>> Konto(5).abheben(2)
    3
    """
    def __init__(self, stand):
        self.stand = stand

    @functools.cache
    def zins(self):
        return 0

    def abheben(self, betrag):
        try:
            self.stand = self.stand - betrag
        except TypeError:
            return None
        sortiert = sorted([3, 1], key=lambda x: -x)
        return self.stand
''', [(13, 13, "return 0"), (19, 19, "return None")])

# Failing examples don't stop the recording (the UI shows the coverage only
# when all pass).
report = expect("failing example", '''def f(x):
    """
    >>> f(1)
    2
    """
    if x > 0:
        return x
    return -x
''', [(8, 8, "return -x")])
if report.get("failed") != 1:
    failures.append(f"failing example: report {report!r}")

# Without the capability: no coverage in the report.
report = run("def f(x):\n    '''\n    >>> f(1)\n    1\n    '''\n    return x\n", coverage=False)
if "uncovered" in report:
    failures.append(f"without coverage: report {report!r}")

# The recording is switched off again: a second run counts afresh, and
# sys.monitoring is free.
report = run("def f(x):\n    '''\n    >>> f(1)\n    1\n    '''\n    return x\n")
report = run("def f(x):\n    '''\n    >>> f(1)\n    1\n    '''\n    return x\n")
if report.get("uncovered") != []:
    failures.append(f"second run: report {report!r}")
if sys.monitoring.get_tool(sys.monitoring.COVERAGE_ID) is not None:
    failures.append("sys.monitoring's coverage tool is still taken")

if failures:
    print("\n".join(failures))
    sys.exit(f"{len(failures)} coverage check(s) failed.")
print("Runtime coverage checks passed.")
