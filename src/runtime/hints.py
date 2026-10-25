import re

# A short hint shown below an error for the unit's common mistakes - Python's
# own message and traceback stay exactly as they are. Matched on the
# exception's type and its message; anything else (another message, a
# subclass, an ambiguous case such as a method whose count includes self)
# gets no hint, since no hint is better than a wrong one. The result is data
# ({"kind": ..., plus the names it mentions}); the UI words it in the course's
# language (CoreStrings.errorHint). doctest's "lacks blank after >>>" is
# handled in doctests.py, which knows the file line.
_GLPYTHON_IDENTIFIER = r"[^\W\d]\w*"

def _glpython_error_hint(error):
  kind = type(error).__name__
  message = str(error)
  if kind == "NameError":
    match = re.fullmatch(r"name '(" + _GLPYTHON_IDENTIFIER + r")' is not defined", message)
    if match:
      return {"kind": "name-not-defined", "name": match.group(1)}
  elif kind == "TypeError":
    match = re.fullmatch(r"(" + _GLPYTHON_IDENTIFIER + r")\(\) missing \d+ required positional arguments?: (.+)", message)
    if match:
      return {"kind": "missing-arguments", "function": match.group(1), "names": re.findall(r"'([^']+)'", match.group(2))}
    match = re.fullmatch(r"(" + _GLPYTHON_IDENTIFIER + r")\(\) takes (\d+) positional arguments? but (\d+) (?:was|were) given", message)
    if match:
      return {"kind": "too-many-arguments", "function": match.group(1), "expected": int(match.group(2)), "given": int(match.group(3))}
    operands = re.fullmatch(r"unsupported operand type\(s\) for (\S+): '(\w+)' and '(\w+)'", message)
    concatenated = re.fullmatch(r'can only concatenate str \(not "(\w+)"\) to str', message)
    if (operands and "NoneType" in operands.group(2, 3)) or (concatenated and concatenated.group(1) == "NoneType"):
      return {"kind": "none-operand"}
    if (operands and operands.group(1) == "+" and operands.group(2) in ("int", "float") and operands.group(3) == "str") or (concatenated and concatenated.group(1) in ("int", "float")):
      return {"kind": "text-plus-number"}
  elif kind == "ZeroDivisionError":
    if message.endswith("by zero"):
      return {"kind": "zero-division"}
  elif kind == "RecursionError":
    if "recursion depth exceeded" in message:
      return {"kind": "recursion"}
  elif kind == "IndexError":
    if message == "list index out of range":
      return {"kind": "list-index"}
  return None
