import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  activityFor,
  baseEnergyFor,
  inferLifeState,
  inferMood,
  lifeBlock,
  lifeFilePath,
  lifeSummary,
  LIFE_WRITE_INTERVAL_MS,
  readLifeState,
  readOrInferLifeState,
  writeLifeState,
} from '../src/message/life-state.js'

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-life-'))
const at = (hour, minute = 0) => new Date(2026, 9, 26, hour, minute, 0).getTime() // Mon 2026-10-26, local
const WEEKEND = new Date(2026, 9, 25, 10, 0, 0).getTime() // Sun 2026-10-25, local

test('baseEnergyFor and activityFor follow the clock, weekday vs weekend', () => {
  assert.ok(baseEnergyFor(3) < baseEnergyFor(10), 'the small hours are the low point')
  assert.ok(baseEnergyFor(23) < baseEnergyFor(15), 'late night is not a high point')
  assert.equal(activityFor(10), '在上班，抽空回你')
  assert.equal(activityFor(10, true), '在家，慢悠悠的')
  assert.equal(activityFor(3), '这个点还醒着')
  assert.equal(activityFor(23), '准备睡了')
  assert.equal(activityFor(18), '刚下班，在路上')
})

test('inferMood: absence beats tiredness, then the hour, then the battery', () => {
  assert.equal(inferMood({ energy: 90, hour: 12, gapMs: 4 * 86_400_000 }), '好久没聊天了，有点想你')
  assert.equal(inferMood({ energy: 90, hour: 23, gapMs: 0 }), '有点困，但还是想再说两句')
  assert.equal(inferMood({ energy: 18, hour: 12, gapMs: 0 }), '今天挺累的，不太想动')
  assert.equal(inferMood({ energy: 34, hour: 12, gapMs: 0 }), '有点乏，回得会慢一点')
  assert.equal(inferMood({ energy: 88, hour: 12, gapMs: 0 }), '精神不错，心情挺好')
  assert.equal(inferMood({ energy: 55, hour: 12, gapMs: 0 }), '平静')
})

test('inferLifeState is deterministic for a pinned clock and carries the first sighting forward', () => {
  const first = inferLifeState({ now: at(10) })
  assert.equal(first.activity, '在上班，抽空回你')
  assert.ok(first.energy >= 5 && first.energy <= 100)
  assert.equal(first.energy, inferLifeState({ now: at(10) }).energy, 'same minute, same number')
  assert.equal(first.firstSeenAt, at(10))

  const later = inferLifeState({ now: at(11), prior: first })
  assert.equal(later.firstSeenAt, at(10), 'the first sighting survives')

  // A tired snapshot drifts back toward the clock's baseline while you sleep.
  const tired = { mood: '累', activity: '在家歇着', energy: 20, updatedAt: at(2), firstSeenAt: at(2) }
  const morning = inferLifeState({ now: at(9), prior: tired })
  assert.ok(morning.energy > 40, `recovered: ${morning.energy}`)

  // A heavy chat day costs a little energy.
  const quiet = inferLifeState({ now: at(15), bond: { msgsToday: 0 } })
  const chatty = inferLifeState({ now: at(15), bond: { msgsToday: 30 } })
  assert.ok(chatty.energy < quiet.energy, `${chatty.energy} should be below ${quiet.energy}`)

  // Weekend activity, same clock.
  assert.equal(inferLifeState({ now: WEEKEND }).activity, '在家，慢悠悠的')
})

test('the snapshot round-trips, tolerates rubbish, and is not rewritten every message', () => {
  const root = tmpRoot()
  try {
    assert.equal(readLifeState(root, 'bot1'), null, 'no file yet')

    const life = inferLifeState({ now: at(10) })
    assert.equal(writeLifeState(root, 'bot1', life), true)
    assert.deepEqual(readLifeState(root, 'bot1'), life)
    assert.match(lifeFilePath(root, 'bot1'), /memory\/life-bot1\.json$/)

    // Corrupt or wrong-shaped JSON is "no snapshot", not a crash.
    const warnings = []
    fs.writeFileSync(lifeFilePath(root, 'bot1'), 'not json at all')
    assert.equal(readLifeState(root, 'bot1', { warn: (line) => warnings.push(line) }), null)
    assert.equal(warnings.length, 1)

    fs.writeFileSync(lifeFilePath(root, 'bot1'), JSON.stringify([1, 2, 3]))
    assert.equal(readLifeState(root, 'bot1'), null)

    // A fresh snapshot is not rewritten on the next message.
    const fresh = { ...life, updatedAt: at(10) }
    writeLifeState(root, 'bot1', fresh)
    const peek = readOrInferLifeState(root, 'bot1', { now: at(10) + 60_000 })
    assert.equal(readLifeState(root, 'bot1').updatedAt, at(10), 'written once, inside the interval')
    assert.equal(peek.updatedAt, at(10) + 60_000, 'but the caller still gets the current view')

    // Past the interval it is written again.
    readOrInferLifeState(root, 'bot1', { now: at(10) + LIFE_WRITE_INTERVAL_MS + 1000 })
    assert.equal(readLifeState(root, 'bot1').updatedAt, at(10) + LIFE_WRITE_INTERVAL_MS + 1000)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('lifeBlock renders one short state block and nothing for the stock assistant', () => {
  const rested = lifeBlock({ mood: '平静', activity: '在家歇着', energy: 62 })
  assert.match(rested, /^<weixin_life>/)
  assert.match(rested, /【状态】在家歇着，平静。精力 62\/100。/)
  assert.match(rested, /话可以多说两句/)
  assert.match(rested, /别把这段状态直接念给对方听/)

  const tired = lifeBlock({ mood: '今天挺累的，不太想动', activity: '刚下班，在路上', energy: 18 })
  assert.match(tired, /回短一点、慢一点/)

  assert.equal(lifeBlock(null), '')
  assert.equal(lifeBlock({ mood: '  ', activity: '在家', energy: 50 }), '')
})

test('lifeSummary is the one line the settings card shows', () => {
  assert.equal(lifeSummary({ mood: '平静', activity: '在家歇着', energy: 46 }), '在家歇着 · 平静 · 精力 46/100')
  assert.equal(lifeSummary({ mood: '', activity: '', energy: 70 }), '精力 70/100')
  assert.equal(lifeSummary(null), '')
})
