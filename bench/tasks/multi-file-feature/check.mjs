import { pathToFileURL } from 'node:url'
import { expect, file, pass, run } from '../_lib/check.mjs'

const index = await import(pathToFileURL(file('src/index.js')).href).catch((e) => ({ error: e }))
expect(!index.error, `src/index.js does not load: ${index.error?.message}`)
expect(typeof index.slugify === 'function', 'src/index.js does not export slugify')
expect(typeof index.capitalize === 'function' && typeof index.squish === 'function', 'src/index.js lost an existing export')
const cases = [
  ['  Hello, World!  ', 'hello-world'],
  ['Barrel Jumper 2', 'barrel-jumper-2'],
  ['--already--hyphenated--', 'already-hyphenated'],
  ['ALL CAPS & symbols #1', 'all-caps-symbols-1'],
]
for (const [input, want] of cases) {
  const got = index.slugify(input)
  expect(got === want, `slugify(${JSON.stringify(input)}) is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
}
const cli = run(process.execPath, ['cli.js', '--slug', 'Barrel', 'Jumper', '2'])
expect(cli.status === 0 && cli.stdout.trim() === 'barrel-jumper-2', `cli.js --slug printed ${JSON.stringify(cli.stdout.trim())} (exit ${cli.status}) ${cli.stderr.slice(0, 200)}`)
const old = run(process.execPath, ['cli.js', '--capitalize', 'barrel'])
expect(old.stdout.trim() === 'Barrel', 'cli.js --capitalize broke')
pass('slugify exported and correct; cli --slug works; old options intact')
