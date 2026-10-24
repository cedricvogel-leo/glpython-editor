// Version 2 adds programs of several files ("files" and "mainFile" on load,
// run and visualize); version 3 adds "glpython:test", which runs the
// doctests of the file to run. The embed still accepts every earlier version
// and answers every parent in the version that parent last used - starting
// with 1 - so courses with an older macro keep working unchanged.
export const GLPYTHON_EMBED_PROTOCOL_VERSION = 3
export const GLPYTHON_SUPPORTED_PROTOCOL_VERSIONS = [1, 2, 3] as const
export type GlPythonProtocolVersion = typeof GLPYTHON_SUPPORTED_PROTOCOL_VERSIONS[number]
export const GLPYTHON_MAX_SOURCE_LENGTH = 500_000
export const GLPYTHON_MAX_FILES = 20
// A file of a version 2 program: a plain Python module name, so "from
// parser import parse" finds "parser.py".
export const GLPYTHON_FILE_PATH = /^[A-Za-z_][A-Za-z0-9_]*\.py$/

export type GlPythonFile = { path: string; source: string }

export type EmbedMode = 'eval' | 'turtle' | 'visual'

export type GlPythonSourceMessage = {
  type: 'glpython:load' | 'glpython:run' | 'glpython:visualize' | 'glpython:test'
  version: GlPythonProtocolVersion
  // The code of the file to run.
  source: string
  mode?: EmbedMode
  // Version 2 only: every file of the program (the one to run included) and
  // which of them to run.
  files?: GlPythonFile[]
  mainFile?: string
}

export type GlPythonLoadMessage = GlPythonSourceMessage & { type: 'glpython:load' }
export type GlPythonRunMessage = GlPythonSourceMessage & { type: 'glpython:run' }
export type GlPythonVisualizeMessage = GlPythonSourceMessage & { type: 'glpython:visualize' }
export type GlPythonTestMessage = GlPythonSourceMessage & { type: 'glpython:test' }

export type GlPythonResetMessage = {
  type: 'glpython:reset'
  version: GlPythonProtocolVersion
}

export type GlPythonParentMessage =
  | GlPythonLoadMessage
  | GlPythonRunMessage
  | GlPythonVisualizeMessage
  | GlPythonTestMessage
  | GlPythonResetMessage

export type GlPythonReadyMessage = {
  type: 'glpython:ready'
  version: GlPythonProtocolVersion
  capabilities: {
    input: boolean
    // Whether version 2 programs of several files are understood.
    files?: boolean
    // Whether version 3 "glpython:test" is understood.
    tests?: boolean
  }
}

export type GlPythonResizeMessage = {
  type: 'glpython:resize'
  version: GlPythonProtocolVersion
  height: number
}

export type GlPythonErrorMessage = {
  type: 'glpython:error'
  version: GlPythonProtocolVersion
  code: 'invalid-message' | 'invalid-origin' | 'unsupported-version'
  message: string
}

export type GlPythonChildMessage =
  | GlPythonReadyMessage
  | GlPythonResizeMessage
  | GlPythonErrorMessage

export function isEmbedMode(value: unknown): value is EmbedMode {
  return value === 'eval' || value === 'turtle' || value === 'visual'
}

export function parseParentOrigin(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.origin === value && (url.protocol === 'https:' || url.protocol === 'http:')
      ? url.origin
      : null
  } catch {
    return null
  }
}

function isValidFileList(files: unknown, mainFile: unknown): boolean {
  if (!Array.isArray(files) || files.length === 0 || files.length > GLPYTHON_MAX_FILES) return false
  const paths = new Set<string>()
  for (const file of files) {
    if (typeof file !== 'object' || file === null) return false
    const { path, source } = file as Partial<GlPythonFile>
    if (typeof path !== 'string' || !GLPYTHON_FILE_PATH.test(path) || paths.has(path)) return false
    if (typeof source !== 'string' || source.length > GLPYTHON_MAX_SOURCE_LENGTH) return false
    paths.add(path)
  }
  return typeof mainFile === 'string' && paths.has(mainFile)
}

export function parseParentMessage(value: unknown): GlPythonParentMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const message = value as Partial<GlPythonParentMessage> & { source?: unknown; mode?: unknown; files?: unknown; mainFile?: unknown }
  if (!GLPYTHON_SUPPORTED_PROTOCOL_VERSIONS.includes(message.version as GlPythonProtocolVersion)) return null
  const version = message.version as GlPythonProtocolVersion
  if (message.type === 'glpython:reset') return message as GlPythonResetMessage
  if (
    (message.type !== 'glpython:load' && message.type !== 'glpython:run' && message.type !== 'glpython:visualize' && message.type !== 'glpython:test')
    || (message.type === 'glpython:test' && version < 3)
    || typeof message.source !== 'string'
    || message.source.length > GLPYTHON_MAX_SOURCE_LENGTH
    || (message.mode !== undefined && !isEmbedMode(message.mode))
  ) {
    return null
  }
  const hasFiles = message.files !== undefined || message.mainFile !== undefined
  if (hasFiles && (version < 2 || !isValidFileList(message.files, message.mainFile))) return null
  return message as GlPythonSourceMessage
}
