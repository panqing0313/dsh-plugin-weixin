import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PACK_PRESETS, listPresetPacks, normalizePackForImport, presetPack } from '../src/pack-presets.js'
import { importPack } from '../src/packs.js'

const NOW = new Date(2026, 10, 3, 12, 0, 0).getTime() // 2026-11-03 12:00 local

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-preset-'))
}

test('all three presets are well formed and carry only shippable content', () => {
  assert.equal(PACK_PRESETS.length, 3)
  for (const preset of PACK_PRESETS) {
    const pack = preset.pack
    assert.equal(pack.format, 'dsh-weixin-pack')
    assert.equal(pack.version, 1)
    assert.ok(preset.name !== '' && preset.tagline !== '', preset.id)
    assert.ok(pack.persona.modes.length >= 1, `${preset.id} needs a mode`)
    for (const mode of pack.persona.modes) {
      assert.ok(mode.name.trim() !== '' && mode.prompt.trim() !== '', preset.id)
    }
    // A pack must never carry a security decision or machine-bound value.
    for (const forbidden of ['allowedSenders', 'maxMediaBytes', 'accountId', 'webhookUrl', 'packsIndexUrl']) {
      assert.equal(pack.config[forbidden], undefined, `${preset.id} must not ship ${forbidden}`)
    }
  }
})

test('the card list has the four display fields and no pack body', () => {
  const list = listPresetPacks()
  assert.equal(list.length, 3)
  for (const entry of list) {
    assert.ok(typeof entry.id === 'string' && entry.id !== '')
    assert.ok(typeof entry.name === 'string' && entry.name !== '')
    assert.ok(typeof entry.tagline === 'string' && entry.tagline !== '')
    assert.ok(Number.isInteger(entry.modes) && Number.isInteger(entry.subscriptions))
    assert.equal(entry.pack, undefined, 'the list must not ship the whole pack to the card')
  }
})

test('presetPack returns a copy, so a caller cannot mutate the constant', () => {
  const first = presetPack('companion')
  first.persona.modes[0].name = 'mutated'
  assert.notEqual(presetPack('companion').persona.modes[0].name, 'mutated')
  assert.equal(presetPack('nope'), undefined)
})

test('a daily reminder whose clock already passed is moved to tomorrow', () => {
  const pack = { subscriptions: [{ prompt: '晚安', when: '每天 22:30' }, { prompt: '早起', when: '每天 06:30' }] }
  const normalized = normalizePackForImport(pack, { now: NOW }) // 12:00
  // 06:30 already happened today → must become a "明天" schedule so it does not fire now.
  assert.equal(normalized.subscriptions.find((s) => s.prompt === '早起').when, '明天 06:30')
  // A clock still ahead of us today is left alone: it should fire later today.
  assert.equal(normalized.subscriptions.find((s) => s.prompt === '晚安').when, '每天 22:30')
  // The input pack is not mutated.
  assert.equal(pack.subscriptions[1].when, '每天 06:30')
})

test('a preset installs additively and schedules its reminders on the importing account', () => {
  const root = tmpRoot()
  try {
    const scheduled = []
    const pack = normalizePackForImport(presetPack('companion'), { now: NOW })
    const result = importPack(root, 'bot1@im.bot', pack, {
      now: NOW,
      scheduleSubscription: (plan) => {
        scheduled.push(plan.when)
        return { ok: true }
      },
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.modes.added, ['贴心陪伴'])
    assert.equal(result.subscriptions.added.length, 2)
    assert.equal(scheduled.length, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('installing the same preset twice adds nothing the second time', () => {
  const root = tmpRoot()
  try {
    const pack = normalizePackForImport(presetPack('assistant'), { now: NOW })
    const options = { now: NOW, scheduleSubscription: () => ({ ok: true }) }
    const first = importPack(root, 'bot1@im.bot', pack, options)
    assert.equal(first.modes.added.length, 1)
    const second = importPack(root, 'bot1@im.bot', pack, { now: NOW + 1000, scheduleSubscription: () => ({ ok: true }) })
    assert.equal(second.modes.added.length, 0)
    assert.equal(second.modes.skipped[0].reason, 'duplicate-name')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the group preset turns group chat on in mention mode, not all mode', () => {
  const pack = presetPack('group-host')
  assert.equal(pack.config.groupChatEnabled, true)
  assert.equal(pack.config.groupReplyWhen, 'mention')
  // A group bot that also DMs on a schedule would be exhausting.
  assert.equal(pack.config.proactiveEnabled, false)
})
