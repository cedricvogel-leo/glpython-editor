import type { CoreStrings } from './GlPythonWorkspace'
import type { ErrorHint, ErrorHintContext } from './errorHints'

export type UiLocale = 'en' | 'de'

export const uiLocales: readonly UiLocale[] = ['en', 'de']

// The workspace's UI strings in every supported language - the only copy:
// the embed uses them directly and the glpython IDE builds its translations
// on top of them, so a course and the IDE use the same terms.
export const coreStrings: Record<UiLocale, CoreStrings> = {
  en: {
    exitVisualizer: 'Exit visualizer',
    readyOutput: 'No output yet – run the code.',
    resetOutput: 'Reset',
    visualize: 'Visualize',
    visualizing: 'Visualizing...',
    runProject: 'Run',
    running: 'Running...',
    runningOutput: (mainFile) => `Running ${mainFile} and its project files...`,
    visualizerBeforeStart: 'Before execution',
    visualizerStepOf: (current, total) => `Step ${current} of ${total}`,
    visualizerNoSteps: 'No steps recorded. Run a program with at least one statement first.',
    visualizerRestart: 'Restart',
    visualizerPrevStep: 'Previous step',
    visualizerFirstStep: 'First step',
    visualizerLastStep: 'Last step',
    visualizerOptions: 'Options',
    visualizerNextStep: 'Next step',
    visualizerAnimate: 'Animate steps',
    visualizerError: (message) => `Visualizer error: ${message}`,
    visualizerTruncated: 'Trace stopped after too many steps (likely an infinite loop). Showing what ran so far.',
    visualizerCollapsedCalls: (count, call) => `… ${count} more calls${call ? ` of ${call}` : ''} …`,
    replInputLabel: 'Python input',
    replDefinitionHint: 'Definitions belong in the file.',
    replVisualizeEntry: 'Visualize',
    replReplayNote: (reason) => reason === 'input'
      ? "Can't be visualized: the history up to here uses input()."
      : "Can't be visualized: replaying the history gave a different result, e.g. because of random numbers.",
    visualizerModeLabel: 'Display',
    visualizerModeBox: 'Box',
    visualizerModeSubstitution: 'Substitution',
    visualizerBoxHint: 'The box shows which return is executed.',
    copyChain: 'Copy → chain',
    copyChainDone: 'Copied',
    copyChainFailed: 'Could not copy',
    copyChainComments: 'Comments',
    chainConditionComment: (condition, value) => `${condition} is ${value}`,
    chainLocalsComment: 'body with local variables',
    valueKindFunction: 'function',
    valueKindClass: 'class',
    valueKindModule: 'module',
    runTests: 'Tests',
    testsRunning: 'Running tests...',
    testsSummary: (passed, total) => `${passed} of ${total} examples passed`,
    testsNone: 'No examples found in docstrings.',
    testsLoadError: (message) => `The file could not be loaded: ${message}`,
    visualizeExample: 'Visualize example',
    testsPrintHint: (source, output) => `Note: ${source} printed ${output}, but returned None.`,
    exampleGotExpected: (got, want) => `Got: ${got} \u00b7 Expected: ${want}`,
    errorHint: englishErrorHint,
    hintLabel: 'Hint:',
    testsExamplesError: (message) => `The examples could not be read: ${message}`,
    closeFile: (path) => `Close ${path}`,
    output: 'Console',
    stop: 'Stop',
    stoppedNote: 'Stopped. Python was restarted.',
    consoleSize: 'Console size',
    editorPlaceholder: 'Type code here',
    pyodideRuntime: 'Pyodide runtime',
    runsFile: (mainFile) => `Runs ${mainFile}`,
    noOutput: '(No output)',
    turtleGraphics: 'Turtle graphics',
    gturtleWindow: 'gturtle window',
    collapseGraphics: 'Hide graphics',
    expandGraphics: 'Expand graphics window',
    graphicsEmptyBefore: 'The drawing appears here when a project that imports',
    graphicsEmptyAfter: 'runs.',
    graphicsCollapsedLabel: 'Graphics',
    inputDialogTitle: 'Program input',
    inputDialogFallbackPrompt: 'This program is asking for input:',
    inputPlaceholder: 'Type your answer...',
    inputCancel: 'Cancel',
    inputSubmit: 'Submit',
  },
  de: {
    exitVisualizer: 'Visualisierung beenden',
    readyOutput: 'Noch keine Ausgabe – Code ausführen.',
    resetOutput: 'Zurücksetzen',
    visualize: 'Visualisieren',
    visualizing: 'Visualisierung läuft...',
    runProject: 'Ausführen',
    running: 'Wird ausgeführt...',
    runningOutput: (mainFile) => `${mainFile} und die Projektdateien werden ausgeführt...`,
    visualizerBeforeStart: 'Vor der Ausführung',
    visualizerStepOf: (current, total) => `Schritt ${current} von ${total}`,
    visualizerNoSteps: 'Keine Schritte aufgezeichnet. Zuerst ein Programm mit mindestens einer Anweisung ausführen.',
    visualizerRestart: 'Neu starten',
    visualizerPrevStep: 'Vorheriger Schritt',
    visualizerFirstStep: 'Erster Schritt',
    visualizerLastStep: 'Letzter Schritt',
    visualizerOptions: 'Optionen',
    visualizerNextStep: 'Nächster Schritt',
    visualizerAnimate: 'Schritte animieren',
    visualizerError: (message) => `Fehler in der Visualisierung: ${message}`,
    visualizerTruncated: 'Die Aufzeichnung wurde nach zu vielen Schritten gestoppt (wahrscheinlich eine Endlosschleife). Es wird gezeigt, was bisher ausgeführt wurde.',
    visualizerCollapsedCalls: (count, call) => `… ${count} weitere Aufrufe${call ? ` von ${call}` : ''} …`,
    replInputLabel: 'Python-Eingabe',
    replDefinitionHint: 'Definitionen gehören in die Datei.',
    replVisualizeEntry: 'Visualisieren',
    replReplayNote: (reason) => reason === 'input'
      ? 'Kann nicht visualisiert werden: Der Verlauf bis hier verwendet input().'
      : 'Kann nicht visualisiert werden: Beim Wiederholen des Verlaufs kam etwas anderes heraus, z. B. wegen Zufallszahlen.',
    visualizerModeLabel: 'Darstellung',
    visualizerModeBox: 'Kasten',
    visualizerModeSubstitution: 'Ersetzung',
    visualizerBoxHint: 'Der Kasten zeigt, welches return ausgeführt wird.',
    copyChain: '→-Kette kopieren',
    copyChainDone: 'Kopiert',
    copyChainFailed: 'Kopieren nicht möglich',
    copyChainComments: 'Kommentare',
    chainConditionComment: (condition, value) => `${condition} ist ${value}`,
    chainLocalsComment: 'Rumpf mit lokalen Variablen',
    valueKindFunction: 'Funktion',
    valueKindClass: 'Klasse',
    valueKindModule: 'Modul',
    runTests: 'Tests',
    testsRunning: 'Tests laufen...',
    testsSummary: (passed, total) => `${passed} von ${total} Beispielen bestanden`,
    testsNone: 'Keine Beispiele in Docstrings gefunden.',
    testsLoadError: (message) => `Die Datei konnte nicht geladen werden: ${message}`,
    visualizeExample: 'Beispiel visualisieren',
    testsPrintHint: (source, output) => `Hinweis: ${source} hat ${output} ausgegeben, aber None zurückgegeben.`,
    exampleGotExpected: (got, want) => `Erhalten: ${got} \u00b7 Erwartet: ${want}`,
    errorHint: germanErrorHint,
    hintLabel: 'Hinweis:',
    testsExamplesError: (message) => `Die Beispiele konnten nicht gelesen werden: ${message}`,
    closeFile: (path) => `${path} schliessen`,
    output: 'Konsole',
    stop: 'Stoppen',
    stoppedNote: 'Gestoppt. Python wurde neu gestartet.',
    consoleSize: 'Grösse der Konsole',
    editorPlaceholder: 'Code hier eingeben',
    pyodideRuntime: 'Pyodide-Laufzeit',
    runsFile: (mainFile) => `Führt ${mainFile} aus`,
    noOutput: '(Keine Ausgabe)',
    turtleGraphics: 'Turtle-Grafik',
    gturtleWindow: 'gturtle-Fenster',
    collapseGraphics: 'Grafik ausblenden',
    expandGraphics: 'Grafikfenster ausklappen',
    graphicsEmptyBefore: 'Die Zeichnung erscheint hier, wenn ein Projekt läuft, das',
    graphicsEmptyAfter: 'importiert.',
    graphicsCollapsedLabel: 'Grafik',
    inputDialogTitle: 'Programmeingabe',
    inputDialogFallbackPrompt: 'Dieses Programm bittet um eine Eingabe:',
    inputPlaceholder: 'Antwort eingeben...',
    inputCancel: 'Abbrechen',
    inputSubmit: 'Bestätigen',
  },
}

// "`a`", "`a` and `b`", "`a`, `b` and `c`" - names as code, joined with the
// language's "and".
function codeList(names: string[], and: string): string {
  const codes = names.map((name) => `\`${name}\``)
  return codes.length < 2 ? codes.join('') : `${codes.slice(0, -1).join(', ')} ${and} ${codes[codes.length - 1]}`
}

// The hints below errors (see src/runtime/hints.py). German in Swiss spelling,
// neutral: statements and questions, never "du" or "Sie".
function germanErrorHint(hint: ErrorHint, context: ErrorHintContext): string | null {
  switch (hint.kind) {
    case 'name-not-defined':
      return `\`${hint.name}\` ist hier nicht definiert. Tippfehler oder Gross-/Kleinschreibung? Fehlt die Definition?${context === 'repl' ? ' Wurde die Datei schon ausgeführt?' : ''}`
    case 'missing-arguments':
      return hint.names.length === 1
        ? `\`${hint.function}\` erwartet mehr Argumente: Es fehlt ein Wert für ${codeList(hint.names, 'und')}.`
        : `\`${hint.function}\` erwartet mehr Argumente: Es fehlen Werte für ${codeList(hint.names, 'und')}.`
    case 'too-many-arguments':
      return `\`${hint.function}\` erwartet ${hint.expected === 0 ? 'keine Argumente' : hint.expected === 1 ? '1 Argument' : `${hint.expected} Argumente`}, erhalten hat es ${hint.given}.`
    case 'none-operand':
      return 'Ein Wert ist `None`. Fehlt in einer Funktion das `return`?'
    case 'text-plus-number':
      return 'Text und Zahl lassen sich nicht mit `+` verbinden.'
    case 'zero-division':
      return 'Ein Nenner ist 0 geworden. Wie lautet der Nenner, Schritt für Schritt ausgewertet?'
    case 'recursion':
      return 'Die Funktion ruft sich immer wieder selbst auf. Gibt es einen Fall, in dem sie ohne weiteren Aufruf ein Ergebnis zurückgibt?'
    case 'list-index':
      return 'Die Liste hat weniger Elemente, als der Index verlangt. Die Zählung beginnt bei 0.'
    case 'doctest-blank':
      return `Nach \`>>>\` fehlt ein Leerzeichen (Zeile ${hint.line}).`
    default:
      return null
  }
}

function englishErrorHint(hint: ErrorHint, context: ErrorHintContext): string | null {
  switch (hint.kind) {
    case 'name-not-defined':
      return `\`${hint.name}\` isn't defined here. A typo or upper/lower case? Is the definition missing?${context === 'repl' ? ' Has the file been run yet?' : ''}`
    case 'missing-arguments':
      return hint.names.length === 1
        ? `\`${hint.function}\` expects more arguments: a value for ${codeList(hint.names, 'and')} is missing.`
        : `\`${hint.function}\` expects more arguments: values for ${codeList(hint.names, 'and')} are missing.`
    case 'too-many-arguments':
      return `\`${hint.function}\` expects ${hint.expected === 0 ? 'no arguments' : hint.expected === 1 ? '1 argument' : `${hint.expected} arguments`} but got ${hint.given}.`
    case 'none-operand':
      return 'A value is `None`. Is a function missing its `return`?'
    case 'text-plus-number':
      return "Text and a number can't be joined with `+`."
    case 'zero-division':
      return 'A denominator has become 0. What is the denominator, evaluated step by step?'
    case 'recursion':
      return 'The function keeps calling itself. Is there a case in which it returns a result without calling itself again?'
    case 'list-index':
      return 'The list has fewer elements than the index asks for. Counting starts at 0.'
    case 'doctest-blank':
      return `A space is missing after \`>>>\` (line ${hint.line}).`
    default:
      return null
  }
}

// The first candidate language that is supported, by its primary subtag
// ("de-CH" -> "de"), or English. Hosts pass their candidates in order of
// precedence, e.g. the embed: the course's language, then the browser's;
// the IDE: the learner's explicit choice, then the browser's. Unsupported
// languages (e.g. "fr") just fall through to the next candidate.
export function resolveUiLocale(...candidates: Array<string | null | undefined>): UiLocale {
  for (const candidate of candidates) {
    const primary = candidate?.toLowerCase().split('-')[0]
    const locale = uiLocales.find((supported) => supported === primary)
    if (locale) return locale
  }
  return 'en'
}
