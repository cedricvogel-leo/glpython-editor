"""Regression test: the Tests button's doctest runner (src/runtime/doctests.py)
- the summary, each failing example with doctest's own report and the texts it
compared, the print hint, and a file that doesn't load.

Runs the runtime with CPython (no Pyodide needed):
    python3 -B scripts/check-runtime-doctests.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "src", "runtime")

namespace = {"__name__": "glpython_runtime"}
for name in ("hints.py", "doctests.py"):
    with open(os.path.join(RUNTIME, name), encoding="utf-8") as handle:
        exec(compile(handle.read(), name, "exec"), namespace)
run_doctests = namespace["_glpython_run_doctests"]

failures = []
folder = tempfile.mkdtemp(prefix="glpython-doctests-")
sys.path.insert(0, folder)  # the worker mounts a project's files next to each other


def run(source, name="main.py"):
    """The report for one file, and what the run printed outside the examples."""
    path = os.path.join(folder, name)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(source)
    printed = io.StringIO()
    with contextlib.redirect_stdout(printed):
        report = json.loads(run_doctests(path))
    return report, printed.getvalue()


def expect(label, got, expected):
    if got != expected:
        failures.append(f"{label}: got {got!r}, expected {expected!r}")


PROGRAM = '''def doppelt(x):
    """
    >>> doppelt(2)
    4
    >>> doppelt(3)
    6
    """
    return x * x

def zeige(x):
    """
    >>> zeige(3)
    9
    """
    print(x * x)

def teile(a, b):
    """
    >>> teile(1, 0)
    0
    """
    return a / b

def länge(text):
    """
    >>> länge("ä🙂")
    2
    """
    return len(text)

if __name__ == "__main__":
    print("main läuft")
'''
report, printed = run(PROGRAM)
expect("attempted", report.get("attempted"), 5)
expect("failed", report.get("failed"), 2)
expect("main block", printed, "")
failed = report.get("failures", [])
expect("failing examples", [(f["name"], f["line"], f["source"]) for f in failed],
       [("main.doppelt", 5, "doppelt(3)"), ("main.teile", 19, "teile(1, 0)")])
if len(failed) == 2:
    # A wrong result: doctest's own words, and both texts for «Erhalten · Erwartet».
    expect("want", failed[0].get("want"), "6\n")
    expect("got", failed[0].get("got"), "9\n")
    for part in ("Failed example:", "doppelt(3)", "Expected:", "Got:"):
        if part not in failed[0]["text"]:
            failures.append(f"report of doppelt(3) lacks {part!r}: {failed[0]['text']!r}")
    # An exception: no texts to compare.
    expect("exception want/got", ("want" in failed[1], "got" in failed[1]), (False, False))
    for part in ("Exception raised:", "ZeroDivisionError"):
        if part not in failed[1]["text"]:
            failures.append(f"report of teile(1, 0) lacks {part!r}: {failed[1]['text']!r}")
# Passes in doctest, but printed instead of returning.
expect("print hints", report.get("printHints"), [{"source": "zeige(3)", "output": "9"}])
# The file's definitions stay available to visualize a failing example.
expect("test namespace", sorted(n for n in ("doppelt", "zeige", "teile", "länge") if n in namespace["_glpython_test_namespace"]),
       ["doppelt", "länge", "teile", "zeige"])
# doctest swaps sys.displayhook per example; the runner restores it.
expect("displayhook restored", sys.__displayhook__ is sys.displayhook, True)

# Importing another file of the project.
run("def halb(x):\n    return x / 2\n", "hilfe.py")
report, _ = run('''from hilfe import halb

def viertel(x):
    """
    >>> viertel(8)
    2.0
    """
    return halb(halb(x))
''')
expect("import: attempted/failed", (report.get("attempted"), report.get("failed")), (1, 0))

# No examples at all.
report, _ = run("def f(x):\n    return x\n")
expect("no examples", (report.get("attempted"), report.get("failed"), report.get("failures"), report.get("printHints")), (0, 0, [], []))

# A file that doesn't load: Python's error (for a syntax error with the line
# and caret above it).
report, _ = run("def f(x)\n    return x\n")
expect("syntax error", str(report.get("error", "")).splitlines()[-1:], ["SyntaxError: expected ':'"])
report, _ = run("x = 1 / 0\n")
expect("error while loading", report.get("error"), "ZeroDivisionError: division by zero")

if failures:
    print("\n".join(failures))
    sys.exit(f"{len(failures)} doctest check(s) failed.")
print("Runtime doctest checks passed.")
