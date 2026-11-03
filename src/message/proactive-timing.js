/**
 * 主动开口的时机，不该只看配置文件，也该看这个人实际什么时候在线。
 *
 * 现在的窗口是写死的（默认 09:00–23:00），掷骰子每 5 分钟一次 —— 对一个凌晨
 * 两点才回消息的人，这套规则等于白天对着空气说话。这个模块从**消息流水**里
 * 学：把最近两周的「对方发来的消息」按小时数一遍，找出最活跃的一段连续小时，
 * 把它和配置窗口求交集。
 *
 * 三条边界，都是刻意的：
 *
 * 1. **只是收窄，不会放宽**。配置里的窗口是硬边界：学到的时段只在窗口内部生效，
 *    两边不重合时回退到配置窗口（宁可照旧，也不要因为数据太少就把人静音）。
 * 2. **样本不够就不用**。少于 20 条入站消息、或覆盖不到 4 天，就当作「还不认识你」，
 *    什么也不改 —— 新装机器上前几天不该被推断出作息。
 * 3. **不落盘**。每次 tick 现算（读的是已经存在的日流水），没有新的状态文件，
 *    也没有「学习结果过期」这种事：删掉流水它就忘掉。
 *
 * @module dsh-weixin/message/proactive-timing
 */

/** 至少要这么多条对方发的消息，才敢谈作息。 */
export const MIN_SAMPLES = 20
/** 而且要分散在这些天里，否则一个小时内的 20 条只说明当时在聊天。 */
export const MIN_DAYS = 4
/** 学习窗口：两周足够覆盖工作日与周末。 */
export const LEARN_DAYS = 14
/** 学出来的连续时段长度（小时）。 */
export const BAND_HOURS = 8

/**
 * Count inbound messages per hour of the day.
 *
 * @param {Array<{ dir?: string, at?: number, type?: string }>} entries journal entries
 * @param {{ now?: number, days?: number }} [options]
 */
export function hourlyHistogram(entries, { now = Date.now(), days = LEARN_DAYS } = {}) {
  const counts = new Array(24).fill(0)
  const dayKeys = new Set()
  let samples = 0
  const floor = now - days * 86_400_000
  for (const entry of entries ?? []) {
    if (entry?.dir !== 'in') continue
    const at = Number(entry.at ?? entry.time)
    if (!Number.isFinite(at) || at < floor) continue
    const date = new Date(at)
    counts[date.getHours()] += 1
    dayKeys.add(`${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`)
    samples += 1
  }
  return { counts, samples, dayCount: dayKeys.size }
}

/**
 * The busiest contiguous band of `bandHours`, wrapping past midnight so a night
 * owl gets 22:00–06:00 instead of two broken halves.
 *
 * @param {number[]} counts 24 hourly counts
 * @param {number} bandHours
 * @returns {{ startHour: number, endHour: number, count: number, wraps: boolean }}
 */
export function busiestBand(counts, bandHours = BAND_HOURS) {
  const width = Math.max(1, Math.min(24, Math.trunc(bandHours)))
  let best = { startHour: 0, endHour: width % 24, count: -1, wraps: false }
  for (let start = 0; start < 24; start += 1) {
    let total = 0
    for (let offset = 0; offset < width; offset += 1) total += counts[(start + offset) % 24]
    if (total > best.count) {
      const endHour = (start + width) % 24
      best = { startHour: start, endHour, count: total, wraps: endHour <= start }
    }
  }
  return best
}

/**
 * @param {Array<{ dir?: string, at?: number }>} entries journal entries
 * @param {{ now?: number, days?: number, minSamples?: number, minDays?: number, bandHours?: number }} [options]
 * @returns {{ ok: true, startHour: number, endHour: number, wraps: boolean, samples: number, dayCount: number, share: number, counts: number[] }
 *   | { ok: false, reason: 'not-enough-data' | 'no-activity', samples: number, dayCount: number, counts: number[] }}
 */
export function learnActiveHours(entries, { now = Date.now(), days = LEARN_DAYS, minSamples = MIN_SAMPLES, minDays = MIN_DAYS, bandHours = BAND_HOURS } = {}) {
  const { counts, samples, dayCount } = hourlyHistogram(entries, { now, days })
  if (samples === 0) return { ok: false, reason: 'no-activity', samples, dayCount, counts }
  if (samples < minSamples || dayCount < minDays) {
    return { ok: false, reason: 'not-enough-data', samples, dayCount, counts }
  }
  const band = busiestBand(counts, bandHours)
  return {
    ok: true,
    startHour: band.startHour,
    endHour: band.endHour,
    wraps: band.wraps,
    samples,
    dayCount,
    share: band.count / samples,
    counts,
  }
}

/**
 * Where a learned band and the configured window overlap, in minutes-of-day.
 *
 * A night-owl band wraps midnight, so the answer can be two ranges: the evening
 * half and the small-hours half. The caller asks whether the current minute is
 * inside any of them.
 *
 * `undefined` means "no usable overlap": the caller keeps the configured window
 * rather than silencing an account whose habits fall outside it.
 *
 * @param {{ start: number, end: number }} window minutes of day, start < end
 * @param {{ startHour: number, endHour: number, wraps?: boolean }} learned
 * @returns {{ ranges: Array<{ start: number, end: number }> } | undefined}
 */
export function intersectWindow(window, learned) {
  if (!Number.isFinite(learned?.startHour) || !Number.isFinite(learned?.endHour)) return undefined
  const startHour = Math.max(0, Math.min(23, Math.trunc(learned.startHour)))
  const endHour = Math.max(0, Math.min(23, Math.trunc(learned.endHour)))
  const wraps = learned.wraps === true || endHour <= startHour
  const ranges = []
  if (wraps) {
    // 22:00 → 次日 03:00：和配置窗口重合的部分可能落在两端。
    const late = { start: Math.max(window.start, startHour * 60), end: window.end }
    if (late.start < late.end) ranges.push(late)
    const early = { start: window.start, end: Math.min(window.end, endHour * 60) }
    if (early.start < early.end) ranges.push(early)
  } else {
    const start = Math.max(window.start, startHour * 60)
    const end = Math.min(window.end, endHour * 60)
    if (start < end) ranges.push({ start, end })
  }
  return ranges.length === 0 ? undefined : { ranges }
}

/**
 * One human-readable line for `/diag` or a log: what was learned, or why not.
 *
 * @param {ReturnType<typeof learnActiveHours> | undefined} learned
 */
export function describeLearnedHours(learned) {
  if (learned === undefined) return '还没有统计（没有候选账号）'
  if (learned.ok !== true) {
    return learned.reason === 'no-activity'
      ? '还没看到对方发来的消息，暂按配置窗口'
      : `样本不够（${learned.samples} 条 / ${learned.dayCount} 天），暂按配置窗口`
  }
  const pad = (hour) => String(hour).padStart(2, '0')
  const span = learned.wraps ? `${pad(learned.startHour)}:00–${pad(learned.endHour)}:00（跨零点）` : `${pad(learned.startHour)}:00–${pad(learned.endHour)}:00`
  return `${span}，覆盖 ${Math.round(learned.share * 100)}% 的消息（${learned.samples} 条 / ${learned.dayCount} 天）`
}