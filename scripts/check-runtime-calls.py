"""Regression test: a call with the wrong arguments fails in the visualizer
exactly as in Python - same exception, same message - instead of running on
with a parameter missing. Valid calls still run.

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
