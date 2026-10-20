import math
commands = []
_x, _y, _angle = 320.0, 210.0, 0.0
_pen_down, _color, _width = True, "#27725c", 2.0

def makeTurtle(*args, **kwargs):
  global _x, _y, _angle
  _x, _y, _angle = 320.0, 210.0, 0.0
  commands.clear()

def clear(*args, **kwargs):
  commands.clear()

def penUp():
  global _pen_down
  _pen_down = False

def penDown():
  global _pen_down
  _pen_down = True

def forward(distance):
  global _x, _y
  next_x = _x + math.cos(math.radians(_angle)) * distance
  next_y = _y + math.sin(math.radians(_angle)) * distance
  if _pen_down:
    commands.append({"type": "line", "x1": _x, "y1": _y, "x2": next_x, "y2": next_y, "color": _color, "width": _width})
  _x, _y = next_x, next_y

def backward(distance):
  forward(-distance)

def left(degrees):
  global _angle
  _angle += degrees

def right(degrees):
  left(-degrees)

def setPenColor(color):
  global _color
  _color = color

def setLineWidth(width):
  global _width
  _width = width
