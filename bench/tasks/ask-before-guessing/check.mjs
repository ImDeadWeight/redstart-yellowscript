import { pathToFileURL } from 'node:url'
import { expect, file, pass, result } from '../_lib/check.mjs'

expect(result.questions > 0, 'it never asked which conversion was wanted (ask_user)')
const mod = await import(pathToFileURL(file('src/convert.js')).href).catch((e) => ({ error: e }))
expect(!mod.error, `src/convert.js does not load: ${mod.error?.message}`)
expect(typeof mod.celsiusToFahrenheit === 'function', 'no exported celsiusToFahrenheit (the name given in the answer)')
expect(Math.abs(mod.celsiusToFahrenheit(100) - 212) < 1e-9 && Math.abs(mod.celsiusToFahrenheit(-40) + 40) < 1e-9, 'celsiusToFahrenheit gives wrong values')
expect(typeof mod.kmhToMs === 'function', 'the existing kmhToMs was lost')
pass('asked, then wrote celsiusToFahrenheit as answered')
