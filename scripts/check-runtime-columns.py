"""Regression test: every column the runtime sends to the UI must index the
source the way the UI does - in UTF-16 code units, as JavaScript strings are
indexed - also on lines with umlauts or emoji before the code it points at.

Runs the visualizer runtime with CPython (no Pyodide needed):
    python3 -B scripts/check-runtime-columns.py
"""
import ast
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


def utf16_slice(line, start, end):
    """line[start:end] with start/end in UTF-16 code units, as JavaScript slices."""
    units = line.encode("utf-16-le")
    return units[start * 2:end * 2].decode("utf-16-le")


def ui_text(source, line, col, end_line, end_col):
    lines = source.split("\n")
    if line == end_line:
        return utf16_slice(lines[line - 1], col, end_col)
    first = utf16_slice(lines[line - 1], col, len(lines[line - 1].encode("utf-16-le")) // 2)
    last = utf16_slice(lines[end_line - 1], 0, end_col)
    return "\n".join([first, *lines[line:end_line - 1], last])


failures = []

# The conversion itself: byte offsets (ast) and character offsets (tokenize).
convert = namespace["_glpython_ui_column"]
for line, byte_offset, char_offset, expected in [
    ('x = 1', 4, 4, 4),
    ('s = "Grüezi " + name', 17, 16, 16),       # ü: 2 bytes, 1 code unit
    ('def länge(x):', 10, 9, 9),
    ('r = "🙂" + str(x * 2)', 13, 10, 11),      # 🙂: 4 bytes, 2 code units
    ('é = "Zoë" + "ä"', 14, 12, 12),
]:
    for unit, offset in (("utf8", byte_offset), ("chars", char_offset)):
        got = convert(line, offset, unit)
        if got != expected:
            failures.append(f"_glpython_ui_column({line!r}, {offset}, {unit!r}) = {got}, expected {expected}")

PROGRAM = '''def gruss(name):
    return "Grüezi " + name

def länge(x):
    return x * 2

def mit_emoji(x):
    return "🙂" + str(x * 2)

def über(a, b):
    """Mehrzeiliger Ausdruck mit Umlauten."""
    return (a + "ä"
            + b + "🙂")   # Kommentar mit ö

gruss("Zoë")
länge(länge(3)) + 1
mit_emoji(2 + 3)
über("ü", "é")
'''


def check_trace(label, main_path, sources, run):
    result = json.loads(run())
    trees = {path: ast.parse(source) for path, source in sources.items()}
    # Every node the trace points at must cover exactly that node's source text.
    for path, tree in trees.items():
        source = sources[path]
        expected_by_id = {}
        ast_dict = result["ast"][path]

        def walk(node_dict):
            if isinstance(node_dict, dict) and "id" in node_dict:
                if "line" in node_dict and node_dict.get("endLine") is not None:
                    text = ui_text(source, node_dict["line"], node_dict["col"], node_dict["endLine"], node_dict["endCol"])
                    expected_by_id[node_dict["id"]] = (node_dict["type"], text)
                for value in node_dict.get("fields", {}).values():
                    for child in value if isinstance(value, list) else [value]:
                        walk(child)
        walk(ast_dict)
        # Compare against Python's own segment for each node, matched by
        # walking both trees in the same order.
        python_nodes = [node for node in ast.walk(tree) if hasattr(node, "lineno")]
        python_texts = sorted(ast.get_source_segment(source, node) or "" for node in python_nodes)
        ui_texts = sorted(text for _, text in expected_by_id.values())
        if python_texts != ui_texts:
            wrong = sorted(set(ui_texts) - set(python_texts))[:5]
            failures.append(f"{label}: {path}: AST node spans differ from Python's source segments, e.g. {wrong}")
        for step in result["trace"]:
            if step["path"] != path or step["nodeId"] is None:
                continue
            text = ui_text(source, step["line"], step["col"], step["endLine"], step["endCol"])
            node_type, node_text = expected_by_id.get(step["nodeId"], (None, None))
            if node_text is not None and text != node_text:
                failures.append(f"{label}: step {step['step']} ({step['kind']} {step['label']!r}) covers {text!r}, its node is {node_text!r}")
        # Hidden ranges (comments) must cover exactly a comment.
        for line, col, end_line, end_col in result["hidden"].get(path, []):
            if end_line == line:
                text = ui_text(source, line, col, end_line, end_col)
                if text.strip() and not text.strip().startswith("#"):
                    failures.append(f"{label}: hidden range {[line, col, end_line, end_col]} covers {text!r}, not a comment")


check_trace("file", "main.py", {"main.py": PROGRAM},
            lambda: namespace["_glpython_trace_program"]("main.py", {"main.py": PROGRAM}, None))

# A REPL input traced against the file's definitions.
os.makedirs("/tmp", exist_ok=True)
namespace["_glpython_repl_namespace"] = {}
exec(compile(PROGRAM, "/main.py", "exec"), namespace["_glpython_repl_namespace"])
check_trace("REPL", "<repl>", {"main.py": PROGRAM, "<repl>": "länge(3) + 1"},
            lambda: namespace["_glpython_run_visual_repl"]("länge(3) + 1", json.dumps({"main.py": PROGRAM}), "main.py"))

# A docstring, and the evaluation chain's condition comment («# 'ä🙂' == ...
# ist True»), on lines with ä and 🙂: both slice lines through the same
# conversion as the columns above.
DOC_PROGRAM = '''def prüfe(wört, zähler):
    """Prüft, ob wört «ä🙂» ist."""
    if "🙂" in wört and zähler > 2:  # Kommentar mit ö
        return "ja"
    return "nein"

prüfe("ä🙂", 3)
'''
result = json.loads(namespace["_glpython_trace_program"]("main.py", {"main.py": DOC_PROGRAM}, None))
hidden = result["hidden"]["main.py"]
if [2, 0, 3, 0] not in hidden:
    failures.append(f"docstring: line 2 not hidden as a docstring, hidden ranges are {hidden}")
conditions = [step.get("conditionText") for step in result["trace"] if step["kind"] == "branch"]
expected_condition = """"🙂" in 'ä🙂' and 3 > 2"""
if conditions != [expected_condition]:
    failures.append(f"condition comment: got {conditions}, expected {[expected_condition]}")

if failures:
    print("\n".join(failures))
    sys.exit(f"{len(failures)} column check(s) failed.")
print("Runtime column checks passed.")
