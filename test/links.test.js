/**
 * Behavioural tests for inbound link enrichment (src/message/links.js).
 *
 * The experience protected: paste a link into WeChat, the agent answers about
 * the page's content instead of "我打不开链接". The module's shape is safety
 * first — http(s) only, byte caps, and a failed link NEVER fails the message.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const {
  clearLinkCache,
  checkFetchableUrl,
  describeLinkResults,
  extractUrls,
  fetchLinkText,
  htmlToText,
  isPrivateHost,
  LINK_TIMEOUT_MS,
  MAX_REDIRECTS,
} = await import('../src/message/links.js')

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
      headers: {
        get: (name) => {
          const key = name.toLowerCase()
          if (key === 'content-type') return entry.contentType ?? 'text/html; charset=utf-8'
          if (key === 'location') return entry.location ?? null
          return null
        },
      },
      text: async () => entry.body ?? '',
    }
  }
  return { impl, calls }
}

/** A DNS stub: everything is public unless the table says otherwise. */
const publicLookup = async () => [{ address: '93.184.216.34' }]
const publicHost = (hostname) => (hostname === 'private.example' ? [{ address: '127.0.0.1' }] : [{ address: '93.184.216.34' }])

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
  const result = await fetchLinkText('https://example.com/article', { fetchImpl: impl, lookupImpl: publicLookup })
  assert.equal(result.ok, true)
  assert.equal(result.title, '发布说明')
  assert.match(result.text, /版本 1/)
  assert.match(result.text, /修复了 构建/)
  assert.doesNotMatch(result.text, /ignored/, 'script bodies are stripped, not handed to the model')
})

test('fetchLinkText caps the extracted text and marks the truncation', async () => {
  const { impl } = fakeFetch({ 'https://example.com/long': { body: 'x'.repeat(50_000), contentType: 'text/plain' } })
  const result = await fetchLinkText('https://example.com/long', { fetchImpl: impl, lookupImpl: publicLookup, maxChars: 100 })
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
  assert.deepEqual(await fetchLinkText('https://dead.example/', { fetchImpl: impl, lookupImpl: publicLookup }), { ok: false, url: 'https://dead.example/', reason: '请求失败：connection refused' })
  const http500 = await fetchLinkText('https://500.example/', { fetchImpl: impl, lookupImpl: publicLookup })
  assert.equal(http500.ok, false)
  assert.match(http500.reason, /HTTP 500/)
  const image = await fetchLinkText('https://img.example/1.png', { fetchImpl: impl, lookupImpl: publicLookup })
  assert.match(image.reason, /不是可读文本/, 'binary content is named, not reduced to garbage text')
  const empty = await fetchLinkText('https://empty.example/', { fetchImpl: impl, lookupImpl: publicLookup })
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

/**
 * SSRF, stalls and repeated fetches.
 *
 * A chat link is untrusted input: it arrives from whoever is talking to the
 * bot. `redirect: 'follow'` plus no address policy meant a public host could
 * walk the request into 127.0.0.1 or the cloud metadata service, and a host
 * that accepted the connection then stalled cost the turn its whole latency
 * budget. These tests pin the policy layer, the per-hop revalidation, the
 * deadline and the cache.
 */
test('private, loopback, link-local and metadata addresses are refused by name', () => {
  for (const host of ['localhost', 'api.localhost', 'printer.local', 'db.internal', 'metadata.google.internal']) {
    assert.equal(isPrivateHost(host), true, host)
  }
  for (const address of ['127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.4.4', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateHost(address), true, address)
  }
  for (const host of ['example.com', '93.184.216.34', '172.32.0.1', '11.0.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateHost(host), false, host)
  }
})

test('the URL policy allows only plain http(s) with no credentials and no private host', () => {
  assert.deepEqual(checkFetchableUrl('https://example.com/a?b=1'), { url: 'https://example.com/a?b=1' })
  assert.match(checkFetchableUrl('file:///etc/passwd').reason, /只抓 http\/https/)
  assert.match(checkFetchableUrl('ftp://example.com/x').reason, /只抓 http\/https/)
  assert.match(checkFetchableUrl('https://user:pass@example.com/').reason, /账号密码/)
  assert.match(checkFetchableUrl('http://169.254.169.254/latest/meta-data/').reason, /本机或内网/)
  assert.match(checkFetchableUrl('not a url').reason, /不合法|不是一个合法链接/)
})

test('a private target is never fetched, and a public name that resolves inward is refused', async () => {
  const { impl, calls } = fakeFetch({ 'http://127.0.0.1:8080/admin': { body: 'secret' }, 'https://private.example/x': { body: 'also secret' } })
  const direct = await fetchLinkText('http://127.0.0.1:8080/admin', { fetchImpl: impl, lookupImpl: publicLookup })
  assert.equal(direct.ok, false)
  assert.match(direct.reason, /本机或内网/)
  const resolved = await fetchLinkText('https://private.example/x', { fetchImpl: impl, lookupImpl: publicHost })
  assert.equal(resolved.ok, false)
  assert.match(resolved.reason, /解析到内网/)
  assert.deepEqual(calls, [], 'nothing may reach the network for either case')
})

test('every redirect hop is revalidated, and the hop count is capped', async () => {
  const internal = fakeFetch({
    'https://public.example/start': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
  })
  const hop = await fetchLinkText('https://public.example/start', { fetchImpl: internal.impl, lookupImpl: publicLookup })
  assert.equal(hop.ok, false)
  assert.match(hop.reason, /本机或内网/)
  assert.equal(internal.calls.length, 1, 'the metadata hop must not be requested')

  const loop = fakeFetch({
    'https://loop.example/1': { status: 301, location: '/2' },
    'https://loop.example/2': { status: 301, location: '/3' },
    'https://loop.example/3': { status: 301, location: '/4' },
    'https://loop.example/4': { status: 301, location: '/5' },
    'https://loop.example/5': { status: 301, location: '/6' },
  })
  const capped = await fetchLinkText('https://loop.example/1', { fetchImpl: loop.impl, lookupImpl: publicLookup })
  assert.match(capped.reason, new RegExp(`重定向超过 ${MAX_REDIRECTS} 次`))

  const relative = fakeFetch({ 'https://ok.example/a': { status: 302, location: '/b' }, 'https://ok.example/b': { body: '<p>落地页</p>' } })
  const followed = await fetchLinkText('https://ok.example/a', { fetchImpl: relative.impl, lookupImpl: publicLookup })
  assert.equal(followed.ok, true)
  assert.match(followed.text, /落地页/)
  assert.deepEqual(relative.calls, ['https://ok.example/a', 'https://ok.example/b'])
})

test('a stalled host costs its deadline, and a repeated URL within the TTL is not fetched twice', async () => {
  const stalled = async () => {
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    throw error
  }
  const timedOut = await fetchLinkText('https://slow.example/', { fetchImpl: stalled, lookupImpl: publicLookup, timeoutMs: 20 })
  assert.equal(timedOut.ok, false)
  assert.match(timedOut.reason, /请求超时（20ms）/)

  clearLinkCache()
  const { impl, calls } = fakeFetch({ 'https://cache.example/a': { body: '<p>缓存内容</p>' } })
  // The cache is keyed by URL and only applies to the real fetch path (a
  // caller-supplied fetch is a test seam), so drive it through `fetchImpl:
  // undefined` by counting through a global stub.
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    const first = await fetchLinkText('https://cache.example/a', { lookupImpl: publicLookup })
    const second = await fetchLinkText('https://cache.example/a', { lookupImpl: publicLookup })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(calls.length, 1, 'the second call must be served from the cache')
  } finally {
    globalThis.fetch = original
    clearLinkCache()
  }
})
