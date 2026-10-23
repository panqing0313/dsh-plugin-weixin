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
import { OutboundPacer, DEFAULT_SEND_INTERVAL_MS, DEFAULT_COOLDOWN_MS, DEFAULT_WINDOW_MS, DEFAULT_WINDOW_MAX } from '../src/message/rate-limit.js'

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

// ---------------------------------------------------------------------------
// Integration: the transport is the one place every outbound item passes
// through, so the pacer must be gated there and nowhere else. These tests
// inject a recording pacer and stub fetch: they assert the WIRING (acquire
// before, success/failure after), while the timing lives in the unit tests
// above. Without this half, the pacer is a tested module nobody calls.
// ---------------------------------------------------------------------------

/** A pacer that records the protocol instead of measuring time. */
function recordingPacer() {
	const calls = []
	return {
		calls,
		acquire: async () => {
			calls.push('acquire')
		},
		noteSuccess: () => {
			calls.push('success')
		},
		noteFailure: () => {
			calls.push('failure')
		},
	}
}

/** Run `body` with fetch stubbed to answer the iLink send endpoint. */
async function withStubbedSend(responseBody, body) {
	const original = globalThis.fetch
	globalThis.fetch = async () => new Response(JSON.stringify(responseBody), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})
	try {
		return await body()
	} finally {
		globalThis.fetch = original
	}
}

test('transport.send acquires the pacer before sending and reports success', async () => {
	const { ILinkTransport } = await import('../src/transport/ilink.js')
	const pacer = recordingPacer()
	const transport = new ILinkTransport({ accountId: 'acc', baseUrl: 'http://127.0.0.1:1', token: 'tok', pacer })

	await withStubbedSend({ ret: 0 }, () => transport.send({ conversationId: 'peer', text: 'hello' }))

	assert.deepEqual(pacer.calls, ['acquire', 'success'], 'every text send is gated, and its outcome reported')
})

test('a rejected send reports failure to the pacer and still throws', async () => {
	const { ILinkTransport } = await import('../src/transport/ilink.js')
	const pacer = recordingPacer()
	const transport = new ILinkTransport({ accountId: 'acc', baseUrl: 'http://127.0.0.1:1', token: 'tok', pacer })

	await assert.rejects(
		withStubbedSend({ ret: 1, errmsg: 'nope' }, () => transport.send({ conversationId: 'peer', text: 'hello' })),
		/sendMessage ret=1/,
		'a failed send must surface to the caller, not be swallowed by the pacer',
	)
	assert.deepEqual(pacer.calls, ['acquire', 'failure'], 'the failure counter sees every rejected send')
})

test('transport.sendMedia is gated by the same pacer as text', async () => {
	const { ILinkTransport } = await import('../src/transport/ilink.js')
	const pacer = recordingPacer()
	const transport = new ILinkTransport({ accountId: 'acc', baseUrl: 'http://127.0.0.1:1', token: 'tok', pacer })

	// A missing file fails inside the media layer before any upload; what is
	// asserted is that the gate ran and the failure was reported, because media
	// is the heavier half of a reply and must count toward the ban threshold.
	await assert.rejects(transport.sendMedia({ filePath: '/nonexistent/x.png', conversationId: 'peer' }))
	assert.deepEqual(pacer.calls, ['acquire', 'failure'])
})

test('the transport builds its pacer from the configured interval and cooldown', async () => {
	const { ILinkTransport } = await import('../src/transport/ilink.js')
	const transport = new ILinkTransport({
		accountId: 'acc',
		baseUrl: 'http://127.0.0.1:1',
		token: 'tok',
		sendIntervalMs: 5,
		sendCooldownMs: 7,
	})

	assert.equal(transport.pacer.minIntervalMs, 5, 'sendIntervalMs reaches the pacer')
	assert.equal(transport.pacer.cooldownMs, 7, 'sendCooldownMs reaches the pacer')
})

test('an unpaced transport falls back to the measured defaults', async () => {
	const { ILinkTransport } = await import('../src/transport/ilink.js')
	const transport = new ILinkTransport({ accountId: 'acc', baseUrl: 'http://127.0.0.1:1', token: 'tok' })

	assert.equal(transport.pacer.minIntervalMs, DEFAULT_SEND_INTERVAL_MS)
	assert.equal(transport.pacer.cooldownMs, DEFAULT_COOLDOWN_MS)
})

// ---------------------------------------------------------------------------
// Rolling-window budget: the interval bounds the rate only for short replies.
// Twenty chunks at the 1200ms floor still go out inside 24s — the exact burst
// the measured ban punishes — so the pacer also caps how many sends fit in a
// window and delays past that instead of dropping anything.
// ---------------------------------------------------------------------------

test('a full window delays the next send until the oldest one ages out', async () => {
	const clock = fakeClock()
	const { sleep, sleeps } = fakeSleep(clock)
	const warnings = []
	const pacer = new OutboundPacer({
		minIntervalMs: 1_000,
		windowMs: 10_000,
		windowMax: 2,
		now: clock.now,
		sleep,
		warn: (line) => warnings.push(line),
	})

	await pacer.acquire() // t=0
	clock.advance(1_000)
	await pacer.acquire() // t=1000, window now holds two sends
	clock.advance(1_000)
	await pacer.acquire() // t=2000: full, so wait until t=10000

	// 10000 - 2000 = 8000ms of waiting, and only the interval sleep before it.
	assert.deepEqual(sleeps, [8_000])
	assert.equal(pacer.windowTimes.length, 2, 'the aged-out send left the window and the new one joined it')
	assert.match(warnings[0], /window is full \(2 sends in 10s\)/)
})

test('sends older than the window do not count against it', async () => {
	const clock = fakeClock()
	const { sleep, sleeps } = fakeSleep(clock)
	const pacer = new OutboundPacer({ minIntervalMs: 1_000, windowMs: 10_000, windowMax: 2, now: clock.now, sleep })

	await pacer.acquire()
	clock.advance(10_000) // the first send is now outside the window
	await pacer.acquire()
	clock.advance(10_000)
	await pacer.acquire()

	assert.deepEqual(sleeps, [], 'every send arrived after the window had room again')
})

test('a failure does not consume window budget', async () => {
	const clock = fakeClock()
	const { sleep } = fakeSleep(clock)
	const pacer = new OutboundPacer({ minIntervalMs: 1_000, windowMs: 10_000, windowMax: 2, now: clock.now, sleep })

	await pacer.acquire()
	pacer.noteFailure()
	pacer.noteFailure()
	pacer.noteFailure()
	// The cooldown that the third failure armed is the thing that must not be
	// mistaken for window occupancy: the window still holds exactly one send.
	assert.equal(pacer.windowTimes.length, 1)
})

test('the window defaults keep a chunked reply under the ban line', () => {
	assert.equal(DEFAULT_WINDOW_MAX, 15)
	assert.equal(DEFAULT_WINDOW_MS, 120_000)
	const clock = fakeClock()
	const pacer = new OutboundPacer({ now: clock.now, sleep: async () => {} })
	assert.equal(pacer.windowMax, DEFAULT_WINDOW_MAX)
	assert.equal(pacer.windowMs, DEFAULT_WINDOW_MS)
})
