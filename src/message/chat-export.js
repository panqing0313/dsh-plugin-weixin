// 聊天导出：把消息流水渲染成 Markdown。/export 命令和设置卡的「消息流水」
// 页签共用这里；小的直接当消息回出去，大的落一个文件再回路径。
// 约束：读取按天窗口（不是条数窗口），这样「最近 N 天」语义稳定。

import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const pad = (n) => String(n).padStart(2, '0')

function dayStamp(at) {
    const d = new Date(at)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Day-number distance between two stamps, calendar-based (local zone). */
function dayDistance(a, b) {
    const da = new Date(a)
    const db = new Date(b)
    return Math.round(
        (Date.UTC(da.getFullYear(), da.getMonth(), da.getDate()) -
         Date.UTC(db.getFullYear(), db.getMonth(), db.getDate())) / 86_400_000,
    )
}

/**
 * Journal entries from the last `days` days (inclusive), oldest first.
 * Unlike readJournal this scans whole day files by date, so "最近 30 天" is
 * a real window rather than "the last N entries".
 */
export function readJournalRange(stateRoot, { accountId, conversationId, days = 30, now = Date.now() } = {}) {
    const dir = join(stateRoot, 'journal')
    let files = []
    try {
        files = readdirSync(dir).filter((name) => /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()
    } catch {
        return []
    }
    const out = []
    for (const name of files) {
        const m = /journal-(\d{4})-(\d{2})-(\d{2})\.jsonl/.exec(name)
        if (m !== null && dayDistance(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])), now) < -(days - 1)) continue
        let lines = []
        try {
            lines = readFileSync(join(dir, name), 'utf8').split('\n').filter((line) => line !== '')
        } catch {
            continue
        }
        for (const line of lines) {
            try {
                const entry = JSON.parse(line)
                if (accountId !== undefined && entry.accountId !== accountId) continue
                if (conversationId !== undefined && entry.conversationId !== conversationId) continue
                out.push(entry)
            } catch { /* skip a torn line */ }
        }
    }
    return out
}

/** Render entries (oldest first) as one Markdown document, grouped by day. */
export function renderChatMarkdown(entries, { title = '聊天记录', now = Date.now() } = {}) {
    const lines = [`# ${title}`, '']
    let currentDay = null
    for (const entry of entries) {
        const at = new Date(entry.at ?? now)
        const day = dayStamp(entry.at ?? now)
        if (day !== currentDay) {
            lines.push(`## ${day}`, '')
            currentDay = day
        }
        const who = entry.dir === 'out' ? '我' : (entry.senderId ? `对方（${entry.senderId}）` : '对方')
        const hhmm = `${pad(at.getHours())}:${pad(at.getMinutes())}`
        // One bullet per entry: embedded newlines would break the list shape,
        // so they flatten to a separator.
        const text = String(entry.text ?? '').replace(/\s*\r?\n\s*/g, ' ⏎ ')
        lines.push(`- [${hhmm}] ${who}：${text}`)
    }
    return lines.join('\n')
}

/**
 * Write a Markdown export file under `<stateRoot>/exports/` and return its
 * absolute path. The name carries account, conversation and a timestamp so a
 * second export never overwrites the first.
 */
export function writeChatExport(stateRoot, accountId, conversationId, markdown, { now = Date.now() } = {}) {
    const dir = join(stateRoot, 'exports')
    mkdirSync(dir, { recursive: true })
    const d = new Date(now)
    const safe = (s) => String(s).replace(/[^A-Za-z0-9@._-]/g, '_').slice(0, 60) || 'chat'
    const stamp = `${dayStamp(now).replaceAll('-', '')}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const file = join(dir, `chat-${safe(accountId)}-${safe(conversationId)}-${stamp}.md`)
    writeFileSync(file, markdown, 'utf8')
    return file
}
