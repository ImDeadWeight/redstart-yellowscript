// =============================================================================
// Diagnostics for the bench: what the editor's Problems panel would say,
// without an editor.
// =============================================================================
// In VS Code, ys_diagnostics and the report after each write come from the
// language servers. The bench has none, so a model there wrote code blind to
// what the product would have told it (agent-runtime plan item 1). This
// supplies the same records headlessly:
//
//   .ts / .js      a TypeScript language service over the workspace's
//                  tsconfig.json (or plain defaults without one), like the
//                  editor's built-in TypeScript server
//   .svelte        which TypeScript cannot see: `svelte-check --output
//                  machine` when the workspace depends on Svelte and has it
//                  installed. It checks the .ts files too, so it replaces the
//                  language service there rather than doubling its answers.
//
// Results are kept until a source file changes, so ys_diagnostics after a
// read costs nothing.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

import { formatWriteDiagnostics, type DiagnosticRecord, type DiagnosticSeverity } from '../tools/diagnostics.ts'

const SOURCE = /\.(m|c)?(j|t)sx?$|\.svelte$/i
const SKIP = new Set(['node_modules', '.git', '.yellowscript', '.svelte-kit', 'dist', 'build'])

export interface HeadlessDiagnostics {
  /** Which checker answers: the editor would use the same. */
  readonly checker: 'svelte-check' | 'typescript'
  /** The current problems in the workspace. */
  records(): DiagnosticRecord[]
  /** The report appended after a write, as the product's diagnosticsAfterWrite gives it. */
  afterWrite(files: string[]): Promise<string | null>
}

/** Every source file under `root` and its newest change, to know when to re-check. */
function sourceStamp(root: string): string {
  let newest = 0
  let count = 0
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(full)
      } else if (SOURCE.test(entry.name) || entry.name === 'tsconfig.json' || entry.name === 'package.json') {
        count++
        try {
          newest = Math.max(newest, fs.statSync(full).mtimeMs)
        } catch {
          // Gone between the listing and the stat: the next check sees it.
        }
      }
    }
  }
  walk(root)
  return `${count}:${newest}`
}

/** The workspace depends on Svelte and has svelte-check installed: its bin script, or null. */
export function svelteCheckBin(root: string): string | null {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  if (!deps.svelte) return null
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'svelte-check', 'package.json'), 'utf8')) as { bin?: string | Record<string, string> }
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['svelte-check']
    return bin ? path.join(root, 'node_modules', 'svelte-check', bin) : null
  } catch {
    return null
  }
}

/**
 * svelte-check's machine output as records. Lines look like
 * `1795548587901 ERROR "src/routes/+page.svelte" 12:5 "Cannot assign to constant"`,
 * with JSON-escaped strings and 1-based positions; START and COMPLETED lines
 * carry no problem.
 */
export function parseSvelteCheckMachine(output: string, root: string): DiagnosticRecord[] {
  const out: DiagnosticRecord[] = []
  const line = /^\d+\s+(ERROR|WARNING|HINT)\s+("(?:[^"\\]|\\.)*")\s+(\d+):(\d+)\s+("(?:[^"\\]|\\.)*")/
  for (const raw of output.split(/\r?\n/)) {
    const m = line.exec(raw.trim())
    if (!m) continue
    let file: string
    let message: string
    try {
      file = JSON.parse(m[2]!) as string
      message = JSON.parse(m[5]!) as string
    } catch {
      continue
    }
    const severity: DiagnosticSeverity = m[1] === 'ERROR' ? 'error' : m[1] === 'WARNING' ? 'warning' : 'hint'
    out.push({ file: path.resolve(root, file), line: Number(m[3]), column: Number(m[4]), severity, message, source: 'svelte-check' })
  }
  return out
}

/** Run svelte-check once over the workspace (after `svelte-kit sync`, as `npm run check` does). */
function runSvelteCheck(root: string, bin: string): DiagnosticRecord[] {
  const kit = path.join(root, 'node_modules', '@sveltejs', 'kit', 'svelte-kit.js')
  if (fs.existsSync(kit)) spawnSync(process.execPath, [kit, 'sync'], { cwd: root, timeout: 60_000, windowsHide: true })
  const run = spawnSync(process.execPath, [bin, '--output', 'machine', '--workspace', root], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  return parseSvelteCheckMachine(`${run.stdout ?? ''}\n${run.stderr ?? ''}`, root)
}

/** The workspace's compiler options: its tsconfig.json when it parses, else defaults for plain JS and TS. */
function compilerSetup(root: string): { options: ts.CompilerOptions; files: () => string[] } {
  const defaults: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: true,
  }
  const configPath = path.join(root, 'tsconfig.json')
  if (fs.existsSync(configPath)) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile)
    if (!read.error) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, { noEmit: true }, configPath)
      // A config that extends a file not generated yet (SvelteKit's) still
      // gives its own files; its options are kept where they parsed.
      if (parsed.fileNames.length > 0) {
        return {
          options: { ...defaults, ...parsed.options, noEmit: true },
          files: () => ts.parseJsonConfigFileContent(read.config, ts.sys, root, { noEmit: true }, configPath).fileNames,
        }
      }
    }
  }
  const walk = (dir: string, out: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name), out)
      } else if (/\.(m|c)?(j|t)sx?$/i.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(path.join(dir, entry.name))
      }
    }
    return out
  }
  return { options: defaults, files: () => walk(root, []) }
}

const SEVERITY: Record<ts.DiagnosticCategory, DiagnosticSeverity> = {
  [ts.DiagnosticCategory.Error]: 'error',
  [ts.DiagnosticCategory.Warning]: 'warning',
  [ts.DiagnosticCategory.Suggestion]: 'hint',
  [ts.DiagnosticCategory.Message]: 'info',
}

/** The TypeScript language service's problems in the workspace's own files. */
function typescriptChecker(root: string): () => DiagnosticRecord[] {
  const { options, files } = compilerSetup(root)
  /** Listed once per check: the service asks for them many times. */
  let names = files()
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => names,
    getScriptVersion: (file) => {
      try {
        return String(fs.statSync(file).mtimeMs)
      } catch {
        return '0'
      }
    },
    getScriptSnapshot: (file) => (fs.existsSync(file) ? ts.ScriptSnapshot.fromString(fs.readFileSync(file, 'utf8')) : undefined),
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }
  const service = ts.createLanguageService(host, ts.createDocumentRegistry())
  const inWorkspace = (file: string) => {
    const rel = path.relative(root, file)
    return !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(/[\\/]/).some((part) => SKIP.has(part))
  }
  return () => {
    names = files()
    const out: DiagnosticRecord[] = []
    for (const file of names) {
      if (!inWorkspace(file) || file.endsWith('.d.ts')) continue
      const isJs = /\.(m|c)?jsx?$/i.test(file)
      const found = [
        ...service.getSyntacticDiagnostics(file),
        // Plain JS is only type-checked when the project asks (checkJs), as in the editor.
        ...(isJs && !options.checkJs ? [] : service.getSemanticDiagnostics(file)),
      ]
      for (const d of found) {
        const at = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 }
        out.push({
          file: path.resolve(d.file?.fileName ?? file),
          line: at.line + 1,
          column: at.character + 1,
          severity: SEVERITY[d.category],
          message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
          source: 'ts',
          code: String(d.code),
        })
      }
    }
    return out
  }
}

/** The workspace's diagnostics, from svelte-check when it is a Svelte project, else TypeScript. */
export function createHeadlessDiagnostics(root: string): HeadlessDiagnostics {
  // Looked up on each check: a run that installs svelte-check (Crestline's
  // setup does) gets it from then on.
  let typescript: (() => DiagnosticRecord[]) | null = null
  let checker: HeadlessDiagnostics['checker'] = 'typescript'
  let stamp = ''
  let cached: DiagnosticRecord[] = []
  const records = () => {
    const now = sourceStamp(root)
    if (now !== stamp) {
      const bin = svelteCheckBin(root)
      checker = bin ? 'svelte-check' : 'typescript'
      try {
        cached = bin ? runSvelteCheck(root, bin) : (typescript ??= typescriptChecker(root))()
      } catch {
        cached = []
      }
      stamp = now
    }
    return cached
  }
  return {
    get checker() {
      return checker
    },
    records,
    afterWrite: async (files) => formatWriteDiagnostics(records(), files, [root]),
  }
}
