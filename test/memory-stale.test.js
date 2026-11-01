import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_STALE_DAYS,
  MAX_STALE_LIST,
  MIN_STALE_DAYS,
  formatStaleReport,
  staleDigestLine,
  staleFacts,
} from '../src/message/memory-stale.js'

const DAY = 86_400_000
const NOW = new Date(2026, 10, 1, 10, 0).getTime()

function daysAgo(days) {
  return NOW - days * DAY
}

test('only facts past the threshold count as stale, oldest first', () => {
  const report = staleFacts(
    [
      { text: '我对花生过敏', updatedAt: daysAgo(2) },
      { text: '我住在杭州', updatedAt: daysAgo(120) },
      { text: '我在做 A 项目', updatedAt: daysAgo(95) },
    ],
    { now: NOW, staleDays: 90 },
  )
  assert.deepEqual(
    report.stale.map((fact) => [fact.text, fact.days, fact.index]),
    [
      ['我住在杭州', 120, 2],
      ['我在做 A 项目', 95, 3],
    ],
    'the oldest goes first and the index still matches /memory',
  )
  assert.equal(report.staleDays, 90)
})

test('a correction refreshes the clock, so a rewritten fact is not stale', () => {
  const report = staleFacts(
    [
      // Written a year ago, corrected yesterday: `addGlobalFact` stamps
      // `updatedAt` on the correction, which is exactly the reconfirmation.
      { text: '我住在上海', at: daysAgo(365), updatedAt: daysAgo(1) },
    ],
    { now: NOW, staleDays: 90 },
  )
  assert.deepEqual(report.stale, [])
})

test('old facts without a timestamp are unknown, not stale', () => {
  const report = staleFacts([{ text: '我妈生日 5 月 20' }], { now: NOW, staleDays: 90 })
  assert.deepEqual(report.stale, [])
  assert.deepEqual(report.unknown, [{ text: '我妈生日 5 月 20', index: 1 }])
})

test('the threshold is clamped to a sane minimum and the list is capped', () => {
  assert.equal(staleFacts([], { now: NOW, staleDays: 0 }).staleDays, MIN_STALE_DAYS)
  assert.equal(staleFacts([], { now: NOW, staleDays: 'nonsense' }).staleDays, DEFAULT_STALE_DAYS)
  const many = Array.from({ length: MAX_STALE_LIST + 5 }, (_unused, index) => ({
    text: `事实 ${index}`,
    updatedAt: daysAgo(200 + index),
  }))
  assert.equal(staleFacts(many, { now: NOW, staleDays: 90 }).stale.length, MAX_STALE_LIST)
})

test('the report says nothing is wrong only when nothing is', () => {
  const quiet = formatStaleReport({ stale: [], unknown: [], staleDays: 90 })
  assert.match(quiet, /没有需要核对的记忆/)
  assert.match(quiet, /90 天/)

  const loud = formatStaleReport(
    { stale: [{ text: '我住在杭州', days: 120, index: 2 }], unknown: [], staleDays: 90 },
    { total: 5 },
  )
  assert.match(loud, /超过 90 天没确认过的记忆，共 1 条/)
  assert.match(loud, /2\. 我住在杭州（120 天没提起了）/)
  assert.match(loud, /\/remember 重新确认/)
  assert.match(loud, /长期记忆一共 5 条/)
})

test('the digest line is empty unless something went stale', () => {
  assert.equal(staleDigestLine({ stale: [], unknown: [{ text: 'x', index: 1 }], staleDays: 90 }), '')
  const one = staleDigestLine({ stale: [{ text: '我住在杭州', days: 120, index: 1 }], unknown: [], staleDays: 90 })
  assert.match(one, /有 1 条记忆超过 90 天没提过（我住在杭州）/)
  assert.match(one, /\/memory stale/)
  assert.doesNotMatch(one, /等 \d+ 条/, 'one fact needs no "and N more"')

  const many = staleDigestLine({
    stale: [
      { text: '甲', days: 200, index: 1 },
      { text: '乙', days: 190, index: 2 },
      { text: '丙', days: 180, index: 3 },
    ],
    unknown: [],
    staleDays: 90,
  })
  assert.match(many, /甲、乙 等 3 条/)
})