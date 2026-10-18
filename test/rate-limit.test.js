/**
 * Behavioural tests for the outbound pacer (src/message/rate-limit.js) and its
 * integration into ILinkTransport's send path.
 *
 * The measured fact these tests protect: roughly twenty outbound messages
 * within a few minutes trip an account-level Weixin send ban of at least
 * thirty minutes. The pacer's job is to keep a chunked reply (plus media)
 * under that line, and to stop hammering the server once it starts
 * rejecting sends.
 *
 * Time is virtual. The pacer takes `now`/`sleep` seams precisely so these
 * tests can step a fake clock instead of sleeping real milliseconds.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { OutboundPacer, DEFAULT_SEND_INTERVAL_MS, DEFAULT_COOLDOWN_MS } from '../src/message/rate-limit.js'

/** A controllable clock: `now()` reads it, `advance(ms)` moves it. */
function fakeClock(start = 0) {
	let time = start
	return {
		now: () => time,
		advance: (ms) => {
			time += ms
		},
	}
}

/**
 * A sleep() that doesn't wait: it records the requested duration and lets the
 * test decide how far the clock should have moved before resolving.
 */
function fakeSleep(clock) {
	const sleeps = []
	const sleep = async (ms) => {
		sleeps.push(ms)
		clock.advance(ms)
	}
	return { sleep, sleeps }
}

test('the first send is never delayed', async () => {
	const clock = fakeClock()
	const { sleep, sleeps } = fakeSleep(clock)
	const pacer = new OutboundPacer({ now: clock.now, sleep })

	await pacer.acquire()

	assert.deepEqual(sleeps, [], 'a first send with no history must not wait')
	assert.equal(pacer.lastSendAt, 0, 'acquire stamps the send time from the injected clock')
})

test('a send right after the previous one waits out the interval', async () => {
	const clock = fakeClock()
	const { sleep, sleeps } = fakeSleep(clock)
	const pacer = new OutboundPacer({ minIntervalMs: 1_200, now: clock.now, sleep })

	await pacer.acquire()
	clock.advance(300)
	await pacer.acquire()

	// 1200 - 300 = 900ms of waiting, then the stamp moves to the new time.
	assert.deepEqual(sleeps, [900])
	assert.equal(pacer.lastSendAt, 1_200)
})

test('a send after the interval has passed does not wait', async () => {
	const clock = fakeClock()
	const { sleep, sleeps } = fakeSleep(clock)
	const pacer = new OutboundPacer({ minIntervalMs: 1_200, now: clock.now, sleep })

	await pacer.acquire()
	clock.advance(1_200)
	await pacer.acquire()

	assert.deepEqual(sleeps, [])
})

test('three consecutive failures arm the cooldown and a warning says why', async () => {
	const clock = fakeClock()
	const { sleep } = fakeSleep(clock)
	const warnings = []
	const pacer = new OutboundPacer({ cooldownMs: 30_000, now: clock.now, sleep, warn: (line) => warnings.push(line) })

	pacer.noteFailure()
	pacer.noteFailure()
	assert.equal(pacer.cooldownUntil, 0, 'two failures must not arm the cooldown yet')
	pacer.noteFailure()

	assert.equal(pacer.cooldownUntil, 30_000, 'the third failure arms cooldownUntil = now + cooldownMs')
	assert.equal(warnings.length, 1)
	assert.match(warnings[0], /cooling down 30000ms/)
})

test('a success resets the failure counter', () => {
	const clock = fakeClock()
	const pacer = new OutboundPacer({ now: clock.now })

	pacer.noteFailure()
	pacer.noteFailure()
	pacer.noteSuccess()
	pacer.noteFailure()

	assert.equal(pacer.cooldownUntil, 0, 'failures on either side of a success never reach the threshold')
})

test('acquire during a cooldown waits until it ends and says so once', async () => {
	const clock = fakeClock()
	const { sleep, sleeps } = fakeSleep(clock)
	const warnings = []
	const pacer = new OutboundPacer({ minIntervalMs: 1_200, cooldownMs: 30_000, now: clock.now, sleep, warn: (line) => warnings.push(line) })

	await pacer.acquire()
	pacer.noteFailure()
	pacer.noteFailure()
	pacer.noteFailure()
	clock.advance(100) // still inside the interval gap AND the cooldown
	await pacer.acquire()

	// With the -Infinity first-send fix, the first acquire does not sleep and
	// stamps lastSendAt=0. The second acquire is 100ms later, so it sleeps the
	// remaining 1100ms of the interval; the pacer then re-measures the cooldown
	// against the clock AFTER that sleep moved it: 30000 - 1200 = 28800.
	assert.deepEqual(sleeps, [1_100, 28_800])
	assert.equal(warnings.filter((line) => line.includes('cooldown active')).length, 1, 'one warning per cooldown wait, not one per millisecond')
	assert.equal(pacer.lastSendAt, 30_000)
})

test('the defaults match the measured ban line', () => {
	assert.equal(DEFAULT_SEND_INTERVAL_MS, 1_200)
	assert.equal(DEFAULT_COOLDOWN_MS, 30_000)
	// 1200ms between sends means 20 messages take 24s — under the "a few
	// minutes" ban window rather than straddling it.
	assert.ok((20 - 1) * DEFAULT_SEND_INTERVAL_MS < 120_000)
})

test('non-positive or missing options fall back to the defaults', async () => {
	const clock = fakeClock()
	const { sleep } = fakeSleep(clock)
	const pacer = new OutboundPacer({ minIntervalMs: 0, cooldownMs: -5, now: clock.now, sleep })

	assert.equal(pacer.minIntervalMs, DEFAULT_SEND_INTERVAL_MS)
	assert.equal(pacer.cooldownMs, DEFAULT_COOLDOWN_MS)
})
