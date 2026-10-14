/**
 * Unit tests for the outbound Markdown conversion and its wiring into the send
 * path.
 *
 * Two things are under test, and they are different claims:
 *  - `markdownToPlainText` renders a reply the way the vendored upstream filter
 *    does — CJK italic markers stripped, `**bold**`/fences/tables/rules kept,
 *    images removed, whitespace otherwise byte-identical.
 *  - `sendChunked` (through the plugin's outbound path) converts *before* it
 *    chunks, so a converted reply is always split to fit `maxMessageLength`.
 *
 * Run with: node --test test/
 * @module dsh-weixin/test/markdown
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MARKDOWN_MODES,
  markdownToPlainText,
  resolveMarkdownMode,
} from '../src/message/markdown.js'
import { chunkText } from '../src/message/chunker.js'
import { StreamingMarkdownFilter } from '../vendor/openclaw-weixin/messaging/markdown-filter.js'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// What the filter keeps and what it strips
// ---------------------------------------------------------------------------

test('markdown: CJK italic markers are stripped but the text survives', () => {
  assert.equal(markdownToPlainText('中文 *斜体* 保留'), '中文 斜体 保留')
  assert.equal(markdownToPlainText('*斜体*'), '斜体')
  assert.equal(markdownToPlainText('中文 _下划线斜体_ 保留'), '中文 下划线斜体 保留')
  // Bold-italic over CJK loses its markers too.
  assert.equal(markdownToPlainText('***中文三连***'), '中文三连')
})

test('markdown: bold is preserved, including over CJK content', () => {
  // The filter deliberately keeps `**` — the file header lists bold as a
  // pass-through construct, and CJK is not an exception for bold.
  assert.equal(markdownToPlainText('**bold**'), '**bold**')
  assert.equal(markdownToPlainText('**中文加粗**'), '**中文加粗**')
  assert.equal(markdownToPlainText('___bold___'), '___bold___')
})

test('markdown: italics over non-CJK content keep their markers', () => {
  // Only the CJK case is stripped; this pins the boundary so a future
  // "improvement" cannot quietly widen the rule.
  assert.equal(markdownToPlainText('an *emphasis* here'), 'an *emphasis* here')
})

test('markdown: a `*` inside a code fence is never treated as a marker', () => {
  const fenced = '```js\nconst a = "*not italic*"\n```'
  assert.equal(markdownToPlainText(fenced), fenced)
  // CJK italic markers *are* stripped outside the fence, which is what makes the
  // fence the thing doing the protecting rather than the pattern going unnoticed.
  assert.equal(markdownToPlainText('中文 *斜体* x'), '中文 斜体 x')
  // Non-CJK italics keep their markers either way, so use a CJK sample above.
  assert.equal(markdownToPlainText('an *emphasis* x'), 'an *emphasis* x')
})

test('markdown: inline code, tables and horizontal rules pass through', () => {
  assert.equal(markdownToPlainText('use `a * b` here'), 'use `a * b` here')
  const table = '| a | b |\n|---|---|\n| 1 | 2 |'
  assert.equal(markdownToPlainText(table), table)
  assert.equal(markdownToPlainText('---'), '---')
})

test('markdown: image syntax is removed entirely', () => {
  assert.equal(markdownToPlainText('![alt](http://x/y.png)'), '')
  // Removed whole — neither the alt text nor the URL is left behind.
  const out = markdownToPlainText('before ![alt](http://x/y.png) after')
  assert.equal(out, 'before  after')
  assert.ok(!out.includes('alt') && !out.includes('http'))
})

test('markdown: H5/H6 marker text is dropped, H1-H4 are kept', () => {
  assert.equal(markdownToPlainText('##### H5 gone'), 'H5 gone')
  assert.equal(markdownToPlainText('###### H6 gone'), 'H6 gone')
  assert.equal(markdownToPlainText('#### H4 kept'), '#### H4 kept')
  assert.equal(markdownToPlainText('## H2 kept'), '## H2 kept')
})

// ---------------------------------------------------------------------------
// Whitespace fidelity — the part a naive wrapper gets wrong
// ---------------------------------------------------------------------------

test('markdown: blank lines and leading/trailing newlines survive', () => {
  assert.equal(markdownToPlainText('a\n\nb'), 'a\n\nb')
  assert.equal(markdownToPlainText('a\n\n\n\nb'), 'a\n\n\n\nb')
  assert.equal(markdownToPlainText('\n'), '\n')
  assert.equal(markdownToPlainText('\n\n'), '\n\n')
  assert.equal(markdownToPlainText(''), '')
  assert.equal(markdownToPlainText('trailing\n'), 'trailing\n')
})

test('markdown: a fenced block keeps its internal blank lines and CRLF survives', () => {
  const fenced = '```js\nconst a = 1\n\nconst b = 2\n```\n'
  assert.equal(markdownToPlainText(fenced), fenced)
  assert.equal(markdownToPlainText('x\r\ny\r\n'), 'x\r\ny\r\n')
})

test('markdown: a plain-text reply is returned byte-identical', () => {
  // Idempotence and "no gratuitous rewriting": a reply that is already plain
  // text must not be reflowed, re-indented or re-spaced.
  const plain = '- item one\n- item two\n\n> quoted\n\nplain paragraph'
  assert.equal(markdownToPlainText(plain), plain)
  assert.equal(markdownToPlainText(markdownToPlainText(plain)), plain)
})

test('markdown: feeding the whole reply equals feeding it character by character', () => {
  // `feed(wholeText) + flush()` is only correct because it is the single-delta
  // case of the streaming contract. Verify against the state machine directly.
  const sample = '**bold**\n中文 *斜体*\n\n```\ncode *x*\n```\n![img](u)\n##### H5\nend'
  const streamed = (() => {
    const filter = new StreamingMarkdownFilter()
    let acc = ''
    for (const char of sample) acc += filter.feed(char)
    return acc + filter.flush()
  })()
  assert.equal(markdownToPlainText(sample), streamed)
})

// ---------------------------------------------------------------------------
// Mode handling
// ---------------------------------------------------------------------------

test('markdown: off mode sends the reply verbatim', () => {
  const raw = '**bold** and *中文斜体*\n\n![img](u)\n'
  assert.equal(markdownToPlainText(raw, 'off'), raw)
  assert.equal(markdownToPlainText('', 'off'), '')
})

test('markdown: the mode reader defaults to strip and only honors a literal off', () => {
  assert.deepEqual(MARKDOWN_MODES, ['strip', 'off'])
  assert.equal(resolveMarkdownMode({}), 'strip')
  assert.equal(resolveMarkdownMode({ markdownMode: 'strip' }), 'strip')
  assert.equal(resolveMarkdownMode({ markdownMode: 'off' }), 'off')
  // An unrecognized value must not silently disable filtering.
  assert.equal(resolveMarkdownMode({ markdownMode: 'OFF' }), 'strip')
  assert.equal(resolveMarkdownMode({ markdownMode: undefined }), 'strip')
})

test('markdown: non-string input degrades to an empty string, never throws', () => {
  assert.equal(markdownToPlainText(null), '')
  assert.equal(markdownToPlainText(undefined), '')
  assert.equal(markdownToPlainText(42), '42')
})

// ---------------------------------------------------------------------------
// Conversion happens before chunking
// ---------------------------------------------------------------------------

test('markdown: chunking the converted text never exceeds the limit', () => {
  // Build a reply that is over the limit *in both* forms, so the assertion is
  // about the converted length rather than about the input being short.
  const reply = Array.from({ length: 40 }, (_, i) => `**第 ${i} 行加粗内容** 与 *斜体*`).join('\n')
  const converted = markdownToPlainText(reply)
  assert.ok(converted.length < reply.length, 'conversion should shorten the reply')

  const limit = 120
  const chunks = chunkText(converted, limit)
  assert.ok(chunks.length > 1, 'the sample must actually need splitting')
  for (const chunk of chunks) {
    assert.ok(chunk.length <= limit, `chunk of ${chunk.length} exceeds ${limit}`)
  }
  // Only the constructs the filter strips may vanish; bold is preserved on
  // purpose, so the check is for the CJK italic markers rather than for `*`.
  assert.ok(!chunks.join('').includes('*斜体*'), 'stripped markers must not reach the wire')
  assert.ok(chunks.join('').includes('**第 0 行加粗内容**'), 'preserved bold must survive the split')
  // Nothing was lost in the split either.
  assert.equal(chunks.join(''), converted)
})

// ---------------------------------------------------------------------------
// End-to-end: the plugin's own outbound path filters before it chunks
// ---------------------------------------------------------------------------

/** Fake iLink endpoint that records every sendmessage body. */
async function startFakeILink(msgs) {
  const sent = []
  let poll = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      res.setHeader('content-type', 'application/json')
      if (url.pathname === '/ilink/bot/getconfig') return res.end(JSON.stringify({ ret: 0, typing_ticket: 'TT' }))
      if (url.pathname === '/ilink/bot/sendmessage') {
        sent.push(JSON.parse(body))
        return res.end(JSON.stringify({ ret: 0 }))
      }
      if (url.pathname === '/ilink/bot/sendtyping') return res.end(JSON.stringify({ ret: 0 }))
      if (url.pathname === '/ilink/bot/getupdates') {
        const batch = poll === 0 ? msgs : []
        poll += 1
        return res.end(JSON.stringify({ ret: 0, get_updates_buf: 'b1', longpolling_timeout_ms: 20, msgs: batch }))
      }
      res.end(JSON.stringify({ ret: 0 }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}`, sent }
}

/**
 * Drive one reply through the real plugin and collect what actually got sent.
 * @param {{ reply: string, config?: object }} options
 */
async function roundTrip({ reply, config: extraConfig = {} }) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-md-'))
  const accountId = 'bot1'
  const allowed = 'wxid_abc'
  process.env.DSH_WEIXIN_STATE_DIR = stateRoot
  try {
    const accounts = path.join(stateRoot, 'openclaw-weixin', 'accounts')
    fs.mkdirSync(accounts, { recursive: true })
    fs.writeFileSync(path.join(accounts, `${accountId}.json`), JSON.stringify({ token: 'tok', baseUrl: '' }), { mode: 0o600 })
    fs.writeFileSync(path.join(stateRoot, 'openclaw-weixin', 'accounts.json'), JSON.stringify([accountId]))

    const { server, baseUrl, sent } = await startFakeILink([
      { message_id: 2001, from_user_id: allowed, group_id: '', message_type: 1, message_state: 2, context_token: 'ct1', create_time_ms: 1, item_list: [{ type: 1, text_item: { text: 'hi' } }] },
    ])
    const accounts2 = path.join(stateRoot, 'openclaw-weixin', 'accounts', `${accountId}.json`)
    fs.writeFileSync(accounts2, JSON.stringify({ token: 'tok', baseUrl }), { mode: 0o600 })

    const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
    const config = plugin.Config({ allowedSenders: [allowed], accountId, ...extraConfig })

    const agents = {
      get: () => undefined,
      resume: async ({ resumeSessionId }) => {
        let seq = 0
        const events = []
        const ev = (type, data) => events.push({ type, seq: seq++, time: Date.now(), data })
        const agent = {
          session: { id: resumeSessionId, snapshotEvents: () => events },
          inbox: { clear() {} },
          followup() {
            ev('turn/start', {})
            setTimeout(() => {
              ev('assistant/message', { stream: [{ type: 'text-chunks', texts: [reply] }] })
              ev('turn/end', {})
            }, 20)
          },
        }
        return { agent, dispose: async () => {} }
      },
    }

    const disposers = []
    const ctx = {
      logger: { info: () => {}, warn: () => {} },
      effect(fn) { disposers.push(fn()); return { dispose() {} } },
      get: (n) => (n === 'agents' ? agents : undefined),
    }
    plugin.apply(ctx, config)

    const deadline = Date.now() + 8000
    while (sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    for (const d of disposers) await (await d)?.()
    await new Promise((r) => setTimeout(r, 50))
    server.close()

    return sent.map((s) => s.msg.item_list[0].text_item.text)
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
    delete process.env.DSH_WEIXIN_STATE_DIR
  }
}

test('e2e: the outbound path strips Markdown before sending', async () => {
  // `mediaEnabled: false` isolates the text path: with media on, `![shot](path)`
  // is an *outbound attachment reference* handled earlier in the pipeline, so it
  // is removed (or replaced by its alt text) before the filter ever sees it.
  const texts = await roundTrip({
    reply: '**完成** 了 *这一项*\n\n![shot](http://x/y.png)\n结束',
    config: { mediaEnabled: false },
  })
  const joined = texts.join('')
  assert.ok(joined.includes('**完成**'), `bold must survive, got: ${JSON.stringify(texts)}`)
  assert.ok(joined.includes('这一项'), 'the italic content must survive')
  assert.ok(!joined.includes('*这一项*'), 'CJK italic markers must be stripped')
  assert.ok(!joined.includes('![') && !joined.includes('http://x/y.png'), 'the image must be gone')
  assert.ok(joined.includes('结束'), 'text after the image must survive')
})

test('e2e: markdownMode "off" sends the raw Markdown', async () => {
  const raw = '**完成** 了 *这一项* 与普通文字'
  const texts = await roundTrip({ reply: raw, config: { markdownMode: 'off' } })
  assert.deepEqual(texts, [raw])
})

test('e2e: a converted reply longer than the limit is split, and every part fits', async () => {
  const line = '**加粗的中文行** 与 *斜体片段* 以及一些普通文字'
  const reply = Array.from({ length: 60 }, (_, i) => `${i}: ${line}`).join('\n')
  const limit = 200
  const texts = await roundTrip({ reply, config: { maxMessageLength: limit } })

  assert.ok(texts.length > 1, `expected several messages, got ${texts.length}`)
  for (const text of texts) {
    assert.ok(text.length <= limit, `sent a ${text.length}-char message with limit ${limit}`)
    assert.ok(!text.includes('*斜体片段*'), 'no markdown markers may reach the wire')
  }
  // Reassembling what was sent equals the converted reply: nothing lost.
  assert.equal(texts.join(''), markdownToPlainText(reply))
})
