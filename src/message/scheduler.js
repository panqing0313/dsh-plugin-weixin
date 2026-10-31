import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from '../atomic.js'

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
 *  - `明天 9:00` / `后天下午3点半` / `下周一 10点` / `3小时后` — 中文口语
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

  // 4. Natural Chinese: `明天 9:00`, `后天下午3点半`, `下周一 10点`, `3小时后`.
  const natural = parseNaturalWhen(trimmed, now)
  if (natural !== undefined) return natural

  return { ok: false, reason: '看不懂这个时间：支持 10m / 2h / 1d30m、14:30、2026-10-19 09:00、明天 9:00、下周一 10:00、3小时后' }
}

const CN_DAY_OFFSET = { 今天: 0, 今晚: 0, 明天: 1, 明晚: 1, 后天: 2, 大后天: 3 }
const CN_WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }
const CN_PERIOD_PM = new Set(['下午', '傍晚', '晚上', '夜里'])
const CN_PERIOD_AM = new Set(['凌晨', '早上', '早晨', '上午'])

/**
 * 中文口语时间：`明天 9:00`、`后天下午3点半`、`下周一 10点`、`3小时后`。
 *
 * 只认「日期词 + 时钟」这一种组合，不做模糊猜测：`明天下午`（没有钟点）
 * 会明确要求补一个时间，而不是替用户选一个。`下周一` 永远指下一周，
 * `周一` 指本周（已过则报错），避免同一个词在不同日子有两种解释。
 *
 * @param {string} spec
 * @param {Date} now
 * @returns {{ ok: true, fireAt: number, label: string } | { ok: false, reason: string } | undefined}
 *   undefined 表示「不是这种写法」，交给调用方继续尝试其它格式。
 */
function parseNaturalWhen(spec, now) {
  const text = spec.replace(/\s+/g, ' ').trim()

  // `3小时后` / `30分钟后` / `半小时后` / `2天后`
  const relative = /^(\d+(?:\.\d+)?|半)\s*(分钟|分|小时|钟头|天)\s*后$/.exec(text)
  if (relative !== null) {
    const amount = relative[1] === '半' ? 0.5 : Number(relative[1])
    const unitMs = { 分钟: 60_000, 分: 60_000, 小时: 3_600_000, 钟头: 3_600_000, 天: 86_400_000 }
    const delay = Math.round(amount * unitMs[relative[2]])
    if (delay <= 0) return { ok: false, reason: '时间必须是未来的某个时刻' }
    if (delay > MAX_DELAY_MS) return { ok: false, reason: '定得太远：最多支持一年以内' }
    return { ok: true, fireAt: now.getTime() + delay, label: formatLabel(new Date(now.getTime() + delay)) }
  }

  let rest = text
  let day = null
  const dayMatch = /^(今天|今晚|明天|明晚|后天|大后天)/.exec(rest)
  if (dayMatch !== null) {
    day = { offset: CN_DAY_OFFSET[dayMatch[1]], evening: dayMatch[1].endsWith('晚') }
    rest = rest.slice(dayMatch[1].length).trim()
  } else {
    const week = /^(下|这|本)?(?:周|星期)([一二三四五六日天])/.exec(rest)
    if (week !== null) {
      day = { weekday: CN_WEEKDAY[week[2]], next: week[1] === '下' }
      rest = rest.slice(week[0].length).trim()
    }
  }

  let period = null
  const periodMatch = /^(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)/.exec(rest)
  if (periodMatch !== null) {
    period = periodMatch[1]
    rest = rest.slice(periodMatch[1].length).trim()
  }

  const clock = /^(\d{1,2})\s*(?:[:：点时])\s*(?:(\d{1,2})\s*分?|(半))?$/.exec(rest)
  if (clock === null) {
    if (day !== null || period !== null) return { ok: false, reason: '还需要一个钟点，例如 明天 9:00 / 下午 3 点半' }
    return undefined
  }

  let hour = Number(clock[1])
  const minute = clock[3] === '半' ? 30 : Number(clock[2] ?? 0)
  if (hour > 23 || minute > 59) return { ok: false, reason: '时间格式应为 9:00 或 9点半' }
  if (CN_PERIOD_PM.has(period) && hour < 12) hour += 12
  if (period === '中午' && hour < 11) hour += 12
  if (period === '凌晨' && hour === 12) hour = 0
  if (day?.evening === true && hour < 12) hour += 12
  if (CN_PERIOD_AM.has(period) && hour === 12) hour = 0

  const target = new Date(now)
  if (day?.offset !== undefined) {
    target.setDate(target.getDate() + day.offset)
  } else if (day?.weekday !== undefined) {
    let delta = (day.weekday - now.getDay() + 7) % 7
    if (day.next === true) delta += 7
    target.setDate(target.getDate() + delta)
  }
  target.setHours(hour, minute, 0, 0)

  if (day === null && target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  if (target.getTime() <= now.getTime()) return { ok: false, reason: '那个时刻已经过去了' }
  if (target.getTime() - now.getTime() > MAX_DELAY_MS) return { ok: false, reason: '定得太远：最多支持一年以内' }
  return { ok: true, fireAt: target.getTime(), label: formatLabel(target) }
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
 * 重复提醒：`每天 9:00`、`工作日 8:30`、`每周一 10点`。
 *
 * 重复与一次性分开解析：`parseWhen` 说的是「哪一刻」，这里说的是「每个周期
 * 的同一刻」。分开之后 `明天 9:00` 这种相对写法不会和重复混在一起，`/remind`
 * 只需要在候选前缀上先试重复、再试一次性，不需要在正则里穷举组合。
 *
 * @param {string} spec
 * @param {Date} [now]
 * @returns {{ ok: true, recurrence: { kind: 'daily' | 'weekdays' | 'weekly', weekday?: number }, hour: number, minute: number, fireAt: number, label: string } | { ok: false, reason: string }}
 */
export function parseRecurrence(spec, now = new Date()) {
  const text = String(spec ?? '').replace(/\s+/g, ' ').trim()
  const head = /^(每天|天天|每日|工作日|每个工作日|每周([一二三四五六日天]))\s*(.+)$/.exec(text)
  if (head === null) return { ok: false, reason: `「${text}」不是重复写法（每天 9:00 / 工作日 8:30 / 每周一 10点）` }
  const clock = /^(\d{1,2})\s*(?:[:：点时])\s*(?:(\d{1,2})\s*分?|(半))?$/.exec(head[3].trim())
  if (clock === null) return { ok: false, reason: `「${head[3].trim()}」不是钟点（例如 9:00、9点、9点半）` }
  const hour = Number(clock[1])
  const minute = clock[3] === '半' ? 30 : Number(clock[2] ?? 0)
  if (hour > 23 || minute > 59) return { ok: false, reason: '钟点超出范围（0–23 点，0–59 分）' }
  const kind = head[1].startsWith('每周') ? 'weekly' : (head[1].includes('工作日') ? 'weekdays' : 'daily')
  const recurrence = kind === 'weekly' ? { kind, weekday: CN_WEEKDAY[head[2]] } : { kind }
  return {
    ok: true,
    recurrence,
    hour,
    minute,
    fireAt: nextRecurrenceAt(recurrence, hour, minute, now.getTime()),
    label: recurrenceLabel(recurrence, hour, minute),
  }
}

/**
 * The first occurrence strictly after `afterMs` (the current slot, so a repeat
 * never re-fires the same minute).
 *
 * @param {{ kind: 'daily' | 'weekdays' | 'weekly', weekday?: number }} recurrence
 * @param {number} hour
 * @param {number} minute
 * @param {number} afterMs
 * @returns {number}
 */
export function nextRecurrenceAt(recurrence, hour, minute, afterMs) {
  const from = new Date(afterMs)
  for (let offset = 0; offset <= 14; offset += 1) {
    const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, hour, minute, 0, 0)
    if (candidate.getTime() <= afterMs) continue
    const day = candidate.getDay()
    if (recurrence.kind === 'weekly' && day !== recurrence.weekday) continue
    if (recurrence.kind === 'weekdays' && (day === 0 || day === 6)) continue
    return candidate.getTime()
  }
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7, hour, minute, 0, 0).getTime()
}

function recurrenceLabel(recurrence, hour, minute) {
  const at = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  if (recurrence.kind === 'weekly') return `每周${CN_WEEKDAY_NAME[recurrence.weekday]} ${at}`
  if (recurrence.kind === 'weekdays') return `工作日 ${at}`
  return `每天 ${at}`
}

const CN_WEEKDAY_NAME = { 0: '日', 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' }

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
    if (raw !== null && typeof raw === 'object' && Number.isFinite(raw.seq) && Array.isArray(raw.items)) {
      return { seq: raw.seq, items: raw.items }
    }
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
  atomicWriteJson(path.join(stateRoot, 'reminders.json'), { schemaVersion: 1, ...store }, {
    warn: (message) => warn(`writing reminders.json failed: ${message}`),
  })
}

/**
 * @typedef {{ id: string, accountId: string, conversationId: string,
 *   text: string, fireAt: number, createdAt: string,
 *   recurrence?: { kind: 'daily' | 'weekdays' | 'weekly', weekday?: number },
 *   recurrenceLabel?: string, hour?: number, minute?: number, scheduledFor?: number }} Reminder
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
  constructor({ stateRoot, fire, warn = () => {}, setTimeoutRef = ((ms, cb) => setTimeout(cb, ms)), clearTimeoutRef = ((t) => clearTimeout(t)), quiet = null }) {
    this.stateRoot = stateRoot
    this.fire = fire
    // Optional quiet-hours gate: (nowMs) => ms until the window ends, 0 when
    // the moment is not quiet. A slot landing inside the window is pushed to
    // the window's end — kept in the store, so a restart re-arms it.
    this.quiet = quiet
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
   * @param {{ accountId: string, conversationId: string, text: string, fireAt: number,
   *   recurrence?: { kind: 'daily' | 'weekdays' | 'weekly', weekday?: number },
   *   recurrenceLabel?: string, hour?: number, minute?: number }} plan
   * @returns {Reminder | { error: string }}
   */
  schedule(plan) {
    const text = String(plan.text ?? '').trim()
    if (text === '') return { error: '提醒内容不能为空' }
    if (text.length > MAX_REMINDER_TEXT_CHARS) return { error: `提醒内容太长（最多 ${MAX_REMINDER_TEXT_CHARS} 字）` }
    const pending = this.store.items.filter((item) => item.accountId === plan.accountId)
    if (pending.length >= MAX_PENDING_PER_ACCOUNT) return { error: `这个账号的待发提醒太多了（最多 ${MAX_PENDING_PER_ACCOUNT} 条），先用 /remindlist 看，/remindcancel 删掉一些` }
    const id = `r${++this.store.seq}`
    const reminder = {
      id,
      accountId: plan.accountId,
      conversationId: plan.conversationId,
      text,
      fireAt: plan.fireAt,
      createdAt: new Date().toISOString(),
      ...(plan.recurrence === undefined
        ? {}
        : {
            recurrence: plan.recurrence,
            recurrenceLabel: plan.recurrenceLabel ?? '',
            hour: plan.hour,
            minute: plan.minute,
            scheduledFor: plan.fireAt,
          }),
    }
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
   * Push the soonest pending reminder later by `minutes` (the `/snooze` command).
   * A recurring reminder shifts its `scheduledFor` too, so the next cycle is
   * counted from the snoozed moment instead of re-firing the skipped slot.
   *
   * @param {string} accountId
   * @param {number} minutes
   * @param {number} [now]
   * @returns {Reminder | undefined} the item, or undefined when nothing is pending
   */
  snooze(accountId, minutes, now = Date.now()) {
    const item = this.list(accountId)[0]
    if (item === undefined) return undefined
    const span = Math.max(1, Math.round(minutes)) * 60_000
    const timer = this.timers.get(item.id)
    if (timer !== undefined) {
      this.clearTimeoutRef(timer)
      this.timers.delete(item.id)
    }
    const base = Math.max(item.fireAt, now)
    item.fireAt = base + span
    if (item.recurrence !== undefined) item.scheduledFor = item.fireAt
    writeReminders(this.stateRoot, this.store, this.warn)
    this.#arm(item)
    return item
  }

  /**
   * Skip the next occurrence of the soonest recurring reminder (`/remind skip`).
   * One-off reminders are not skipped: dropping one is `cancel`.
   *
   * @param {string} accountId
   * @returns {Reminder | undefined} the item now pointing at the following slot
   */
  skipNext(accountId) {
    const item = this.list(accountId).find((entry) => entry.recurrence !== undefined)
    if (item === undefined) return undefined
    const base = item.scheduledFor ?? item.fireAt
    const next = nextRecurrenceAt(item.recurrence, Number(item.hour ?? 0), Number(item.minute ?? 0), base)
    const timer = this.timers.get(item.id)
    if (timer !== undefined) {
      this.clearTimeoutRef(timer)
      this.timers.delete(item.id)
    }
    item.scheduledFor = next
    item.fireAt = next
    writeReminders(this.stateRoot, this.store, this.warn)
    this.#arm(item)
    return item
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
      const quietMs = this.quiet === null ? 0 : this.quiet(Date.now(), reminder.accountId)
      if (quietMs > 0) {
        // 免打扰时段: the item was not removed yet — keep it in the store with
        // a pushed fireAt so it survives a restart, then re-arm for the end.
        reminder.fireAt = Date.now() + quietMs
        writeReminders(this.stateRoot, this.store, this.warn)
        this.warn(`免打扰时段，提醒 ${reminder.id} 推迟到 ${new Date(reminder.fireAt).toLocaleString('zh-CN', { hour12: false })} 发送`)
        this.#arm(reminder)
        return
      }
      if (reminder.recurrence !== undefined) {
        // A repeat is never removed: the slot it just fired is behind us, so the
        // store moves to the next occurrence and the timer re-arms for it. The
        // next slot is computed from `scheduledFor` (the intended moment), not
        // from a quiet-hours push, or a pushed reminder would skip a day.
        const slot = reminder.scheduledFor ?? reminder.fireAt
        const next = nextRecurrenceAt(reminder.recurrence, Number(reminder.hour ?? 0), Number(reminder.minute ?? 0), slot)
        reminder.scheduledFor = next
        reminder.fireAt = next
        writeReminders(this.stateRoot, this.store, this.warn)
        this.#arm(reminder)
      } else {
        this.store.items = this.store.items.filter((item) => item.id !== reminder.id)
        writeReminders(this.stateRoot, this.store, this.warn)
      }
      // The send must never throw into the timer callback: a transport hiccup
      // would otherwise leave the other timers unstarted for this tick.
      Promise.resolve()
        .then(() => this.fire(reminder))
        .catch((error) => this.warn(`reminder ${reminder.id} send failed: ${String(error?.message ?? error)}`))
    })
    this.timers.set(reminder.id, timer)
  }
}
