// The wording of the hints below errors (CoreStrings.errorHint) in German and
// English, against the built library: one case per hint kind, the REPL's
// extra question, and German without ß, "du" or "Sie". Which errors get
// which hint is checked in scripts/check-runtime-hints.py.
//
//   npm run build && node scripts/check-error-hints.mjs
import assert from 'node:assert/strict'
import { coreStrings } from '../dist/index.js'

const de = coreStrings.de
const en = coreStrings.en

const cases = [
  [{ kind: 'name-not-defined', name: 'zahl' },
    '`zahl` ist hier nicht definiert. Tippfehler oder Gross-/Kleinschreibung? Fehlt die Definition?',
    "`zahl` isn't defined here. A typo or upper/lower case? Is the definition missing?"],
  [{ kind: 'missing-arguments', function: 'f', names: ['y'] },
    '`f` erwartet mehr Argumente: Es fehlt ein Wert für `y`.',
    '`f` expects more arguments: a value for `y` is missing.'],
  [{ kind: 'missing-arguments', function: 'f', names: ['a', 'b'] },
    '`f` erwartet mehr Argumente: Es fehlen Werte für `a` und `b`.',
    '`f` expects more arguments: values for `a` and `b` are missing.'],
  [{ kind: 'missing-arguments', function: 'fläche', names: ['a', 'b', 'c'] },
    '`fläche` erwartet mehr Argumente: Es fehlen Werte für `a`, `b` und `c`.',
    '`fläche` expects more arguments: values for `a`, `b` and `c` are missing.'],
  [{ kind: 'too-many-arguments', function: 'f', expected: 1, given: 2 },
    '`f` erwartet 1 Argument, erhalten hat es 2.',
    '`f` expects 1 argument but got 2.'],
  [{ kind: 'too-many-arguments', function: 'f', expected: 2, given: 3 },
    '`f` erwartet 2 Argumente, erhalten hat es 3.',
    '`f` expects 2 arguments but got 3.'],
  [{ kind: 'too-many-arguments', function: 'f', expected: 0, given: 1 },
    '`f` erwartet keine Argumente, erhalten hat es 1.',
    '`f` expects no arguments but got 1.'],
  [{ kind: 'none-operand' },
    'Ein Wert ist `None`. Gibt eine Funktion ihr Ergebnis mit `print` aus statt mit `return`?',
    'A value is `None`. Does a function output its result with `print` instead of `return`?'],
  [{ kind: 'text-plus-number' },
    'Text und Zahl lassen sich nicht mit `+` verbinden.',
    "Text and a number can't be joined with `+`."],
  [{ kind: 'zero-division' },
    'Ein Nenner ist 0 geworden. Wie lautet der Nenner, Schritt für Schritt ausgewertet?',
    'A denominator has become 0. What is the denominator, evaluated step by step?'],
  [{ kind: 'recursion' },
    'Die Funktion ruft sich immer wieder selbst auf. Gibt es einen Fall, in dem sie ohne weiteren Aufruf ein Ergebnis zurückgibt?',
    'The function keeps calling itself. Is there a case in which it returns a result without calling itself again?'],
  [{ kind: 'list-index' },
    'Die Liste hat weniger Elemente, als der Index verlangt. Die Zählung beginnt bei 0.',
    'The list has fewer elements than the index asks for. Counting starts at 0.'],
  [{ kind: 'doctest-blank', line: 2, function: 'f' },
    'Nach `>>>` fehlt ein Leerzeichen (Zeile 2 im Docstring von `f`).',
    'A space is missing after `>>>` (line 2 of the docstring of `f`).'],
]
for (const [hint, german, english] of cases) {
  assert.equal(de.errorHint(hint, 'other'), german)
  assert.equal(en.errorHint(hint, 'other'), english)
}

// The REPL asks whether the file has been run (only for an undefined name).
const name = { kind: 'name-not-defined', name: 'quadrat' }
assert.equal(de.errorHint(name, 'repl'), '`quadrat` ist hier nicht definiert. Tippfehler oder Gross-/Kleinschreibung? Fehlt die Definition? Wurde die Datei schon ausgeführt?')
assert.equal(en.errorHint(name, 'repl'), "`quadrat` isn't defined here. A typo or upper/lower case? Is the definition missing? Has the file been run yet?")
assert.equal(de.errorHint({ kind: 'zero-division' }, 'repl'), de.errorHint({ kind: 'zero-division' }, 'other'))

// A kind this version doesn't know (e.g. from a newer runtime): no hint.
assert.equal(de.errorHint({ kind: 'something-new' }, 'other'), null)
assert.equal(en.errorHint({ kind: 'something-new' }, 'other'), null)

assert.equal(de.hintLabel, 'Hinweis:')
assert.equal(en.hintLabel, 'Hint:')
assert.equal(de.testsExamplesError('ValueError: x'), 'Die Beispiele konnten nicht gelesen werden: ValueError: x')

// German: Swiss spelling, and neutral - never "du" or "Sie".
for (const text of [...cases.map(([hint]) => de.errorHint(hint, 'repl')), de.errorHint(name, 'repl')]) {
  assert.ok(!text.includes('ß'), `ß in ${text}`)
  assert.ok(!/\b(du|dich|dir|dein\w*|Sie|Ihnen|Ihr\w*)\b/.test(text), `du/Sie in ${text}`)
}

console.log('Error hint wording checks passed.')
