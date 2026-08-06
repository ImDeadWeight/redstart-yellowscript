// Bundle the extension host entry point.
//
// Output is `.cjs` on purpose: package.json declares `"type": "module"` so that
// Node's type stripping treats our `.ts` sources as ESM for `node --test`, but
// VSCode `require()`s the extension entry — an `.mjs`/ESM bundle there would
// fail to load. The explicit `.cjs` extension keeps both true at once.

import * as esbuild from 'esbuild'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  // VSCode 1.90 ships Node 20; don't emit syntax it can't parse.
  target: 'node20',
  // Provided by the extension host at runtime, never bundled.
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log('[esbuild] watching…')
} else {
  await esbuild.build(options)
}
