// Bundle the extension host entry point.
//
// Output is `.cjs` on purpose: package.json declares `"type": "module"` so that
// Node's type stripping treats our `.ts` sources as ESM for `node --test`, but
// VSCode `require()`s the extension entry — an `.mjs`/ESM bundle there would
// fail to load. The explicit `.cjs` extension keeps both true at once.

import * as esbuild from 'esbuild'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

const shared = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
}

/** The extension host: Node, CommonJS, `vscode` supplied at runtime. */
const extensionBuild = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  format: 'cjs',
  platform: 'node',
  // VSCode 1.90 ships Node 20; don't emit syntax it can't parse.
  target: 'node20',
  external: ['vscode'],
}

/**
 * The webview: a browser context, so a different platform and format entirely.
 * It shares `src/chat/protocol.ts` with the extension build — one type
 * definition, two bundles, and a breaking change fails both typechecks.
 */
const webviewBuild = {
  ...shared,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
}

const builds = [extensionBuild, webviewBuild]

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)))
  await Promise.all(contexts.map((ctx) => ctx.watch()))
  console.log('[esbuild] watching…')
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)))
}
