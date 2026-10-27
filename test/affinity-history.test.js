import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AFFINITY_KEEP_DAYS,
  affinityFilePath,
  dayString,
  describeAffinity,
  readAffinityHistory,
  recordAffinitySnapshot,
  sparkline,
} from '../src/message/affinity-history.js'

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-affinity-'))
}

test('one row per local day, updated in place, newest wins', () => {
  const state = root()
  const at = (day, hour = 12) => new Date(2026, 9, day, hour, 0, 0).getTime()
  recordAffinitySnapshot(state, 'acc', 'conv', { now: at(26), bond: { msgs: 3 }, life: { energy: 40, mood: '平静' } })
  recordAffinitySnapshot(state, 'acc', 'conv', { now: at(26, 20), bond: { msgs: 9 }, life: { energy: 25, mood: '有点乏' } })
  recordAffinitySnapshot(state, 'acc', 'conv', { now: at(27), bond: { msgs: 12 }, life: { energy: 70, mood: '精神不错' } })

  const history = readAffinityHistory(state, 'acc', 'conv')
  assert.equal(history.days.length, 2, 'the same day is one row, not two')
  assert.deepEqual(history.days.map((entry) => entry.day), ['2026-10-26', '2026-10-27'])
  assert.equal(history.days[0].msgs, 9, 'the later turn of the day wins')
  assert.equal(history.days[0].energy, 25)
  assert.equal(history.days[1].mood, '精神不错')
  assert.ok(fs.existsSync(affinityFilePath(state, 'acc', 'conv')))
})

test('the history is bounded, and a missing file reads as empty rather than failing', () => {
  const state = root()
  for (let day = 1; day <= AFFINITY_KEEP_DAYS + 10; day += 1) {
    const now = new Date(2026, 0, 1, 12, 0, 0).getTime() + day * 86_400_000
    recordAffinitySnapshot(state, 'acc', 'conv', { now, bond: { msgs: day }, life: { energy: 50 } })
  }
  const history = readAffinityHistory(state, 'acc', 'conv')
  assert.equal(history.days.length, AFFINITY_KEEP_DAYS)
  assert.equal(history.days.at(-1).msgs, AFFINITY_KEEP_DAYS + 10)

  const empty = readAffinityHistory(state, 'nobody', 'nothing')
  assert.deepEqual(empty.days, [])
})

test('a sparkline normalises across the window and stays flat when the series is flat', () => {
  assert.equal(sparkline([]), '')
  assert.equal(sparkline([5, 5, 5]).length, 3)
  assert.equal(new Set(sparkline([5, 5, 5])).size, 1, 'a flat series is one block, not full blocks')
  const rising = sparkline([1, 2, 3, 4])
  assert.equal(rising.length, 4)
  assert.equal(rising.at(0), '▁')
  assert.equal(rising.at(-1), '█')
  assert.equal(sparkline(Array.from({ length: 40 }, (_, i) => i), { width: 10 }).length, 10, 'width is honoured')
})

test('the one-line summary names the window and both series', () => {
  const state = root()
  recordAffinitySnapshot(state, 'acc', 'conv', { now: new Date(2026, 9, 26, 12).getTime(), bond: { msgs: 1 }, life: { energy: 30 } })
  recordAffinitySnapshot(state, 'acc', 'conv', { now: new Date(2026, 9, 27, 12).getTime(), bond: { msgs: 8 }, life: { energy: 60 } })
  const line = describeAffinity(readAffinityHistory(state, 'acc', 'conv'))
  assert.match(line, /^近 2 天/)
  assert.match(line, /精力 /)
  assert.match(line, /2026-10-26 → 2026-10-27/)
  assert.equal(describeAffinity({ days: [] }), '')
  assert.equal(dayString(new Date(2026, 0, 5, 23, 59).getTime()), '2026-01-05')
})
