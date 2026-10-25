"""Regression test: glpython behaves like CPython.

- A Run's output is what CPython prints for "python3 main.py": the program's
  own output, then the traceback - without the runtime's own frames, and with
  the project's files named as in the editor ("main.py", where CPython shows
  the absolute path).
- The visualizer treats a function's names as Python does: a name the
  function assigns is local throughout it, so reading it first raises
  UnboundLocalError (not NameError, and not the global of that name).

Runs the runtime with CPython (no Pyodide needed):
    python3 -B scripts/check-runtime-fidelity.py
"""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "src", "runtime")
sys.path.insert(0, RUNTIME)  # for "import gturtle"

# Loaded as Pyodide loads them, so their frames are named "<exec>" there too.
namespace = {"__name__": "glpython_runtime"}
for name in ("hints.py", "session.py", "visualizer.py"):
    with open(os.path.join(RUNTIME, name), encoding="utf-8") as handle:
        exec(compile(handle.read(), "<exec>", "exec"), namespace)

failures = []

# --- Run: output and traceback as CPython prints them ----------------------
RUNS = [
    ("error after output", {"main.py": "def kehrwert(x):\n    return 1 / x\n\nprint(kehrwert(2))\nprint(kehrwert(0))\n"}),
    ("syntax error", {"main.py": "print('vorher')\ndef f(x)\n    return x\n"}),
    ("error in another file", {"main.py": "import hilfe\nprint(hilfe.halb(None))\n", "hilfe.py": "def halb(x):\n    return x / 2\n"}),
    ("chained exceptions", {"main.py": "try:\n    1 / 0\nexcept ZeroDivisionError:\n    undefinierter_name\n"}),
    ("error from the standard library", {"main.py": "import math\nprint(math.sqrt(-1))\n"}),
    ("umlauts and emoji", {"main.py": "def grüsse(name):\n    return 'Grüezi 🙂 ' + name\n\nprint(grüsse(42))\n"}),
    ("no error", {"main.py": "print('alles gut')\n"}),
]
for label, files in RUNS:
    folder = os.path.realpath(tempfile.mkdtemp(prefix="glpython-fidelity-"))
    for path, source in files.items():
        with open(os.path.join(folder, path), "w", encoding="utf-8") as handle:
            handle.write(source)
    cpython = subprocess.run([sys.executable, "-B", "main.py"], cwd=folder, capture_output=True, text=True)
    expected = (cpython.stdout + cpython.stderr).replace(f'File "{folder}/', 'File "')

    sys.modules.pop("hilfe", None)
    sys.path.insert(0, folder)
    printed = io.StringIO()
    with contextlib.redirect_stdout(printed):
        try:
            namespace["_glpython_run_project"](os.path.join(folder, "main.py"))
        except BaseException:
            pass
    sys.path.remove(folder)
    report = json.loads(namespace["_glpython_take_error_report"]())
    got = printed.getvalue() + (report["traceback"] if report else "")
    if got != expected:
        failures.append(f"Run, {label}:\n--- glpython\n{got}--- CPython (paths relative)\n{expected}")

# --- Visualizer: local names as Python decides them -------------------------
PROGRAMS = [
    "def f():\n    print(n)\n    n = 1\nf()\n",
    "n = 5\ndef f():\n    print(n)\n    n = 1\nf()\n",
    "x = 1\ndef f():\n    x += 1\n    return x\nf()\n",
    "x = 1\ndef f():\n    global x\n    x += 1\n    return x\nprint(f())\n",
    "def f(a):\n    del a\n    return a\nf(1)\n",
    "z = 3\ndef f():\n    return z * 2\nprint(f())\n",
    "def f(n):\n    if n > 0:\n        s = n\n    return s\nprint(f(2))\nf(0)\n",
    "def f():\n    for i in range(2):\n        pass\n    return i\nprint(f())\n",
    "def zähle(liste):\n    for x in liste:\n        summe = summe + x\n    return summe\nzähle([1, 2])\n",
    "print(y)\n",
]
for source in PROGRAMS:
    printed = io.StringIO()
    try:
        with contextlib.redirect_stdout(printed):
            exec(source, {})
        expected = None
    except BaseException as error:
        expected = f"{type(error).__name__}: {error}"
    result = json.loads(namespace["_glpython_trace_program"]("main.py", {"main.py": source}, None))
    if (result["errorMessage"], result["output"]) != (expected, printed.getvalue()):
        failures.append(f"visualizer {source!r}: {result['errorMessage']!r} / {result['output']!r}, Python {expected!r} / {printed.getvalue()!r}")

if failures:
    print("\n".join(failures))
    sys.exit(f"{len(failures)} fidelity check(s) failed.")
print("Runtime fidelity checks passed.")
