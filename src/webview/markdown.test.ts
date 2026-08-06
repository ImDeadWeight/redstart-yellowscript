import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { renderMarkdown, escapeHtml, isSafeUrl } from './markdown.ts'

describe('escapeHtml', () => {
  test('neutralises every character that could open a tag or attribute', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;')
    assert.equal(escapeHtml('a & b'), 'a &amp; b')
    assert.equal(escapeHtml(`"'`), '&quot;&#39;')
  })
})

describe('renderMarkdown — safety', () => {
  // This renders model output into a privileged webview. These are the tests
  // that matter most in the file.

  test('renders raw HTML as text, never as markup', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    assert.ok(!html.includes('<script>'), 'a script tag must never survive')
    assert.ok(html.includes('&lt;script&gt;'))
  })

  test('neutralises an img onerror payload', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')
    assert.ok(!html.includes('<img'))
    assert.ok(!/onerror\s*=/.test(html.replace(/&quot;/g, '"')) || html.includes('&lt;img'))
  })

  test('refuses javascript: links', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))')
    assert.ok(!html.includes('<a '), 'must not become a link')
    assert.ok(html.includes('click me'), 'the label should still be readable')
  })

  test('refuses data: and vbscript: links', () => {
    for (const url of ['data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd']) {
      const html = renderMarkdown(`[x](${url})`)
      assert.ok(!html.includes('<a '), `must not link ${url}`)
    }
  })

  test('allows ordinary http and https links', () => {
    const html = renderMarkdown('[docs](https://example.com/a)')
    assert.ok(html.includes('<a href="https://example.com/a">docs</a>'))
  })

  test('a quote in a URL cannot break out of the href attribute', () => {
    const html = renderMarkdown('[x](https://e.com/")onmouseover="alert(1))')
    assert.ok(!/onmouseover\s*=\s*"alert/.test(html), 'attribute injection')
    assert.ok(html.includes('&quot;'), 'the quote should have been escaped')
  })

  test('model output cannot forge the internal placeholder sentinel', () => {
    // The sentinel is how extracted code blocks are re-inserted. If the model
    // could emit one, it could point at another block's HTML.
    const forged = `${String.fromCharCode(0xe000)}B0 and \`real code\``
    const html = renderMarkdown(forged)
    assert.ok(html.includes('<code>real code</code>'))
    assert.ok(!html.includes('B0</'), 'a forged reference must not resolve')
  })

  test('escapes HTML inside code blocks too', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```')
    assert.ok(html.includes('<pre><code>'))
    assert.ok(html.includes('&lt;script&gt;'))
    assert.ok(!html.includes('<script>'))
  })

  test('a code fence language cannot inject an attribute', () => {
    // A language that isn't a plain identifier is rejected outright rather than
    // stripped down to something plausible-looking.
    const html = renderMarkdown('```js" onload="alert(1)\ncode\n```')
    assert.ok(!/onload\s*=/.test(html))
    assert.ok(!html.includes('class='), 'a malformed language must yield no class at all')
    assert.ok(html.includes('<pre><code>code</code></pre>'))
  })

  test('a well-formed language still becomes a class', () => {
    assert.ok(renderMarkdown('```js\ncode\n```').includes('class="language-js"'))
    assert.ok(renderMarkdown('```c++\ncode\n```').includes('class="language-c++"'))
  })
})

describe('renderMarkdown — blocks', () => {
  test('wraps plain text in a paragraph', () => {
    assert.equal(renderMarkdown('hello'), '<p>hello</p>')
  })

  test('separates paragraphs on a blank line', () => {
    const html = renderMarkdown('one\n\ntwo')
    assert.equal(html, '<p>one</p>\n<p>two</p>')
  })

  test('treats a single newline as a line break', () => {
    // Models lean on soft line breaks far more than the Markdown spec does.
    assert.equal(renderMarkdown('one\ntwo'), '<p>one<br>two</p>')
  })

  test('renders headings at the right level', () => {
    assert.equal(renderMarkdown('# Big'), '<h1>Big</h1>')
    assert.equal(renderMarkdown('### Small'), '<h3>Small</h3>')
    assert.equal(renderMarkdown('####### too deep'), '<p>####### too deep</p>')
  })

  test('groups consecutive bullets into one list', () => {
    const html = renderMarkdown('- a\n- b')
    assert.equal(html, '<ul>\n<li>a</li>\n<li>b</li>\n</ul>')
  })

  test('renders ordered lists', () => {
    const html = renderMarkdown('1. first\n2. second')
    assert.ok(html.startsWith('<ol>'))
    assert.ok(html.includes('<li>first</li>'))
  })

  test('closes a list when prose follows', () => {
    const html = renderMarkdown('- a\n\nafter')
    assert.equal(html, '<ul>\n<li>a</li>\n</ul>\n<p>after</p>')
  })

  test('switches list type without nesting them', () => {
    const html = renderMarkdown('- a\n1. b')
    assert.ok(html.includes('</ul>'))
    assert.ok(html.includes('<ol>'))
  })

  test('renders blockquotes', () => {
    assert.equal(renderMarkdown('> quoted'), '<blockquote><p>quoted</p></blockquote>')
  })

  test('renders horizontal rules', () => {
    assert.equal(renderMarkdown('---'), '<hr>')
  })

  test('renders a fenced code block with its language', () => {
    const html = renderMarkdown('```ts\nconst x = 1\n```')
    assert.equal(html, '<pre><code class="language-ts">const x = 1</code></pre>')
  })

  test('renders a fence with no language', () => {
    assert.equal(renderMarkdown('```\nplain\n```'), '<pre><code>plain</code></pre>')
  })

  test('does not apply markdown rules inside a code block', () => {
    const html = renderMarkdown('```\n**not bold** and - not a list\n```')
    assert.ok(html.includes('**not bold**'))
    assert.ok(!html.includes('<strong>'))
    assert.ok(!html.includes('<li>'))
  })

  test('keeps prose around a code block', () => {
    const html = renderMarkdown('before\n\n```\ncode\n```\n\nafter')
    assert.ok(html.indexOf('<p>before</p>') < html.indexOf('<pre>'))
    assert.ok(html.indexOf('<pre>') < html.indexOf('<p>after</p>'))
  })
})

describe('renderMarkdown — inline', () => {
  test('renders bold, italic, strikethrough and inline code', () => {
    assert.ok(renderMarkdown('**b**').includes('<strong>b</strong>'))
    assert.ok(renderMarkdown('__b__').includes('<strong>b</strong>'))
    assert.ok(renderMarkdown('*i*').includes('<em>i</em>'))
    assert.ok(renderMarkdown('~~s~~').includes('<del>s</del>'))
    assert.ok(renderMarkdown('`c`').includes('<code>c</code>'))
  })

  test('does not italicise inside snake_case identifiers', () => {
    // The single most common false positive in model output about code.
    const html = renderMarkdown('call some_long_name_here now')
    assert.ok(!html.includes('<em>'), html)
  })

  test('does not apply markdown rules inside inline code', () => {
    const html = renderMarkdown('`**literal**`')
    assert.ok(html.includes('<code>**literal**</code>'))
    assert.ok(!html.includes('<strong>'))
  })

  test('bold wins over italic for a triple marker', () => {
    assert.ok(renderMarkdown('**bold** and *it*').includes('<strong>bold</strong>'))
  })
})

describe('renderMarkdown — streaming', () => {
  // renderMarkdown runs on every delta, so partial input must look sane rather
  // than flickering between "literal backticks" and "code block".

  test('renders an unterminated code fence as a code block', () => {
    const html = renderMarkdown('```ts\nconst x =')
    assert.ok(html.includes('<pre><code class="language-ts">'), html)
    assert.ok(!html.includes('```'))
  })

  test('renders a fence whose language line is still arriving', () => {
    const html = renderMarkdown('```typ')
    assert.ok(html.includes('<pre>'), html)
  })

  test('a half-typed bold marker does not emit a stray tag', () => {
    const html = renderMarkdown('this is **partial')
    assert.ok(!html.includes('<strong>'))
    assert.ok(html.includes('**partial'))
  })

  test('every prefix of a document renders without throwing', () => {
    const document = [
      '# Title',
      '',
      'Some **bold** text with `code` and a [link](https://x.com).',
      '',
      '- one',
      '- two',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      '> a quote',
    ].join('\n')

    for (let i = 0; i <= document.length; i++) {
      assert.doesNotThrow(() => renderMarkdown(document.slice(0, i)), `failed at prefix length ${i}`)
    }
  })

  test('handles an empty string', () => {
    assert.equal(renderMarkdown(''), '')
  })
})

describe('isSafeUrl', () => {
  test('accepts http and https only', () => {
    assert.equal(isSafeUrl('http://x.com'), true)
    assert.equal(isSafeUrl('https://x.com'), true)
    assert.equal(isSafeUrl('  https://x.com  '), true)
    assert.equal(isSafeUrl('HTTPS://x.com'), true)
  })

  test('rejects every other scheme, including relative paths', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///x', '/relative', 'x.com', '//x.com']) {
      assert.equal(isSafeUrl(url), false, url)
    }
  })
})
