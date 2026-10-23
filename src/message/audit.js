// 工具审计：把「哪个工具、什么参数、被谁触发、结果如何」按天落盘成 JSONL。
// 设计约束与消息流水一致：
// - 追加失败绝不抛错（审计是观测工具，不能反过来弄坏 agent 轮次）；
// - 参数截断到 500 字符，避免一次大文件写入把审计文件撑爆；
// - 按天一个文件（audit-YYYY-MM-DD.jsonl），读取时只取尾部，天然滚动。
//
// 为什么不是 ctx.logger：日志是给运维看的过程流，滚掉就没了；审计要能事后回答
// 「昨天 15:20 是谁让 agent 删了那个目录」。所以它是独立文件、独立保留策略。

import { mkdirSync, appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_AUDIT_ARGS_CHARS = 500
export const DEFAULT_AUDIT_LIMIT = 100

function dayStamp(at) {
    const d = new Date(at)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function auditDir(stateRoot) {
    return join(stateRoot, 'audit')
}

function auditPath(stateRoot, at) {
    return join(auditDir(stateRoot), `audit-${dayStamp(at)}.jsonl`)
}

/**
 * Render a tool call's arguments as one truncated string.
 *
 * `JSON.stringify` can throw on a cyclic or BigInt-bearing value, and a tool
 * argument is arbitrary model output — so a failure degrades to String(), never
 * to a missing audit line.
 */
function renderArgs(args) {
    if (args === undefined) return ''
    let rendered
    try {
        rendered = typeof args === 'string' ? args : JSON.stringify(args)
    } catch {
        rendered = String(args)
    }
    if (rendered === undefined) return ''
    return rendered.length > MAX_AUDIT_ARGS_CHARS ? `${rendered.slice(0, MAX_AUDIT_ARGS_CHARS)}…` : rendered
}

/**
 * Append one audit line.
 *
 * @param {string} stateRoot
 * @param {{ at?: number, kind: 'tool/call' | 'tool/result', accountId?: string,
 *   conversationId?: string, sessionId?: string, senderId?: string,
 *   tool?: string, callId?: string, args?: unknown, ok?: boolean,
 *   aborted?: boolean, durationMs?: number }} entry
 * @param {{ warn?: (line: string) => void }} [options]
 */
export function appendToolAudit(stateRoot, entry, { warn } = {}) {
    try {
        const at = typeof entry?.at === 'number' ? entry.at : Date.now()
        const line = JSON.stringify({
            at,
            kind: entry.kind === 'tool/result' ? 'tool/result' : 'tool/call',
            accountId: String(entry.accountId ?? ''),
            conversationId: String(entry.conversationId ?? ''),
            sessionId: String(entry.sessionId ?? ''),
            senderId: entry.senderId === undefined ? undefined : String(entry.senderId),
            tool: entry.tool === undefined ? undefined : String(entry.tool),
            callId: entry.callId === undefined ? undefined : String(entry.callId),
            args: renderArgs(entry.args),
            ...(typeof entry.ok === 'boolean' ? { ok: entry.ok } : {}),
            // Set when the turn was interrupted, so a reader can tell "the tool
            // reported a failure" from "nobody ever reported: the user stopped
            // it". Kept separate from `ok` for exactly that reason.
            ...(entry.aborted === true ? { aborted: true } : {}),
            ...(typeof entry.durationMs === 'number' ? { durationMs: entry.durationMs } : {}),
        })
        mkdirSync(auditDir(stateRoot), { recursive: true })
        appendFileSync(auditPath(stateRoot, at), line + '\n')
    } catch (error) {
        try {
            warn?.(`tool audit append failed: ${String(error)}`)
        } catch {
            /* never throw from an audit */
        }
    }
}

/**
 * Newest first. A torn or unparsable line is skipped rather than failing the
 * read: the file is appended by a live process, so the last line can be partial.
 *
 * @param {string} stateRoot
 * @param {{ limit?: number, accountId?: string, conversationId?: string }} [options]
 */
export function readToolAudit(stateRoot, { limit = DEFAULT_AUDIT_LIMIT, accountId, conversationId } = {}) {
    const dir = auditDir(stateRoot)
    let files = []
    try {
        files = readdirSync(dir).filter((name) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse()
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
            let entry
            try {
                entry = JSON.parse(lines[i])
            } catch {
                continue // a torn tail line is expected, not an error
            }
            if (accountId !== undefined && entry.accountId !== accountId) continue
            if (conversationId !== undefined && entry.conversationId !== conversationId) continue
            out.push(entry)
            if (out.length >= limit) return out.slice(0, limit)
        }
    }
    return out.slice(0, limit)
}
