import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_MAX_PER_DAY,
  DEFAULT_MIN_GAP_MINUTES,
  ProactiveScheduler,
  describePlan,
  hoursSince,
  planProactive,
  proactiveFilePath,
  readProactiveState,
  writeProactiveState,
} from '../src/message/proactive.js'

/** A local timestamp at a given clock time, so the window tests are stable. */
function at(hour, minute = 0, day = 26) {
  return new Date(2026, 9, day, hour, minute, 0, 0).getTime()
}

const ENABLED = {
  proactiveEnabled: true,
  proactiveMinGapMinutes: DEFAULT_MIN_GAP_MINUTES,
  proactiveMaxPerDay: DEFAULT_MAX_PER_DAY,
  proactiveWindowStart: '09:00',
  proactiveWindowEnd: '23:00',
}

test('off by default, and nothing happens without the flag', () => {
  const plan = planProactive({ now: at(14), state: null, lastInboundAt: at(9), config: {}, rng: () => 0 })
  assert.equal(plan.fire, false)
  assert.equal(plan.reason, 'disabled')
})

test('outside the window there is no message, night included', () => {
  for (const [hour, minute] of [[8, 59], [23, 0], [3, 30]]) {
    const plan = planProactive({ now: at(hour, minute), state: null, lastInboundAt: at(1), config: ENABLED, rng: () => 0 })
    assert.equal(plan.fire, false, `${hour}:${minute} must be outside`)
    assert.equal(plan.reason, 'outside-window')
  }
  const inside = planProactive({ now: at(9, 0), state: null, lastInboundAt: at(1), config: ENABLED, rng: () => 0 })
  assert.equal(inside.fire, true)
})

test('it waits the minimum gap after the user last spoke', () => {
  const plan = planProactive({ now: at(14), state: null, lastInboundAt: at(12, 30), config: ENABLED, rng: () => 0 })
  assert.equal(plan.fire, false)
  assert.equal(plan.reason, 'too-soon')
  assert.equal(plan.waitMs, 90 * 60_000, 'half an hour left of a 3 hour gap')
})

test('every unanswered message doubles the next gap, capped at a day', () => {
  const base = 3 * 60 * 60_000
  const lastAt = at(10)
  const oneMiss = planProactive({ now: lastAt + base + 1, state: { lastAt, misses: 1 }, lastInboundAt: 0, config: ENABLED, rng: () => 0 })
  assert.equal(oneMiss.reason, 'backoff')
  assert.ok(oneMiss.waitMs > 0)

  const twoMisses = planProactive({ now: lastAt + base + 1, state: { lastAt, misses: 2 }, lastInboundAt: 0, config: ENABLED, rng: () => 0 })
  assert.equal(twoMisses.reason, 'backoff')
  assert.ok(twoMisses.waitMs > oneMiss.waitMs, 'a second unanswered message must wait longer')

  const capped = planProactive({ now: lastAt + 23 * 3_600_000, state: { lastAt, misses: 9 }, lastInboundAt: 0, config: ENABLED, rng: () => 0 })
  assert.equal(capped.reason, 'backoff')
  assert.ok(capped.waitMs <= 24 * 3_600_000, 'the cap is one day')
})

test('the daily cap stops it even when everything else passes', () => {
  const now = at(20)
  const plan = planProactive({
    now,
    state: { day: '2026-10-26', count: DEFAULT_MAX_PER_DAY, lastAt: 0, misses: 0 },
    lastInboundAt: 0,
    config: ENABLED,
    rng: () => 0,
  })
  assert.equal(plan.reason, 'daily-cap')
  assert.equal(plan.fire, false)
})

test('a new day resets the counter', () => {
  const plan = planProactive({
    now: at(20, 0, 27),
    state: { day: '2026-10-26', count: DEFAULT_MAX_PER_DAY, lastAt: 0, misses: 0 },
    lastInboundAt: 0,
    config: ENABLED,
    rng: () => 0,
  })
  assert.equal(plan.fire, true)
})

test('the per-tick chance keeps it from reading like a cron job', () => {
  const unlucky = planProactive({ now: at(14), state: null, lastInboundAt: 0, config: ENABLED, rng: () => 0.99 })
  assert.equal(unlucky.fire, false)
  assert.equal(unlucky.reason, 'tick-chance')
  const lucky = planProactive({ now: at(14), state: null, lastInboundAt: 0, config: ENABLED, rng: () => 0.01 })
  assert.equal(lucky.fire, true)
})

test('an inverted window falls back to the default instead of never speaking', () => {
  const config = { ...ENABLED, proactiveWindowStart: '23:00', proactiveWindowEnd: '09:00' }
  const plan = planProactive({ now: at(14), state: null, lastInboundAt: 0, config, rng: () => 0 })
  assert.equal(plan.fire, true)
})

test('hoursSince rounds to a tenth and ignores a missing stamp', () => {
  assert.equal(hoursSince(0, at(14)), null)
  assert.equal(hoursSince(at(12), at(14, 30)), 2.5)
})

test('state survives a round trip, and a corrupt file reads as empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proactive-'))
  assert.deepEqual(readProactiveState(root, 'bot1').count, 0)
  writeProactiveState(root, 'bot1', { day: '2026-10-26', count: 2, lastAt: 5, misses: 1, recent: ['在干嘛'] })
  const back = readProactiveState(root, 'bot1')
  assert.equal(back.count, 2)
  assert.deepEqual(back.recent, ['在干嘛'])
  fs.writeFileSync(proactiveFilePath(root, 'bot1'), '{ not json')
  const warnings = []
  assert.equal(readProactiveState(root, 'bot1', { warn: (l) => warnings.push(l) }).count, 0)
  assert.equal(warnings.length, 1)
})

test('the scheduler speaks once, then backs off, and resetting on a reply unblocks it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proactive-'))
  let now = at(14)
  const sent = []
  const scheduler = new ProactiveScheduler({
    stateRoot: root,
    candidates: () => [{ accountId: 'bot1', conversationId: 'wxid_a', lastInboundAt: at(9) }],
    fire: async () => {
      sent.push('消息')
      return '你在干嘛呀'
    },
    config: () => ENABLED,
    now: () => now,
    rng: () => 0,
    setTimeoutRef: () => null,
    clearTimeoutRef: () => {},
  })

  const first = await scheduler.tick()
  assert.deepEqual(first, { fired: 1, reason: 'sent' })
  assert.equal(sent.length, 1)
  const state = scheduler.status('bot1')
  assert.equal(state.count, 1)
  assert.equal(state.misses, 1)
  assert.deepEqual(state.recent, ['你在干嘛呀'])

  // Ten minutes later the backoff (6 hours for one miss) still holds it.
  now += 10 * 60_000
  const second = await scheduler.tick()
  assert.equal(second.fired, 0)
  assert.equal(second.reason, 'backoff')

  // The user replies: misses drop to zero and the next gap is the base again.
  scheduler.noteInbound('bot1')
  assert.equal(scheduler.status('bot1').misses, 0)
  now += 3 * 3_600_000
  const third = await scheduler.tick()
  assert.equal(third.fired, 1)
  assert.equal(sent.length, 2)
})

test('an empty reply is not sent and does not count as a message', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proactive-'))
  const scheduler = new ProactiveScheduler({
    stateRoot: root,
    candidates: () => [{ accountId: 'bot1', conversationId: 'wxid_a', lastInboundAt: 0 }],
    fire: async () => '',
    config: () => ENABLED,
    now: () => at(14),
    rng: () => 0,
    setTimeoutRef: () => null,
    clearTimeoutRef: () => {},
  })
  const result = await scheduler.tick()
  assert.equal(result.fired, 0)
  assert.equal(result.reason, 'empty')
})

test('a throwing fire callback is swallowed and counted as a miss', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proactive-'))
  const warnings = []
  const scheduler = new ProactiveScheduler({
    stateRoot: root,
    candidates: () => [{ accountId: 'bot1', conversationId: 'wxid_a', lastInboundAt: 0 }],
    fire: async () => {
      throw new Error('transport exploded')
    },
    config: () => ENABLED,
    warn: (line) => warnings.push(line),
    now: () => at(14),
    rng: () => 0,
    setTimeoutRef: () => null,
    clearTimeoutRef: () => {},
  })
  const result = await scheduler.tick()
  assert.equal(result.fired, 0)
  assert.equal(result.reason, 'failed')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /transport exploded/)
  assert.equal(scheduler.status('bot1').misses, 1, 'a broken channel must not retry every five minutes')
})

test('describePlan turns a refusal into one readable line', () => {
  assert.equal(describePlan({ fire: true, reason: 'ok', waitMs: 0 }), 'proactive message: yes')
  assert.match(describePlan({ fire: false, reason: 'too-soon', waitMs: 90 * 60_000 }), /too-soon.*90 分钟/)
})
