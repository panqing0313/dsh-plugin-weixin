import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseSubscriptionWhen, nextFireAt, SubscriptionScheduler, readSubscriptions, describeSubscription, GRACE_MS, MAX_SUBSCRIPTIONS_PER_ACCOUNT } from '../src/message/subscriptions.js'

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-sub-'))
}

/** Manual timer queue: arm(...) records, advance(ms) runs what is due. */
function fakeTimers() {
  const queue = []
  let now = Date.now()
  return {
    setTimeoutRef: (ms, cb) => {
      const handle = { cb, at: now + ms }
      queue.push(handle)
      return handle
    },
    clearTimeoutRef: (handle) => {
      const index = queue.indexOf(handle)
      if (index !== -1) queue.splice(index, 1)
    },
    async advance(ms) {
      now += ms
      queue.sort((a, b) => a.at - b.at)
      while (queue.length > 0 && queue[0].at <= now) {
        const { cb } = queue.shift()
        cb()
        await new Promise((resolve) => setImmediate(resolve))
        queue.sort((a, b) => a.at - b.at)
      }
    },
  }
}

test('parseSubscriptionWhen understands recurring and one-shot forms', () => {
  const now = new Date(2026, 9, 26, 19, 0, 0)
  const daily = parseSubscriptionWhen('每天 08:00', now)
  assert.deepEqual({ kind: daily.kind, time: daily.time }, { kind: 'daily', time: '08:00' })
  assert.equal(parseSubscriptionWhen('每日 9:05', now).time, '09:05', 'zero-padded normalization')
  assert.equal(parseSubscriptionWhen('daily 22:00', now).kind, 'daily', 'english alias')
  assert.equal(parseSubscriptionWhen('07:30', now).kind, 'daily', 'a bare clock time means every day')
  const weekly = parseSubscriptionWhen('每周日 21:30', now)
  assert.deepEqual({ kind: weekly.kind, weekday: weekly.weekday, time: weekly.time }, { kind: 'weekly', weekday: 7, time: '21:30' })
  assert.equal(parseSubscriptionWhen('每周六 10:00', now).weekday, 6)
  const once = parseSubscriptionWhen('2026-11-01 09:00', now)
  assert.deepEqual({ kind: once.kind, fireAt: once.fireAt }, { kind: 'once', fireAt: new Date(2026, 10, 1, 9, 0).getTime() })
  const relative = parseSubscriptionWhen('2h', now)
  assert.equal(relative.kind, 'once')
  assert.equal(relative.fireAt, now.getTime() + 2 * 3_600_000)
  assert.equal(parseSubscriptionWhen('25:00', now).ok, false)
  assert.equal(parseSubscriptionWhen('每天 25:00', now).ok, false)
  assert.equal(parseSubscriptionWhen('明天下午', now).ok, false)
})

test('nextFireAt lands on the next slot strictly after the given moment', () => {
  const daily = { kind: 'daily', time: '08:00' }
  assert.equal(nextFireAt(daily, new Date(2026, 9, 26, 10, 0).getTime()), new Date(2026, 9, 27, 8, 0).getTime())
  assert.equal(nextFireAt(daily, new Date(2026, 9, 26, 7, 30).getTime()), new Date(2026, 9, 26, 8, 0).getTime())
  const monday = { kind: 'weekly', time: '08:00', weekday: 1 }
  // Saturday noon → the coming Monday.
  assert.equal(nextFireAt(monday, new Date(2026, 9, 24, 12, 0).getTime()), new Date(2026, 9, 26, 8, 0).getTime())
  // Monday, already past 08:00 → next week's Monday.
  assert.equal(nextFireAt(monday, new Date(2026, 9, 26, 9, 0).getTime()), new Date(2026, 10, 2, 8, 0).getTime())
})

test('schedule persists, arms, fires at the slot, and advances recurring items', async () => {
  const stateRoot = tmpState()
  const timers = fakeTimers()
  try {
    const fired = []
    const scheduler = new SubscriptionScheduler({ stateRoot, fire: async (item) => { fired.push(item) }, ...timers })
    const planned = scheduler.schedule({ accountId: 'a1', conversationId: 'c1', prompt: '早安，问问我睡得怎么样', when: { ok: true, kind: 'daily', time: '08:00' } })
    assert.ok(planned.id, 'the scheduler returns the stored subscription')
    const slot = nextFireAt({ kind: 'daily', time: '08:00' }, Date.now())
    assert.equal(planned.fireAt, slot)
    assert.deepEqual(readSubscriptions(stateRoot).items.map((item) => item.id), [planned.id], 'durable before any fire')

    // Far past the slot: fire once, then the store shows the advanced slot.
    await timers.advance(48 * 3_600_000)
    assert.equal(fired.length, 1, 'a daily slot fires once even if the clock jumped two days')
    assert.equal(fired[0].prompt, '早安，问问我睡得怎么样')
    const stored = readSubscriptions(stateRoot).items[0]
    assert.ok(stored.fireAt > Date.now(), 'the store advanced to the next slot')
    assert.equal(typeof stored.lastFiredAt, 'number')
    assert.equal(stored.kind, 'daily', 'recurring items stay')
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('one-shot subscriptions remove themselves after firing', async () => {
  const stateRoot = tmpState()
  const timers = fakeTimers()
  try {
    const fired = []
    const scheduler = new SubscriptionScheduler({ stateRoot, fire: async (item) => { fired.push(item) }, ...timers })
    const planned = scheduler.schedule({ accountId: 'a1', conversationId: 'c1', prompt: '十一月一号提醒我交房租', when: { ok: true, kind: 'once', fireAt: Date.now() + 100 } })
    assert.equal(planned.kind, 'once')
    await timers.advance(200)
    assert.equal(fired.length, 1)
    assert.deepEqual(readSubscriptions(stateRoot).items, [], 'a fired one-shot is gone from the store')
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('a slot missed by downtime fires once inside the grace window, never outside', async () => {
  const stateRoot = tmpState()
  const timers = fakeTimers()
  try {
    // Write a store by hand: an 08:00 daily whose slot was 10 minutes ago.
    const missed = Date.now() - 10 * 60_000
    fs.writeFileSync(path.join(stateRoot, 'subscriptions.json'), JSON.stringify({
      seq: 1,
      items: [{ id: 's1', accountId: 'a1', conversationId: 'c1', prompt: '早安', kind: 'daily', time: '08:00', fireAt: missed, createdAt: missed - 86_400_000 }],
    }))
    const fired = []
    const scheduler = new SubscriptionScheduler({ stateRoot, fire: async (item) => { fired.push(item) }, ...timers })
    await timers.advance(50)
    assert.equal(fired.length, 1, 'a just-missed slot still fires once')
    assert.ok(readSubscriptions(stateRoot).items[0].fireAt > Date.now(), 'and the schedule advanced')

    // Beyond the grace window: skipped, not queued.
    const stateRoot2 = tmpState()
    try {
      const ancient = Date.now() - GRACE_MS - 3_600_000
      fs.writeFileSync(path.join(stateRoot2, 'subscriptions.json'), JSON.stringify({
        seq: 1,
        items: [{ id: 's2', accountId: 'a1', conversationId: 'c1', prompt: '早安', kind: 'daily', time: '08:00', fireAt: ancient, createdAt: ancient - 86_400_000 }],
      }))
      const fired2 = []
      const scheduler2 = new SubscriptionScheduler({ stateRoot: stateRoot2, fire: async (item) => { fired2.push(item) }, ...timers })
      await timers.advance(50)
      assert.equal(fired2.length, 0, 'an old miss is skipped, not replayed')
      const stored = readSubscriptions(stateRoot2).items[0]
      assert.ok(stored.fireAt > Date.now(), 'but the schedule moved to the next slot')
    } finally {
      fs.rmSync(stateRoot2, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('an expired one-shot is dropped on load with a warning', () => {
  const stateRoot = tmpState()
  try {
    const warnings = []
    fs.writeFileSync(path.join(stateRoot, 'subscriptions.json'), JSON.stringify({
      seq: 1,
      items: [{ id: 's3', accountId: 'a1', conversationId: 'c1', prompt: '过期了', kind: 'once', fireAt: Date.now() - 5_000, createdAt: Date.now() - 60_000 }],
    }))
    const timers = fakeTimers()
    new SubscriptionScheduler({ stateRoot, fire: () => {}, warn: (m) => warnings.push(m), ...timers })
    assert.deepEqual(readSubscriptions(stateRoot).items, [], 'the stale one-shot is removed')
    assert.ok(warnings.some((m) => m.includes('s3')), warnings.join(' | '))
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('schedule validates, caps per account, and cancel removes', () => {
  const stateRoot = tmpState()
  const timers = fakeTimers()
  try {
    const scheduler = new SubscriptionScheduler({ stateRoot, fire: () => {}, ...timers })
    assert.ok(scheduler.schedule({ accountId: 'a1', conversationId: 'c1', prompt: '', when: { ok: true, kind: 'daily', time: '08:00' } }).error !== undefined, 'empty prompt refused')
    assert.ok(scheduler.schedule({ accountId: 'a1', conversationId: 'c1', prompt: 'x'.repeat(501), when: { ok: true, kind: 'daily', time: '08:00' } }).error !== undefined, 'over-long prompt refused')
    assert.ok(scheduler.schedule({ accountId: 'a1', conversationId: 'c1', prompt: 'hi', when: { ok: false, reason: 'bad' } }).error !== undefined, 'bad when refused')
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_ACCOUNT; i += 1) {
      assert.ok(scheduler.schedule({ accountId: 'a1', conversationId: `c${i}`, prompt: `m${i}`, when: { ok: true, kind: 'daily', time: '08:00' } }).id, `slot ${i} scheduled`)
    }
    assert.ok(scheduler.schedule({ accountId: 'a1', conversationId: 'c99', prompt: 'overflow', when: { ok: true, kind: 'daily', time: '08:00' } }).error !== undefined, `the ${MAX_SUBSCRIPTIONS_PER_ACCOUNT} cap holds`)
    const id = scheduler.list('a1')[0].id
    assert.equal(scheduler.cancel(id), true)
    assert.equal(scheduler.cancel(id), false, 'cancelling twice reports honestly')
    assert.equal(scheduler.list('a1').length, MAX_SUBSCRIPTIONS_PER_ACCOUNT - 1)
    scheduler.stop()
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('describeSubscription renders each kind', () => {
  assert.equal(describeSubscription({ kind: 'daily', time: '08:00' }), '每天 08:00')
  assert.equal(describeSubscription({ kind: 'weekly', time: '21:30', weekday: 7 }), '每周日 21:30')
  const once = describeSubscription({ kind: 'once', fireAt: new Date(2026, 10, 1, 9, 0).getTime() })
  assert.match(once, /2026-11-01 09:00/)
})
