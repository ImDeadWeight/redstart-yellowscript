// =============================================================================
// A SymbolProvider for the bench: the TypeScript language service, headless.
// =============================================================================
// In the editor, ys_outline, ys_find_symbol and ys_references ask VS Code's
// language servers. The bench has none, so it asks the TypeScript compiler
// API directly, over the workspace's .js and .ts files. Same answers for JS
// and TS as the editor's built-in TypeScript server gives; nothing for other
// languages, where ys_outline falls back to its text outline as it does in
// the editor.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

import type { OutlineSymbol, SymbolProvider } from '../tools/symbols.ts'

const SOURCE = /\.(m|c)?(j|t)sx?$/i
const SKIP = new Set(['node_modules', '.git', '.yellowscript', 'dist', 'build'])

function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name))
      } else if (SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(path.join(dir, entry.name))
      }
    }
  }
  walk(root)
  return out
}

export function createTsSymbolProvider(root: string): SymbolProvider {
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
  }
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => sourceFiles(root),
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
  const lineOf = (file: string, position: number) => {
    const source = service.getProgram()?.getSourceFile(file)
    return source ? source.getLineAndCharacterOfPosition(position) : { line: 0, character: 0 }
  }
  const norm = (file: string) => path.resolve(file)

  const convert = (item: ts.NavigationTree, file: string): OutlineSymbol => {
    const span = item.spans[0]!
    const symbol: OutlineSymbol = {
      name: item.text,
      kind: item.kind,
      line: lineOf(file, span.start).line + 1,
      endLine: lineOf(file, span.start + span.length).line + 1,
    }
    const children = (item.childItems ?? []).filter((c) => c.kind !== 'alias').map((c) => convert(c, file))
    if (children.length) symbol.children = children
    return symbol
  }

  return {
    async outline(absolutePath) {
      if (!SOURCE.test(absolutePath)) return []
      const tree = service.getNavigationTree(norm(absolutePath))
      return (tree.childItems ?? []).filter((c) => c.kind !== 'alias').map((c) => convert(c, norm(absolutePath)))
    },
    async workspaceSymbols(query) {
      return service.getNavigateToItems(query, 100).map((item) => ({
        name: item.name,
        kind: item.kind,
        file: norm(item.fileName),
        line: lineOf(item.fileName, item.textSpan.start).line + 1,
        ...(item.containerName ? { container: item.containerName } : {}),
      }))
    },
    async references(absolutePath, line, character) {
      const file = norm(absolutePath)
      const source = service.getProgram()?.getSourceFile(file)
      if (!source) return []
      const position = source.getPositionOfLineAndCharacter(line - 1, character - 1)
      return (service.getReferencesAtPosition(file, position) ?? []).map((ref) => {
        const at = lineOf(ref.fileName, ref.textSpan.start)
        return { file: norm(ref.fileName), line: at.line + 1, character: at.character + 1 }
      })
    },
  }
}
