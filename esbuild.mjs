// Bundle the extension host entry point.
//
// Output is `.cjs` on purpose: package.json declares `"type": "module"` so that
// Node's type stripping treats our `.ts` sources as ESM for `node --test`, but
// VSCode `require()`s the extension entry — an `.mjs`/ESM bundle there would
// fail to load. The explicit `.cjs` extension keeps both true at once.

import * as esbuild from 'esbuild'
import sveltePlugin from 'esbuild-svelte'

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
  // Also writes dist/webview.css: the components' styles go to a file, not
  // into <style> tags at runtime, because the CSP has no 'unsafe-inline'.
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  // Svelte's runtime is ESM with browser conditions.
  conditions: ['svelte', 'browser'],
  mainFields: ['svelte', 'browser', 'module', 'main'],
  // The mascot SVG is imported as text and inlined: the CSP allows no image
  // requests, and the drawing is static markup with no model text in it.
  loader: { '.svg': 'text' },
  plugins: [
    sveltePlugin({
      // Svelte 5 strips `lang="ts"` itself: no preprocessor needed.
      compilerOptions: { css: 'external', dev: !production },
    }),
  ],
}

const builds = [extensionBuild, webviewBuild]

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)))
  await Promise.all(contexts.map((ctx) => ctx.watch()))
  console.log('[esbuild] watching…')
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)))
}
