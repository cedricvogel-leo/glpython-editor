export const GLPYTHON_EMBED_PROTOCOL_VERSION = 1
export const GLPYTHON_MAX_SOURCE_LENGTH = 500_000

export type EmbedMode = 'eval' | 'turtle' | 'visual'

export type GlPythonSourceMessage = {
  type: 'glpython:load' | 'glpython:run' | 'glpython:visualize'
  version: typeof GLPYTHON_EMBED_PROTOCOL_VERSION
  source: string
  mode?: EmbedMode
}

export type GlPythonLoadMessage = GlPythonSourceMessage & { type: 'glpython:load' }
export type GlPythonRunMessage = GlPythonSourceMessage & { type: 'glpython:run' }
export type GlPythonVisualizeMessage = GlPythonSourceMessage & { type: 'glpython:visualize' }

export type GlPythonResetMessage = {
  type: 'glpython:reset'
  version: typeof GLPYTHON_EMBED_PROTOCOL_VERSION
}

export type GlPythonParentMessage =
  | GlPythonLoadMessage
  | GlPythonRunMessage
  | GlPythonVisualizeMessage
  | GlPythonResetMessage

export type GlPythonReadyMessage = {
  type: 'glpython:ready'
  version: typeof GLPYTHON_EMBED_PROTOCOL_VERSION
  capabilities: {
    input: boolean
  }
}

export type GlPythonResizeMessage = {
  type: 'glpython:resize'
  version: typeof GLPYTHON_EMBED_PROTOCOL_VERSION
  height: number
}

export type GlPythonErrorMessage = {
  type: 'glpython:error'
  version: typeof GLPYTHON_EMBED_PROTOCOL_VERSION
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

export function parseParentMessage(value: unknown): GlPythonParentMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const message = value as Partial<GlPythonParentMessage> & { source?: unknown; mode?: unknown }
  if (message.version !== GLPYTHON_EMBED_PROTOCOL_VERSION) return null
  if (message.type === 'glpython:reset') return message as GlPythonResetMessage
  if (
    (message.type !== 'glpython:load' && message.type !== 'glpython:run' && message.type !== 'glpython:visualize')
    || typeof message.source !== 'string'
    || message.source.length > GLPYTHON_MAX_SOURCE_LENGTH
    || (message.mode !== undefined && !isEmbedMode(message.mode))
  ) {
    return null
  }
  return message as GlPythonSourceMessage
}
