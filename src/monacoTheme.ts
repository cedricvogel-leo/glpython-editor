// The Monaco editor's theme, built from the --glp-* tokens of style.css, so
// the IDE's editor looks like the rest of glpython (light code surface, the
// course's syntax colours). Monaco can't read CSS variables, so the tokens'
// current values are read from the page (a host's overrides included) when
// the theme is defined.
import type { Monaco } from '@monaco-editor/react'

export const GLPYTHON_THEME = 'glpython'

// A token's value as "#rrggbb" (Monaco's format), resolved by the browser.
function tokenColor(probe: HTMLElement, name: string, fallback: string): string {
  probe.style.color = fallback
  probe.style.color = `var(--glp-${name}, ${fallback})`
  const channels = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? []
  if (channels.length < 3) return fallback
  const hex = channels.slice(0, 3).map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')
  const alpha = channels.length > 3 && channels[3] < 1 ? Math.round(channels[3] * 255).toString(16).padStart(2, '0') : ''
  return `#${hex}${alpha}`
}

export function defineGlpythonTheme(monaco: Monaco): void {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  document.body.append(probe)
  const color = (name: string, fallback: string) => tokenColor(probe, name, fallback)
  const bg = color('bg', '#FFFFFF')
  const surface = color('surface', '#F3F4F6')
  const border = color('border', '#D1D5DB')
  const borderControl = color('border-control', '#6B7280')
  const text = color('text', '#1A1A1A')
  const textMuted = color('text-muted', '#4B5563')
  const accent = color('accent', '#1F3A5F')
  const current = color('current', '#DCE6F2')
  const currentOutline = color('current-outline', '#1F3A5F')
  const error = color('error', '#B42318')
  const warning = color('warning', '#8A4B00')
  const keyword = color('syntax-keyword', '#1F3A5F')
  const string = color('syntax-string', '#8A3B12')
  const number = color('syntax-number', '#0F5F7A')
  const comment = color('syntax-comment', '#5B6472')
  probe.remove()
  const plain = (value: string) => value.replace('#', '')

  monaco.editor.defineTheme(GLPYTHON_THEME, {
    base: 'vs',
    inherit: true,
    // Names, operators and brackets in the text colour; keywords bold and
    // comments italic, as in the visualizer.
    rules: [
      { token: '', foreground: plain(text) },
      { token: 'identifier', foreground: plain(text) },
      { token: 'delimiter', foreground: plain(text) },
      // The base theme colours brackets by kind; the course doesn't.
      { token: 'delimiter.parenthesis', foreground: plain(text) },
      { token: 'delimiter.bracket', foreground: plain(text) },
      { token: 'delimiter.curly', foreground: plain(text) },
      { token: 'keyword', foreground: plain(keyword), fontStyle: 'bold' },
      { token: 'tag', foreground: plain(keyword), fontStyle: 'bold' },
      { token: 'string', foreground: plain(string) },
      { token: 'number', foreground: plain(number) },
      { token: 'comment', foreground: plain(comment), fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': surface,
      'editor.foreground': text,
      'editorGutter.background': surface,
      'editorLineNumber.foreground': textMuted,
      'editorLineNumber.activeForeground': text,
      'editorCursor.foreground': accent,
      'editor.lineHighlightBackground': bg,
      'editor.lineHighlightBorder': bg,
      'editor.selectionBackground': current,
      'editor.inactiveSelectionBackground': current,
      'editor.selectionHighlightBackground': bg,
      'editor.wordHighlightBackground': bg,
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((level) => [`editorBracketHighlight.foreground${level}`, text])),
      'editorBracketMatch.background': current,
      'editorBracketMatch.border': currentOutline,
      'editorIndentGuide.background1': border,
      'editorIndentGuide.activeBackground1': borderControl,
      'editorWhitespace.foreground': border,
      'editorError.foreground': error,
      'editorWarning.foreground': warning,
      'focusBorder': accent,
      'scrollbarSlider.background': border,
      'scrollbarSlider.hoverBackground': borderControl,
      'scrollbarSlider.activeBackground': textMuted,
    },
  })
}
