"""Regression test: the short hints below errors (src/runtime/hints.py). Each
case the unit knows gets its hint wherever the error shows - a Run, the REPL,
the visualizer, a doctest example - and near misses get none. Python's own
message stays as it is. The wording (German, English) is checked in
scripts/check-error-hints.mjs.

Runs the runtime with CPython (no Pyodide needed):
    python3 -B scripts/check-runtime-hints.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "src", "runtime")
sys.path.insert(0, RUNTIME)  # for "import gturtle"

namespace = {"__name__": "glpython_runtime"}
for name in ("hints.py", "session.py", "visualizer.py", "doctests.py"):
    with open(os.path.join(RUNTIME, name), encoding="utf-8") as handle:
        exec(compile(handle.read(), name, "exec"), namespace)

failures = []
folder = tempfile.mkdtemp(prefix="glpython-hints-")


def write(source, name="main.py"):
    path = os.path.join(folder, name)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(source)
    return path


def run(source):
    """A Run: the error message Python raised and the hint the worker gets."""
    path = write(source)
    with contextlib.redirect_stdout(io.StringIO()):
        try:
            namespace["_glpython_run_project"](path)
            message = None
        except BaseException as error:
            message = namespace["_glpython_error_message"](error)
    return message, json.loads(namespace["_glpython_last_error_hint"]())


def visualize(source):
    result = json.loads(namespace["_glpython_trace_program"]("main.py", {"main.py": source}, None))
    return result["errorMessage"], result["errorHint"]


# (label, program, Python's message, hint)
CASES = [
    ("NameError", "print(zahl + 1)\n", "NameError: name 'zahl' is not defined",
     {"kind": "name-not-defined", "name": "zahl"}),
    ("missing argument", "def f(x, y):\n    return x + y\nprint(f(1))\n", "TypeError: f() missing 1 required positional argument: 'y'",
     {"kind": "missing-arguments", "function": "f", "names": ["y"]}),
    ("missing arguments", "def fläche(a, b, c):\n    return a\nfläche()\n", "TypeError: fläche() missing 3 required positional arguments: 'a', 'b', and 'c'",
     {"kind": "missing-arguments", "function": "fläche", "names": ["a", "b", "c"]}),
    ("too many arguments", "def f(x):\n    return x\nf(1, 2)\n", "TypeError: f() takes 1 positional argument but 2 were given",
     {"kind": "too-many-arguments", "function": "f", "expected": 1, "given": 2}),
    ("None operand", "def doppelt(x):\n    print(2 * x)\n\nprint(doppelt(3) + 1)\n", "TypeError: unsupported operand type(s) for +: 'NoneType' and 'int'",
     {"kind": "none-operand"}),
    ("None concatenated", "def name():\n    print('Zoë')\n\nprint('Hallo ' + name())\n", 'TypeError: can only concatenate str (not "NoneType") to str',
     {"kind": "none-operand"}),
    ("str + int", "print('Alter: ' + 15)\n", 'TypeError: can only concatenate str (not "int") to str',
     {"kind": "text-plus-number"}),
    ("int + str", "print(15 + ' Jahre')\n", "TypeError: unsupported operand type(s) for +: 'int' and 'str'",
     {"kind": "text-plus-number"}),
    ("ZeroDivisionError", "def kehrwert(x):\n    return 1 / x\nprint(kehrwert(0))\n", "ZeroDivisionError: division by zero",
     {"kind": "zero-division"}),
    ("IndexError", "zahlen = [1, 2, 3]\nprint(zahlen[3])\n", "IndexError: list index out of range",
     {"kind": "list-index"}),
]
for label, source, message, hint in CASES:
    for where, (got_message, got_hint) in (("run", run(source)), ("visualizer", visualize(source))):
        if got_message != message:
            failures.append(f"{label} ({where}): message {got_message!r}, expected {message!r}")
        if got_hint != hint:
            failures.append(f"{label} ({where}): hint {got_hint!r}, expected {hint!r}")

# RecursionError: Python's message in a Run, the visualizer's own deeper limit.
RECURSION = "def f(n):\n    return f(n - 1)\nf(3)\n"
for where, (got_message, got_hint) in (("run", run(RECURSION)), ("visualizer", visualize(RECURSION))):
    if not str(got_message).startswith("RecursionError: maximum") or got_hint != {"kind": "recursion"}:
        failures.append(f"RecursionError ({where}): {got_message!r} with hint {got_hint!r}")

# The REPL, after a Run of the file.
run("def quadrat(x):\n    return x * x\n")
for source, hint in (("quadrat(y)", {"kind": "name-not-defined", "name": "y"}), ("quadrat()", {"kind": "missing-arguments", "function": "quadrat", "names": ["x"]}), ("quadrat(2)", None)):
    result = json.loads(namespace["_glpython_repl"](source))
    if result.get("errorHint") != hint:
        failures.append(f"REPL {source!r}: {result!r}, expected hint {hint!r}")

# Doctests: an example that raises, and an example without a blank after >>>.
report = json.loads(namespace["_glpython_run_doctests"](write('''def quadrat(x):
    """
    >>> quadrat(y)
    4
    >>> quadrat(2)
    4
    """
    return x * x
''')))
hints = [failure.get("errorHint") for failure in report.get("failures", [])]
if (report.get("attempted"), report.get("failed"), hints) != (2, 1, [{"kind": "name-not-defined", "name": "y"}]):
    failures.append(f"doctest example: {report!r}")
# A missing blank after >>>: the hint names the line in the editor, not
# doctest's line within the docstring. Python's message stays as it is.
BLANK_CASES = [
    ("function", '''def quadrat(x):
    """
    >>>quadrat(2)
    4
    """
    return x * x
''', "ValueError: line 2 of the docstring for main.quadrat lacks blank after >>>: '>>>quadrat(2)'", 3),
    ("method", '''class Konto:
    """Ein Konto."""

    def einzahlen(self, betrag):
        """Zahlt ein.

        >>>Konto().einzahlen(5)
        5
        """
        return betrag
''', "ValueError: line 3 of the docstring for main.Konto.einzahlen lacks blank after >>>: '        >>>Konto().einzahlen(5)'", 7),
    ("module", '''"""Ein Modul.

>>>1 + 1
2
"""
''', "ValueError: line 3 of the docstring for main lacks blank after >>>: '>>>1 + 1'", 3),
]
for label, source, message, line in BLANK_CASES:
    report = json.loads(namespace["_glpython_run_doctests"](write(source)))
    expected = {"examplesError": message, "errorHint": {"kind": "doctest-blank", "line": line}}
    if report != expected:
        failures.append(f"doctest blank ({label}): {report!r}, expected {expected!r}")
    if source.splitlines()[line - 1].strip() != message.rsplit(": ", 1)[1].strip("'").strip():
        failures.append(f"doctest blank ({label}): line {line} is {source.splitlines()[line - 1]!r}")

# Near misses: no hint - silence is better than a wrong hint.
NEAR_MISSES = [
    ("not callable", "x = 3\nx()\n"),
    ("ValueError", "int('drei')\n"),
    ("tuple index", "(1, 2)[5]\n"),
    ("str - int", "'a' - 1\n"),
    ("range of arguments", "def f(x, y=1):\n    return x\nf(1, 2, 3)\n"),
    ("method counts self", "class Punkt:\n    def __init__(self, x):\n        self.x = x\nPunkt(1, 2)\n"),
    ("0 to a negative power", "0 ** -1\n"),
    ("comparison with None", "None < 1\n"),
    ("keyword argument", "def f(x):\n    return x\nf(z=1)\n"),
]
for label, source in NEAR_MISSES:
    for where, (got_message, got_hint) in (("run", run(source)), ("visualizer", visualize(source))):
        if got_message is None:
            failures.append(f"near miss {label} ({where}): raised nothing")
        elif got_hint is not None:
            failures.append(f"near miss {label} ({where}): {got_message!r} got hint {got_hint!r}")

# A local used before its assignment: Python's UnboundLocalError is no NameError
# case. (The visualizer still reports it as "NameError: name 'n' is not
# defined" - a known difference to Python, so only the Run is checked.)
message, hint = run("def f():\n    print(n)\n    n = 1\nf()\n")
if not str(message).startswith("UnboundLocalError") or hint is not None:
    failures.append(f"near miss UnboundLocalError (run): {message!r} got hint {hint!r}")

if failures:
    print("\n".join(failures))
    sys.exit(f"{len(failures)} hint check(s) failed.")
print("Runtime hint checks passed.")
