// 统计：从消息流水现算「最近 N 天收发量 / 24 小时时段分布 / 会话排行」。
// 设置卡「统计」页签用它；纯函数、不缓存——流水本身就是事实来源，
// 现算永远比一份可能过期的快照诚实。
//
// 约束：
// - 只读 journal，不碰账号目录与网络；
// - 按本地时区分桶（用户看到的「今天」就是本地的今天）；
// - daily 永远返回恰好 days 项（没有消息的那天补 0），这样卡片画图不用补洞。

import { readJournalRange } from './chat-export.js'

const pad = (n) => String(n).padStart(2, '0')

function dayStamp(at) {
    const d = new Date(at)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The local date string `offset` days before `now` (offset 0 = today). */
function dayBefore(now, offset) {
    const d = new Date(now)
    d.setDate(d.getDate() - offset)
    return dayStamp(d.getTime())
}

/**
 * Compute the stats block for the settings card.
 *
 * @param {string} stateRoot plugin state directory
 * @param {{ days?: number, now?: number, accountId?: string, conversationLimit?: number }} [options]
 * @returns {{
 *   days: number,
 *   total: { in: number, out: number, all: number },
 *   daily: Array<{ day: string, in: number, out: number, all: number }>,
 *   hours: number[],
 *   conversations: Array<{ accountId: string, conversationId: string, in: number, out: number, all: number }>,
 * }}
 */
export function computeStats(stateRoot, { days = 14, now = Date.now(), accountId, conversationLimit = 5 } = {}) {
    const span = Math.max(1, Math.min(Number(days) || 14, 90))
    const entries = readJournalRange(stateRoot, { days: span, now, accountId })

    // Oldest → newest, exactly `span` buckets.
    const daily = []
    const byDay = new Map()
    const indexByDay = new Map()
    for (let offset = span - 1; offset >= 0; offset -= 1) {
        const day = dayBefore(now, offset)
        const bucket = { day, in: 0, out: 0, all: 0 }
        indexByDay.set(day, daily.length)
        daily.push(bucket)
        byDay.set(day, bucket)
    }
    const hours = Array.from({ length: 24 }, () => 0)
    const byConversation = new Map()
    const seriesByConversation = new Map()
    let inCount = 0
    let outCount = 0

    for (const entry of entries) {
        const at = typeof entry.at === 'number' ? entry.at : now
        const outbound = entry.dir === 'out'
        if (outbound) outCount += 1
        else inCount += 1

        const bucket = byDay.get(dayStamp(at))
        // A journal entry can fall outside the window only through a clock
        // change; it gets no bar, and the totals describe the window too.
        if (bucket !== undefined) {
            bucket[outbound ? 'out' : 'in'] += 1
            bucket.all += 1
        }
        hours[new Date(at).getHours()] += 1

        const key = `${entry.accountId ?? ''}|${entry.conversationId ?? ''}`
        const row = byConversation.get(key) ?? {
            accountId: String(entry.accountId ?? ''),
            conversationId: String(entry.conversationId ?? ''),
            in: 0,
            out: 0,
            all: 0,
        }
        row[outbound ? 'out' : 'in'] += 1
        row.all += 1
        byConversation.set(key, row)

        // Per-day counts for the sparkline: same buckets as `daily`, so a
        // conversation line and the aggregate bar chart always agree.
        const dayIndex = indexByDay.get(dayStamp(at))
        if (dayIndex !== undefined) {
            let series = seriesByConversation.get(key)
            if (series === undefined) {
                series = new Array(span).fill(0)
                seriesByConversation.set(key, series)
            }
            series[dayIndex] += 1
        }
    }

    const conversations = [...byConversation.values()]
        .sort((a, b) => b.all - a.all)
        .slice(0, Math.max(1, Number(conversationLimit) || 5))
        .map((row) => ({
            ...row,
            series: seriesByConversation.get(`${row.accountId}|${row.conversationId}`) ?? new Array(span).fill(0),
        }))

    return {
        days: span,
        total: { in: inCount, out: outCount, all: inCount + outCount },
        daily,
        hours,
        conversations,
    }
}

/**
 * 「健康度」环：四项各 25 分。这不是模型评分，是我们自己定的运维口径，
 * 每一项都在卡片上写明「怎么算的」—— 一个不给口径的分数比没有分数更糟。
 *
 * - 连接：至少有一个账号凭据可加载（25 / 0）
 * - 待发：outbox 为空 25；1–3 条 15；更多 5
 * - 预算：未设上限 25；用掉 <80% 25；<100% 15；已用完 0
 * - 留存：journal / audit / media 都设了天数 25；否则 10
 *
 * @param {{
 *   connected: boolean,
 *   outboxPending: number,
 *   budgetUsed: number,
 *   budgetLimit: number,
 *   retention: { journalDays?: number, auditDays?: number, mediaDays?: number },
 * }} input
 * @returns {{ score: number, parts: Array<{ key: string, score: number, max: number }> }}
 */
export function buildHealth({ connected, outboxPending, budgetUsed, budgetLimit, retention } = {}) {
    const pending = Math.max(0, Number(outboxPending) || 0)
    const used = Math.max(0, Number(budgetUsed) || 0)
    const limit = Math.max(0, Number(budgetLimit) || 0)
    const keep = retention ?? {}

    const parts = [
        { key: 'connected', score: connected === true ? 25 : 0, max: 25 },
        { key: 'outbox', score: pending === 0 ? 25 : pending <= 3 ? 15 : 5, max: 25 },
        {
            key: 'budget',
            score: limit <= 0 ? 25 : used < limit * 0.8 ? 25 : used < limit ? 15 : 0,
            max: 25,
        },
        {
            key: 'retention',
            score:
                Number(keep.journalDays) > 0 && Number(keep.auditDays) > 0 && Number(keep.mediaDays) > 0
                    ? 25
                    : 10,
            max: 25,
        },
    ]
    return { score: parts.reduce((sum, part) => sum + part.score, 0), parts }
}