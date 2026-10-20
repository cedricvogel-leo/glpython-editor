import assert from 'node:assert/strict'
import {
  GLPYTHON_EMBED_PROTOCOL_VERSION,
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

const readyMessage = {
  type: 'glpython:ready',
  version: GLPYTHON_EMBED_PROTOCOL_VERSION,
  capabilities: { input: false },
}
assert.equal(readyMessage.capabilities.input, false)

console.log('Embed protocol checks passed.')
