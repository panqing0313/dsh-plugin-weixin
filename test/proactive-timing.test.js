import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BAND_HOURS,
  MIN_DAYS,
  MIN_SAMPLES,
  busiestBand,
  describeLearnedHours,
  hourlyHistogram,
  intersectWindow,
  learnActiveHours,
} from '../src/message/proactive-timing.js'

const NOW = new Date(2026, 10, 4, 12, 0).getTime()
const HOUR = 3_600_000

/** `at(dayOffset, hour)` — days back from NOW, at a local hour. */
function at(daysAgo, hour, minute = 0) {
  const date = new Date(NOW)
  date.setDate(date.getDate() - daysAgo)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

function entriesFor(hourCounts) {
  const out = []
  for (const [hour, count] of hourCounts) {
    for (let index = 0; index < count; index += 1) out.push({ dir: 'in', at: at(index % 7, hour) })
  }
  return out
}

test('the histogram counts what the other person wrote, per hour of the day', () => {
  const entries = [
    { dir: 'in', at: at(0, 21) },
    { dir: 'in', at: at(1, 21) },
    { dir: 'in', at: at(2, 22) },
    { dir: 'out', at: at(2, 22) },
    { dir: 'in', at: at(9, 9) },
    { dir: 'in', at: at(40, 9) },
  ]
  const { counts, samples, dayCount } = hourlyHistogram(entries, { now: NOW, days: 14 })
  assert.equal(samples, 4, 'only dir=in inside the window: 30 days ago is out of range')
  assert.equal(counts[21], 2)
  assert.equal(counts[22], 1)
  assert.equal(counts[9], 1)
  assert.equal(dayCount, 4)
})

test('with too little history it declines to guess', () => {
  assert.equal(learnActiveHours([], { now: NOW }).reason, 'no-activity')
  assert.equal(learnActiveHours(entriesFor([[20, 5]]), { now: NOW }).reason, 'not-enough-data')

  // Enough messages, but crammed into one evening: that is one conversation,
  // not a routine.
  const oneEvening = []
  for (let index = 0; index < MIN_SAMPLES + 5; index += 1) oneEvening.push({ dir: 'in', at: at(0, 21, index) })
  const thin = learnActiveHours(oneEvening, { now: NOW })
  assert.equal(thin.ok, false)
  assert.ok(thin.dayCount < MIN_DAYS)
})

test('it finds the busiest window, and wraps midnight for a night owl', () => {
  const daytime = new Array(24).fill(0)
  for (const hour of [9, 10, 11, 14, 15]) daytime[hour] = 4
  const dayBand = busiestBand(daytime, 8)
  assert.ok(dayBand.startHour <= 9 && dayBand.startHour + 8 > 15, `band ${dayBand.startHour}–${dayBand.endHour} must cover 9–15`)

  const night = new Array(24).fill(0)
  for (const hour of [22, 23, 0, 1, 2]) night[hour] = 5
  const nightBand = busiestBand(night, 8)
  const covered = new Set()
  for (let offset = 0; offset < 8; offset += 1) covered.add((nightBand.startHour + offset) % 24)
  for (const hour of [22, 23, 0, 1, 2]) assert.ok(covered.has(hour), `hour ${hour} must be inside the band`)
  assert.equal(nightBand.wraps, true, 'a night owl gets a band that crosses midnight')
})

test('a learned band only ever narrows the configured window', () => {
  const config = { start: 9 * 60, end: 23 * 60 }
  const inside = intersectWindow(config, { startHour: 19, endHour: 22, wraps: false })
  assert.deepEqual(inside, { ranges: [{ start: 19 * 60, end: 22 * 60 }] })

  const partial = intersectWindow({ start: 14 * 60, end: 23 * 60 }, { startHour: 9, endHour: 20, wraps: false })
  assert.deepEqual(partial, { ranges: [{ start: 14 * 60, end: 20 * 60 }] }, 'the configured window stays a hard bound')

  const disjoint = intersectWindow({ start: 9 * 60, end: 12 * 60 }, { startHour: 22, endHour: 23, wraps: false })
  assert.equal(disjoint, undefined, 'no overlap -> the caller keeps the config, not silence')

  const wrapping = intersectWindow({ start: 0, end: 23 * 60 }, { startHour: 22, endHour: 3, wraps: true })
  assert.deepEqual(
    wrapping,
    { ranges: [{ start: 22 * 60, end: 23 * 60 }, { start: 0, end: 3 * 60 }] },
    'a wrapping band can overlap the window at both ends of the day',
  )
})

test('the learned line says what it found, or why it did not', () => {
  assert.match(describeLearnedHours(undefined), /还没有统计/)
  assert.match(describeLearnedHours({ ok: false, reason: 'no-activity', samples: 0, dayCount: 0 }), /还没看到/)
  assert.match(describeLearnedHours({ ok: false, reason: 'not-enough-data', samples: 7, dayCount: 2 }), /样本不够（7 条 \/ 2 天）/)

  const line = describeLearnedHours({ ok: true, startHour: 19, endHour: 23, wraps: false, samples: 40, dayCount: 9, share: 0.8 })
  assert.match(line, /19:00–23:00/)
  assert.match(line, /覆盖 80% 的消息（40 条 \/ 9 天）/)
  assert.match(describeLearnedHours({ ok: true, startHour: 22, endHour: 3, wraps: true, samples: 30, dayCount: 6, share: 0.7 }), /22:00–03:00（跨零点）/)
})

test('a real two-week routine is learned with its own hours', () => {
  const counts = new Array(24).fill(0)
  for (const hour of [19, 20, 21]) counts[hour] = 6
  counts[12] = 2
  const entries = []
  for (let hour = 0; hour < 24; hour += 1) {
    for (let index = 0; index < counts[hour]; index += 1) entries.push({ dir: 'in', at: at(index % 12, hour) })
  }
  const learned = learnActiveHours(entries, { now: NOW })
  assert.equal(learned.ok, true)
  assert.equal(learned.wraps, false)
  const covered = new Set()
  for (let offset = 0; offset < BAND_HOURS; offset += 1) covered.add((learned.startHour + offset) % 24)
  for (const hour of [19, 20, 21]) assert.ok(covered.has(hour))
  assert.ok(learned.share > 0.8, `the evening accounts for nearly everything (share ${learned.share})`)
  assert.equal(learned.samples, 20)
  assert.ok(learned.dayCount >= MIN_DAYS)
})