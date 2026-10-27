// The send path, not just the planner: a long code block must leave the process
// as a file attachment and the bubble must say so.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { configureOutbound, sendChunked } from '../src/outbound.js'

function fakeTransport(sent, media) {
  return {
    accountId: 'bot1',
    capabilities: { text: true, media: true },
    async send(chunk) {
      sent.push(chunk)
    },
    async sendMedia(params) {
      media.push(params)
    },
    async setTyping() {},
  }
}

test('a long code block is sent as a file after the bubble that announces it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-send-'))
  const snippets = path.join(root, 'snippets')
  configureOutbound({ snippetsDir: snippets, warn: () => {} })
  const sent = []
  const media = []
  const code = Array.from({ length: 60 }, (_, i) => `const value${i} = ${i}`).join('\n')
  await sendChunked(fakeTransport(sent, media), { maxMessageLength: 2000, markdownMode: 'strip', codeFileThreshold: 300 }, {
    conversationId: 'wx1',
    text: `这是脚本：\n\`\`\`js\n${code}\n\`\`\`\n跑一下试试。`,
  })
  assert.equal(sent.length, 1, 'the reply text arrives as one message')
  assert.match(sent[0].text, /已作为文件 snippet-1\.js 发出/)
  assert.ok(!sent[0].text.includes('const value59'), 'the code itself is not in the bubble')
  assert.equal(media.length, 1, 'one attachment follows')
  assert.match(path.basename(media[0].filePath), /-snippet-1\.js$/)
  assert.equal(fs.readFileSync(media[0].filePath, 'utf8').trim().split('\n').length, 60)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a short code block stays in the bubble and sends nothing extra', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-send-'))
  configureOutbound({ snippetsDir: path.join(root, 'snippets'), warn: () => {} })
  const sent = []
  const media = []
  await sendChunked(fakeTransport(sent, media), { maxMessageLength: 2000, markdownMode: 'strip' }, {
    conversationId: 'wx1',
    text: '这样写：\n```js\nconst a = 1\n```\n就好了。',
  })
  assert.equal(media.length, 0)
  assert.match(sent[0].text, /const a = 1/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('richContent off keeps the old behaviour: one flat message, no files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-send-'))
  configureOutbound({ snippetsDir: path.join(root, 'snippets'), warn: () => {} })
  const sent = []
  const media = []
  const code = 'x'.repeat(3000)
  await sendChunked(fakeTransport(sent, media), { maxMessageLength: 2000, markdownMode: 'strip', richContent: false }, {
    conversationId: 'wx1',
    text: `\`\`\`js\n${code}\n\`\`\``,
  })
  assert.equal(media.length, 0)
  assert.ok(sent.map((chunk) => chunk.text).join('').includes(code))
  fs.rmSync(root, { recursive: true, force: true })
})
