// 消息流水：一个极简的按天 JSONL 追加日志，供设置卡的「消息流水」页签读取。
// 设计约束：
// - 追加失败绝不抛错（流水是观测工具，不能反过来弄坏消息收发）；
// - 文本截断到 200 字符，避免一条长回复把流水文件撑爆；
// - 按天一个文件（journal-YYYY-MM-DD.jsonl），读取时只取尾部，天然滚动。

import { mkdirSync, appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_JOURNAL_TEXT_CHARS = 200
export const DEFAULT_JOURNAL_LIMIT = 50

function dayStamp(at) {
    const d = new Date(at)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function journalPath(stateRoot, at) {
    return join(stateRoot, 'journal', `journal-${dayStamp(at)}.jsonl`)
}

/**
 * What the line can say about delivery.
 *
 * The field exists because an `out` line used to mean only "the agent wrote
 * something": it was appended *before* `channel.sendText()` ran, so it could not
 * tell "the server took it" from "the server was never reached". The line is
 * written as `sending`, and the outcome arrives as a second, empty-text line
 * with `phase: 'settled'`; {@link collapseDeliveryLines} merges the pair back
 * into one entry when the card reads them. Keeping the day file append-only is
 * what makes the write-then-outcome pair safe to crash in the middle of.
 *
 * @typedef {'sending'|'accepted'|'unconfirmed'|'failed'|'queued'} Delivery
 *
 * - `sending`    — recorded, request not finished yet (the process died here).
 * - `accepted`   — the server answered `ret=0`; `messageId`/`clientId` say which.
 * - `unconfirmed`— the server said ok but handed back no message id. Weixin has
 *                  no delivery receipt, so the bubble may still never appear.
 * - `failed`     — the call threw; the text went to the outbox when there is one.
 * - `queued`     — failed, and the outbox holds it for a retry.
 */
export const DELIVERY_UNCONFIRMED = 'unconfirmed'

/** @param {unknown} value */
function deliveryOf(value) {
    return typeof value === 'string' && value !== '' ? value.slice(0, 32) : undefined
}

/**
 * Render the last step of a send for the settings card.
 *
 * @param {{ delivery?: string, messageId?: string, clientId?: string }} entry
 * @param {(key: string, params?: Record<string, unknown>) => string} [t]
 */
export function describeDelivery(entry, t) {
    const say = t ?? ((key, params = {}) => {
        const zh = {
            'delivery.sending': '发送中',
            'delivery.accepted': '服务端已接收 {id}',
            'delivery.unconfirmed': '服务端已接收，但没有回执号 {id}',
            'delivery.failed': '发送失败',
            'delivery.queued': '发送失败，已排队重试',
        }
        return String(zh[key] ?? key).replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
    })
    const id = entry.messageId ?? entry.clientId
    const where = id === undefined ? {} : { id: `#${String(id).slice(-8)}` }
    switch (entry.delivery) {
        case 'sending': return say('delivery.sending', where)
        case 'accepted': return say('delivery.accepted', where)
        case 'unconfirmed': return say('delivery.unconfirmed', where)
        case 'failed': return say('delivery.failed', where)
        case 'queued': return say('delivery.queued', where)
        default: return ''
    }
}

export function appendJournal(stateRoot, entry, { warn } = {}) {
    try {
        const at = typeof entry?.at === 'number' ? entry.at : Date.now()
        const text = typeof entry?.text === 'string' ? entry.text.slice(0, MAX_JOURNAL_TEXT_CHARS) : ''
        const delivery = deliveryOf(entry.delivery)
        const messageId = entry.messageId === undefined ? undefined : String(entry.messageId)
        const clientId = entry.clientId === undefined ? undefined : String(entry.clientId)
        const line = JSON.stringify({
            at,
            dir: entry.dir === 'out' ? 'out' : 'in',
            accountId: String(entry.accountId ?? ''),
            conversationId: String(entry.conversationId ?? ''),
            senderId: entry.senderId === undefined ? undefined : String(entry.senderId),
            text,
            // Where in the send this line sits: a provisional `sending` line
            // when the text is recorded, and one settled line (accepted /
            // unconfirmed / failed / queued) when the call returns. The reader
            // merges the pair, so a message shows once, with its final state.
            ...(entry.phase === undefined ? {} : { phase: String(entry.phase).slice(0, 16) }),
            // Only outbound lines carry a delivery step; an inbound line that
            // grew one would be claiming something nobody observed.
            ...(delivery === undefined ? {} : { delivery }),
            ...(messageId === undefined ? {} : { messageId }),
            ...(clientId === undefined ? {} : { clientId }),
        })
        const dir = join(stateRoot, 'journal')
        mkdirSync(dir, { recursive: true })
        appendFileSync(journalPath(stateRoot, at), line + '\n')
    } catch (error) {
        try { warn?.(`journal append failed: ${String(error)}`) } catch { /* never throw from a journal */ }
    }
}

/** Newest last in the file, newest first in the returned array. */
export function readJournal(stateRoot, { limit = DEFAULT_JOURNAL_LIMIT, accountId, conversationId, before } = {}) {
    const dir = join(stateRoot, 'journal')
    let files = []
    try {
        files = readdirSync(dir).filter((name) => /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse()
    } catch {
        return []
    }
    const out = []
    for (const name of files) {
        let lines = []
        try {
            lines = readFileSync(join(dir, name), 'utf8').split('\n').filter((line) => line !== '')
        } catch {
            continue
        }
        for (let i = lines.length - 1; i >= 0; i -= 1) {
            try {
                const entry = JSON.parse(lines[i])
                if (accountId !== undefined && entry.accountId !== accountId) continue
                if (conversationId !== undefined && entry.conversationId !== conversationId) continue
                // `before` pages backwards: the card asks for everything older
                // than the oldest entry it already has.
                if (before !== undefined && Number(entry.at) >= Number(before)) continue
                out.push(entry)
            } catch { /* skip a torn line */ }
            // Read more lines than asked for: one message is now two lines
            // (provisional + settled), so a page of `limit` can hide behind up
            // to 2× as many file lines. The collapse leaves at most `limit`.
            if (out.length >= limit * 2) break
        }
        if (out.length >= limit * 2) break
    }
    return collapseDeliveryLines(out).slice(0, limit)
}

/**
 * Merge each message's provisional line with its settled line.
 *
 * The send path writes `sending` when the text exists and one settled line per
 * chunk when the call returns; both are appended (the day file is append-only),
 * so the reader is where they become one message again. Old journals have no
 * `phase` at all — those lines pass through untouched.
 *
 * @param {Array<any>} newestFirst
 */
export function collapseDeliveryLines(newestFirst) {
    const settled = newestFirst.filter((entry) => entry.phase === 'settled')
    if (settled.length === 0) return newestFirst
    const used = new Set()
    const take = (entry) => {
        const match = settled.find((candidate) => !used.has(candidate)
            && candidate.conversationId === entry.conversationId
            && candidate.accountId === entry.accountId
            && Number(candidate.at) >= Number(entry.at))
        if (match === undefined) return entry
        used.add(match)
        return { ...entry, delivery: match.delivery, ...(match.messageId === undefined ? {} : { messageId: match.messageId }), ...(match.clientId === undefined ? {} : { clientId: match.clientId }) }
    }
    const merged = []
    for (const entry of newestFirst) {
        if (entry.phase === 'settled') {
            // Consumed by its provisional partner: the message is already there.
            if (used.has(entry)) continue
            // Nothing carries text for this one, so it is only worth a bubble
            // when someone has to act on it. A successful send with no visible
            // text would just be a blank bubble.
            if (entry.delivery === 'accepted' || entry.delivery === 'unconfirmed') continue
            merged.push(entry)
            continue
        }
        merged.push(entry.phase === 'sending' ? take(entry) : entry)
    }
    return merged.slice().sort((a, b) => Number(b.at) - Number(a.at))
}
