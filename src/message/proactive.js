import fs from 'node:fs'
import path from 'node:path'
import { keyedStatePath } from '../state-layout.js'
import { atomicWriteJson } from '../atomic.js'
import { parseClockHHmm } from './quiet-hours.js'
import { formatStamp } from './subscriptions.js'

/**
 * 「先开口」 — the bot initiating a conversation.
 *
 * Every other outbound path in this plugin is a reply: something arrived, then
 * something goes out. This one starts from nothing, which is exactly why it
 * needs rules rather than a timer. The rules are:
 *
 *  - **off by default.** A chat tool that spontaneously messages you is a bug
 *    report waiting to happen unless the operator asked for it.
 *  - **companion modes only.** The stock `default` assistant stays silent; it
 *    is a tool, and a tool does not text you.
 *  - **a window** (default 09:00–23:00), because a 3 a.m. "你在干嘛" is what
 *    makes people uninstall things.
 *  - **a minimum gap** since the user's last message, plus **backoff**: every
 *    unanswered proactive message doubles the next gap, capped at a day. A bot
 *    that keeps talking into silence is the failure mode.
 *  - **a daily cap**, and a per-tick probability so the timing does not read
 *    like a cron job.
 *
 * The module is split into a pure decision function (`planProactive`) and a
 * thin scheduler around it, so every rule above is table-testable without
 * touching a clock or a disk.
 */

/** How often the scheduler wakes up. Cheap: a few small file reads. */
export const PROACTIVE_TICK_MS = 5 * 60_000
export const DEFAULT_MIN_GAP_MINUTES = 180
export const DEFAULT_MAX_PER_DAY = 3
export const DEFAULT_WINDOW_START = '09:00'
export const DEFAULT_WINDOW_END = '23:00'
/** Every unanswered proactive message multiplies the gap by this. */
export const BACKOFF_FACTOR = 2
/** …but never waits longer than a day. */
export const MAX_BACKOFF_MS = 24 * 60 * 60_000
/** Probability that a tick which passes every rule actually speaks. */
export const DEFAULT_TICK_CHANCE = 0.35

function safeName(value) {
  const text = String(value ?? '').replace(/[^A-Za-z0-9@._-]/g, '_')
  return text === '' ? 'unknown' : text.slice(0, 120)
}

function dayString(now) {
  const d = new Date(now)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** Where one account's proactive bookkeeping lives. */
export function proactiveFilePath(stateRoot, accountId) {
  return keyedStatePath(stateRoot, 'memoryDir', `proactive-${safeName(accountId)}.json`)
}

/**
 * @returns {{ day: string, count: number, lastAt: number, misses: number, recent: string[] }}
 */
export function readProactiveState(stateRoot, accountId, { warn = () => {} } = {}) {
  const empty = { day: '', count: 0, lastAt: 0, misses: 0, recent: [] }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(proactiveFilePath(stateRoot, accountId), 'utf8'))
  } catch (error) {
    // No file is the normal first run; a corrupt one is a warning, and either
    // way an empty state means "nothing sent yet today", which is safe.
    if (error?.code !== 'ENOENT') warn(`could not read proactive state for ${accountId}: ${String(error)}`)
    return empty
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
  return {
    day: typeof parsed.day === 'string' ? parsed.day : '',
    count: Number.isFinite(parsed.count) && parsed.count > 0 ? Math.floor(parsed.count) : 0,
    lastAt: Number.isFinite(parsed.lastAt) && parsed.lastAt > 0 ? parsed.lastAt : 0,
    misses: Number.isFinite(parsed.misses) && parsed.misses > 0 ? Math.floor(parsed.misses) : 0,
    recent: Array.isArray(parsed.recent) ? parsed.recent.filter((line) => typeof line === 'string').slice(-5) : [],
  }
}

export function writeProactiveState(stateRoot, accountId, state, { warn = () => {} } = {}) {
  return atomicWriteJson(proactiveFilePath(stateRoot, accountId), { schemaVersion: 1, ...state }, {
    warn: (message) => warn(`could not write proactive state for ${accountId}: ${message}`),
  })
}

function minutesOf(value, fallback) {
  const parsed = parseClockHHmm(value)
  return parsed === null ? fallback : parsed
}

function windowOf(config) {
  const start = minutesOf(config.proactiveWindowStart, parseClockHHmm(DEFAULT_WINDOW_START))
  const end = minutesOf(config.proactiveWindowEnd, parseClockHHmm(DEFAULT_WINDOW_END))
  // A window that starts at or after it ends is unusable (unlike quiet hours,
  // which wrap midnight on purpose) — fall back rather than guess.
  return start < end ? { start, end } : { start: parseClockHHmm(DEFAULT_WINDOW_START), end: parseClockHHmm(DEFAULT_WINDOW_END) }
}

/**
 * Decide whether to speak right now.
 *
 * Returns `{ fire, reason, waitMs }`. `reason` is a short machine word that is
 * logged verbatim — "why is it silent?" must be answerable from the log.
 *
 * @param {object} params
 * @param {number} params.now
 * @param {{ day?: string, count?: number, lastAt?: number, misses?: number } | null} params.state
 * @param {number} [params.lastInboundAt]  When the user last said anything.
 * @param {object} [params.config]
 * @param {() => number} [params.rng]
 * @param {number} [params.tickChance]
 */
export function planProactive({ now, state, lastInboundAt, config = {}, rng = Math.random, tickChance = DEFAULT_TICK_CHANCE }) {
  if (config.proactiveEnabled !== true) return { fire: false, reason: 'disabled', waitMs: 0 }

  const minutesOfDay = (() => {
    const d = new Date(now)
    return d.getHours() * 60 + d.getMinutes()
  })()
  const window = windowOf(config)
  if (minutesOfDay < window.start || minutesOfDay >= window.end) {
    return { fire: false, reason: 'outside-window', waitMs: 0 }
  }

  const minGapMs = Math.max(1, Number(config.proactiveMinGapMinutes ?? DEFAULT_MIN_GAP_MINUTES)) * 60_000
  if (Number.isFinite(lastInboundAt) && lastInboundAt > 0) {
    const sinceInbound = now - lastInboundAt
    if (sinceInbound < minGapMs) {
      return { fire: false, reason: 'too-soon', waitMs: minGapMs - sinceInbound }
    }
  }

  const misses = Math.max(0, Number(state?.misses ?? 0))
  const backoffMs = Math.min(minGapMs * Math.pow(BACKOFF_FACTOR, misses), Math.max(minGapMs, MAX_BACKOFF_MS))
  const lastAt = Number(state?.lastAt ?? 0)
  if (lastAt > 0 && now - lastAt < backoffMs) {
    return { fire: false, reason: 'backoff', waitMs: backoffMs - (now - lastAt) }
  }

  const maxPerDay = Math.max(1, Number(config.proactiveMaxPerDay ?? DEFAULT_MAX_PER_DAY))
  const sentToday = state?.day === dayString(now) ? Number(state?.count ?? 0) : 0
  if (sentToday >= maxPerDay) return { fire: false, reason: 'daily-cap', waitMs: 0 }

  if (rng() > tickChance) return { fire: false, reason: 'tick-chance', waitMs: 0 }

  return { fire: true, reason: 'ok', waitMs: 0 }
}

/** How many hours since the user last wrote (for the prompt). */
export function hoursSince(lastInboundAt, now) {
  if (!Number.isFinite(lastInboundAt) || lastInboundAt <= 0) return null
  return Math.max(0, Math.round(((now - lastInboundAt) / 3_600_000) * 10) / 10)
}

/**
 * The scheduler: wake up, ask `planProactive`, and at most once per tick ask the
 * caller to produce one message.
 *
 * `candidates()` supplies the conversations worth speaking into — the caller
 * owns that knowledge (it needs the persona store and the memory files), and it
 * may return several; the first one that passes every rule wins.
 */
export class ProactiveScheduler {
  #stateRoot
  #candidates
  #fire
  #config
  #warn
  #now
  #rng
  #setTimeout
  #clearTimeout
  #tickMs
  #tickChance
  #timer
  #running
  #busy = new Set()

  constructor({
    stateRoot,
    candidates,
    fire,
    config = () => ({}),
    warn = () => {},
    now = () => Date.now(),
    rng = Math.random,
    setTimeoutRef = setTimeout,
    clearTimeoutRef = clearTimeout,
    tickMs = PROACTIVE_TICK_MS,
    tickChance = DEFAULT_TICK_CHANCE,
  }) {
    this.#stateRoot = stateRoot
    this.#candidates = candidates
    this.#fire = fire
    this.#config = config
    this.#warn = warn
    this.#now = now
    this.#rng = rng
    this.#setTimeout = setTimeoutRef
    this.#clearTimeout = clearTimeoutRef
    this.#tickMs = tickMs
    this.#tickChance = tickChance
    this.#timer = null
    this.#running = false
  }

  start() {
    if (this.#timer !== null) return
    this.#arm()
  }

  stop() {
    if (this.#timer !== null) this.#clearTimeout(this.#timer)
    this.#timer = null
  }

  #arm() {
    this.#timer = this.#setTimeout(() => {
      void this.tick().finally(() => {
        if (this.#timer !== null) this.#arm()
      })
    }, this.#tickMs)
    // Never hold the process open for a message that may be hours away.
    if (typeof this.#timer?.unref === 'function') this.#timer.unref()
  }

  /**
   * One pass. Returns `{ fired, reason }` so tests and the log can see the
   * decision without reading the store back.
   */
  async tick() {
    if (this.#running) return { fired: 0, reason: 'busy' }
    this.#running = true
    try {
      const config = this.#config() ?? {}
      if (config.proactiveEnabled !== true) return { fired: 0, reason: 'disabled' }

      const now = this.#now()
      // Remember why the last candidate was refused: "silent since Tuesday" is
      // only diagnosable when the log says which gate held it back.
      let lastReason = 'no-candidate'
      for (const candidate of this.#candidates() ?? []) {
        const { accountId, conversationId } = candidate
        if (this.#busy.has(conversationId)) continue
        const state = readProactiveState(this.#stateRoot, accountId, { warn: this.#warn })
        const plan = planProactive({
          now,
          state,
          lastInboundAt: candidate.lastInboundAt,
          config,
          rng: this.#rng,
          tickChance: this.#tickChance,
        })
        lastReason = plan.reason
        if (!plan.fire) continue

        this.#busy.add(conversationId)
        try {
          const text = await this.#fire(candidate, { now, state })
          if (typeof text !== 'string' || text.trim() === '') return { fired: 0, reason: 'empty' }
          this.recordSent(accountId, text, now)
          return { fired: 1, reason: 'sent' }
        } catch (error) {
          this.#warn(`proactive message failed for ${conversationId}: ${String(error)}`)
          // Count the miss anyway: a broken channel must not turn into a
          // retry storm every five minutes.
          this.recordSent(accountId, '', now)
          return { fired: 0, reason: 'failed' }
        } finally {
          this.#busy.delete(conversationId)
        }
      }
      return { fired: 0, reason: lastReason }
    } finally {
      this.#running = false
    }
  }

  /** Record that one message went out (and that it went unanswered, for now). */
  recordSent(accountId, text, now = this.#now()) {
    const state = readProactiveState(this.#stateRoot, accountId, { warn: this.#warn })
    const today = dayString(now)
    const count = state.day === today ? state.count + 1 : 1
    const recent = [...state.recent, String(text ?? '').slice(0, 200)].filter((line) => line !== '').slice(-5)
    writeProactiveState(this.#stateRoot, accountId, {
      day: today,
      count,
      lastAt: now,
      misses: state.misses + 1,
      recent,
    }, { warn: this.#warn })
  }

  /**
   * The user wrote back: reset the backoff.
   *
   * Reading the file on every inbound message is the price of keeping the
   * counters on disk (they must survive a restart); it is one small JSON read
   * on a path that already reads a persona store and a memory file.
   */
  noteInbound(accountId) {
    const state = readProactiveState(this.#stateRoot, accountId, { warn: this.#warn })
    if (state.misses === 0) return
    writeProactiveState(this.#stateRoot, accountId, { ...state, misses: 0 }, { warn: this.#warn })
  }

  /** For diagnostics: what the store says right now. */
  status(accountId) {
    return readProactiveState(this.#stateRoot, accountId, { warn: () => {} })
  }
}

/** One line for the log: "主动消息 3 小时后 (reason)". */
export function describePlan(plan) {
  if (plan.fire) return 'proactive message: yes'
  const wait = plan.waitMs > 0 ? `，约 ${Math.max(1, Math.round(plan.waitMs / 60_000))} 分钟后可以再说` : ''
  return `proactive message: no (${plan.reason}${wait})`
}

/** The stamp used in the prompt, kept identical to the /subscribe wording. */
export const promptStamp = formatStamp
