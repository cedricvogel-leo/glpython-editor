"""Regression test: Run (and Tests, Visualize) imports the project's files as
they are now. A changed file is read again - also when its size stays the
same and it changes within a second - a new file is found, and a removed or
renamed file can't be imported under its old name anymore, as in CPython
(ModuleNotFoundError) - before, its old module stayed in memory.

session.py's _glpython_invalidate_modules gets the paths of the files mounted
now, as the worker's mountProjectFiles passes them, and remembers those of the
time before itself.

Runs the runtime with CPython (no Pyodide needed):
    python3 -B scripts/check-runtime-imports.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "src", "runtime")

runtime = {"__name__": "glpython_runtime"}
for name in ("hints.py", "session.py"):
    with open(os.path.join(RUNTIME, name), encoding="utf-8") as handle:
        exec(compile(handle.read(), "<exec>", "exec"), runtime)

folder = tempfile.mkdtemp(prefix="glpython-imports-")
sys.path.insert(0, folder)
mounted = []
failures = []


def mount(files):
    """As the worker's mountProjectFiles: remove the old files, write the new
    ones, pass the new ones' paths."""
    global mounted
    for name in mounted:
        os.remove(os.path.join(folder, name))
    for name, source in files.items():
        with open(os.path.join(folder, name), "w", encoding="utf-8") as handle:
            handle.write(source)
    mounted = list(files)
    runtime["_glpython_invalidate_modules"](json.dumps([os.path.join(folder, name) for name in mounted]))


def run(main):
    namespace = {"__name__": "__main__"}
    try:
        exec(main, namespace)
        return namespace.get("result")
    except BaseException as error:
        return f"{type(error).__name__}: {error}"


def expect(label, got, want):
    if got != want:
        failures.append(f"{label}: got {got!r}, want {want!r}")


MAIN = "import helfer\nresult = helfer.wert()\n"
mount({"main.py": MAIN, "helfer.py": "def wert():\n    return 1\n"})
expect("first run", run(MAIN), 1)
mount({"main.py": MAIN, "helfer.py": "def wert():\n    return 2\n"})
expect("same size, at once", run(MAIN), 2)
mount({"main.py": MAIN, "helfer.py": "def wert():\n    return 3\n"})
expect("same size, at once again", run(MAIN), 3)
mount({"main.py": MAIN, "helfer.py": "def wert():\n    return 40\n"})
expect("other size", run(MAIN), 40)
mount({"main.py": "import neu\nresult = neu.X\n", "neu.py": "X = 5\n"})
expect("a new file", run("import neu\nresult = neu.X\n"), 5)
mount({"main.py": MAIN})
expect("helfer.py removed", run(MAIN), "ModuleNotFoundError: No module named 'helfer'")
mount({"main.py": MAIN, "helfer2.py": "def wert():\n    return 7\n"})
expect("renamed to helfer2.py, imported as helfer2", run("import helfer2\nresult = helfer2.wert()\n"), 7)
expect("renamed, imported under the old name", run(MAIN), "ModuleNotFoundError: No module named 'helfer'")
# A module importing another project file (parser.py next to auswerter.py).
mount({"main.py": "import auswerter\nresult = auswerter.auswerten()\n", "auswerter.py": "from parser import parse\ndef auswerten():\n    return parse()\n", "parser.py": "def parse():\n    return 'alt'\n"})
expect("parser via auswerter", run("import auswerter\nresult = auswerter.auswerten()\n"), "alt")
mount({"main.py": "import auswerter\nresult = auswerter.auswerten()\n", "auswerter.py": "from parser import parse\ndef auswerten():\n    return parse()\n", "parser.py": "def parse():\n    return 'neu'\n"})
expect("changed parser via auswerter", run("import auswerter\nresult = auswerter.auswerten()\n"), "neu")

if failures:
    print("\n".join(failures))
    sys.exit(f"{len(failures)} import check(s) failed.")
print("Runtime import checks passed.")
