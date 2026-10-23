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
/** Length of the rolling window the ban threshold is measured over. */
export const DEFAULT_WINDOW_MS = 120_000
/**
 * Sends allowed inside one window before the pacer starts delaying.
 *
 * The measured line is "about twenty messages in a few minutes". Fifteen in
 * two minutes leaves headroom for the media and progress notes a busy
 * conversation adds on top, and is still fast enough that an ordinary reply
 * never waits: fifteen chunks of the 1500-character default is 22 500
 * characters of reply text.
 */
export const DEFAULT_WINDOW_MAX = 15
/** Failures in a row that arm the cooldown. */
const FAILURE_THRESHOLD = 3

/**
 * Sequential gate for outbound sends.
 *
 * `acquire()` resolves when the caller may send: it waits out the remainder
 * of the interval since the previous send, waits out a rolling-window budget
 * that is close to the measured ban line, and during a cooldown it waits
 * (once, at the front of the queue) until the cooldown ends. Callers report
 * the outcome afterwards with {@link noteSuccess}/{@link noteFailure} so the
 * failure counter tracks reality even when sends are interleaved.
 */
export class OutboundPacer {
	/**
	 * @param {{ minIntervalMs?: number, cooldownMs?: number, windowMs?: number, windowMax?: number, log?: (line: string) => void, warn?: (line: string) => void, now?: () => number, sleep?: (ms: number) => Promise<void> }} [options]
	 *   `now`/`sleep` are seams for tests; production uses the clock.
	 */
	constructor(options = {}) {
		this.minIntervalMs = positiveOr(options.minIntervalMs, DEFAULT_SEND_INTERVAL_MS)
		this.cooldownMs = positiveOr(options.cooldownMs, DEFAULT_COOLDOWN_MS)
		this.windowMs = positiveOr(options.windowMs, DEFAULT_WINDOW_MS)
		this.windowMax = positiveOr(options.windowMax, DEFAULT_WINDOW_MAX)
		this.log = options.log ?? (() => {})
		this.warn = options.warn ?? (() => {})
		this.now = options.now ?? (() => Date.now())
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
		this.lastSendAt = -Infinity
		this.consecutiveFailures = 0
		this.cooldownUntil = 0
		/** Send timestamps still inside the rolling window, oldest first. */
		this.windowTimes = []
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
		// Rolling-window budget. The interval alone bounds the rate only as long
		// as a reply is short: twenty chunks at the 1200ms floor still fit in
		// 24s, which is exactly the burst the measured ban punishes. Once the
		// window is full, wait until the oldest send ages out rather than
		// dropping anything — the pacer delays, it never discards.
		this.#pruneWindow()
		if (this.windowTimes.length >= this.windowMax) {
			const wait = this.windowTimes[0] + this.windowMs - this.now()
			if (wait > 0) {
				this.warn(`outbound send window is full (${this.windowTimes.length} sends in ${Math.round(this.windowMs / 1000)}s); waiting ${Math.ceil(wait / 1000)}s to stay under the send-ban threshold`)
				await this.sleep(wait)
			}
			this.#pruneWindow()
		}
		const inCooldown = this.cooldownUntil - this.now()
		if (inCooldown > 0) {
			this.warn(`outbound send cooldown active for another ${Math.ceil(inCooldown / 1000)}s; waiting instead of sending into a throttled session`)
			await this.sleep(inCooldown)
		}
		this.lastSendAt = this.now()
		this.windowTimes.push(this.lastSendAt)
	}

	/** Drop sends that have aged out of the window; the array stays small. */
	#pruneWindow() {
		const cutoff = this.now() - this.windowMs
		// Timestamps are non-decreasing, so a single scan is enough.
		let first = 0
		while (first < this.windowTimes.length && this.windowTimes[first] <= cutoff) first += 1
		if (first > 0) this.windowTimes = this.windowTimes.slice(first)
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
