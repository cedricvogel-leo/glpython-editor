import builtins
from js import requestInputFromMainThread

def _glpython_input(prompt=""):
  try:
    return requestInputFromMainThread(str(prompt))
  except Exception as error:
    if "__GLPYTHON_INPUT_CANCELLED__" in str(error):
      raise EOFError("Input was cancelled.") from None
    raise

builtins.input = _glpython_input
