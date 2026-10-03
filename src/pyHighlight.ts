// Syntax highlighting for the plain-HTML visualizer view (see App.tsx's
// Frame component), built on Monaco's own standalone Python tokenizer
// (monaco.editor.tokenize) so colors stay consistent with the real editor
// without pulling in a separate highlighting library.
//
// monaco.editor.tokenize only classifies text into Monarch token types
// (e.g. "keyword.python", "string.python") - it does not return colors;
// those normally come from VS Code's internal theme/TextMate matching,
// which isn't exposed as a public API. This maps the small, fixed set of
// token types Monaco's actual Python tokenizer produces (see
// node_modules/monaco-editor/esm/vs/languages/definitions/python/python.js)
// to CSS classes using the vs-dark theme's well-known default colors for
// each category, so the result looks consistent with the real editor even
// though it isn't using its theme engine directly.
import type { Monaco } from '@monaco-editor/react'

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
  const tokens = monaco.editor.tokenize(text, 'python')[0] ?? []
  const runs: PyTextRun[] = []
  for (let t = 0; t < tokens.length; t++) {
    const start = tokens[t].offset
    const end = t + 1 < tokens.length ? tokens[t + 1].offset : text.length
    if (end > start) runs.push({ text: text.slice(start, end), className: pyTokenClassName(tokens[t].type) })
  }
  return runs
}
