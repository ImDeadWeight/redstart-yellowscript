import { expect, original, pass, read, run } from '../_lib/check.mjs'

const taskDir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
expect(read('test/cart.test.js') === original(taskDir, 'test/cart.test.js'), 'the test file was changed')
const tests = run(process.execPath, ['--test'])
expect(tests.status === 0, `node --test still fails:\n${(tests.stdout + tests.stderr).slice(-600)}`)
pass('all 3 tests pass, tests untouched')
