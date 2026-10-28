import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MAX_READING,
  addReading,
  completeReading,
  createReadingCommands,
  formatReading,
  readingItems,
  removeReading,
} from '../src/message/reading.js'
import { parseSessionCommand } from '../src/sessions.js'

function stateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-reading-'))
}

test('/later is a session command with an optional argument', () => {
  assert.deepEqual(parseSessionCommand('/later'), { command: 'later', arg: '' })
  assert.deepEqual(parseSessionCommand('/later https://example.com/a'), { command: 'later', arg: 'https://example.com/a' })
  assert.deepEqual(parseSessionCommand('/稍后读 done 2'), { command: 'later', arg: 'done 2' })
  assert.equal(parseSessionCommand('/laterbox'), undefined)
})

test('an empty list says how to start one', () => {
  const root = stateRoot()
  const commands = createReadingCommands({ stateRoot: root, accountId: 'bot1', fetchTitle: async () => '' })
  assert.match(formatReading([]), /还是空的/)
  return commands.later('').then((text) => assert.match(text, /\/later https/))
})

test('a URL is stored with the fetched title, and listed', async () => {
  const root = stateRoot()
  const commands = createReadingCommands({
    stateRoot: root,
    accountId: 'bot1',
    now: () => 5000,
    fetchTitle: async (url) => (url === 'https://example.com/post' ? '一篇好文章' : ''),
  })

  assert.match(await commands.later('https://example.com/post'), /存好了（第 1 条）：一篇好文章/)
  const items = readingItems(root, 'bot1')
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '一篇好文章')
  assert.equal(items[0].done, false)

  const rendered = await commands.later('')
  assert.match(rendered, /稍后读 1\/1 条未读/)
  assert.match(rendered, /1\. 📖 一篇好文章/)
})

test('a title that cannot be fetched falls back to the hostname', async () => {
  const root = stateRoot()
  const commands = createReadingCommands({ stateRoot: root, accountId: 'bot1', fetchTitle: async () => '' })
  const reply = await commands.later('https://news.example.org/story')
  assert.match(reply, /news\.example\.org/)
  assert.equal(readingItems(root, 'bot1')[0].title, 'news.example.org')
})

test('plain text is kept as a note, without a network call', async () => {
  const root = stateRoot()
  let fetched = 0
  const commands = createReadingCommands({
    stateRoot: root,
    accountId: 'bot1',
    fetchTitle: async () => {
      fetched += 1
      return ''
    },
  })
  assert.match(await commands.later('读那篇讲 RSC 的文章'), /读那篇讲 RSC 的文章/)
  assert.equal(fetched, 0)
  assert.equal(readingItems(root, 'bot1')[0].url, '')
})

test('the same unread URL is not stored twice', async () => {
  const root = stateRoot()
  const commands = createReadingCommands({ stateRoot: root, accountId: 'bot1', fetchTitle: async () => 't' })
  await commands.later('https://example.com/a')
  assert.match(await commands.later('https://example.com/a'), /已经在清单里/)
  assert.equal(readingItems(root, 'bot1').length, 1)
})

test('done marks the numbered item; a read item may be added again later', async () => {
  const root = stateRoot()
  const commands = createReadingCommands({ stateRoot: root, accountId: 'bot1', now: () => 7000, fetchTitle: async () => 't' })
  await commands.later('https://example.com/a')

  assert.match(await commands.later('done 1'), /标记读完/)
  assert.match(await commands.later('done 1'), /已经标记过了/)
  assert.match(await commands.later('done 9'), /没有这个序号/)

  // Once it is read, the same URL is a new thing to save.
  assert.match(await commands.later('https://example.com/a'), /存好了（第 2 条）/)
})

test('rm removes one item and refuses a missing number', async () => {
  const root = stateRoot()
  addReading(root, 'bot1', { url: 'https://example.com/a', title: 'a', at: 1 })
  addReading(root, 'bot1', { url: 'https://example.com/b', title: 'b', at: 2 })

  assert.match(await createReadingCommands({ stateRoot: root, accountId: 'bot1' }).later('rm 1'), /删掉了：a/)
  assert.equal(readingItems(root, 'bot1').length, 1)
  assert.match(await createReadingCommands({ stateRoot: root, accountId: 'bot1' }).later('rm 9'), /没有这个序号/)
})

test('the list is capped at fifty items', () => {
  const root = stateRoot()
  for (let i = 0; i < MAX_READING; i += 1) {
    assert.equal(addReading(root, 'bot1', { url: `https://example.com/${i}`, title: `第 ${i} 篇`, at: i }).ok, true)
  }
  assert.equal(addReading(root, 'bot1', { url: 'https://example.com/overflow' }).reason, 'full')
  assert.equal(readingItems(root, 'bot1').length, MAX_READING)
})

test('formatReading counts unread and falls back through title, text, url', () => {
  const rendered = formatReading([
    { title: '标题', text: '', url: 'https://a', done: false },
    { title: '', text: '一段笔记', url: '', done: false },
    { title: '', text: '', url: 'https://c', done: true },
  ])
  assert.match(rendered, /2\/3 条未读/)
  assert.match(rendered, /1\. 📖 标题/)
  assert.match(rendered, /2\. 📖 一段笔记/)
  assert.match(rendered, /3\. ✅ https:\/\/c/)
})

test('help names /later so it is discoverable', async () => {
  const { buildCommandsHelp } = await import('../src/sessions.js')
  assert.match(buildCommandsHelp(), /\/later/)
})
