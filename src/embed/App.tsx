import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GlPythonWorkspace } from '../GlPythonWorkspace'
import {
  GLPYTHON_EMBED_PROTOCOL_VERSION,
  isEmbedMode,
  parseParentMessage,
  parseParentOrigin,
  type EmbedMode,
  type GlPythonChildMessage,
} from '../embedProtocol'
import { updateProjectFile, type Project } from '../project'
import { embedStrings } from './strings'

const defaultSource = 'print("Hello from glpython")'

function createEmbedProject(source: string): Project {
  return {
    id: 'liascript-embed',
    name: 'LiaScript',
    mainFile: 'main.py',
    files: {
      'main.py': {
        path: 'main.py',
        label: 'Main program',
        kind: 'python',
        code: source,
      },
    },
  }
}

function modeFromLocation(): EmbedMode {
  const mode = new URLSearchParams(window.location.search).get('mode')
  return isEmbedMode(mode) ? mode : 'eval'
}

export function App() {
  const configuredParentOrigin = useMemo(
    () => parseParentOrigin(new URLSearchParams(window.location.search).get('parentOrigin')),
    [],
  )
  const [mode, setMode] = useState<EmbedMode>(modeFromLocation)
  const [project, setProject] = useState(() => createEmbedProject(defaultSource))
  const [isGraphicsOpen, setIsGraphicsOpen] = useState(mode === 'turtle')
  const rootRef = useRef<HTMLDivElement | null>(null)

  const sendToParent = useCallback((message: GlPythonChildMessage) => {
    if (configuredParentOrigin && window.parent !== window) {
      window.parent.postMessage(message, configuredParentOrigin)
    }
  }, [configuredParentOrigin])

  useEffect(() => {
    if (!configuredParentOrigin || window.parent === window) return

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== configuredParentOrigin) return
      const message = parseParentMessage(event.data)
      if (!message) {
        sendToParent({
          type: 'glpython:error',
          version: GLPYTHON_EMBED_PROTOCOL_VERSION,
          code: 'invalid-message',
          message: 'The parent sent an invalid glpython message.',
        })
        return
      }

      const nextMode = message.mode ?? mode
      setMode(nextMode)
      setIsGraphicsOpen(nextMode === 'turtle')
      setProject(createEmbedProject(message.source))
    }

    window.addEventListener('message', onMessage)
    sendToParent({ type: 'glpython:ready', version: GLPYTHON_EMBED_PROTOCOL_VERSION })
    return () => window.removeEventListener('message', onMessage)
  }, [configuredParentOrigin, mode, sendToParent])

  useEffect(() => {
    const root = rootRef.current
    if (!root || !configuredParentOrigin) return
    const observer = new ResizeObserver(() => {
      sendToParent({
        type: 'glpython:resize',
        version: GLPYTHON_EMBED_PROTOCOL_VERSION,
        height: Math.ceil(root.getBoundingClientRect().height),
      })
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [configuredParentOrigin, sendToParent])

  if (!configuredParentOrigin && window.parent !== window) {
    return <p className="embed-configuration-error">This embed is missing a valid parentOrigin.</p>
  }

  return (
    <main className={`embed-app embed-app--${mode}`} ref={rootRef}>
      <GlPythonWorkspace
        project={project}
        activeFile={project.mainFile}
        openFiles={[project.mainFile]}
        onOpenFile={() => undefined}
        onCloseFile={() => undefined}
        onFileCodeChange={(path, code) => setProject((current) => updateProjectFile(current, path, code))}
        isGraphicsOpen={isGraphicsOpen}
        onGraphicsOpenChange={setIsGraphicsOpen}
        t={embedStrings}
        compact
        capabilities={{
          breadcrumbs: false,
          fileTabs: false,
          resetOutput: false,
          visualization: mode === 'eval',
          graphics: mode === 'turtle',
        }}
      />
    </main>
  )
}
