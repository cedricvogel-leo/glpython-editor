import assert from 'node:assert/strict'
import {
  GLPYTHON_EMBED_PROTOCOL_VERSION,
  GLPYTHON_MAX_FILES,
  GLPYTHON_MAX_SOURCE_LENGTH,
  parseParentMessage,
  parseParentOrigin,
} from '../dist/index.js'

assert.equal(parseParentOrigin('https://course.example'), 'https://course.example')
assert.equal(parseParentOrigin('http://localhost:5173'), 'http://localhost:5173')
assert.equal(parseParentOrigin('https://course.example/path'), null)
assert.equal(parseParentOrigin('javascript:alert(1)'), null)

assert.deepEqual(parseParentMessage({
  type: 'glpython:load',
  version: GLPYTHON_EMBED_PROTOCOL_VERSION,
  source: 'print("ok")',
  mode: 'eval',
}), {
  type: 'glpython:load',
  version: GLPYTHON_EMBED_PROTOCOL_VERSION,
  source: 'print("ok")',
  mode: 'eval',
})

for (const type of ['glpython:run', 'glpython:visualize']) {
  assert.deepEqual(parseParentMessage({
    type,
    version: GLPYTHON_EMBED_PROTOCOL_VERSION,
    source: 'print("current source")',
    mode: 'eval',
  }), {
    type,
    version: GLPYTHON_EMBED_PROTOCOL_VERSION,
    source: 'print("current source")',
    mode: 'eval',
  })
}

assert.deepEqual(parseParentMessage({
  type: 'glpython:visualize',
  version: GLPYTHON_EMBED_PROTOCOL_VERSION,
  source: 'print("visual only")',
  mode: 'visual',
}), {
  type: 'glpython:visualize',
  version: GLPYTHON_EMBED_PROTOCOL_VERSION,
  source: 'print("visual only")',
  mode: 'visual',
})

assert.deepEqual(parseParentMessage({
  type: 'glpython:reset',
  version: GLPYTHON_EMBED_PROTOCOL_VERSION,
}), {
  type: 'glpython:reset',
  version: GLPYTHON_EMBED_PROTOCOL_VERSION,
})
assert.equal(parseParentMessage({
  type: 'glpython:run',
  version: GLPYTHON_EMBED_PROTOCOL_VERSION,
}), null)

assert.equal(parseParentMessage({
  type: 'glpython:load',
  version: GLPYTHON_EMBED_PROTOCOL_VERSION + 1,
  source: 'print("wrong version")',
}), null)
assert.equal(parseParentMessage({
  type: 'glpython:load',
  version: GLPYTHON_EMBED_PROTOCOL_VERSION,
  source: 'x'.repeat(GLPYTHON_MAX_SOURCE_LENGTH + 1),
}), null)
assert.equal(parseParentMessage({
  type: 'glpython:load',
  version: GLPYTHON_EMBED_PROTOCOL_VERSION,
  source: 'print("bad mode")',
  mode: 'unknown',
}), null)

// Version 1 (a single source) is still accepted, without files.
assert.equal(GLPYTHON_EMBED_PROTOCOL_VERSION, 4)
assert.deepEqual(parseParentMessage({ type: 'glpython:run', version: 1, source: 'print(1)', mode: 'eval' }), { type: 'glpython:run', version: 1, source: 'print(1)', mode: 'eval' })
assert.equal(parseParentMessage({ type: 'glpython:run', version: 1, source: 'x', files: [{ path: 'main.py', source: 'x' }], mainFile: 'main.py' }), null)
assert.equal(parseParentMessage({ type: 'glpython:reset', version: 5 }), null)

// Version 2: a program of several files and the one to run.
const program = {
  type: 'glpython:visualize',
  version: 2,
  source: 'from helpers import doppelt\nprint(doppelt(21))',
  mode: 'eval',
  files: [
    { path: 'helpers.py', source: 'def doppelt(x):\n    return 2 * x' },
    { path: 'main.py', source: 'from helpers import doppelt\nprint(doppelt(21))' },
  ],
  mainFile: 'main.py',
}
assert.deepEqual(parseParentMessage(program), program)
assert.equal(parseParentMessage({ ...program, mainFile: 'other.py' }), null)
assert.equal(parseParentMessage({ ...program, mainFile: undefined }), null)
assert.equal(parseParentMessage({ ...program, files: [] }), null)
for (const path of ['../evil.py', 'sub/dir.py', 'main.txt', '1abc.py', 'main.py.py ', '']) {
  assert.equal(parseParentMessage({ ...program, files: [{ path, source: '' }, ...program.files] }), null, path)
}
assert.equal(parseParentMessage({ ...program, files: [...program.files, program.files[0]] }), null)
assert.equal(parseParentMessage({ ...program, files: Array.from({ length: GLPYTHON_MAX_FILES + 1 }, (_, i) => ({ path: `f${i}.py`, source: '' })), mainFile: 'f0.py' }), null)
assert.equal(parseParentMessage({ ...program, files: [{ path: 'main.py', source: 'x'.repeat(GLPYTHON_MAX_SOURCE_LENGTH + 1) }] }), null)

// Version 3: running the doctests, with or without files; not before version 3.
const tests = { ...program, type: 'glpython:test', version: 3 }
assert.deepEqual(parseParentMessage(tests), tests)
assert.deepEqual(parseParentMessage({ type: 'glpython:test', version: 3, source: 'def f():\n    pass' }), { type: 'glpython:test', version: 3, source: 'def f():\n    pass' })
assert.equal(parseParentMessage({ ...tests, version: 2 }), null)
assert.equal(parseParentMessage({ type: 'glpython:test', version: 1, source: 'x' }), null)
assert.deepEqual(parseParentMessage({ ...program, version: 3 }), { ...program, version: 3 })

// Version 4: stopping what Python runs; not before version 4. Earlier
// messages are accepted in version 4 too.
assert.deepEqual(parseParentMessage({ type: 'glpython:stop', version: 4 }), { type: 'glpython:stop', version: 4 })
assert.equal(parseParentMessage({ type: 'glpython:stop', version: 3 }), null)
assert.equal(parseParentMessage({ type: 'glpython:stop', version: 1 }), null)
assert.deepEqual(parseParentMessage({ ...tests, version: 4 }), { ...tests, version: 4 })
assert.deepEqual(parseParentMessage({ type: 'glpython:reset', version: 4 }), { type: 'glpython:reset', version: 4 })

const readyMessage = {
  type: 'glpython:ready',
  version: GLPYTHON_EMBED_PROTOCOL_VERSION,
  capabilities: { input: false },
}
assert.equal(readyMessage.capabilities.input, false)

console.log('Embed protocol checks passed.')
