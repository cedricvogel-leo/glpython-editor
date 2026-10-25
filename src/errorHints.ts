// What the runtime reports for an error it has a hint for (see
// src/runtime/hints.py): the kind of mistake and the names in Python's
// message. CoreStrings.errorHint words it in the UI's language.
export type ErrorHint =
  | { kind: 'name-not-defined'; name: string }
  | { kind: 'missing-arguments'; function: string; names: string[] }
  | { kind: 'too-many-arguments'; function: string; expected: number; given: number }
  | { kind: 'none-operand' }
  | { kind: 'text-plus-number' }
  | { kind: 'zero-division' }
  | { kind: 'recursion' }
  | { kind: 'list-index' }
  | { kind: 'doctest-blank'; line: number; function: string }

// Where the error showed up: the REPL adds a question for an undefined name.
export type ErrorHintContext = 'repl' | 'other'
