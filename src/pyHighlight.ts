// Syntax highlighting for the plain-HTML visualizer view (see App.tsx's
// Frame component), built on the same tokenizer as the editor (glpython's
// Python language, see pythonLanguage.ts, via monaco.editor.tokenize), so
// both classify code alike without a separate highlighting library.
//
// monaco.editor.tokenize only classifies text into Monarch token types
// (e.g. "keyword.python", "number.constant.python") - it does not return
// colors. This maps those types to CSS classes, coloured by the same
// --glp-syntax-* tokens in style.css that the editor's theme uses
// (monacoTheme.ts).
import type { Monaco } from '@monaco-editor/react'
import { GLPYTHON_PYTHON, registerGlpythonPython } from './pythonLanguage'

export function pyTokenClassName(tokenType: string): string | undefined {
  if (tokenType.startsWith('keyword')) return 'py-tok-keyword'
  if (tokenType.startsWith('string')) return 'py-tok-string'
  if (tokenType.startsWith('number')) return 'py-tok-number'
  if (tokenType.startsWith('comment')) return 'py-tok-comment'
  if (tokenType.startsWith('tag')) return 'py-tok-decorator'
  return undefined
}

export type PyTextRun = { text: string; className?: string }

// Splits one line fragment of plain Python source into colored runs. Used
// to tokenize only the *un-substituted* leftover text of each rendered
// line (see Frame's buildLineSegments) - substituted values and loop
// annotations keep their own dedicated highlight color instead.
export function tokenizePythonFragment(monaco: Monaco, text: string): PyTextRun[] {
  if (text === '') return []
  // A fragment is always a single rendered line's worth of leftover plain
  // text (see Frame's buildLineSegments, which already split the file into
  // lines and further into per-mark gaps before calling this), so only the
  // first (and only) line tokenize() produces is ever relevant.
  registerGlpythonPython(monaco)
  const tokens = monaco.editor.tokenize(text, GLPYTHON_PYTHON)[0] ?? []
  const runs: PyTextRun[] = []
  for (let t = 0; t < tokens.length; t++) {
    const start = tokens[t].offset
    const end = t + 1 < tokens.length ? tokens[t + 1].offset : text.length
    if (end > start) runs.push({ text: text.slice(start, end), className: pyTokenClassName(tokens[t].type) })
  }
  return runs
}
