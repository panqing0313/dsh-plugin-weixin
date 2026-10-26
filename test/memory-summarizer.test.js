import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemorySummarizer } from '../src/memory-summarizer.js'
import { readConvMemory, setConvSummary } from '../src/memory.js'
import { appendJournal } from '../src/message/journal.js'

let root

before(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-summarizer-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

const ACCOUNT = 'bot1'
const CONV = 'conv-1'

/** Seed a two-turn journal so the summarizer has something to fold. */
function seedJournal(conversationId = CONV) {
  appendJournal(root, { dir: 'in', accountId: ACCOUNT, conversationId, text: '帮我查下明天天气' })
  appendJournal(root, { dir: 'out', accountId: ACCOUNT, conversationId, text: '明天晴，25 度。' })
  appendJournal(root, { dir: 'in', accountId: ACCOUNT, conversationId, text: '那穿什么合适' })
  appendJournal(root, { dir: 'out', accountId: ACCOUNT, conversationId, text: '薄外套就行。' })
}

/** A controllable fake bridge: records summarize() prompts, resolves manually. */
function fakeBridge() {
  const calls = []
  let pending = []
  return {
    calls,
    summarize({ conversationId, accountId, prompt }) {
      const record = { conversationId, accountId, prompt, resolved: undefined }
      calls.push(record)
      return new Promise((resolve) => {
        record.resolve = resolve
        pending.push(record)
      })
    },
    settleAll(text = '摘要内容') {
      const waiting = pending
      pending = []
      for (const record of waiting) record.resolve({ text, sessionId: 'wx-mem-x' })
    },
  }
}

function summarizer(bridge, config) {
  return createMemorySummarizer({
    bridge,
    stateRoot: root,
    accountId: ACCOUNT,
    config: () => config,
  })
}

test('every turn bumps the counter; nothing fires below the cadence', async () => {
  const bridge = fakeBridge()
  const sum = summarizer(bridge, { memoryEnabled: true, memorySummaryTurns: 3, memoryConvMaxChars: 1200 })
  sum.afterTurn(ACCOUNT, CONV)
  sum.afterTurn(ACCOUNT, CONV)
  assert.equal(readConvMemory(root, ACCOUNT, CONV).updatedTurn, 2)
  assert.deepEqual(bridge.calls, [])
})

test('at the cadence the summary runs on the side session and lands in conv memory', async () => {
  const bridge = fakeBridge()
  seedJournal()
  const sum = summarizer(bridge, { memoryEnabled: true, memorySummaryTurns: 3, memoryConvMaxChars: 1200 })
  setConvSummary(root, ACCOUNT, CONV, '之前聊过花生过敏')
  sum.afterTurn(ACCOUNT, CONV) // turn 3 → fire
  await Promise.resolve()
  assert.equal(bridge.calls.length, 1)
  const call = bridge.calls[0]
  assert.equal(call.accountId, ACCOUNT)
  assert.equal(call.conversationId, CONV)
  assert.match(call.prompt, /【已有摘要】\n之前聊过花生过敏/)
  assert.match(call.prompt, /【最近对话】/)
  assert.match(call.prompt, /用户：帮我查下明天天气/)
  assert.match(call.prompt, /助手：薄外套就行。/)
  assert.match(call.prompt, /只输出摘要本身/)
  bridge.settleAll('用户喜欢简洁的回复，正在测试语音功能。')
  await new Promise((resolve) => setImmediate(resolve))
  const conv = readConvMemory(root, ACCOUNT, CONV)
  assert.equal(conv.summary, '用户喜欢简洁的回复，正在测试语音功能。')
  assert.equal(conv.updatedTurn, 3)
})

test('memoryEnabled off still counts turns but never summarizes', async () => {
  const bridge = fakeBridge()
  const sum = summarizer(bridge, { memoryEnabled: false, memorySummaryTurns: 1, memoryConvMaxChars: 1200 })
  sum.afterTurn(ACCOUNT, 'conv-off')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readConvMemory(root, ACCOUNT, 'conv-off').updatedTurn, 1)
  assert.deepEqual(bridge.calls, [])
})

test('a busy side session skips cleanly and writes nothing', async () => {
  const bridge = fakeBridge()
  bridge.summarize = async () => undefined
  const sum = summarizer(bridge, { memoryEnabled: true, memorySummaryTurns: 1, memoryConvMaxChars: 1200 })
  sum.afterTurn(ACCOUNT, 'conv-busy')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readConvMemory(root, ACCOUNT, 'conv-busy').summary, '')
  assert.equal(readConvMemory(root, ACCOUNT, 'conv-busy').updatedTurn, 1)
})

test('an empty or cancelled reply writes nothing', async () => {
  const bridge = fakeBridge()
  const sum = summarizer(bridge, { memoryEnabled: true, memorySummaryTurns: 1, memoryConvMaxChars: 1200 })
  sum.afterTurn(ACCOUNT, 'conv-empty')
  bridge.settleAll('')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readConvMemory(root, ACCOUNT, 'conv-empty').summary, '')
  sum.afterTurn(ACCOUNT, 'conv-empty')
  bridge.settleAll('（已取消）')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readConvMemory(root, ACCOUNT, 'conv-empty').summary, '')
})

test('a failing summarize is swallowed, not thrown', async () => {
  const bridge = fakeBridge()
  bridge.summarize = async () => {
    throw new Error('agents service unavailable')
  }
  const sum = summarizer(bridge, { memoryEnabled: true, memorySummaryTurns: 1, memoryConvMaxChars: 1200 })
  sum.afterTurn(ACCOUNT, 'conv-fail') // must not throw
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readConvMemory(root, ACCOUNT, 'conv-fail').summary, '')
})

test('one summary in flight per conversation', async () => {
  const bridge = fakeBridge()
  seedJournal()
  const sum = summarizer(bridge, { memoryEnabled: true, memorySummaryTurns: 1, memoryConvMaxChars: 1200 })
  sum.afterTurn(ACCOUNT, CONV) // fires, stays pending
  await Promise.resolve()
  assert.equal(bridge.calls.length, 1)
  sum.afterTurn(ACCOUNT, CONV) // next turn while the first summary hangs
  await Promise.resolve()
  assert.equal(bridge.calls.length, 1, 'a second concurrent summarize must not start')
  bridge.settleAll('终于写进去了')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readConvMemory(root, ACCOUNT, CONV).summary, '终于写进去了')
})
