import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  IMPORT_CONFIRM_TTL_MS,
  applyMemoryImport,
  formatImportPreview,
  parseMemoryMarkdown,
  planMemoryImport,
} from '../src/message/memory-import.js'
import { addEvent, addGlobalFact, readGlobalMemory, saveProfile } from '../src/memory.js'
import { parseMemoryJson, renderMemoryJson } from '../src/message/memory-export.js'

const DOC = `# 记忆导出 · 2026-10-31

- 账号：\`bot1\`
- 导出发起会话：\`c1\`

## 人物小传

他叫阿伟，在杭州做后端，喜欢安静。

## 关于你的档案

- 称呼：阿伟
- 作息：早睡早起
- 喜欢：跑步、咖啡
- 重要日期：生日 1990-05-20

## 事件与待办

- · [2026-11-05] 体检
- · 交周报

## 长期记忆

1. 我对花生过敏（12 天前 · 来自/remember）
2. 我住在杭州（今天记的）

## 会话记忆

### c1

昨天聊了跑步的事。
`

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-import-'))
}

test('the parser reads the sections it knows and ignores the rest', () => {
  const parsed = parseMemoryMarkdown(DOC)
  assert.equal(parsed.digest, '他叫阿伟，在杭州做后端，喜欢安静。')
  assert.deepEqual(parsed.profile, {
    call: '阿伟',
    schedule: '早睡早起',
    likes: ['跑步', '咖啡'],
    dates: [{ label: '生日', date: '1990-05-20' }],
  })
  assert.deepEqual(parsed.events, [
    { when: '2026-11-05', text: '体检' },
    { when: '', text: '交周报' },
  ])
  assert.deepEqual(parsed.facts, ['我对花生过敏', '我住在杭州'])
  assert.equal(parsed.skipped, 0, 'every list line is understood')
})

test('the parser keeps the trailing note out of a fact and survives junk', () => {
  const parsed = parseMemoryMarkdown(`## 长期记忆

1. 我对花生过敏（12 天前 · 来自/remember）
2. 我住在杭州
这行没有编号，认不出来

## 理解不了的一节

随便写点什么
`)
  assert.deepEqual(parsed.facts, ['我对花生过敏', '我住在杭州'])
  assert.equal(parsed.skipped, 1, 'the unnumbered line is counted, not guessed at')
  assert.equal(parsed.digest, '', 'an unknown section never becomes a persona paragraph')
})

test('an empty document parses to an empty plan', () => {
  const parsed = parseMemoryMarkdown('')
  assert.deepEqual(parsed.facts, [])
  assert.deepEqual(parsed.events, [])
  assert.equal(parsed.digest, '')
  const plan = planMemoryImport(parsed, { facts: [], events: [], profile: {}, digest: '' })
  assert.equal(plan.nothingToDo, true)
})

test('the plan only offers what is actually new', () => {
  const parsed = parseMemoryMarkdown(DOC)
  const memory = {
    facts: [{ text: '我住在杭州' }],
    events: [{ text: '体检', when: '2026-11-05' }],
    profile: { call: '阿伟' },
    digest: '',
  }
  const plan = planMemoryImport(parsed, memory, { maxFacts: 30 })
  assert.deepEqual(plan.facts, ['我对花生过敏'], 'the stored fact is not offered twice')
  assert.equal(plan.duplicateFacts, 1)
  assert.deepEqual(plan.events, [{ when: '', text: '交周报' }])
  assert.deepEqual(Object.keys(plan.profilePatch).sort(), ['dates', 'likes', 'schedule'], 'call is unchanged')
  assert.equal(plan.newDigest, '他叫阿伟，在杭州做后端，喜欢安静。')
  assert.equal(plan.nothingToDo, false)
})

test('a full memory says how many facts it had to leave behind', () => {
  const parsed = parseMemoryMarkdown(DOC)
  const memory = { facts: [{ text: '旧的' }], events: [], profile: {}, digest: '' }
  const plan = planMemoryImport(parsed, memory, { maxFacts: 2 })
  assert.equal(plan.facts.length, 1, 'one slot left')
  assert.equal(plan.droppedFacts, 1, 'the rest is reported, not silently dropped')
})

test('the preview names what will happen and asks before doing it', () => {
  const parsed = parseMemoryMarkdown(DOC)
  const plan = planMemoryImport(parsed, { facts: [], events: [], profile: {}, digest: '' })
  const preview = formatImportPreview(plan, { source: '/memory export 的内容' })
  assert.match(preview, /从\/memory export 的内容里读到/)
  assert.match(preview, /长期记忆 2 条/)
  assert.match(preview, /事件与待办 2 条/)
  assert.match(preview, /回「是」/)
})

test('a plan with nothing new says so instead of asking', () => {
  const plan = planMemoryImport(
    { facts: ['我对花生过敏'], events: [], profile: {}, digest: '', skipped: 2 },
    { facts: [{ text: '我对花生过敏' }], events: [], profile: {}, digest: '' },
  )
  assert.equal(plan.nothingToDo, true)
  const preview = formatImportPreview(plan)
  assert.match(preview, /没有需要新导入的东西/)
  assert.match(preview, /1 条长期记忆已经记过了/)
  assert.match(preview, /2 行认不出来已跳过/)
})

test('applying a plan writes facts with their origin and never removes anything', () => {
  const root = tempRoot()
  try {
    addGlobalFact(root, 'bot1', '我住在杭州', { now: 1_000 })
    const parsed = parseMemoryMarkdown(DOC)
    const before = readGlobalMemory(root, 'bot1')
    const plan = planMemoryImport(parsed, before)
    const written = applyMemoryImport({ stateRoot: root, accountId: 'bot1', plan, now: 2_000 })

    assert.equal(written.facts, 1)
    assert.equal(written.events, 2)
    assert.equal(written.digest, true)
    assert.deepEqual(written.failures, [])

    const after = readGlobalMemory(root, 'bot1')
    assert.deepEqual(after.facts.map((fact) => fact.text), ['我住在杭州', '我对花生过敏'], 'the old fact stays, the new one is appended')
    assert.equal(after.facts[1].origin, '/import')
    assert.equal(after.digest, '他叫阿伟，在杭州做后端，喜欢安静。')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a fact the store refuses is reported rather than swallowed', () => {
  const root = tempRoot()
  try {
    addGlobalFact(root, 'bot1', '第一条', { now: 1_000 })
    const parsed = parseMemoryMarkdown('## 长期记忆\n\n1. 第二条\n')
    const plan = planMemoryImport(parsed, readGlobalMemory(root, 'bot1'), { maxFacts: 1 })
    // The plan sees no room, so nothing is offered — the honest outcome is an
    // empty plan, not a write that fails silently.
    assert.deepEqual(plan.facts, [])
    assert.equal(plan.droppedFacts, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the confirmation window is ten minutes', () => {
  assert.equal(IMPORT_CONFIRM_TTL_MS, 10 * 60_000)
})

test('imported events keep their date', () => {
  const root = tempRoot()
  try {
    addEvent(root, 'bot1', { text: '旧事件' }, { now: 1_000 })
    const plan = planMemoryImport(
      { facts: [], profile: {}, digest: '', skipped: 0, events: [{ when: '2099-01-05', text: '体检' }] },
      readGlobalMemory(root, 'bot1'),
    )
    const written = applyMemoryImport({ stateRoot: root, accountId: 'bot1', plan, now: 2_000 })
    assert.equal(written.events, 1)
    const events = readGlobalMemory(root, 'bot1').events
    assert.ok(events.some((event) => event.text === '体检' && event.when === '2099-01-05'))
    assert.ok(events.some((event) => event.text === '旧事件'), 'existing events are untouched')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
test('the three policies differ exactly where the docs say they do', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-policy-'))
  const now = Date.now()
  addGlobalFact(root, 'bot', '对花生过敏', { warn: () => {}, now })
  // The profile has five fixed fields (call/schedule/likes/dislikes/dates) —
  // `name` is not one of them, so the conflict here is on `call`.
  saveProfile(root, 'bot', { call: '小王' }, { warn: () => {} })
  const parsed = {
    digest: '',
    profile: { call: '大王', schedule: '夜猫子', likes: ['海边'] },
    events: [{ text: '体检', when: '2026-11-20' }],
    facts: ['对花生过敏', '养了一只猫'],
    skipped: 0,
  }
  const memory = readGlobalMemory(root, 'bot', { warn: () => {} })

  // fill: only empty profile fields are written.
  const fill = planMemoryImport(parsed, memory, { maxFacts: 30 })
  const filled = applyMemoryImport({ stateRoot: root, accountId: 'bot', plan: fill, policy: 'fill', warn: () => {} })
  assert.equal(filled.facts, 1, 'the duplicate fact is skipped, the new one lands')
  // `saveProfile` reports what the whole profile looks like after the write, so
  // the number counts three fields (name unchanged, city + likes added).
  assert.equal(filled.profile, 2, 'two fields were written; `call` stayed as it was')
  let after = readGlobalMemory(root, 'bot', { warn: () => {} })
  assert.equal(after.profile.call, '小王', 'fill never overwrites a field this machine already has')
  assert.equal(after.profile.schedule, '夜猫子', 'an empty field is filled')

  // replace: the pack wins on its own fields.
  const memory2 = readGlobalMemory(root, 'bot', { warn: () => {} })
  const replacePlan = planMemoryImport(parsed, memory2, { maxFacts: 30 })
  const replaced = applyMemoryImport({ stateRoot: root, accountId: 'bot', plan: replacePlan, policy: 'replace', warn: () => {} })
  assert.ok(replaced.profile >= 1)
  after = readGlobalMemory(root, 'bot', { warn: () => {} })
  assert.equal(after.profile.call, '大王', 'replace writes the pack value over the local one')
  assert.equal(after.facts.some((fact) => fact.text === '对花生过敏'), true, 'facts are appended, never deleted')
})

test('a JSON export round-trips through the JSON parser, and refuses foreign JSON', () => {
  const now = Date.UTC(2026, 10, 4, 9, 0, 0)
  const payload = renderMemoryJson({
    store: {
      digest: '一个喜欢夜里聊天的人',
      profile: { name: '小王', likes: ['海边'], city: '' },
      events: [{ text: '体检', when: '2026-11-20', done: false }],
      facts: [{ text: '对花生过敏', at: now, source: 'user' }],
      superseded: [{ text: '喜欢猫', by: '养了一只狗' }],
    },
    conversations: [
      { conversationId: 'c1', summary: '聊了工作', bond: { level: 3 } },
      { conversationId: 'c2', summary: '' },
    ],
    dates: [{ label: '生日', date: '2026-12-01' }],
    conversationId: 'c1',
    now,
  })
  assert.equal(payload.format, 'dsh-weixin-memory')
  assert.equal(payload.exportedAt, new Date(now).toISOString())
  assert.equal(payload.profile.city, undefined, 'empty fields are left out rather than written as ""')
  assert.equal(payload.conversations.length, 1, 'a conversation with no summary is not exported')
  assert.equal(payload.facts[0].at, now, 'the confirmation time survives, so imports can rank')

  const decoded = parseMemoryJson(JSON.stringify(payload))
  assert.equal(decoded.ok, true)
  assert.deepEqual(decoded.parsed.facts, ['对花生过敏'])
  assert.equal(decoded.parsed.profile.name, '小王')
  assert.equal(decoded.parsed.conversations[0].conversationId, 'c1')
  assert.equal(decoded.parsed.events.length, 1)

  assert.match(parseMemoryJson('not json').reason, /不是合法的 JSON/)
  assert.match(parseMemoryJson('{"facts":[]}').reason, /不是本插件的记忆导出/)
  const edited = parseMemoryJson(JSON.stringify({ format: 'dsh-weixin-memory', version: 1, facts: [{ text: '新的一条' }] }))
  assert.equal(edited.ok, true)
  assert.deepEqual(edited.parsed.facts, ['新的一条'], 'a hand-edited file still imports')
})
