import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemorySummarizer } from '../src/memory-summarizer.js'
import { addGlobalFact, readConvMemory, readGlobalMemory, setConvSummary, setDigest } from '../src/memory.js'
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
function seedJournal(conversationId = CONV, accountId = ACCOUNT) {
  appendJournal(root, { dir: 'in', accountId, conversationId, text: '帮我查下明天天气' })
  appendJournal(root, { dir: 'out', accountId, conversationId, text: '明天晴，25 度。' })
  appendJournal(root, { dir: 'in', accountId, conversationId, text: '那穿什么合适' })
  appendJournal(root, { dir: 'out', accountId, conversationId, text: '薄外套就行。' })
}

/** A controllable fake bridge: records summarize() prompts, resolves manually. */
function fakeBridge() {
  const calls = []
  let pending = []
  return {
    calls,
    summarize({ conversationId, accountId, prompt, sessionPrefix, route }) {
      const record = { conversationId, accountId, prompt, sessionPrefix, route, resolved: undefined }
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
  assert.match(call.prompt, /只输出一个 JSON 对象/)
  assert.match(call.prompt, /"summary"/)
  assert.match(call.prompt, /"profile"/)
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

test('a JSON reply fills the conversation summary, facts, events and profile', async () => {
  const bridge = fakeBridge()
  const conv = 'conv-json'
  seedJournal(conv)
  const sum = summarizer(bridge, { memoryEnabled: true, memorySummaryTurns: 1, memoryConvMaxChars: 1200 })
  sum.afterTurn(ACCOUNT, conv)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(bridge.calls.length, 1)
  assert.match(bridge.calls[0].prompt, /"events"/)
  bridge.settleAll(JSON.stringify({
    summary: '在聊明天穿什么。',
    facts: ['对花生过敏', '住在杭州'],
    events: [{ text: '明天去体检', when: '2099-01-02' }],
    profile: { call: '小满', schedule: '夜里两点睡', likes: ['猫'], dislikes: ['香菜'], dates: [{ label: '生日', date: '1998-03-04' }] },
  }))
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(readConvMemory(root, ACCOUNT, conv).summary, '在聊明天穿什么。')
  const store = readGlobalMemory(root, ACCOUNT)
  assert.deepEqual(store.facts.map((fact) => fact.text), ['对花生过敏', '住在杭州'])
  assert.equal(store.facts[0].weight, 4, 'an inferred fact is more durable than a passing line')
  assert.deepEqual(store.events.map((event) => event.text), ['明天去体检'])
  assert.equal(store.events[0].when, '2099-01-02')
  assert.equal(store.profile.call, '小满')
  assert.deepEqual(store.profile.likes, ['猫'])
  assert.deepEqual(store.profile.dates, [{ label: '生日', date: '1998-03-04' }])
})

test('a JSON reply in a code fence still parses, and a garbage reply stays a plain summary', async () => {
  const bridge = fakeBridge()
  const conv = 'conv-fence'
  seedJournal(conv)
  const sum = summarizer(bridge, { memoryEnabled: true, memorySummaryTurns: 1, memoryConvMaxChars: 1200 })
  sum.afterTurn(ACCOUNT, conv)
  await new Promise((resolve) => setImmediate(resolve))
  bridge.settleAll('```json\n{"summary": "围栏里的摘要", "facts": [], "events": [], "profile": {}}\n```')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readConvMemory(root, ACCOUNT, conv).summary, '围栏里的摘要')

  const conv2 = 'conv-garbage'
  seedJournal(conv2)
  const sum2 = summarizer(bridge, { memoryEnabled: true, memorySummaryTurns: 1, memoryConvMaxChars: 1200 })
  sum2.afterTurn(ACCOUNT, conv2)
  await new Promise((resolve) => setImmediate(resolve))
  bridge.settleAll('就是一段普通文字摘要，没有 JSON。')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readConvMemory(root, ACCOUNT, conv2).summary, '就是一段普通文字摘要，没有 JSON。')
})

test('consolidation merges a long fact list into a digest, and only when it is due', async () => {
  const bridge = fakeBridge()
  const conv = 'conv-digest'
  const account = 'bot-digest'
  const facts = Array.from({ length: 12 }, (_v, i) => ({ text: `事实 ${i + 1}`, at: Date.now(), weight: 3 }))
  // Seed through the public writers so the file shape is the real one.
  const { addGlobalFact } = await import('../src/memory.js')
  for (const fact of facts) addGlobalFact(root, account, fact.text, { weight: fact.weight })
  seedJournal(conv, account)

  const sum = summarizer(bridge, { memoryEnabled: true, memorySummaryTurns: 1, memoryGlobalMaxFacts: 30 })
  sum.afterTurn(account, conv)
  await new Promise((resolve) => setImmediate(resolve))
  bridge.settleAll(JSON.stringify({ summary: '摘要', facts: [], events: [], profile: {} }))
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const digestCall = bridge.calls.find((call) => call.sessionPrefix === 'wx-dig-' || /人物小传/.test(call.prompt))
  assert.ok(digestCall, 'a long fact list must trigger the consolidation prompt')
  assert.match(digestCall.prompt, /【记下的事实】/)
  bridge.settleAll(JSON.stringify({ digest: '小满是杭州人，夜里睡，喜欢猫。', facts: [{ text: '对花生过敏', weight: 5 }] }))
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const store = readGlobalMemory(root, account)
  assert.equal(store.digest, '小满是杭州人，夜里睡，喜欢猫。')
  assert.deepEqual(store.facts.map((fact) => fact.text), ['对花生过敏'])
  assert.equal(store.facts[0].weight, 5)
  assert.ok(store.digestAt > 0)

  // A second pass inside the window must not run again.
  const before = bridge.calls.length
  const again = summarizer(bridge, { memoryEnabled: true, memorySummaryTurns: 1, memoryGlobalMaxFacts: 30 })
  again.afterTurn(account, conv)
  await new Promise((resolve) => setImmediate(resolve))
  bridge.settleAll(JSON.stringify({ summary: '摘要', facts: [], events: [], profile: {} }))
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(bridge.calls.length, before + 1, 'only the summary call, no second consolidation')
})

test('the memory model route rides along to the side session', async () => {
  const bridge = fakeBridge()
  const route = { provider: 'zai', model: 'glm-4-flash' }
  const sum = createMemorySummarizer({
    bridge,
    stateRoot: root,
    config: () => ({ memoryEnabled: true, memorySummaryTurns: 1 }),
    route: () => route,
  })
  seedJournal('conv-route')
  sum.afterTurn(ACCOUNT, 'conv-route')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(bridge.calls.length, 1)
  assert.deepEqual(bridge.calls[0].route, route)
})

test('a correction in the reply replaces the fact it names, instead of joining it', async () => {
  const bridge = fakeBridge()
  seedJournal()
  addGlobalFact(root, ACCOUNT, '用户住在北京', { warn: () => {}, now: 1000 })
  const sum = summarizer(bridge, { memoryEnabled: true, memorySummaryTurns: 1 })
  sum.afterTurn(ACCOUNT, CONV)
  await Promise.resolve()
  assert.equal(bridge.calls.length, 1)
  assert.match(bridge.calls[0].prompt, /supersedes/)
  assert.match(bridge.calls[0].prompt, /用户住在北京/)
  bridge.settleAll(JSON.stringify({
    summary: '聊到搬家',
    facts: [{ text: '用户搬到杭州了', supersedes: ['用户住在北京'] }],
    events: [],
    profile: {},
  }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const store = readGlobalMemory(root, ACCOUNT, { warn: () => {} })
  const texts = store.facts.map((fact) => fact.text)
  assert.ok(texts.includes('用户搬到杭州了'), 'the new value is stored')
  assert.ok(!texts.includes('用户住在北京'), 'and the old one is gone, not sitting beside it')
  assert.ok(store.superseded.some((entry) => entry.text === '用户住在北京'), 'the replaced text is kept as history')
})
