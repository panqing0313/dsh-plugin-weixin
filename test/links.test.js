/**
 * Behavioural tests for inbound link enrichment (src/message/links.js).
 *
 * The experience protected: paste a link into WeChat, the agent answers about
 * the page's content instead of "我打不开链接". The module's shape is safety
 * first — http(s) only, byte caps, and a failed link NEVER fails the message.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const { extractUrls, fetchLinkText, htmlToText, describeLinkResults } = await import('../src/message/links.js')

/** A stub fetch that answers from a table of URLs. */
function fakeFetch(table) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    const entry = table[url]
    if (entry === undefined) throw new Error('no route in fake')
    if (entry.throw === true) throw new Error('connection refused')
    return {
      ok: entry.status === undefined || entry.status === 200,
      status: entry.status ?? 200,
      statusText: '',
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? entry.contentType ?? 'text/html; charset=utf-8' : null) },
      text: async () => entry.body ?? '',
    }
  }
  return { impl, calls }
}

test('extractUrls finds unique URLs and strips trailing Chinese punctuation', () => {
  assert.deepEqual(
    extractUrls('看看这个 https://example.com/a？然后这个 https://example.com/b。'),
    ['https://example.com/a', 'https://example.com/b'],
  )
  assert.deepEqual(extractUrls('same link twice https://x.io/1 and https://x.io/1'), ['https://x.io/1'], 'duplicates collapse to one fetch')
  assert.deepEqual(extractUrls('no links here'), [])
  assert.deepEqual(extractUrls(undefined), [])
  assert.deepEqual(extractUrls('ftp://not-http.example.com and file:///etc/passwd'), [], 'only http(s) counts')
})

test('extractUrls keeps URL-internal punctuation and drops only the tail', () => {
  // Query strings carry & and = ; those must survive. The trailing comma is
  // glued-on Chinese-style punctuation; it must go.
  assert.deepEqual(extractUrls('https://x.io/search?q=a&lang=zh, 了解一下'), ['https://x.io/search?q=a&lang=zh'])
})

test('fetchLinkText strips HTML to readable text with the title', async () => {
  const { impl } = fakeFetch({
    'https://example.com/article': {
      body: '<html><head><title>发布说明</title></head><body><h1>版本 1</h1><p>修复了&nbsp;构建。</p><script>ignored()</script></body></html>',
    },
  })
  const result = await fetchLinkText('https://example.com/article', { fetchImpl: impl })
  assert.equal(result.ok, true)
  assert.equal(result.title, '发布说明')
  assert.match(result.text, /版本 1/)
  assert.match(result.text, /修复了 构建/)
  assert.doesNotMatch(result.text, /ignored/, 'script bodies are stripped, not handed to the model')
})

test('fetchLinkText caps the extracted text and marks the truncation', async () => {
  const { impl } = fakeFetch({ 'https://example.com/long': { body: 'x'.repeat(50_000), contentType: 'text/plain' } })
  const result = await fetchLinkText('https://example.com/long', { fetchImpl: impl, maxChars: 100 })
  assert.equal(result.ok, true)
  assert.ok(result.text.length <= 100 + '…（正文超长，已截断）'.length)
  assert.match(result.text, /已截断/)
})

test('fetchLinkText reports failures instead of throwing — every failure shape', async () => {
  const { impl } = fakeFetch({
    'https://dead.example/': { throw: true },
    'https://500.example/': { status: 500 },
    'https://img.example/1.png': { body: 'not really a png', contentType: 'image/png' },
    'https://empty.example/': { body: '   ' },
  })
  assert.deepEqual(await fetchLinkText('https://dead.example/', { fetchImpl: impl }), { ok: false, url: 'https://dead.example/', reason: '请求失败：connection refused' })
  const http500 = await fetchLinkText('https://500.example/', { fetchImpl: impl })
  assert.equal(http500.ok, false)
  assert.match(http500.reason, /HTTP 500/)
  const image = await fetchLinkText('https://img.example/1.png', { fetchImpl: impl })
  assert.match(image.reason, /不是可读文本/, 'binary content is named, not reduced to garbage text')
  const empty = await fetchLinkText('https://empty.example/', { fetchImpl: impl })
  assert.match(empty.reason, /没有可提取的正文/)
})

test('htmlToText reduces markup and decodes the common entities', () => {
  assert.equal(htmlToText('<p>a &amp; b</p><div>c</div>'), 'a & b\nc')
  assert.equal(htmlToText('<script>x()</script><style>.y{}</style>kept'), 'kept')
  assert.equal(htmlToText('<p>1</p>\n\n\n\n<p>2</p>'), '1\n\n2', 'blank runs collapse, structure survives')
})

test('describeLinkResults renders successes as quoted material and failures as one line', () => {
  assert.equal(describeLinkResults([]), undefined, 'no links means no block at all')
  const block = describeLinkResults([
    { ok: true, url: 'https://a.example/', title: '标题', text: '正文内容' },
    { ok: false, url: 'https://b.example/', reason: 'HTTP 404' },
  ])
  assert.match(block, /【链接内容：标题】\(https:\/\/a\.example\/\)/)
  assert.match(block, /"""\n正文内容\n"""/, "the fetched text is clearly fenced from the user's own words")
  assert.match(block, /【链接无法读取】https:\/\/b\.example\/：HTTP 404/)
  const untitled = describeLinkResults([{ ok: true, url: 'https://c.example/', text: 'x' }])
  assert.match(untitled, /【链接内容】\(https:\/\/c\.example\/\)/, 'a page without a title still reads as link material')
})
