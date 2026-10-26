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

export function appendJournal(stateRoot, entry, { warn } = {}) {
    try {
        const at = typeof entry?.at === 'number' ? entry.at : Date.now()
        const text = typeof entry?.text === 'string' ? entry.text.slice(0, MAX_JOURNAL_TEXT_CHARS) : ''
        const line = JSON.stringify({
            at,
            dir: entry.dir === 'out' ? 'out' : 'in',
            accountId: String(entry.accountId ?? ''),
            conversationId: String(entry.conversationId ?? ''),
            senderId: entry.senderId === undefined ? undefined : String(entry.senderId),
            text,
        })
        const dir = join(stateRoot, 'journal')
        mkdirSync(dir, { recursive: true })
        appendFileSync(journalPath(stateRoot, at), line + '\n')
    } catch (error) {
        try { warn?.(`journal append failed: ${String(error)}`) } catch { /* never throw from a journal */ }
    }
}

/** Newest last in the file, newest first in the returned array. */
export function readJournal(stateRoot, { limit = DEFAULT_JOURNAL_LIMIT, accountId, conversationId } = {}) {
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
                out.push(entry)
            } catch { /* skip a torn line */ }
            if (out.length >= limit) return out.slice(0, limit)
        }
    }
    return out.slice(0, limit)
}
