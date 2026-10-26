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
    for (let offset = span - 1; offset >= 0; offset -= 1) {
        const day = dayBefore(now, offset)
        const bucket = { day, in: 0, out: 0, all: 0 }
        daily.push(bucket)
        byDay.set(day, bucket)
    }
    const hours = Array.from({ length: 24 }, () => 0)
    const byConversation = new Map()
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
    }

    const conversations = [...byConversation.values()]
        .sort((a, b) => b.all - a.all)
        .slice(0, Math.max(1, Number(conversationLimit) || 5))

    return {
        days: span,
        total: { in: inCount, out: outCount, all: inCount + outCount },
        daily,
        hours,
        conversations,
    }
}