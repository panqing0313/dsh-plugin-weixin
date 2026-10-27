/**
 * Per-sender rate limiting.
 *
 * The existing limiter is account-wide: it protects the Weixin account from a
 * ban, but nothing protects the plugin from one person. One sender can send
 * thirty messages into a running turn, each of which becomes a queued turn (a
 * paid model call), and a stalled conversation chain means the queue keeps
 * growing while the token bill grows with it.
 *
 * This is a sliding-window counter per sender. It is deliberately coarse: the
 * goal is "one person cannot monopolise the bot", not a fair-share scheduler. A
 * refused message is answered once per window (silence would look like a bug),
 * and the refusal is written to the audit trail so it is visible after the fact.
 *
 * @module dsh-weixin/message/sender-limit
 */

/** Defaults: 20 messages per minute per sender, 6 turns ahead at most. */
export const DEFAULT_PER_MINUTE = 20
export const DEFAULT_MAX_QUEUE = 6
/** How long a "too fast" notice stays quiet for that sender. */
export const WARN_COOLDOWN_MS = 60_000

const WINDOW_MS = 60_000

/**
 * @param {{ perMinute?: number, warnCooldownMs?: number, now?: () => number }} [options]
 */
export function createSenderLimiter(options = {}) {
  const perMinute = Math.max(1, Number(options.perMinute ?? DEFAULT_PER_MINUTE))
  const warnCooldownMs = Number(options.warnCooldownMs ?? WARN_COOLDOWN_MS)
  const now = options.now ?? (() => Date.now())
  /** @type {Map<string, number[]>} sender → timestamps inside the window */
  const hits = new Map()
  /** @type {Map<string, number>} sender → when we last told them to slow down */
  const warned = new Map()

  /**
   * Record one message and say whether it may be handled.
   *
   * @param {string} key sender id (or any stable per-sender key)
   * @returns {{ allowed: boolean, shouldWarn: boolean, retryAfterMs: number, recent: number }}
   */
  const check = (key) => {
    const at = now()
    const cutoff = at - WINDOW_MS
    const list = (hits.get(key) ?? []).filter((stamp) => stamp > cutoff)
    if (list.length >= perMinute) {
      const oldest = list[0] ?? at
      const retryAfterMs = Math.max(0, oldest + WINDOW_MS - at)
      const lastWarn = warned.get(key) ?? 0
      const shouldWarn = at - lastWarn >= warnCooldownMs
      if (shouldWarn) warned.set(key, at)
      hits.set(key, list)
      return { allowed: false, shouldWarn, retryAfterMs, recent: list.length }
    }
    list.push(at)
    hits.set(key, list)
    return { allowed: true, shouldWarn: false, retryAfterMs: 0, recent: list.length }
  }

  /** Forget one sender (tests, or after a long silence). */
  const reset = (key) => {
    hits.delete(key)
    warned.delete(key)
  }

  return { check, reset, perMinute }
}

/**
 * Decide whether a conversation's queue is full.
 *
 * The queue is the per-conversation promise chain: a message dispatched while
 * another turn is running waits for it. Above the cap the honest answer is to
 * refuse the new one and say so — accepting it would just mean paying for a
 * reply the user has already forgotten about by the time it arrives.
 *
 * @param {number} inflight how many turns are queued/running for this conversation
 * @param {number} cap
 */
export function queueFull(inflight, cap) {
  return Number.isFinite(cap) && cap > 0 && inflight >= cap
}
