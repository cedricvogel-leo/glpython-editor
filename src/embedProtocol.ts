export const GLPYTHON_EMBED_PROTOCOL_VERSION = 1
export const GLPYTHON_MAX_SOURCE_LENGTH = 500_000

export type EmbedMode = 'eval' | 'turtle'

export type GlPythonLoadMessage = {
  type: 'glpython:load'
  version: typeof GLPYTHON_EMBED_PROTOCOL_VERSION
  source: string
  mode?: EmbedMode
}

export type GlPythonParentMessage = GlPythonLoadMessage

export type GlPythonReadyMessage = {
  type: 'glpython:ready'
  version: typeof GLPYTHON_EMBED_PROTOCOL_VERSION
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
  return value === 'eval' || value === 'turtle'
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
  const message = value as Partial<GlPythonLoadMessage>
  if (
    message.type !== 'glpython:load'
    || message.version !== GLPYTHON_EMBED_PROTOCOL_VERSION
    || typeof message.source !== 'string'
    || message.source.length > GLPYTHON_MAX_SOURCE_LENGTH
    || (message.mode !== undefined && !isEmbedMode(message.mode))
  ) {
    return null
  }
  return message as GlPythonLoadMessage
}
