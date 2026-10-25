"""Regression test: a call with the wrong arguments fails in the visualizer
exactly as in Python - same exception, same message - instead of running on
with a parameter missing. Valid calls still run. And a call box's header
shows a parameter with a default once, with the value of this call.

Runs the visualizer runtime with CPython (no Pyodide needed):
    python3 -B scripts/check-runtime-calls.py
"""
import contextlib
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "src", "runtime")
sys.path.insert(0, RUNTIME)  # for "import gturtle"

namespace = {"__name__": "glpython_runtime"}
for name in ("hints.py", "session.py", "visualizer.py"):
    with open(os.path.join(RUNTIME, name), encoding="utf-8") as handle:
        exec(compile(handle.read(), name, "exec"), namespace)

PROGRAMS = [
    "def f(x, y):\n    return x + y\nprint(f(1))\n",
    "def f(a, b):\n    return a\nf()\n",
    "def f(a, b, c):\n    return a\nf()\n",
    "def f(x):\n    return x\nf(1, 2)\n",
    "def f():\n    return 1\nf(1)\n",
    "def f(x, y=1):\n    return x\nf(1, 2, 3)\n",
    "def f(x):\n    return x\nf(z=1)\n",
    "def f(x):\n    return x\nf(1, x=2)\n",
    "def f(*, a):\n    return a\nf()\n",
    "def aussen():\n    def innen(x):\n        return x\n    return innen()\naussen()\n",
    "g = lambda x: x\ng()\n",
    # Valid calls keep working.
    "def f(x, *rest, **named):\n    return x\nprint(f(1, 2, 3, k=4))\n",
    "def f(x, y=2):\n    return x + y\nprint(f(1), f(1, 5), f(y=3, x=1))\n",
]

failures = []
for source in PROGRAMS:
    printed = io.StringIO()
    try:
        with contextlib.redirect_stdout(printed):
            exec(source, {})
        expected = None
    except BaseException as error:
        expected = f"{type(error).__name__}: {error}"
    result = json.loads(namespace["_glpython_trace_program"]("main.py", {"main.py": source}, None))
    if result["errorMessage"] != expected:
        failures.append(f"{source!r}: visualizer {result['errorMessage']!r}, Python {expected!r}")
    elif result["output"] != printed.getvalue():
        failures.append(f"{source!r}: visualizer printed {result['output']!r}, Python {printed.getvalue()!r}")

if failures:
    print("\n".join(failures))
    sys.exit(f"{len(failures)} call check(s) failed.")
print("Runtime call checks passed.")

# A call box's header shows each parameter once, with the value of this
# call: "def zeichne(n=3, tiefe=1):", not "tiefe=1=0". Splices the call-enter
# step's "=value" annotations into the "def" line as the UI does: after the
# parameter's name, replacing the span of its default where it has one.
import ast

HEADERS = [
    ("def zeichne(n, tiefe=0):", "zeichne(3)", "def zeichne(n=3, tiefe=0):"),
    ("def zeichne(n, tiefe=0):", "zeichne(3, 1)", "def zeichne(n=3, tiefe=1):"),
    ("def zeichne(n, tiefe = 0):", "zeichne(3, tiefe=2)", "def zeichne(n=3, tiefe=2):"),
    ("def zeichne(n: int, tiefe: int = 0, farbe='rot'):", "zeichne(3, farbe='blau')", "def zeichne(n: int=3, tiefe: int=0, farbe='blau'):"),
    ("def zeichne(n=[1, 2], *rest, tiefe=0):", "zeichne()", "def zeichne(n=[1, 2], *rest, tiefe=0):"),
]

failures = []
for header, call, expected in HEADERS:
    source = f"{header}\n    return n\n{call}\n"
    result = json.loads(namespace["_glpython_trace_program"]("main.py", {"main.py": source}, None))
    enter = next(step for step in result["trace"] if step["kind"] == "call-enter")
    arg_ends = {arg.arg: arg.end_col_offset for arg in ast.parse(source).body[0].args.args}
    edits = []
    for annotation in enter["paramAnnotations"]:
        start = arg_ends[annotation[2]]
        end = annotation[3][3] if len(annotation) > 3 else start
        if len(annotation) > 3 and annotation[3][1] != start:
            failures.append(f"{call}: the default of {annotation[2]} starts at {annotation[3][1]}, the name ends at {start}")
        edits.append((start, end, annotation[1]))
    line = header
    for start, end, text in sorted(edits, reverse=True):
        line = line[:start] + text + line[end:]
    if line != expected:
        failures.append(f"{call}: header {line!r}, expected {expected!r}")

if failures:
    print("\n".join(failures))
    sys.exit(f"{len(failures)} header check(s) failed.")
print("Runtime header checks passed.")
