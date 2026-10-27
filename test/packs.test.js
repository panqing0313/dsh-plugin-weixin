import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PACK_FORMAT, PACK_VERSION, exportPack, importPack, packFile, writePack, describeSubscriptionClock } from '../src/packs.js'
import { readPersonaStore, writePersonaStore, MAX_CUSTOM_MODES } from '../src/persona.js'
import { parseSubscriptionWhen, SubscriptionScheduler } from '../src/message/subscriptions.js'

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-pack-'))
}

function seedSample(root) {
  const modes = readPersonaStore(root)
  modes.push({ id: 'custom-a', name: '毒舌室友', prompt: '损友，嘴上不饶人但会记得你的事。', builtin: false })
  writePersonaStore(root, modes)
  const scheduler = new SubscriptionScheduler({ stateRoot: root, fire: async () => '', warn: () => {}, setTimeoutRef: () => undefined, clearTimeoutRef: () => {} })
  scheduler.schedule({ accountId: 'acc', conversationId: 'conv', prompt: '早安，问问我睡得怎么样', when: parseSubscriptionWhen('每天 08:00', new Date()) })
  scheduler.schedule({ accountId: 'acc', conversationId: 'conv', prompt: '周日晚上提醒我收心', when: parseSubscriptionWhen('每周日 21:00', new Date()) })
  return scheduler
}

test('a pack carries the custom modes, the schedule and the behaviour knobs — and nothing else', () => {
  const root = freshRoot()
  seedSample(root)
  const pack = exportPack(root, 'acc', {
    config: { stickerEnabled: true, allowedSenders: ['wxid_secret'], minecraftProvider: 'x', locale: 'en' },
    name: '毒舌陪聊',
  })
  assert.equal(pack.format, PACK_FORMAT)
  assert.equal(pack.version, PACK_VERSION)
  assert.equal(pack.name, '毒舌陪聊')
  assert.deepEqual(pack.persona.modes.map((m) => m.name), ['毒舌室友'])
  assert.equal(pack.persona.modes[0].prompt, '损友，嘴上不饶人但会记得你的事。')
  assert.deepEqual(pack.subscriptions.map((s) => s.when).sort(), ['每周日 21:00', '每天 08:00'].sort())

  // Settings travel only when they are on the whitelist: an allowlist is a security
  // decision and a provider name belongs to the machine, so neither is in a template.
  assert.equal(pack.config.stickerEnabled, true)
  assert.equal(pack.config.locale, 'en')
  assert.equal(pack.config.allowedSenders, undefined)
  assert.equal(pack.config.minecraftProvider, undefined)
})

test('importing a pack adds and never overwrites', () => {
  const source = freshRoot()
  seedSample(source)
  const pack = exportPack(source, 'acc', { config: { locale: 'en' } })

  const target = freshRoot()
  const modes = readPersonaStore(target)
  modes.push({ id: 'custom-mine', name: '我自己的角色', prompt: '这是我自己写的，不能被模板覆盖。', builtin: false })
  writePersonaStore(target, modes)

  const scheduled = []
  const result = importPack(target, 'acc2', pack, {
    scheduleSubscription: (plan) => { scheduled.push(plan); return { ok: true } },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.modes.added, ['毒舌室友'])
  assert.equal(result.subscriptions.added.length, 2)
  assert.deepEqual(result.config, ['locale'])

  const after = readPersonaStore(target)
  assert.ok(after.some((mode) => mode.name === '我自己的角色'), 'the importer keeps its own role')
  assert.ok(after.some((mode) => mode.name === '毒舌室友'), 'and gains the pack\'s')
  assert.equal(scheduled[0].accountId, 'acc2', 'subscriptions land on the importer\'s account')

  // Twice is a no-op: the second import has nothing left to add.
  const again = importPack(target, 'acc2', pack, { scheduleSubscription: () => ({ ok: true }) })
  assert.deepEqual(again.modes.added, [])
  assert.deepEqual(again.modes.skipped.map((s) => s.reason), ['duplicate-name'])
})

test('a pack cannot exceed the custom-mode cap, and malformed packs are refused', () => {
  const root = freshRoot()
  const pack = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    persona: { modes: Array.from({ length: MAX_CUSTOM_MODES + 5 }, (_, i) => ({ name: `角色${i}`, prompt: '一段人格描述。' })) },
    subscriptions: [{ prompt: '', when: '每天 08:00' }, { prompt: '有词无钟', when: '' }],
  }
  const result = importPack(root, 'acc', pack, { scheduleSubscription: () => ({ ok: true }) })
  assert.equal(result.modes.added.length, MAX_CUSTOM_MODES)
  assert.deepEqual(result.modes.skipped.map((s) => s.reason), Array(5).fill('cap'))
  assert.deepEqual(result.subscriptions.skipped.map((s) => s.reason), ['empty-prompt-or-when', 'empty-prompt-or-when'])

  assert.equal(importPack(root, 'acc', 'not json').error, 'not-json')
  assert.equal(importPack(root, 'acc', { format: 'something-else' }).error, 'wrong-format')
  assert.equal(importPack(root, 'acc', { format: PACK_FORMAT, version: PACK_VERSION + 1 }).error, 'newer-version')
  assert.equal(importPack(root, 'acc', { format: PACK_FORMAT, version: PACK_VERSION, subscriptions: [{ prompt: 'x', when: '每天 08:00' }] }).subscriptions.skipped[0].reason, 'not-wired')
})

test('an exported pack lands next to the chat exports with a readable name', () => {
  const root = freshRoot()
  seedSample(root)
  const pack = exportPack(root, 'acc', { name: '带空格 的/名字' })
  const file = writePack(root, pack)
  assert.ok(fs.existsSync(file))
  assert.ok(file.endsWith('.json'))
  assert.ok(file.includes(path.join('exports')))
  const base = path.basename(file)
  assert.ok(!base.includes('/') && !base.includes('\\'), 'a name never introduces a path separator')
  assert.equal(path.dirname(path.dirname(file)), root, 'and it stays inside the state root')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).format, PACK_FORMAT)
  assert.equal(packFile(root, 'x').startsWith(root), true)
})

test('the clock inside a pack is written the way /subscribe reads it', () => {
  assert.equal(describeSubscriptionClock({ kind: 'daily', time: '08:00' }), '每天 08:00')
  assert.equal(describeSubscriptionClock({ kind: 'weekly', weekday: 7, time: '21:00' }), '每周日 21:00')
  assert.equal(describeSubscriptionClock({ kind: 'weekly', weekday: 3, time: '09:30' }), '每周三 09:30')
  assert.equal(describeSubscriptionClock({ kind: 'once' }), undefined)
})
