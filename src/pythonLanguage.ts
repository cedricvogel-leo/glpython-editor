/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// (The notice above is the one of Monaco Editor's python.ts, which this file
// adapts; Monaco's license text is in THIRD_PARTY_NOTICES.md.)

// glpython's Python language for Monaco: Monaco's own Python definition
// (monaco-editor, src/basic-languages/python/python.ts, MIT license) with
// three changes, so the editor and the visualizer (see pyHighlight.ts) colour
// code as the course does:
// - keywords are Python's keywords (keyword.kwlist) - Monaco also counts
//   builtins such as print, int, str, type and self, which the course writes
//   as plain names;
// - True, False and None are values, in the number colour;
// - a comment after code ("x = 1  # ...") is a comment too.
// It has its own id rather than replacing "python": Monaco loads its built-in
// definition lazily and would overwrite a replacement.
import type { Monaco } from '@monaco-editor/react'

export const GLPYTHON_PYTHON = 'glpython-python'

// Registered once per Monaco instance; cheap to call before every use.
const registeredIn = new WeakSet<object>()

export function registerGlpythonPython(monaco: Monaco): void {
  if (registeredIn.has(monaco)) return
  registeredIn.add(monaco)
  if (monaco.languages.getLanguages().some((language: { id: string }) => language.id === GLPYTHON_PYTHON)) return
  monaco.languages.register({ id: GLPYTHON_PYTHON, aliases: ['Python'] })
  monaco.languages.setLanguageConfiguration(GLPYTHON_PYTHON, {
    comments: { lineComment: '#', blockComment: ["'''", "'''"] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] },
      { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    onEnterRules: [
      {
        beforeText: /^\s*(?:def|class|for|if|elif|else|while|try|with|finally|except|async|match|case).*?:\s*$/,
        action: { indentAction: monaco.languages.IndentAction.Indent },
      },
    ],
    folding: {
      offSide: true,
      markers: { start: /^\s*#region\b/, end: /^\s*#endregion\b/ },
    },
  })
  monaco.languages.setMonarchTokensProvider(GLPYTHON_PYTHON, {
    defaultToken: '',
    tokenPostfix: '.python',
    keywords: ['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'],
    constants: ['True', 'False', 'None'],
    brackets: [
      { open: '{', close: '}', token: 'delimiter.curly' },
      { open: '[', close: ']', token: 'delimiter.bracket' },
      { open: '(', close: ')', token: 'delimiter.parenthesis' },
    ],
    tokenizer: {
      root: [
        { include: '@whitespace' },
        { include: '@numbers' },
        { include: '@strings' },
        [/[,:;]/, 'delimiter'],
        [/[{}[\]()]/, '@brackets'],
        [/@[a-zA-Z_]\w*/, 'tag'],
        [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@constants': 'number.constant', '@default': 'identifier' } }],
      ],
      whitespace: [
        [/\s+/, 'white'],
        [/#.*$/, 'comment'],
        [/'''/, 'string', '@endDocString'],
        [/"""/, 'string', '@endDblDocString'],
      ],
      endDocString: [
        [/[^']+/, 'string'],
        [/\\'/, 'string'],
        [/'''/, 'string', '@popall'],
        [/'/, 'string'],
      ],
      endDblDocString: [
        [/[^"]+/, 'string'],
        [/\\"/, 'string'],
        [/"""/, 'string', '@popall'],
        [/"/, 'string'],
      ],
      numbers: [
        [/-?0x([abcdef]|[ABCDEF]|\d)+[lL]?/, 'number.hex'],
        [/-?(\d*\.)?\d+([eE][+-]?\d+)?[jJ]?[lL]?/, 'number'],
      ],
      strings: [
        [/'$/, 'string.escape', '@popall'],
        [/f'{1,3}/, 'string.escape', '@fStringBody'],
        [/'/, 'string.escape', '@stringBody'],
        [/"$/, 'string.escape', '@popall'],
        [/f"{1,3}/, 'string.escape', '@fDblStringBody'],
        [/"/, 'string.escape', '@dblStringBody'],
      ],
      fStringBody: [
        [/[^\\'{}]+$/, 'string', '@popall'],
        [/[^\\'{}]+/, 'string'],
        [/\{[^}':!=]+/, 'identifier', '@fStringDetail'],
        [/\\./, 'string'],
        [/'/, 'string.escape', '@popall'],
        [/\\$/, 'string'],
      ],
      stringBody: [
        [/[^\\']+$/, 'string', '@popall'],
        [/[^\\']+/, 'string'],
        [/\\./, 'string'],
        [/'/, 'string.escape', '@popall'],
        [/\\$/, 'string'],
      ],
      fDblStringBody: [
        [/[^\\"{}]+$/, 'string', '@popall'],
        [/[^\\"{}]+/, 'string'],
        [/\{[^}':!=]+/, 'identifier', '@fStringDetail'],
        [/\\./, 'string'],
        [/"/, 'string.escape', '@popall'],
        [/\\$/, 'string'],
      ],
      dblStringBody: [
        [/[^\\"]+$/, 'string', '@popall'],
        [/[^\\"]+/, 'string'],
        [/\\./, 'string'],
        [/"/, 'string.escape', '@popall'],
        [/\\$/, 'string'],
      ],
      fStringDetail: [
        [/[:][^}]+/, 'string'],
        [/[!][ars]/, 'string'],
        [/=/, 'string'],
        [/\}/, 'identifier', '@pop'],
      ],
    },
  })
}
