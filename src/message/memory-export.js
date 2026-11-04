/**
 * 记忆导出：把「它记得什么」渲染成一份可以发出去、可以存档的 Markdown。
 *
 * 导出的对象是三层：全局记忆（人物小传、档案、事件、长期事实、改过的说法）、
 * 重要日子、以及每个会话的记忆（摘要、关系、亲密度曲线）。它回答的是
 * 「这个机器人对你的了解有多少」—— 和 /memory 的聊天版回答同一个问题，
 * 但整理成文档形状，可以拿去读、可以分享、可以换机前留档。
 *
 * 写文件复用 chat-export 的 exports 目录与命名习惯：`memory-<账号>-<会话>-<时间>.md`，
 * 附件走现有的回复白名单链路（exports 在 mediaDirs 里）。
 *
 * @module dsh-weixin/message/memory-export
 */

import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

function pad(value) {
    return String(value).padStart(2, '0')
}

function dayStamp(now) {
    const d = new Date(now)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * @param {object} params
 * @param {object} params.store 全局记忆（readGlobalMemory 的结果）
 * @param {Array<{conversationId: string, summary?: string, bond?: object}>} params.conversations 该账号全部会话记忆
 * @param {Array<{label: string, date: string}>} [params.dates] 重要日子（可省略）
 * @param {string} params.accountId
 * @param {string} params.conversationId 发起导出的会话
 * @param {number} params.now
 * @param {(text: string) => string} [params.formatProfile]
 * @param {(events: Array) => string[]} [params.formatEvents]
 * @param {(bond: object) => string} [params.bondLine]
 * @param {(history: object) => string} [params.describeAffinity]
 * @param {object} [params.affinity] 发起会话的亲密度历史（可省略）
 * @param {Array<{text: string}>} params.facts 由调用方从 store 抽好的事实列表（保持 /memory 的口径）
 */
export function renderMemoryMarkdown(params) {
    const {
        store,
        conversations,
        dates = [],
        accountId,
        conversationId,
        now = Date.now(),
        formatProfile,
        formatEvents,
        bondLine,
        describeAffinity,
        affinity,
    } = params

    const lines = []
    lines.push(`# 记忆导出 · ${dayStamp(now)}`)
    lines.push('')
    lines.push(`- 账号：\`${accountId}\``)
    lines.push(`- 导出发起会话：\`${conversationId}\``)
    lines.push('')

    if (store.digest !== '') {
        lines.push('## 人物小传')
        lines.push('')
        lines.push(store.digest)
        lines.push('')
    }

    const profileLines = typeof formatProfile === 'function' ? formatProfile(store.profile) : []
    if (profileLines.length > 0) {
        lines.push('## 关于你的档案')
        lines.push('')
        for (const line of profileLines) lines.push(`- ${line}`)
        lines.push('')
    }

    if (typeof formatEvents === 'function' && store.events.length > 0) {
        lines.push('## 事件与待办')
        lines.push('')
        for (const line of formatEvents(store.events)) lines.push(`- ${line}`)
        lines.push('')
    }

    lines.push('## 长期记忆')
    lines.push('')
    if (store.facts.length === 0) {
        lines.push('（还没有，用 /remember 教我。）')
    } else {
        for (let i = 0; i < store.facts.length; i += 1) lines.push(`${i + 1}. ${store.facts[i].text}`)
    }
    lines.push('')

    if (store.superseded.length > 0) {
        lines.push('## 改过的说法')
        lines.push('')
        for (const entry of store.superseded.slice(-10)) lines.push(`- ${entry.text} → ${entry.by}`)
        lines.push('')
    }

    if (dates.length > 0) {
        lines.push('## 重要日子（接下来）')
        lines.push('')
        for (const item of dates) lines.push(`- ${item.label} · ${item.date}`)
        lines.push('')
    }

    const withSummary = conversations.filter((conv) => (conv.summary ?? '') !== '')
    if (withSummary.length > 0) {
        lines.push('## 会话记忆')
        lines.push('')
        for (const conv of withSummary) {
            lines.push(`### ${conv.conversationId}`)
            lines.push('')
            lines.push(conv.summary)
            const bond = typeof bondLine === 'function' ? bondLine(conv.bond ?? {}) : ''
            if (bond !== '') {
                lines.push('')
                lines.push(bond)
            }
            lines.push('')
        }
    }

    if (affinity !== undefined && typeof describeAffinity === 'function') {
        const curve = describeAffinity(affinity)
        if (curve !== '') {
            lines.push('## 发起会话的关系曲线')
            lines.push('')
            lines.push('```')
            lines.push(curve)
            lines.push('```')
            lines.push('')
        }
    }

    return lines.join('\n').trimEnd() + '\n'
}

/**
 * 写入 `<stateRoot>/exports/`，命名与 chat 导出一致，返回绝对路径。
 */
export function writeMemoryExport(stateRoot, accountId, conversationId, markdown, { now = Date.now(), extension = 'md' } = {}) {
    const dir = join(stateRoot, 'exports')
    mkdirSync(dir, { recursive: true })
    const d = new Date(now)
    const safe = (s) => String(s).replace(/[^A-Za-z0-9@._-]/g, '_').slice(0, 60) || 'memory'
    const stamp = `${dayStamp(now).replaceAll('-', '')}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const suffix = String(extension).replace(/[^A-Za-z0-9]/g, '').slice(0, 5) || 'md'
    const file = join(dir, `memory-${safe(accountId)}-${safe(conversationId)}-${stamp}.${suffix}`)
    writeFileSync(file, markdown, 'utf8')
    return file
}

/**
 * The JSON twin of `renderMemoryMarkdown`.
 *
 * For machines to carry: same three layers, but nothing is prettified away.
 * Two things are deliberately left out — the account id (a JSON a user might
 * paste into a chat should not carry their WeChat id) and any token-shaped
 * field. What remains is exactly what `parseMemoryJson` can read back, so the
 * round trip is lossless for facts, events, profile and per-conversation
 * summaries.
 *
 * `exportedAt` is a real timestamp rather than a rendered date: an import on
 * another machine needs to compare ages, and a human-readable date has no
 * unambiguous parse.
 *
 * @param {object} params  Same inputs as `renderMemoryMarkdown`, minus the
 *   formatting callbacks — JSON carries the values, not their sentences.
 */
export function renderMemoryJson(params) {
    const {
        store,
        conversations,
        dates = [],
        conversationId,
        now = Date.now(),
        affinity,
    } = params

    const facts = (store.facts ?? []).map((fact) => ({
        text: fact.text,
        at: typeof fact.at === 'number' ? fact.at : undefined,
        source: typeof fact.source === 'string' && fact.source !== '' ? fact.source : undefined,
        weight: typeof fact.weight === 'number' ? fact.weight : undefined,
    }))

    const events = (store.events ?? []).map((event) => ({
        text: event.text,
        when: event.when,
        ...(event.done === true ? { done: true } : {}),
    }))

    const profile = {}
    for (const [field, value] of Object.entries(store.profile ?? {})) {
        if (Array.isArray(value)) {
            if (value.length > 0) profile[field] = [...value]
        } else if (value !== undefined && value !== null && value !== '') {
            profile[field] = value
        }
    }

    return {
        format: 'dsh-weixin-memory',
        version: 1,
        exportedAt: new Date(now).toISOString(),
        origin: { conversationId },
        digest: typeof store.digest === 'string' ? store.digest : '',
        profile,
        events,
        facts,
        superseded: (store.superseded ?? []).slice(-10).map((entry) => ({ text: entry.text, by: entry.by })),
        dates: dates.map((item) => ({ label: item.label, date: item.date })),
        conversations: conversations
            .filter((conv) => typeof conv.summary === 'string' && conv.summary !== '')
            .map((conv) => ({
                conversationId: conv.conversationId,
                summary: conv.summary,
                bond: conv.bond ?? undefined,
            })),
        affinity: affinity === undefined ? undefined : affinity,
    }
}

/**
 * Parse a JSON export back into the shape `planMemoryImport` accepts.
 *
 * Strict about the single thing that would make an import dangerous — that the
 * file really is a memory export — and forgiving about everything else, so a
 * hand-edited file (one more fact typed by the user) still imports.
 *
 * @returns {{ ok: true, parsed: object } | { ok: false, reason: string }}
 */
export function parseMemoryJson(text) {
    let data
    try {
        data = JSON.parse(String(text ?? ''))
    } catch {
        return { ok: false, reason: '这不是合法的 JSON（可以先确认粘贴的是完整的 /memory export json 结果）' }
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, reason: 'JSON 顶层应该是一个对象，而不是数组或标量' }
    }
    if (data.format !== 'dsh-weixin-memory') {
        return { ok: false, reason: '这份 JSON 不是本插件的记忆导出（缺少 format: "dsh-weixin-memory"）' }
    }
    const strings = (list, key = 'text') => (Array.isArray(list) ? list : [])
        .map((entry) => (typeof entry === 'string' ? entry : entry?.[key]))
        .filter((value) => typeof value === 'string' && value.trim() !== '')
        .map((value) => value.trim())

    const profile = {}
    if (data.profile !== null && typeof data.profile === 'object' && Array.isArray(data.profile) === false) {
        for (const [field, value] of Object.entries(data.profile)) {
            if (Array.isArray(value)) {
                const kept = value.filter((item) => typeof item === 'string' && item.trim() !== '')
                if (kept.length > 0) profile[field] = kept
            } else if (typeof value === 'string' && value.trim() !== '') {
                profile[field] = value.trim()
            }
        }
    }

    const events = (Array.isArray(data.events) ? data.events : [])
        .filter((event) => event !== null && typeof event === 'object')
        .map((event) => ({ text: String(event.text ?? '').trim(), when: String(event.when ?? '').trim(), done: event.done === true }))
        .filter((event) => event.text !== '')

    const lines = strings(data.facts)
    return {
        ok: true,
        parsed: {
            digest: typeof data.digest === 'string' ? data.digest.trim() : '',
            profile,
            events,
            facts: lines,
            // The markdown parser reports how many lines it could not read; a
            // JSON export has no such lines.
            skipped: 0,
            conversations: (Array.isArray(data.conversations) ? data.conversations : [])
                .filter((conv) => conv !== null && typeof conv === 'object' && typeof conv.conversationId === 'string')
                .map((conv) => ({ conversationId: conv.conversationId, summary: String(conv.summary ?? '') })),
            dates: (Array.isArray(data.dates) ? data.dates : [])
                .filter((item) => item !== null && typeof item === 'object' && typeof item.label === 'string')
                .map((item) => ({ label: item.label, date: String(item.date ?? '') })),
        },
    }
}
