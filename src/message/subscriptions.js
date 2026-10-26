/**
 * Scheduled proactive messages: the bot itself speaks at a time the user set,
 * through its own side session — "每天 08:00 说早安" or "每周日 21:00 问问我这
 * 周过得怎么样".
 *
 * Storage is one JSON file per state root (`subscriptions.json`), guarded by
 * the same tolerant-read rules as the reminder store: a corrupted store must
 * never take the message loop down.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseWhen } from './scheduler.js'

export const MAX_SUBSCRIPTIONS_PER_ACCOUNT = 20
/** A slot missed by downtime fires only if it is this fresh; older ones skip. */
export const GRACE_MS = 30 * 60 * 1000
export const MAX_SUBSCRIPTION_PROMPT_CHARS = 500

const WEEKDAY_ALIASES = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 }
const WEEKDAY_NAMES = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' }

/**
 * Parse the time part of /subscribe. Recurring forms carry no date; a bare
 * `HH:mm` means every day. Anything else falls through to the one-shot
 * parser the reminders already use (durations, absolute date-times).
 *
 * @param {string} spec e.g. `每天 08:00`, `每周日 21:30`, `09:00`, `2h`, `2026-11-01 09:00`
 * @param {Date} [now]
 */
export function parseSubscriptionWhen(spec, now = new Date()) {
    const trimmed = String(spec ?? '').trim()
    const daily = /^(?:每天|每日|daily)\s+(\d{1,2}):(\d{2})$/i.exec(trimmed)
    if (daily !== null) return hhmm(daily[1], daily[2], { kind: 'daily' })
    const weekly = /^每周([一二三四五六日天])\s+(\d{1,2}):(\d{2})$/.exec(trimmed)
    if (weekly !== null) return hhmm(weekly[2], weekly[3], { kind: 'weekly', weekday: WEEKDAY_ALIASES[weekly[1]] })
    const bare = /^(\d{1,2}):(\d{2})$/.exec(trimmed)
    if (bare !== null) return hhmm(bare[1], bare[2], { kind: 'daily' })
    const once = parseWhen(trimmed, now)
    if (once.ok) return { ok: true, kind: 'once', fireAt: once.fireAt, label: once.label }
    return once
}

function hhmm(h, mi, extra) {
    const hour = Number(h)
    const minute = Number(mi)
    if (hour > 23 || minute > 59) return { ok: false, reason: '时间格式应为 HH:mm，例如 08:00' }
    return { ok: true, ...extra, time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` }
}

/**
 * The next epoch strictly after `fromMs` at which the item should fire.
 * Recurring only: `once` items keep their stored fireAt.
 */
export function nextFireAt(item, fromMs) {
    const [h, mi] = String(item.time ?? '00:00').split(':').map(Number)
    if (item.kind === 'weekly') {
        const from = new Date(fromMs)
        for (let day = 0; day < 8; day += 1) {
            const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + day, h, mi)
            if (candidate.getTime() > fromMs && weekdayOf(candidate) === item.weekday) return candidate.getTime()
        }
        return fromMs + 7 * 86_400_000
    }
    const target = new Date(fromMs)
    target.setHours(h, mi, 0, 0)
    if (target.getTime() <= fromMs) target.setDate(target.getDate() + 1)
    return target.getTime()
}

/** JS getDay() is 0-based Sunday-first; our weekday is ISO 1..7. */
function weekdayOf(date) {
    return date.getDay() === 0 ? 7 : date.getDay()
}

/** The human label shown in the confirmation and /subscribelist. */
export function describeSubscription(item) {
    if (item.kind === 'weekly') return `每周${WEEKDAY_NAMES[item.weekday] ?? '?'} ${item.time}`
    if (item.kind === 'daily') return `每天 ${item.time}`
    return formatStamp(item.fireAt)
}

export function formatStamp(ms) {
    const d = new Date(ms)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function storePath(stateRoot) {
    return path.join(stateRoot, 'subscriptions.json')
}

export function readSubscriptions(stateRoot, warn = () => {}) {
    let parsed
    try {
        parsed = JSON.parse(fs.readFileSync(storePath(stateRoot), 'utf8'))
    } catch (error) {
        if (error.code !== 'ENOENT') warn(`subscriptions.json unreadable, starting from an empty list: ${error.message}`)
        return { seq: 0, items: [] }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { seq: 0, items: [] }
    const items = Array.isArray(parsed.items) ? parsed.items.filter((item) => (
        typeof item?.id === 'string'
        && typeof item?.accountId === 'string'
        && typeof item?.conversationId === 'string'
        && typeof item?.prompt === 'string'
        && (item.kind === 'daily' || item.kind === 'weekly' || item.kind === 'once')
    )) : []
    return { seq: typeof parsed.seq === 'number' ? parsed.seq : items.length, items }
}

export function writeSubscriptions(stateRoot, store, warn = () => {}) {
    try {
        fs.writeFileSync(storePath(stateRoot), `${JSON.stringify(store, null, 2)}\n`)
    } catch (error) {
        warn(`subscriptions.json write failed: ${error.message}`)
    }
}

/**
 * Arm and persist timed proactive messages. Mirrors ReminderScheduler: timers
 * per item, store is the source of truth, a reload re-arms from disk.
 */
export class SubscriptionScheduler {
    /**
     * @param {object} options
     * @param {(item: object) => Promise<void> | void} options.fire sends the produced text; must not throw into the timer
     * @param {(message: string) => void} [options.warn]
     * @param {(ms: number, callback: () => void) => unknown} [options.setTimeoutRef] injectable for tests
     * @param {(timer: unknown) => void} [options.clearTimeoutRef] injectable for tests
     */
    constructor({ stateRoot, fire, warn = () => {}, setTimeoutRef = ((ms, cb) => setTimeout(cb, ms)), clearTimeoutRef = ((t) => clearTimeout(t)) }) {
        this.stateRoot = stateRoot
        this.fire = fire
        this.warn = warn
        this.setTimeoutRef = setTimeoutRef
        this.clearTimeoutRef = clearTimeoutRef
        this.store = readSubscriptions(stateRoot, warn)
        this.timers = new Map()
        this.stopped = false
        const now = Date.now()
        for (const item of this.store.items) this.#reconcile(item, now)
    }

    /**
     * A freshly loaded item whose slot has already passed: recurring items
     * advance (a slot missed by a restart still fires once when it is inside
     * the grace window); a stale one-shot is dropped — 不补发.
     */
    #reconcile(item, now) {
        if (item.kind === 'once') {
            if (item.fireAt > now) return this.#arm(item)
            this.warn(`subscription ${item.id} expired while stopped; dropped (once items are never replayed)`)
            this.#remove(item.id)
            writeSubscriptions(this.stateRoot, this.store, this.warn)
            return
        }
        // The stored fireAt is the evidence of the slot this item was armed
        // for: a restart that slept through it fires once when the slot is
        // still inside the grace window, otherwise the miss is skipped.
        if (item.fireAt <= now && now - item.fireAt <= GRACE_MS) {
            item.fireAt = nextFireAt(item, now)
            writeSubscriptions(this.stateRoot, this.store, this.warn)
            this.#arm({ ...item, fireAt: now })
            return
        }
        if (item.fireAt > now) {
            this.#arm(item)
            return
        }
        item.fireAt = nextFireAt(item, now)
        writeSubscriptions(this.stateRoot, this.store, this.warn)
        this.#arm(item)
    }

    /** Compute and store the item's next fire time, and arm it. */
    #advance(item, now) {
        if (item.kind === 'once') return
        const at = nextFireAt(item, now)
        item.fireAt = at
        writeSubscriptions(this.stateRoot, this.store, this.warn)
        this.#arm(item)
    }

    #arm(item) {
        if (this.stopped) return
        const delay = Math.max(0, item.fireAt - Date.now())
        this.timers.set(item.id, this.setTimeoutRef(delay, () => {
            this.timers.delete(item.id)
            void this.#trigger(item)
        }))
    }

    async #trigger(item) {
        if (this.stopped) return
        const snapshot = { ...item }
        const current = this.store.items.find((entry) => entry.id === item.id)
        if (current === undefined) return
        if (current.kind === 'once') this.#remove(current.id)
        else this.#advance(current, Date.now())
        current.lastFiredAt = Date.now()
        writeSubscriptions(this.stateRoot, this.store, this.warn)
        try {
            await this.fire(snapshot)
        } catch (error) {
            this.warn(`subscription ${snapshot.id} fire failed: ${error.message}`)
        }
    }

    /**
     * Store and arm a subscription.
     * @param {{ accountId: string, conversationId: string, prompt: string, when: object }} plan
     * @returns {object | { error: string }}
     */
    schedule(plan) {
        const prompt = String(plan.prompt ?? '').trim()
        if (prompt === '') return { error: '要定时说的话不能为空' }
        if (prompt.length > MAX_SUBSCRIPTION_PROMPT_CHARS) return { error: `主题太长（最多 ${MAX_SUBSCRIPTION_PROMPT_CHARS} 字）` }
        const when = plan.when
        if (!when?.ok) return { error: when?.reason ?? '时间看不懂' }
        const pending = this.store.items.filter((item) => item.accountId === plan.accountId)
        if (pending.length >= MAX_SUBSCRIPTIONS_PER_ACCOUNT) return { error: `这个账号的定时消息太多了（最多 ${MAX_SUBSCRIPTIONS_PER_ACCOUNT} 条），先用 /subscribelist 看，/subscribecancel 删掉一些` }
        const id = `s${++this.store.seq}`
        const item = {
            id,
            accountId: plan.accountId,
            conversationId: plan.conversationId,
            prompt,
            kind: when.kind,
            time: when.time,
            weekday: when.weekday,
            fireAt: when.kind === 'once' ? when.fireAt : nextFireAt({ kind: when.kind, time: when.time, weekday: when.weekday }, Date.now()),
            createdAt: Date.now(),
        }
        this.store.items.push(item)
        writeSubscriptions(this.stateRoot, this.store, this.warn)
        this.#arm(item)
        return item
    }

    /** Remove one subscription by id (as shown by /subscribelist). */
    cancel(id) {
        if (this.#remove(id)) {
            writeSubscriptions(this.stateRoot, this.store, this.warn)
            return true
        }
        return false
    }

    #remove(id) {
        const before = this.store.items.length
        this.store.items = this.store.items.filter((item) => item.id !== id)
        if (this.store.items.length === before) return false
        const timer = this.timers.get(id)
        if (timer !== undefined) {
            this.clearTimeoutRef(timer)
            this.timers.delete(id)
        }
        return true
    }

    /** Subscriptions, soonest first. Optionally narrowed to one account. */
    list(accountId) {
        const items = accountId === undefined ? [...this.store.items] : this.store.items.filter((item) => item.accountId === accountId)
        return items.sort((a, b) => (a.fireAt ?? Infinity) - (b.fireAt ?? Infinity))
    }

    /** Stop every timer. The store is untouched: a reload re-arms from disk. */
    stop() {
        this.stopped = true
        for (const timer of this.timers.values()) this.clearTimeoutRef(timer)
        this.timers.clear()
    }
}
