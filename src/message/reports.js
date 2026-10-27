/**
 * Scheduled reports: a daily digest of what actually happened, and a weekly
 * review of what the bot thinks it remembers.
 *
 * Both are the same machine — a clock, a side session that writes prose, and one
 * outbound message — so they share a scheduler. What they deliberately do NOT
 * share is the ability to act: the review never edits memory by itself, it only
 * asks, and the digest never invents numbers (it prints what the journal and the
 * stats already say, and lets the model write the two sentences around them).
 *
 * Timing reuses the `/subscribe` vocabulary (`每天 21:00`, `每周日 20:00`) so
 * there is one parser to learn and one to keep correct.
 */
import { nextFireAt, parseSubscriptionWhen, formatStamp } from './subscriptions.js'

/** Reports are skipped when the last one is younger than this, whatever the clock says. */
export const MIN_REPORT_GAP_MS = 6 * 60 * 60 * 1000

/** How many facts the weekly review asks about at most. */
export const REVIEW_MAX_FACTS = 8

export const DEFAULT_DIGEST_WHEN = '每天 21:00'
export const DEFAULT_REVIEW_WHEN = '每周日 20:00'

/**
 * Turn a configured `when` into the next firing time, or `undefined` when the
 * spec is unusable. `now` is injectable so the arithmetic is testable without
 * waiting for tomorrow evening.
 */
export function nextReportAt(when, now = Date.now()) {
  const parsed = parseSubscriptionWhen(when, new Date(now))
  // Only a recurring clock makes sense for a report. `parseSubscriptionWhen` also
  // accepts `10m` and `2026-10-19 09:00` — those are one-shot subscription specs,
  // and a report that fires exactly once (or in ten minutes) is a configuration
  // mistake, not a schedule. Reject them instead of silently arming once.
  if (parsed?.ok !== true || (parsed.kind !== 'daily' && parsed.kind !== 'weekly')) return undefined
  const at = nextFireAt(parsed, now)
  return Number.isFinite(at) && at > now ? at : undefined
}

/** The conversation a report should go to: the one spoken in most recently. */
export function pickConversation(conversations) {
  let best
  for (const entry of conversations ?? []) {
    if (typeof entry.conversationId !== 'string' || entry.conversationId === '') continue
    const lastAt = Number(entry.bond?.lastMessageAt ?? 0)
    if (best === undefined || lastAt > best.lastAt) best = { conversationId: entry.conversationId, lastAt }
  }
  return best?.conversationId
}

/**
 * The digest prompt. Numbers first, exactly as measured, and the model's job is
 * only the framing — a report that hallucinates a busy day is worse than none.
 */
export function buildDigestPrompt({ accountLabel = '', day, total, conversations, events, summary }) {
  const lines = []
  lines.push(`现在是 ${day} 的晚上。请给主人写一条当天的简报，语气自然、像助理发的一条微信。`)
  lines.push('')
  lines.push('【今天的实际数据】')
  lines.push(`- 收到 ${total.in} 条、发出 ${total.out} 条消息，一共 ${total.all} 条`)
  if (conversations.length > 0) {
    const top = conversations.slice(0, 3).map((c) => `${c.conversationId}（${c.all} 条）`).join('、')
    lines.push(`- 聊得最多的是 ${top}`)
  }
  if (events.length > 0) {
    lines.push(`- 记着的事：${events.slice(0, 5).map((e) => e.text).join('；')}`)
  }
  if (typeof summary === 'string' && summary !== '') {
    lines.push(`- 这段会话的摘要：${summary}`)
  }
  lines.push('')
  lines.push('【要求】')
  lines.push('- 三到五句话，先说今天聊了什么，再提醒一两件还没做完的事')
  lines.push('- 只用上面给出的数字与事实，不要编造没出现的对话或数据')
  lines.push('- 不要罗列格式、不要标题，就像随手发的一条消息')
  lines.push('- 如果今天几乎没聊，就一句轻描淡写地带过，别硬凑')
  return lines.join('\n')
}

/**
 * The weekly memory review prompt. The output is a question, not an action:
 * the bot lists what it believes and asks the human to correct it. Corrections
 * then go through `/remember` / `/forget`, which is where memory is allowed to
 * change — a report that silently rewrote memory would be far worse than an
 * out-of-date fact.
 */
export function buildReviewPrompt({ day, facts, profile, digest }) {
  const lines = []
  lines.push(`现在是 ${day}，请跟主人核对一下你记着的事。`)
  lines.push('')
  if (typeof digest === 'string' && digest !== '') {
    lines.push(`【你写的人物小传】${digest}`)
    lines.push('')
  }
  const profileLines = []
  if (profile?.call) profileLines.push(`称呼：${profile.call}`)
  if (profile?.schedule) profileLines.push(`作息：${profile.schedule}`)
  if (profile?.likes?.length > 0) profileLines.push(`喜欢：${profile.likes.join('、')}`)
  if (profile?.dislikes?.length > 0) profileLines.push(`不喜欢：${profile.dislikes.join('、')}`)
  for (const entry of profile?.dates ?? []) profileLines.push(`${entry.label}：${entry.date}`)
  if (profileLines.length > 0) {
    lines.push(`【档案】${profileLines.join('；')}`)
    lines.push('')
  }
  const listed = (facts ?? []).slice(0, REVIEW_MAX_FACTS)
  if (listed.length > 0) {
    lines.push('【你记着的事】')
    listed.forEach((fact, index) => lines.push(`${index + 1}. ${fact.text}`))
    lines.push('')
  }
  lines.push('【要求】')
  lines.push('- 用一两句开场，然后把这些条目编号列出来（不超过八条），问一句「有哪条不对吗」')
  lines.push('- 只列上面给出的事实，不要新增、不要推测、不要替主人改')
  lines.push('- 结尾告诉主人：回 `/remember 旧的 → 新的` 改掉某条，回 `/forget 编号` 删掉某条')
  lines.push('- 不要一次问太多问题，重点是让主人好回复')
  return lines.join('\n')
}

export function describeReport(kind, at) {
  return kind === 'review' ? `记忆核对 ${formatStamp(at)}` : `日报 ${formatStamp(at)}`
}

/**
 * A clock that fires at most twice a day and survives the machine sleeping: it
 * re-arms from the wall clock after every fire instead of trusting a long timer.
 */
export class ReportScheduler {
  #timer
  #stopped = false
  #nextAt
  /** What this timer was armed for. Recomputing it at fire time would skip the
   *  fire itself: a second after the target moment, "next" is tomorrow. */
  #due = []

  constructor({ config, fire, warn = () => {}, setTimeoutRef = setTimeout, clearTimeoutRef = clearTimeout, now = Date.now }) {
    this.config = config
    this.fire = fire
    this.warn = warn
    this.setTimeoutRef = setTimeoutRef
    this.clearTimeoutRef = clearTimeoutRef
    this.now = now
  }

  /** @returns {{ kind: 'digest' | 'review', at: number }[]} what is armed right now */
  pending() {
    const live = this.config()
    const armed = []
    if (live.digestEnabled !== false) {
      const at = nextReportAt(live.digestWhen ?? DEFAULT_DIGEST_WHEN, this.now())
      if (at !== undefined) armed.push({ kind: 'digest', at })
    }
    if (live.memoryReviewEnabled !== false) {
      const at = nextReportAt(live.memoryReviewWhen ?? DEFAULT_REVIEW_WHEN, this.now())
      if (at !== undefined) armed.push({ kind: 'review', at })
    }
    return armed
  }

  start() {
    this.#stopped = false
    this.#arm()
    return this
  }

  stop() {
    this.#stopped = true
    if (this.#timer !== undefined) this.clearTimeoutRef(this.#timer)
    this.#timer = undefined
  }

  #arm() {
    if (this.#stopped) return
    if (this.#timer !== undefined) this.clearTimeoutRef(this.#timer)
    const armed = this.pending()
    this.#due = armed
    if (armed.length === 0) return
    const soonest = armed.reduce((a, b) => (a.at <= b.at ? a : b))
    this.#nextAt = soonest.at
    const delay = Math.max(1_000, soonest.at - this.now())
    this.#timer = this.setTimeoutRef(() => this.#run(), delay)
    this.#timer?.unref?.()
  }

  async #run() {
    if (this.#stopped) return
    // Two seconds of slack, not a minute: the timer can land a hair early, but a
    // whole minute of "early" would mean a 20:59 report for a 21:00 schedule.
    const due = this.#due.filter((entry) => entry.at <= this.now() + 2_000)
    for (const entry of due) {
      try {
        await this.fire(entry.kind)
      } catch (error) {
        this.warn(`${entry.kind} report failed: ${String(error?.message ?? error)}`)
      }
    }
    this.#arm()
  }

  /** Test seam: run whatever is due without waiting for the clock. */
  async tick() {
    await this.#run()
    return this.#nextAt
  }

  /** Test seam: what the armed timer is waiting for. */
  get armedFor() {
    return this.#due.map((entry) => ({ ...entry }))
  }
}
