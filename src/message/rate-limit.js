/**
 * Outbound pacing for the Weixin bot API.
 *
 * The send-side lesson this module encodes is measured, not hypothetical:
 * roughly twenty messages within a few minutes trip an account-level send
 * ban that lasts at least thirty minutes. A single agent reply is chunked
 * into several `sendmessage` calls, media adds more, and a busy conversation
 * can push the burst over that line with no malice at all.
 *
 * The pacer is a floor on the interval between consecutive outbound sends
 * (token-bucket shape with a bucket of one: every send waits until
 * `minIntervalMs` has passed since the previous one) plus a cooldown after
 * consecutive failures — once the server starts rejecting sends, hammering
 * it again immediately is exactly the behaviour that escalates a temporary
 * rejection into a ban.
 *
 * Everything here is best-effort protection, not a contract: the server may
 * still throttle, and the pacer never drops a message — it only delays.
 *
 * @module dsh-weixin/message/rate-limit
 */

/** Default floor between two outbound sends, in milliseconds. */
export const DEFAULT_SEND_INTERVAL_MS = 1_200
/** Default cooldown after consecutive send failures. */
export const DEFAULT_COOLDOWN_MS = 30_000
/** Failures in a row that arm the cooldown. */
const FAILURE_THRESHOLD = 3

/**
 * Sequential gate for outbound sends.
 *
 * `acquire()` resolves when the caller may send: it waits out the remainder
 * of the interval since the previous send, and during a cooldown it waits
 * (once, at the front of the queue) until the cooldown ends. Callers report
 * the outcome afterwards with {@link noteSuccess}/{@link noteFailure} so the
 * failure counter tracks reality even when sends are interleaved.
 */
export class OutboundPacer {
	/**
	 * @param {{ minIntervalMs?: number, cooldownMs?: number, log?: (line: string) => void, warn?: (line: string) => void, now?: () => number, sleep?: (ms: number) => Promise<void> }} [options]
	 *   `now`/`sleep` are seams for tests; production uses the clock.
	 */
	constructor(options = {}) {
		this.minIntervalMs = positiveOr(options.minIntervalMs, DEFAULT_SEND_INTERVAL_MS)
		this.cooldownMs = positiveOr(options.cooldownMs, DEFAULT_COOLDOWN_MS)
		this.log = options.log ?? (() => {})
		this.warn = options.warn ?? (() => {})
		this.now = options.now ?? (() => Date.now())
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
		this.lastSendAt = -Infinity
		this.consecutiveFailures = 0
		this.cooldownUntil = 0
	}

	/**
	 * Wait until the next send is allowed. Serialized by the transport (one
	 * send at a time), so no internal queue is needed.
	 */
	async acquire() {
		const now = this.now()
		// `lastSendAt` starts at -Infinity so the very first send never waits:
		// with the 0 default, a fresh pacer at t=0 would compute gap=0 and
		// sleep a full interval before a message that has no history at all.
		const gap = now - this.lastSendAt
		if (gap >= 0 && gap < this.minIntervalMs) {
			await this.sleep(this.minIntervalMs - gap)
		}
		const inCooldown = this.cooldownUntil - this.now()
		if (inCooldown > 0) {
			this.warn(`outbound send cooldown active for another ${Math.ceil(inCooldown / 1000)}s; waiting instead of sending into a throttled session`)
			await this.sleep(inCooldown)
		}
		this.lastSendAt = this.now()
	}

	noteSuccess() {
		this.consecutiveFailures = 0
	}

	noteFailure() {
		this.consecutiveFailures += 1
		if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
			this.cooldownUntil = this.now() + this.cooldownMs
			this.consecutiveFailures = 0
			this.warn(`outbound sends failed ${FAILURE_THRESHOLD} times in a row; cooling down ${this.cooldownMs}ms to avoid escalating into a send ban`)
		}
	}
}

function positiveOr(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
