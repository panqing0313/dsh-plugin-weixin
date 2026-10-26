/**
 * 本地回忆检索（recall）：把消息流水做成可按需查询的倒排索引。
 *
 * 为什么要有它：消息流水（journal）本来就一条不落地存在本地，问题是「查不到」——
 * 摘要是有损的，事实是手工整理的，冷启动窗口只覆盖最近几条。于是历史越长，回忆越糊。
 * 这里补的是最后一块：全量留在磁盘上，检索按需发生。
 *
 * 设计要点：
 * - 纯 JS、零依赖：中文按二元切片（bigram），英文/数字按词；
 * - 索引落在 <stateRoot>/memory/index/<账号>.json，按天文件分片，只增量追加新行；
 * - 查询用 BM25 打分（词频饱和 + 文档长度归一 + 只在窗口内统计 df）；
 * - 正文不复制进索引：命中后再按 (文件, 行号) 回读原文，索引因此只有词表那么大。
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const RECALL_INDEX_VERSION = 1
export const DEFAULT_RECALL_DAYS = 180
export const DEFAULT_RECALL_HITS = 3
export const DEFAULT_RECALL_TEXT_CHARS = 140
const INDEX_DIR = 'index'
const JOURNAL_FILE_RE = /^journal-(\d{4}-\d{2}-\d{2})\.jsonl$/

/** BM25 参数：k1 控制词频饱和，b 控制长度归一强度。 */
const K1 = 1.2
const B = 0.75

/** 抓到这些词，说明用户在追问过去的事，值得花钱检索一次。 */
const RECALL_CUES = /(上次|上回|上一回|之前|以前|那次|那天|那时候|当时|我说过|我说的是|提过|还记得|记得我|前几天|昨天|前天|上周|上个月|早先|原先|原来那个|那个报错|那个文件|那个方案)/

function safeName(value) {
    return String(value ?? '').replace(/[^A-Za-z0-9@._-]/g, '_').slice(0, 120) || '_'
}

function dayStamp(at) {
    const d = new Date(at)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function stampOf(at) {
    const d = new Date(at)
    const pad = (n) => String(n).padStart(2, '0')
    return `${dayStamp(at)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function indexFilePath(stateRoot, accountId) {
    return join(stateRoot, 'memory', INDEX_DIR, `${safeName(accountId)}.json`)
}

/**
 * 中英混合分词：CJK 连续段切二元（「上次那个报错」→ 上次/次那/那个/个报/报错），
 * 拉丁字母与数字整段当一个词（太短的丢掉，避免 "a" 命中一切）。
 */
export function tokenize(text) {
    const out = []
    const normalized = String(text ?? '').toLowerCase()
    for (const match of normalized.matchAll(/[\u4e00-\u9fff]+|[a-z0-9_]+/g)) {
        const run = match[0]
        if (/^[a-z0-9_]+$/.test(run)) {
            if (run.length >= 2) out.push(run)
            continue
        }
        if (run.length === 1) {
            out.push(run)
            continue
        }
        for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2))
    }
    return out
}

function emptyIndex() {
    return { version: RECALL_INDEX_VERSION, files: {} }
}

function readIndexFile(stateRoot, accountId) {
    try {
        const parsed = JSON.parse(readFileSync(indexFilePath(stateRoot, accountId), 'utf8'))
        if (parsed?.version !== RECALL_INDEX_VERSION || typeof parsed.files !== 'object' || parsed.files === null) {
            return emptyIndex()
        }
        return parsed
    } catch {
        // 索引是纯派生数据：坏了大不了重建，绝不向调用方抛错。
        return emptyIndex()
    }
}

function writeIndexFile(stateRoot, accountId, index) {
    const file = indexFilePath(stateRoot, accountId)
    mkdirSync(join(stateRoot, 'memory', INDEX_DIR), { recursive: true })
    writeFileSync(file, JSON.stringify(index))
}

function journalDir(stateRoot) {
    return join(stateRoot, 'journal')
}

/** 窗口内的流水文件，按日期升序（旧→新），只保留最近 days 天。 */
function journalFilesInWindow(stateRoot, { days, now }) {
    const cutoff = new Date(now)
    cutoff.setHours(0, 0, 0, 0)
    cutoff.setDate(cutoff.getDate() - (Math.max(1, days) - 1))
    const cutoffDay = dayStamp(cutoff.getTime())
    let names = []
    try {
        names = readdirSync(journalDir(stateRoot)).filter((name) => JOURNAL_FILE_RE.test(name))
    } catch {
        return []
    }
    return names
        .filter((name) => {
            const day = JOURNAL_FILE_RE.exec(name)[1]
            return day >= cutoffDay
        })
        .sort()
}

function readLines(stateRoot, name) {
    try {
        return readFileSync(join(journalDir(stateRoot), name), 'utf8').split('\n').filter((line) => line !== '')
    } catch {
        return []
    }
}

/** 给一行流水建索引：返回 { meta, postings }，解析失败返回 null（撕裂的行直接跳过）。 */
function indexLine(line, lineNo, onlyAccountId) {
    let entry
    try {
        entry = JSON.parse(line)
    } catch {
        return null
    }
    if (onlyAccountId !== undefined && String(entry?.accountId ?? '') !== onlyAccountId) return null
    const text = typeof entry?.text === 'string' ? entry.text : ''
    if (text === '') return null
    // 指令不是聊天内容：把 /recall 自己、/mode 之类的行排掉，否则一次检索
    // 会先命中刚发出去的那条命令。
    if (text.startsWith('/')) return null
    const terms = tokenize(text)
    if (terms.length === 0) return null
    const meta = {
        l: lineNo,
        at: typeof entry.at === 'number' ? entry.at : 0,
        dir: entry.dir === 'out' ? 'out' : 'in',
        a: String(entry.accountId ?? ''),
        c: String(entry.conversationId ?? ''),
        n: terms.length,
    }
    const postings = {}
    for (const term of terms) {
        if (postings[term] === undefined) postings[term] = []
        postings[term].push(lineNo)
    }
    return { meta, postings }
}

/**
 * 确保索引跟上磁盘：新出现的天文件整文件索引，变长的文件只补新增的行，
 * 滑出窗口或变短的文件整段丢弃（流水只追加，变短只可能是被手工改过）。
 */
export function ensureIndex(stateRoot, { accountId, days = DEFAULT_RECALL_DAYS, now = Date.now(), warn } = {}) {
    // 一个账号一份索引；'_all' 表示不分账号（设置卡里的全量检索用）。
    const onlyAccountId = accountId === '_all' ? undefined : accountId
    const index = readIndexFile(stateRoot, accountId)
    const files = journalFilesInWindow(stateRoot, { days, now })
    const keep = new Set(files)
    let changed = false

    for (const name of Object.keys(index.files)) {
        if (!keep.has(name)) {
            delete index.files[name]
            changed = true
        }
    }

    for (const name of files) {
        const lines = readLines(stateRoot, name)
        const current = index.files[name]
        if (current !== undefined && current.lines === lines.length) continue
        // 新文件 / 追加了新行 / 文件被改短：便宜起见，从零索引这一个文件。
        if (current !== undefined && current.lines < lines.length) {
            const start = current.lines
            for (let i = start; i < lines.length; i += 1) {
                const indexed = indexLine(lines[i], i, onlyAccountId)
                if (indexed === null) continue
                current.meta.push(indexed.meta)
                for (const [term, where] of Object.entries(indexed.postings)) {
                    if (current.postings[term] === undefined) current.postings[term] = []
                    current.postings[term].push(...where)
                }
            }
            current.lines = lines.length
            changed = true
            continue
        }
        const meta = []
        const postings = {}
        for (let i = 0; i < lines.length; i += 1) {
            const indexed = indexLine(lines[i], i, onlyAccountId)
            if (indexed === null) continue
            meta.push(indexed.meta)
            for (const [term, where] of Object.entries(indexed.postings)) {
                if (postings[term] === undefined) postings[term] = []
                postings[term].push(...where)
            }
        }
        index.files[name] = { lines: lines.length, meta, postings }
        changed = true
    }

    if (changed) {
        try {
            writeIndexFile(stateRoot, accountId, index)
        } catch (error) {
            try { warn?.(`recall index write failed: ${String(error)}`) } catch { /* never throw */ }
        }
    }
    return index
}

function readJournalLine(stateRoot, name, lineNo) {
    const lines = readLines(stateRoot, name)
    const line = lines[lineNo]
    if (line === undefined) return null
    try {
        return JSON.parse(line)
    } catch {
        return null
    }
}

/**
 * 查历史原文。返回按分数降序的前 limit 条：
 * { at, dir, accountId, conversationId, text, score, matched }
 */
export function queryRecall(stateRoot, query, {
    accountId, conversationId, days = DEFAULT_RECALL_DAYS, now = Date.now(),
    limit = DEFAULT_RECALL_HITS, textChars = DEFAULT_RECALL_TEXT_CHARS,
    excludeAt, excludeText, warn,
} = {}) {
    const terms = [...new Set(tokenize(query))]
    if (terms.length === 0) return []
    const indexName = accountId === undefined ? '_all' : accountId
    const index = ensureIndex(stateRoot, { accountId: indexName, days, now, warn })

    // 先把窗口内所有行摊平，统计文档总数、平均长度与每个词的文档频率。
    const metaByFile = new Map()
    const docs = []
    for (const [name, file] of Object.entries(index.files)) {
        const byLine = new Map(file.meta.map((meta) => [meta.l, meta]))
        metaByFile.set(name, byLine)
        for (const meta of file.meta) docs.push({ name, meta })
    }
    if (docs.length === 0) return []
    const avgLen = docs.reduce((sum, doc) => sum + doc.meta.n, 0) / docs.length || 1

    const df = {}
    for (const term of terms) {
        let count = 0
        for (const file of Object.values(index.files)) {
            if (file.postings[term] !== undefined) count += new Set(file.postings[term]).size
        }
        df[term] = count
    }

    const scores = new Map()
    for (const term of terms) {
        if (df[term] === 0) continue
        // 在窗口内到处都出现的词没有区分度，idf 压到接近 0 而不是变成负数。
        const idf = Math.max(0.05, Math.log(1 + (docs.length - df[term] + 0.5) / (df[term] + 0.5)))
        for (const [name, file] of Object.entries(index.files)) {
            const lines = file.postings[term]
            if (lines === undefined) continue
            const tf = new Map()
            for (const lineNo of lines) tf.set(lineNo, (tf.get(lineNo) ?? 0) + 1)
            for (const [lineNo, freq] of tf) {
                const meta = metaByFile.get(name)?.get(lineNo)
                if (meta === undefined) continue
                if (accountId !== undefined && meta.a !== accountId) continue
                if (conversationId !== undefined && meta.c !== conversationId) continue
                const norm = 1 - B + B * (meta.n / avgLen)
                const key = `${name}#${lineNo}`
                const prev = scores.get(key) ?? { meta, name, lineNo, score: 0, matched: 0 }
                prev.score += idf * ((freq * (K1 + 1)) / (freq + K1 * norm))
                prev.matched += 1
                scores.set(key, prev)
            }
        }
    }

    const ranked = [...scores.values()].sort((a, b) => b.score - a.score)
    const hits = []
    for (const candidate of ranked) {
        if (hits.length >= limit) break
        const entry = readJournalLine(stateRoot, candidate.name, candidate.lineNo)
        if (entry === null) continue
        if (excludeAt !== undefined && entry.at === excludeAt) continue
        if (typeof excludeText === 'string' && excludeText !== '' && entry.text === excludeText) continue
        const text = typeof entry.text === 'string' ? entry.text : ''
        if (text === '') continue
        hits.push({
            at: entry.at,
            dir: entry.dir === 'out' ? 'out' : 'in',
            accountId: entry.accountId,
            conversationId: entry.conversationId,
            text: text.length > textChars ? `${text.slice(0, textChars)}…` : text,
            score: candidate.score,
            matched: candidate.matched,
        })
    }
    return hits
}

/**
 * 该不该为这条消息花检索 token：提到「上次/之前」之类的旧事就必须查；
 * 否则只在命中够密（≥2 个词面 + 分数过线）时才查，闲聊一律不查。
 */
export function shouldRecall(text, hits) {
    if (!Array.isArray(hits) || hits.length === 0) return false
    const source = String(text ?? '')
    if (RECALL_CUES.test(source)) return true
    const best = hits[0]
    return best.matched >= 2 && best.score >= 3
}

/** 注入用的块：只给原文和日期，并明确告诉模型这是按需检索的、可能无关。 */
export function buildRecallBlock(hits, { now } = {}) {
    if (!Array.isArray(hits) || hits.length === 0) return ''
    const lines = hits.map((hit) => {
        const who = hit.dir === 'out' ? '助手' : '用户'
        return `[${stampOf(typeof hit.at === 'number' ? hit.at : now)}] ${who}：${hit.text}`
    })
    return [
        '<weixin_recall>',
        '以下是从本地历史消息里按关键词检索到的原文片段，可能和当前问题相关，也可能只是词面巧合；用它补充细节，不要强行引用：',
        ...lines,
        '</weixin_recall>',
    ].join('\n')
}

/** /recall 的纯文本回显（不经过模型，0 token）。 */
export function formatRecallHits(hits, { query } = {}) {
    if (!Array.isArray(hits) || hits.length === 0) {
        return `没有在本地流水里找到和「${query ?? ''}」相关的消息。`
    }
    const lines = hits.map((hit, index) => {
        const who = hit.dir === 'out' ? '我' : '对方'
        return `${index + 1}. [${stampOf(hit.at)}] ${who}：${hit.text}`
    })
    return [`找到 ${hits.length} 条和「${query ?? ''}」相关的记录：`, ...lines].join('\n')
}
