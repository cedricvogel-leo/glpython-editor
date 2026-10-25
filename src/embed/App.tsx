import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { GlPythonWorkspace, type WorkspaceCommand } from '../GlPythonWorkspace'
import {
  isEmbedMode,
  parseParentMessage,
  parseParentOrigin,
  type EmbedMode,
  type GlPythonChildMessage,
  type GlPythonFile,
  type GlPythonProtocolVersion,
} from '../embedProtocol'
import { updateProjectFile, type Project } from '../project'
import type { VisualizerMode } from '../visualizer'
import { coreStrings, resolveUiLocale } from '../i18n'

const defaultSource = 'print("Hello from glpython")'

type ChildMessageWithoutVersion = GlPythonChildMessage extends infer Message ? Message extends unknown ? Omit<Message, 'version'> : never : never

// A single source (protocol version 1) becomes "main.py"; a version 2
// program brings its own files and says which one runs.
function createEmbedProject(source: string, files?: GlPythonFile[], mainFile?: string): Project {
  const programFiles = files && mainFile ? files : [{ path: 'main.py', source }]
  return {
    id: 'liascript-embed',
    name: 'LiaScript',
    mainFile: files && mainFile ? mainFile : 'main.py',
    files: Object.fromEntries(programFiles.map((file) => [file.path, {
      path: file.path,
      label: file.path,
      kind: 'python' as const,
      code: file.source,
    }])),
  }
}

// Optional preset for the visualizer's box/substitution mode, e.g. from a
// LiaScript block's macro option: "?visualizer=box".
// Optional "?features=run,repl,visualize,…" from the macro's features=
// option: which of the embed's own parts to show (here: the REPL, the
// visualizer and the → chain export). Without it, everything shows.
const features = (() => {
  const list = new URLSearchParams(window.location.search).get('features')
  const enabled = list === null ? null : new Set(list.split(',').map((feature) => feature.trim()))
  return (feature: string) => enabled === null || enabled.has(feature)
})()

// "?size=large" (the macro's large option): bigger code, and with
// "&visualizerHeight=600" the visualizer at least that many pixels tall (the
// macro passes 60% of the course window; the iframe follows its content).
const isLarge = new URLSearchParams(window.location.search).get('size') === 'large'
const largeVisualizerHeight = Number(new URLSearchParams(window.location.search).get('visualizerHeight')) || null

function visualizerModeFromLocation(): VisualizerMode | undefined {
  const mode = new URLSearchParams(window.location.search).get('visualizer')
  return mode === 'box' || mode === 'substitution' ? mode : undefined
}

// The UI language: the host's "?lang=" (e.g. the LiaScript course's), else
// the browser's, else English.
const embedLocale = resolveUiLocale(new URLSearchParams(window.location.search).get('lang'), navigator.language)
document.documentElement.lang = embedLocale

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
  const [command, setCommand] = useState<WorkspaceCommand | null>(null)
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0)
  const commandIdRef = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // The protocol version the parent last spoke (see
  // GLPYTHON_EMBED_PROTOCOL_VERSION): every message to it uses that version,
  // so an older parent never sees one it would reject.
  const parentVersionRef = useRef<GlPythonProtocolVersion>(1)

  const sendToParent = useCallback((message: ChildMessageWithoutVersion) => {
    if (configuredParentOrigin && window.parent !== window) {
      window.parent.postMessage({ ...message, version: parentVersionRef.current }, configuredParentOrigin)
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
          code: 'invalid-message',
          message: 'The parent sent an invalid glpython message.',
        })
        return
      }

      parentVersionRef.current = message.version
      if (message.type === 'glpython:reset') {
        setCommand(null)
        setWorkspaceGeneration((generation) => generation + 1)
        return
      }

      const nextMode = message.mode ?? mode
      setMode(nextMode)
      setIsGraphicsOpen(nextMode === 'turtle')
      setProject(createEmbedProject(message.source, message.files, message.mainFile))
      if (message.type === 'glpython:run' || message.type === 'glpython:visualize' || message.type === 'glpython:test') {
        setCommand({
          id: ++commandIdRef.current,
          type: message.type === 'glpython:run' ? 'run' : message.type === 'glpython:visualize' ? 'visualize' : 'test',
        })
      } else {
        setCommand(null)
      }
    }

    window.addEventListener('message', onMessage)
    sendToParent({
      type: 'glpython:ready',
      capabilities: {
        input: typeof SharedArrayBuffer !== 'undefined',
        files: true,
        tests: true,
      },
    })
    return () => window.removeEventListener('message', onMessage)
  }, [configuredParentOrigin, mode, sendToParent])

  useEffect(() => {
    const root = rootRef.current
    if (!root || !configuredParentOrigin) return
    const observer = new ResizeObserver(() => {
      sendToParent({
        type: 'glpython:resize',
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
    <main
      className={`embed-app embed-app--${mode}${isLarge ? ' embed-app--large' : ''}`}
      style={isLarge && largeVisualizerHeight ? { '--glp-large-visualizer-height': `${largeVisualizerHeight}px` } as CSSProperties : undefined}
      data-input-available={typeof SharedArrayBuffer !== 'undefined'}
      ref={rootRef}
    >
      <GlPythonWorkspace
        key={`${mode}:${workspaceGeneration}`}
        project={project}
        command={command}
        visualizerMode={visualizerModeFromLocation()}
        activeFile={project.mainFile}
        openFiles={[project.mainFile]}
        onOpenFile={() => undefined}
        onCloseFile={() => undefined}
        onFileCodeChange={(path, code) => setProject((current) => updateProjectFile(current, path, code))}
        isGraphicsOpen={isGraphicsOpen}
        onGraphicsOpenChange={setIsGraphicsOpen}
        t={coreStrings[embedLocale]}
        compact
        capabilities={{
          actions: false,
          editor: false,
          exitVisualizer: mode !== 'visual',
          breadcrumbs: false,
          fileTabs: false,
          resetOutput: false,
          visualization: mode !== 'turtle' && features('visualize'),
          graphics: mode === 'turtle',
          repl: mode === 'eval' && features('repl'),
          export: features('export'),
          emptyOutput: mode !== 'visual',
        }}
      />
    </main>
  )
}
