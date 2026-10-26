"""Regression test (P21): the REPL shows what CPython's interactive REPL shows.
A result that is None is not displayed (sys.displayhook skips it): help(f),
a call of a function without return, print(...) and None itself show only
what they print. Compared, input by input, with `python3 -i` on the same
file. Also: help(...) and dir(...) are flagged as having nothing to
visualize - but not a function of the learner's that is called help.

Runs the runtime with CPython (no Pyodide needed):
    python3 -B scripts/check-runtime-repl.py
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

runtime = {"__name__": "glpython_runtime"}
for name in ("hints.py", "session.py"):
    with open(os.path.join(RUNTIME, name), encoding="utf-8") as handle:
        exec(compile(handle.read(), "<exec>", "exec"), runtime)

MAIN = '''def zeugnis_note(punkte, maximum):
    """Die Note zu den Punkten, auf eine Dezimale."""
    return round(punkte / maximum * 5 + 1, 1)


def melde(text):
    print("Meldung:", text)


x = 5
'''

INPUTS = [
    "help(zeugnis_note)",
    "melde('hallo')",
    "print(1)",
    "None",
    "zeugnis_note(18, 24)",
    "x = x + 1",
    "x",
    "[None, melde('in der Liste')]",
    "print",
    "dir()",
]

folder = tempfile.mkdtemp(prefix="glpython-repl-")
main_path = os.path.join(folder, "main.py")
with open(main_path, "w", encoding="utf-8") as handle:
    handle.write(MAIN)


def cpython_transcript(inputs):
    """What `python3 -i main.py` writes to stdout for each input (prompts and
    tracebacks go to stderr): what it printed, and the value if not None."""
    marker = "----glpython-next-input----"
    script = "".join(f"{line}\nprint({marker!r})\n" for line in inputs)
    result = subprocess.run([sys.executable, "-q", "-i", main_path], input=script, capture_output=True, text=True, cwd=folder, env={**os.environ, "PYTHONSTARTUP": "", "TERM": "dumb"})
    parts = result.stdout.split(marker + "\n")
    return parts[:len(inputs)]


def glpython_transcript(inputs):
    with contextlib.redirect_stdout(io.StringIO()):
        runtime["_glpython_run_project"](main_path)
    transcript, flags = [], []
    for line in inputs:
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            result = json.loads(runtime["_glpython_repl"](line))
        shown = printed.getvalue() + (result["value"] + "\n" if "value" in result else "")
        transcript.append(shown)
        flags.append(result.get("untraced", False))
    return transcript, flags


failures = []
# dir() differs between the two sessions (glpython's namespace has __file__
# and the runtime's own names), so only its flag is compared.
compared = [line for line in INPUTS if line != "dir()"]
expected = cpython_transcript(compared)
got, flags = glpython_transcript(INPUTS)
for line, want, have in zip(compared, expected, [shown for line, shown in zip(INPUTS, got) if line != "dir()"]):
    if want != have:
        failures.append(f">>> {line}\n--- CPython\n{want!r}\n--- glpython\n{have!r}")

untraced = dict(zip(INPUTS, flags))
for line, want in [("help(zeugnis_note)", True), ("dir()", True), ("print(1)", False), ("zeugnis_note(18, 24)", False), ("melde('hallo')", False)]:
    if untraced[line] != want:
        failures.append(f">>> {line}: untraced {untraced[line]}, want {want}")
# A function of the learner's called help is visualized like any other.
namespace = {"__name__": "__main__", "__builtins__": __builtins__}
exec("def help(x):\n    return x\n", namespace)
with contextlib.redirect_stdout(io.StringIO()):
    own = json.loads(runtime["_glpython_repl"]("help(3)", namespace))
if own.get("untraced") or own.get("value") != "3":
    failures.append(f"own help(3): {own}")

if failures:
    print("\n\n".join(failures))
    sys.exit(f"{len(failures)} REPL check(s) failed.")
print("Runtime REPL checks passed.")
