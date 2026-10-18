import fs from 'node:fs'
import path from 'node:path'

/**
 * Durable scheduled messages: `/remind <when> <text>` stores a reminder, a
 * timer fires it, and a restart re-arms the surviving ones.
 *
 * The store lives in the plugin state dir (`reminders.json`), not memory, for
 * the same reason the session lines do: the DSH host is reloaded far more
 * often than a reminder fires, and a reminder that dies with the process is a
 * reminder the user asked for and never received.
 *
 * Fired reminders are deleted, not marked: a reminder.json that only ever
 * grows punishes every read, and "history of what I reminded myself" is what
 * the Weixin chat transcript already is.
 */

/** Largest text a reminder may carry, mirroring the chunker's headroom. */
export const MAX_REMINDER_TEXT_CHARS = 2000

/** How many pending reminders one account may hold. */
export const MAX_PENDING_PER_ACCOUNT = 50

/** Far-future cap: a reminder more than 366 days out is almost surely a typo. */
export const MAX_DELAY_MS = 366 * 24 * 60 * 60 * 1000

/**
 * Parse a `/remind` time spec. Supported forms, in the order they are tried:
 *
 *  - `10m` / `2h` / `1d30m` — a duration from now
 *  - `HH:mm` — today, or tomorrow when the time has already passed
 *  - `YYYY-MM-DD HH:mm` — an explicit local date and time
 *
 * Times are wall-clock in the host's local zone: the person typing the
 * reminder reads the same clock as the host, and storing UTC instants for a
 * "9:00 tomorrow" request would survive a DST shift incorrectly.
 *
 * @param {string} spec
 * @param {Date} [now]
 * @returns {{ ok: true, fireAt: number, label: string } | { ok: false, reason: string }}
 */
export function parseWhen(spec, now = new Date()) {
  const trimmed = String(spec ?? '').trim()
  if (trimmed === '') return { ok: false, reason: '缺少时间：/remind 10m 内容 / /remind 14:30 内容 / /remind 2026-10-19 09:00 内容' }

  // 1. Pure duration: `1d30m`-style run-together units, smallest to largest.
  const duration = parseDuration(trimmed)
  if (duration !== undefined) {
    if (duration <= 0) return { ok: false, reason: '时间必须是未来的某个时刻' }
    if (duration > MAX_DELAY_MS) return { ok: false, reason: '定得太远：最多支持一年以内' }
    return { ok: true, fireAt: now.getTime() + duration, label: formatLabel(new Date(now.getTime() + duration)) }
  }

  // 2. Explicit date + time: `2026-10-19 09:00`.
  const absolute = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(trimmed)
  if (absolute !== null) {
    const [y, mo, d, h, mi] = absolute.slice(1).map(Number)
    const target = new Date(y, mo - 1, d, h, mi)
    if (Number.isNaN(target.getTime()) || target.getDate() !== d || target.getMonth() !== mo - 1) {
      return { ok: false, reason: '日期或时间不存在，请检查' }
    }
    if (target.getTime() <= now.getTime()) return { ok: false, reason: '那个时刻已经过去了' }
    return { ok: true, fireAt: target.getTime(), label: formatLabel(target) }
  }

  // 3. Time of day: `09:00` or `9:05`. Today when still ahead, else tomorrow.
  const timeOfDay = /^(\d{1,2}):(\d{2})$/.exec(trimmed)
  if (timeOfDay !== null) {
    const h = Number(timeOfDay[1])
    const mi = Number(timeOfDay[2])
    if (h > 23 || mi > 59) return { ok: false, reason: '时间格式应为 HH:mm，例如 09:30' }
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi)
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
    return { ok: true, fireAt: target.getTime(), label: formatLabel(target) }
  }

  return { ok: false, reason: '看不懂这个时间：支持 10m / 2h / 1d30m、14:30、2026-10-19 09:00' }
}

/**
 * Parse a run-together duration like `10m`, `2h`, `1d30m`, `90s`.
 * @param {string} spec
 * @returns {number | undefined} milliseconds, or undefined when the spec is not a duration
 */
function parseDuration(spec) {
  if (!/^\d+(?:[dhms]\d+)*[dhms]$/.test(spec)) return undefined
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  let total = 0
  for (const [, value, unit] of spec.matchAll(/(\d+)([dhms])/g)) total += Number(value) * unitMs[unit]
  return total
}

/** The human label attached to the confirmation line, in local time. */
function formatLabel(date) {
  const sameDay = new Date().toDateString() === date.toDateString()
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (sameDay) return `今天 ${time}`
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${time}`
}

/**
 * Read the persisted reminder list. A missing or mangled file is an empty
 * list, not an error: reminders are conveniences, and a corrupted store must
 * never take the whole account loop down.
 *
 * @param {string} stateRoot plugin state directory
 * @returns {{ seq: number, items: Reminder[] }}
 */
export function readReminders(stateRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateRoot, 'reminders.json'), 'utf8'))
    if (raw !== null && typeof raw === 'object' && Number.isFinite(raw.seq) && Array.isArray(raw.items)) return raw
  } catch {
    // first run, or a truncated write — start over
  }
  return { seq: 0, items: [] }
}

/**
 * Persist the reminder list atomically (tmp file + rename, the same shape the
 * registry uses), so a crash mid-write cannot lose every reminder.
 *
 * @param {string} stateRoot
 * @param {{ seq: number, items: Reminder[] }} store
 */
export function writeReminders(stateRoot, store, warn = () => {}) {
  try {
    fs.mkdirSync(stateRoot, { recursive: true })
    const file = path.join(stateRoot, 'reminders.json')
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
    fs.renameSync(tmp, file)
  } catch (error) {
    warn(`writing reminders.json failed: ${String(error?.message ?? error)}`)
  }
}

/**
 * @typedef {{ id: string, accountId: string, conversationId: string,
 *   text: string, fireAt: number, createdAt: string }} Reminder
 */

/**
 * The live scheduler: owns timers for one process, persists every change, and
 * re-arms from disk on construction (a restart re-arms pending reminders;
 * ones whose moment passed while the host was down fire immediately — a late
 * reminder is strictly better than a silently dropped one).
 */
export class ReminderScheduler {
  /**
   * @param {object} options
   * @param {string} options.stateRoot
   * @param {(reminder: Reminder) => Promise<void> | void} options.fire sends the text; must not throw into the timer
   * @param {(message: string) => void} [options.warn]
   * @param {(ms: number, callback: () => void) => unknown} [options.setTimeout] injectable for tests
   * @param {(timer: unknown) => void} [options.clearTimeout] injectable for tests
   */
  constructor({ stateRoot, fire, warn = () => {}, setTimeoutRef = ((ms, cb) => setTimeout(cb, ms)), clearTimeoutRef = ((t) => clearTimeout(t)) }) {
    this.stateRoot = stateRoot
    this.fire = fire
    this.warn = warn
    this.setTimeoutRef = setTimeoutRef
    this.clearTimeoutRef = clearTimeoutRef
    /** @type {Map<string, unknown>} reminder id -> timer handle */
    this.timers = new Map()
    this.store = readReminders(stateRoot)
    this.stopped = false
    for (const reminder of this.store.items) this.#arm(reminder)
  }

  /**
   * Store and arm a reminder.
   *
   * @param {{ accountId: string, conversationId: string, text: string, fireAt: number }} plan
   * @returns {Reminder | { error: string }}
   */
  schedule(plan) {
    const text = String(plan.text ?? '').trim()
    if (text === '') return { error: '提醒内容不能为空' }
    if (text.length > MAX_REMINDER_TEXT_CHARS) return { error: `提醒内容太长（最多 ${MAX_REMINDER_TEXT_CHARS} 字）` }
    const pending = this.store.items.filter((item) => item.accountId === plan.accountId)
    if (pending.length >= MAX_PENDING_PER_ACCOUNT) return { error: `这个账号的待发提醒太多了（最多 ${MAX_PENDING_PER_ACCOUNT} 条），先用 /remindlist 看，/remindcancel 删掉一些` }
    const id = `r${++this.store.seq}`
    const reminder = { id, accountId: plan.accountId, conversationId: plan.conversationId, text, fireAt: plan.fireAt, createdAt: new Date().toISOString() }
    this.store.items.push(reminder)
    writeReminders(this.stateRoot, this.store, this.warn)
    this.#arm(reminder)
    return reminder
  }

  /**
   * Remove one pending reminder by id (as shown by /remindlist).
   * @returns {boolean} whether an item was actually removed
   */
  cancel(id) {
    const before = this.store.items.length
    this.store.items = this.store.items.filter((item) => item.id !== id)
    if (this.store.items.length === before) return false
    writeReminders(this.stateRoot, this.store, this.warn)
    const timer = this.timers.get(id)
    if (timer !== undefined) {
      this.clearTimeoutRef(timer)
      this.timers.delete(id)
    }
    return true
  }

  /**
   * Pending reminders, soonest first. Optionally narrowed to one account.
   * @returns {Reminder[]}
   */
  list(accountId) {
    const items = accountId === undefined ? [...this.store.items] : this.store.items.filter((item) => item.accountId === accountId)
    return items.sort((a, b) => a.fireAt - b.fireAt)
  }

  /** Stop every timer. The store is untouched: a reload re-arms from disk. */
  stop() {
    this.stopped = true
    for (const timer of this.timers.values()) this.clearTimeoutRef(timer)
    this.timers.clear()
  }

  /**
   * Arm one reminder's timer. Overdue ones fire right away rather than being
   * dropped: the host was probably down or reloading when their moment
   * passed, and the user asked for the message, not for its punctuality.
   */
  #arm(reminder) {
    if (this.stopped) return
    const delay = Math.max(0, reminder.fireAt - Date.now())
    const timer = this.setTimeoutRef(delay, () => {
      this.timers.delete(reminder.id)
      this.store.items = this.store.items.filter((item) => item.id !== reminder.id)
      writeReminders(this.stateRoot, this.store, this.warn)
      // The send must never throw into the timer callback: a transport hiccup
      // would otherwise leave the other timers unstarted for this tick.
      Promise.resolve()
        .then(() => this.fire(reminder))
        .catch((error) => this.warn(`reminder ${reminder.id} send failed: ${String(error?.message ?? error)}`))
    })
    this.timers.set(reminder.id, timer)
  }
}
