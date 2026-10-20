import json
import runpy
import sys

def _glpython_invalidate_modules(mounted_paths_json):
  for mounted_path in json.loads(mounted_paths_json):
    for module_name in list(sys.modules):
      module = sys.modules[module_name]
      if getattr(module, "__file__", None) == mounted_path:
        del sys.modules[module_name]

def _glpython_run_project(main_path):
  if "/" not in sys.path:
    sys.path.insert(0, "/")
  runpy.run_path(main_path, run_name="__main__")

def _glpython_graphics_json():
  import gturtle
  return json.dumps(gturtle.commands)
