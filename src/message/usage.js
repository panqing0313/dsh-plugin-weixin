/**
 * `/usage`：今天这台机器花掉了什么。
 *
 * 不调模型，也不新增任何计数器 —— 数字全部来自已有的状态文件：后台预算
 * （`budget.json`）、主动开口额度（`proactive-<account>.json`）、重发队列
 * （`outbox.json`）、提醒与订阅（`reminders.json` / `subscriptions.json`）、
 * 以及今天的消息流水（`journal-<date>.jsonl`）。
 *
 * 「粗估 token」明确是粗估：流水里的字符按 `estimateTokens` 折算，只包含
 * **入站与出站的正文**，不含系统提示词、工具结果与模型上下文。写清这一点，
 * 比给一个看起来很精确的数字更有用。
 *
 * @module dsh-weixin/usage
 */

import { estimateTokens } from '../tokens.js'

function pad(value) {
  return String(Math.max(0, Math.round(value))).padStart(2, '0')
}

/** HH:mm in local time. */
function clock(at) {
  if (!Number.isFinite(at) || at <= 0) return '—'
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * One block of "what today used".
 *
 * @param {{
 *   backgroundUsed?: number,
 *   backgroundLimit?: number,
 *   proactiveCount?: number,
 *   proactiveLimit?: number,
 *   proactiveLastAt?: number,
 *   proactiveMisses?: number,
 *   outboxPending?: number,
 *   reminders?: number,
 *   subscriptions?: number,
 *   journalEntries?: number,
 *   journalChars?: number,
 *   now?: number,
 * }} input
 * @returns {string}
 */
export function buildUsageReport(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const used = Math.max(0, Math.round(input.backgroundUsed ?? 0))
  const limit = Math.max(0, Math.round(input.backgroundLimit ?? 0))
  const budget = limit === 0 ? `${used} 次（未设上限）` : `${used}/${limit} 次`

  const proactiveCount = Math.max(0, Math.round(input.proactiveCount ?? 0))
  const proactiveLimit = Math.max(0, Math.round(input.proactiveLimit ?? 0))
  const proactive = proactiveLimit === 0 ? `${proactiveCount} 条` : `${proactiveCount}/${proactiveLimit} 条`
  const last = Number.isFinite(input.proactiveLastAt) && input.proactiveLastAt > 0
    ? ` · 上次 ${clock(input.proactiveLastAt)}`
    : ' · 今天还没开口'
  const misses = Math.max(0, Math.round(input.proactiveMisses ?? 0))
  const missesText = misses === 0 ? '' : ` · 连发未回 ${misses} 次（退避中）`

  const chars = Math.max(0, Math.round(input.journalChars ?? 0))
  const rough = estimateTokens('x'.repeat(Math.min(chars, 200_000)))
  const lines = [
    '用量 · 今天',
    `后台调用：${budget}`,
    `主动开口：${proactive}${last}${missesText}`,
    `待重发：${Math.max(0, Math.round(input.outboxPending ?? 0))} 条`,
    `待发提醒：${Math.max(0, Math.round(input.reminders ?? 0))} 条 · 订阅：${Math.max(0, Math.round(input.subscriptions ?? 0))} 条`,
    `今天流水：${Math.max(0, Math.round(input.journalEntries ?? 0))} 条 · 正文粗估约 ${rough} token`,
  ]
  if (limit > 0 && used >= limit) lines.push('后台预算今天已用完：记忆折叠、日报、主动开口都不会再调模型，明天零点重置。')
  return lines.join('\n')
}

/** 供 `/diag` 复用：只给一行摘要。 */
export function usageSummary(input = {}) {
  const report = buildUsageReport(input)
  return report.split('\n')[1] ?? ''
}