"""Regression test: values as the visualizer shows them. A type reads the way
learners write it ("int", "list", "NoneType", not "<class 'int'>"), in the
steps the UI substitutes and in the condition text the → chain uses, while the
program's own output keeps Python's repr.

Runs the visualizer runtime with CPython (no Pyodide needed):
    python3 -B scripts/check-runtime-values.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "src", "runtime")
sys.path.insert(0, RUNTIME)  # for "import gturtle"

namespace = {"__name__": "glpython_runtime"}
for name in ("session.py", "visualizer.py"):
    with open(os.path.join(RUNTIME, name), encoding="utf-8") as handle:
        exec(compile(handle.read(), name, "exec"), namespace)

failures = []

# The course's evaluator (Etappen 4-5) asks "type(e) != list".
PROGRAM = '''def ist_blatt(e):
    return type(e) != list

a = 3
if type(2.5) != str:
    print(ist_blatt(a), ist_blatt([1]), type(None), type(True))
'''
result = json.loads(namespace["_glpython_trace_program"]("main.py", {"main.py": PROGRAM}, None))
steps = [(step["label"], step.get("valueText")) for step in result["trace"] if step["kind"] == "eval"]
for expected in [("type(...)", "int"), ("int != list", "True"), ("type(...)", "list"), ("list != list", "False"),
                 ("type(...)", "NoneType"), ("type(...)", "bool"), ("type(...)", "float"), ("float != str", "True")]:
    if expected not in steps:
        failures.append(f"no step {expected[0]!r} -> {expected[1]!r}; eval steps: {steps}")
# The → chain's reason comment for that if: the condition before it runs.
conditions = [step.get("conditionText") for step in result["trace"] if step["kind"] == "branch"]
if conditions != ["type(2.5) != str"]:
    failures.append(f"condition text {conditions}, expected ['type(2.5) != str']")
if any("<class" in (value or "") for _, value in steps):
    failures.append(f"a step still shows <class ...>: {steps}")
if result["output"].strip() != "True False <class 'NoneType'> <class 'bool'>":
    failures.append(f"output changed: {result['output']!r}")

if failures:
    print("\n".join(failures))
    sys.exit(f"{len(failures)} value check(s) failed.")
print("Runtime value checks passed.")
