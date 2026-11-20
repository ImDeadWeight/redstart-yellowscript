import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_IMAGES, attachmentBlock, attachmentLabel, parseAttachments, userContent } from './attachments.ts'
import { parseWebviewMessage } from './protocol.ts'

const png = 'data:image/png;base64,iVBORw0KGgo='

describe('parseAttachments', () => {
  test('keeps well-formed images, files and selections', () => {
    const parsed = parseAttachments([
      { kind: 'image', name: 'shot.png', dataUrl: png },
      { kind: 'file', path: ' src/game.js ' },
      { kind: 'selection', path: 'src/a.js', startLine: 3, endLine: 5, text: 'x' },
    ])
    assert.deepEqual(parsed.map((a) => a.kind), ['image', 'file', 'selection'])
    assert.equal(parsed[1]!.kind === 'file' && parsed[1]!.path, 'src/game.js')
  })

  test('drops what is malformed, and images past the cap', () => {
    const parsed = parseAttachments([
      { kind: 'image', name: 'x', dataUrl: 'https://example.com/a.png' },
      { kind: 'image', name: 'x', dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' },
      { kind: 'selection', path: 'a', startLine: 5, endLine: 3, text: 'x' },
      { kind: 'file', path: '' },
      { kind: 'file', path: 'a.js', content: 'injected from the webview' },
      ...Array.from({ length: MAX_IMAGES + 2 }, () => ({ kind: 'image', name: 'i', dataUrl: png })),
    ])
    assert.equal(parsed.filter((a) => a.kind === 'image').length, MAX_IMAGES)
    // A file's content is read by the host, never taken from the webview.
    assert.deepEqual(parsed.filter((a) => a.kind === 'file'), [{ kind: 'file', path: 'a.js' }])
    assert.equal(parsed.filter((a) => a.kind === 'selection').length, 0)
    assert.deepEqual(parseAttachments('nope'), [])
  })

  test('arrive through the send message', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'send', text: 'look', attachments: [{ kind: 'file', path: 'a.js' }] }), { type: 'send', text: 'look', attachments: [{ kind: 'file', path: 'a.js' }] })
    assert.deepEqual(parseWebviewMessage({ type: 'send', text: 'plain' }), { type: 'send', text: 'plain' })
    assert.deepEqual(parseWebviewMessage({ type: 'searchFiles', query: 'gam' }), { type: 'searchFiles', query: 'gam' })
  })
})

describe('what the model reads', () => {
  test('a file, a long file as its outline, a selection', () => {
    assert.equal(attachmentBlock({ kind: 'file', path: 'a.js', content: 'let a = 1', lines: 1 }), '[Attached: a.js (1 lines)]\n```\nlet a = 1\n```')
    assert.match(attachmentBlock({ kind: 'file', path: 'big.js', content: '1 function f', lines: 900, outline: true })!, /\(900 lines; its outline, read a range with ys_read_file\)/)
    assert.match(attachmentBlock({ kind: 'file', path: 'gone.js' })!, /could not be read/)
    assert.equal(attachmentBlock({ kind: 'selection', path: 'a.js', startLine: 2, endLine: 3, text: 'b()\nc()' }), '[Selected: a.js lines 2-3]\n```\nb()\nc()\n```')
    assert.match(attachmentBlock({ kind: 'selection', path: 'a.md', startLine: 1, endLine: 1, text: '```js' })!, /^\[Selected.*\]\n````\n```js\n````$/)
  })

  test('text alone stays a string', () => {
    assert.equal(userContent('hi', undefined, true), 'hi')
  })

  test('images are image parts for a model that reads them, a note otherwise', () => {
    const attachments = [{ kind: 'image' as const, name: 'shot', dataUrl: png }, { kind: 'file' as const, path: 'a.js', content: 'x', lines: 1 }]
    const seeing = userContent('what is wrong?', attachments, true)
    assert.ok(Array.isArray(seeing))
    if (Array.isArray(seeing)) {
      assert.deepEqual(seeing.map((p) => p.type), ['text', 'image_url'])
      assert.match((seeing[0] as { text: string }).text, /^what is wrong\?\n\n\[Attached: a\.js/)
    }
    assert.match(userContent('what is wrong?', attachments, false) as string, /1 image was attached, but this model cannot read images/)
  })

  test('chip labels', () => {
    assert.equal(attachmentLabel({ kind: 'file', path: 'src/a.js' }), '@src/a.js')
    assert.equal(attachmentLabel({ kind: 'selection', path: 'a.js', startLine: 3, endLine: 9, text: '' }), 'a.js:3-9')
  })
})
