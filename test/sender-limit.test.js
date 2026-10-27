import assert from 'node:assert/strict'
import test from 'node:test'

const { DEFAULT_PER_MINUTE, WARN_COOLDOWN_MS, createSenderLimiter, queueFull } = await import('../src/message/sender-limit.js')

/**
 * One sender must not be able to monopolise the bot.
 *
 * The account-level pacer protects the Weixin account from a ban; this protects
 * the token bill and the reply latency. The rules that matter: the window
 * slides, a refusal tells the person once (not on every message), and the answer
 * says how long to wait.
 */
test('the window slides, and a refusal is answered once per cooldown', () => {
  let now = 1_000_000
  const limiter = createSenderLimiter({ perMinute: 3, now: () => now })
  assert.equal(limiter.check('a').allowed, true)
  assert.equal(limiter.check('a').allowed, true)
  assert.equal(limiter.check('a').allowed, true)
  const refused = limiter.check('a')
  assert.equal(refused.allowed, false)
  assert.equal(refused.shouldWarn, true, 'the first refusal tells the person')
  assert.ok(refused.retryAfterMs > 0 && refused.retryAfterMs <= 60_000)
  // Another message in the same window is still refused, but silently: telling
  // somebody "slow down" on every message they send is noise.
  assert.equal(limiter.check('a').shouldWarn, false)

  // Other senders are unaffected.
  assert.equal(limiter.check('b').allowed, true)

  // Time passes: the window has slid past the first two messages.
  now += 60_001
  assert.equal(limiter.check('a').allowed, true)
  // And a new burst past the cooldown warns again.
  assert.equal(limiter.check('a').allowed, true)
  assert.equal(limiter.check('a').allowed, true)
  const again = limiter.check('a')
  assert.equal(again.allowed, false)
  assert.equal(again.shouldWarn, true, `the notice returns after ${WARN_COOLDOWN_MS}ms`)
})

test('reset forgets one sender, and the default is a sane number', () => {
  const limiter = createSenderLimiter({ perMinute: 1 })
  assert.equal(limiter.check('a').allowed, true)
  assert.equal(limiter.check('a').allowed, false)
  limiter.reset('a')
  assert.equal(limiter.check('a').allowed, true)
  assert.ok(DEFAULT_PER_MINUTE >= 5)
  assert.equal(limiter.perMinute, 1)
})

test('a conversation queue is "full" at the cap, and never full when unbounded', () => {
  assert.equal(queueFull(0, 6), false)
  assert.equal(queueFull(5, 6), false)
  assert.equal(queueFull(6, 6), true)
  assert.equal(queueFull(99, 0), false, 'cap 0 means no cap')
})
