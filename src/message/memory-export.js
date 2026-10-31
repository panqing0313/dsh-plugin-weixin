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
export function writeMemoryExport(stateRoot, accountId, conversationId, markdown, { now = Date.now() } = {}) {
    const dir = join(stateRoot, 'exports')
    mkdirSync(dir, { recursive: true })
    const d = new Date(now)
    const safe = (s) => String(s).replace(/[^A-Za-z0-9@._-]/g, '_').slice(0, 60) || 'memory'
    const stamp = `${dayStamp(now).replaceAll('-', '')}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const file = join(dir, `memory-${safe(accountId)}-${safe(conversationId)}-${stamp}.md`)
    writeFileSync(file, markdown, 'utf8')
    return file
}