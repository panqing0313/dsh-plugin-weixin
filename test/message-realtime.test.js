/**
 * The realtime-line throttle and sanitizer (issue #10): pure functions that
 * decide whether a mid-turn sentence may go out, and clean it for a phone.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_REALTIME_MAX_PER_TURN,
  DEFAULT_REALTIME_INTERVAL_MS,
  DEFAULT_REALTIME_MAX_CHARS,
  REALTIME_REFUSAL_TEXT,
  shouldAnnounce,
  sanitizeRealtimeText,
} from '../src/message/realtime.js'

test('a fresh turn may speak', () => {
  assert.deepEqual(shouldAnnounce({ sent: 0, lastAt: 0, now: 1000 }), { allowed: true })
  assert.equal(DEFAULT_REALTIME_MAX_PER_TURN, 3)
})

test('the per-turn quota runs out', () => {
  const verdict = shouldAnnounce({ sent: 3, lastAt: 0, now: 100000, maxPerTurn: 3 })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.reason, 'limit')
  // A zero quota forbids every line, including the first.
  assert.equal(shouldAnnounce({ sent: 0, lastAt: 0, now: 0, maxPerTurn: 0 }).reason, 'limit')
})

test('two lines cannot be too close together', () => {
  const verdict = shouldAnnounce({ sent: 1, lastAt: 10_000, now: 12_000, minIntervalMs: 20_000 })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.reason, 'interval')
  // Once the gap has passed, it is allowed again.
  assert.deepEqual(shouldAnnounce({ sent: 1, lastAt: 10_000, now: 30_000, minIntervalMs: 20_000 }), { allowed: true })
  // A zero interval disables the spacing check.
  assert.deepEqual(shouldAnnounce({ sent: 1, lastAt: 10_000, now: 10_001, minIntervalMs: 0 }), { allowed: true })
})

test('a cancelled turn is silent even with budget left', () => {
  const verdict = shouldAnnounce({ sent: 0, lastAt: 0, now: 0, cancelled: true })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.reason, 'cancelled')
})

test('the default interval is 20s and the default line cap is 120', () => {
  assert.equal(DEFAULT_REALTIME_INTERVAL_MS, 20_000)
  assert.equal(DEFAULT_REALTIME_MAX_CHARS, 120)
})

test('a line is cleaned for a phone screen: whitespace, wrappers, markdown', () => {
  assert.equal(sanitizeRealtimeText('  正在  查资料  '), '正在 查资料')
  assert.equal(sanitizeRealtimeText('「在跑了」'), '在跑了')
  assert.equal(sanitizeRealtimeText('"还在测试"'), '还在测试')
  assert.equal(sanitizeRealtimeText('**正在**跑测试'), '正在跑测试')
  assert.equal(sanitizeRealtimeText('`代码`好了'), '代码好了')
  // Newlines collapse to a single space — one bubble, one line.
  assert.equal(sanitizeRealtimeText('第一行\n第二行'), '第一行 第二行')
})

test('an over-long line is clipped at the cap, without a mid-word cut when it can help', () => {
  const long = '这是一个特别长的句子，'.repeat(30)
  const clipped = sanitizeRealtimeText(long, { maxChars: 40 })
  assert.ok(clipped.length <= 40)
  assert.ok(clipped.endsWith('…'))
})

test('nothing left after cleaning reports empty', () => {
  assert.equal(sanitizeRealtimeText('   '), '')
  assert.equal(sanitizeRealtimeText('「 」'), '')
  assert.equal(sanitizeRealtimeText('``'), '')
})

test('every refusal has a sentence the model can act on', () => {
  for (const reason of ['off', 'idle', 'cancelled', 'limit', 'interval', 'empty', 'failed']) {
    assert.equal(typeof REALTIME_REFUSAL_TEXT[reason], 'string', reason)
    assert.ok(REALTIME_REFUSAL_TEXT[reason].length > 0, reason)
  }
})
