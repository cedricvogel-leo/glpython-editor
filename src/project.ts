export type ProjectFileKind = 'python' | 'text'

export type ProjectFile = {
  path: string
  label: string
  code: string
  kind: ProjectFileKind
}

export type Project = {
  id: string
  name: string
  mainFile: string
  files: Record<string, ProjectFile>
}

export const initialProject: Project = {
  id: 'first-steps',
  name: 'First steps',
  mainFile: 'main.py',
  files: {
    'main.py': {
      path: 'main.py',
      label: 'Main program',
      kind: 'python',
      code: `# main.py is the project entry point\nfrom gturtle import *\nfrom greetings import welcome\n\nprint(welcome("Python learner"))\n\nmakeTurtle()\nfor _ in range(4):\n    forward(100)\n    right(90)`,
    },
    'greetings.py': {
      path: 'greetings.py',
      label: 'Greetings helper',
      kind: 'python',
      code: `def welcome(name):\n    return f"Hello, {name}!"`,
    },
    'notes.md': {
      path: 'notes.md',
      label: 'Lesson notes',
      kind: 'text',
      code: `# Variables and output\n\nUse print() to show a value.\nStore reusable values in variables.`,
    },
  },
}

// Whether any Python file in the project imports the `gturtle` module, in
// any of its common forms (`import gturtle`, `import gturtle as t`,
// `from gturtle import ...`). Used to auto-open the turtle graphics panel
// only for projects that actually draw something, instead of showing it
// by default for every project.
const GTURTLE_IMPORT_PATTERN = /(^|\n)\s*(import\s+gturtle\b|from\s+gturtle\b)/

export function projectImportsGturtle(project: Project): boolean {
  return Object.values(project.files).some((file) => file.kind === 'python' && GTURTLE_IMPORT_PATTERN.test(file.code))
}

export function updateProjectFile(project: Project, path: string, code: string): Project {
  const file = project.files[path]
  if (!file) return project

  return {
    ...project,
    files: {
      ...project.files,
      [path]: { ...file, code },
    },
  }
}

export function addProjectFile(project: Project, file: ProjectFile): Project {
  return {
    ...project,
    files: { ...project.files, [file.path]: file },
  }
}

export function deleteProjectFile(project: Project, path: string): Project {
  const { [path]: deletedFile, ...remainingFiles } = project.files
  if (!deletedFile) return project

  const nextMainFile = project.mainFile === path
    ? Object.keys(remainingFiles).find((filePath) => remainingFiles[filePath].kind === 'python') ?? Object.keys(remainingFiles)[0]
    : project.mainFile

  return { ...project, mainFile: nextMainFile, files: remainingFiles }
}

export function renameProjectFile(project: Project, path: string, nextPath: string): Project {
  const file = project.files[path]
  if (!file || project.files[nextPath]) return project

  const { [path]: renamedFile, ...remainingFiles } = project.files
  const nextFile = { ...renamedFile, path: nextPath, label: nextPath.replace(/\.[^/.]+$/, '') }

  return {
    ...project,
    mainFile: project.mainFile === path ? nextPath : project.mainFile,
    files: { ...remainingFiles, [nextPath]: nextFile },
  }
}
