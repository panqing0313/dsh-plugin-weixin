/**
 * 记忆冲突检测。
 *
 * 模型抽出来的事实已经能靠 `supersedes` 自我纠正，但那只在它「意识到两条
 * 矛盾」时生效。用户亲口 `/remember 我住在上海`，而记忆里已经有一条「我住在
 * 杭州」时，两条会并排躺着，注入时模型拿到两份互相打架的说法，只能瞎选一份。
 *
 * 这里做的是**同槽位**比较：两句话长得很像、只有少数几个词不同（「我住在
 * 杭州」/「我住在上海」），就把它们当成同一个属性的两个取值 —— 新的应当问
 * 一句要不要替换旧的，而不是默默并存。
 *
 * 刻意保守：词数太少的句子不比（「早安」和「晚安」不冲突），只差一个字的短
 * 句也比（「我住杭州」/「我住上海」差一个字，但那是换城市）。宁可漏问一次，
 * 也不要天天问「要不要替换」把用户烦死。
 *
 * @module dsh-weixin/message/memory-conflict
 */

/** 少于这么多词的句子不参与比较：短句相似度噪声太大。 */
export const MIN_CONFLICT_WORDS = 3
/** 词数差超过这个比例的句子不是同一个槽位。 */
export const MAX_WORD_COUNT_RATIO = 0.5
/** 不同词数不超过这么多，才算「同一句话改了几个词」。 */
export const MAX_CONFLICT_DIFF = 2

/**
 * Split a fact into comparable words. CJK is cut into **bigrams** rather than
 * single characters: 「杭州」/「上海」 differ in both characters, and a single
 * changed character inside a two-character word (「跑步」/「跑」) would otherwise
 * count as a whole extra mismatch. Bigrams are the usual cheap segmentation for
 * Chinese and keep the edit distance proportional to what actually changed.
 * Latin/digit runs stay whole words.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function conflictWords(text) {
    const words = []
    const source = String(text ?? '').toLowerCase()
    const pattern = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[a-z0-9]+/g
    for (const match of source.matchAll(pattern)) {
        const run = match[0]
        if (/[a-z0-9]/.test(run)) {
            words.push(run)
            continue
        }
        if (run.length === 1) {
            words.push(run)
            continue
        }
        for (let index = 0; index + 1 < run.length; index += 1) words.push(run.slice(index, index + 2))
    }
    return words
}

/**
 * Find the recorded fact that this new one most likely contradicts.
 *
 * @param {string} candidate  the fact about to be stored
 * @param {{ text: string }[]} facts  already stored facts
 * @returns {{ text: string, index: number, distance: number } | undefined}
 *   `index` is 1-based, matching what /memory and /forget show.
 */
export function findMemoryConflict(candidate, facts) {
    const next = conflictWords(candidate)
    if (next.length < MIN_CONFLICT_WORDS) return undefined
    let best
    const list = Array.isArray(facts) ? facts : []
    for (let position = 0; position < list.length; position += 1) {
        const previous = conflictWords(list[position]?.text)
        if (previous.length < MIN_CONFLICT_WORDS) continue
        const distance = wordDistance(next, previous)
        if (distance > MAX_CONFLICT_DIFF) continue
        const longest = Math.max(next.length, previous.length)
        const shortest = Math.min(next.length, previous.length)
        if (longest === 0 || shortest / longest < MAX_WORD_COUNT_RATIO) continue
        // Identical means "already recorded", which /remember reports as a
        // duplicate; asking whether to replace a fact with itself is noise.
        if (distance === 0) continue
        if (best === undefined || distance < best.distance) {
            best = { text: String(list[position]?.text ?? ''), index: position + 1, distance }
        }
    }
    return best
}

/** Levenshtein distance over word arrays (bounded input, so plain DP is fine). */
function wordDistance(a, b) {
    let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index)
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i]
        for (let j = 1; j <= b.length; j += 1) {
            const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution)
        }
        previous = current
    }
    return previous[b.length]
}

/**
 * A pending "this one looks like it replaces that one" question. Kept in memory
 * only: a question nobody answers must expire with the process, never sit in a
 * file and fire a week later.
 */
export class MemoryConflictQueue {
    /** @param {{ ttlMs?: number, now?: () => number }} [options] */
    constructor({ ttlMs = 10 * 60_000, now = () => Date.now() } = {}) {
        this.ttlMs = ttlMs
        this.now = now
        /** @type {Map<string, { text: string, supersedes: string[], askedAt: number }>} */
        this.pending = new Map()
    }

    /**
     * @param {string} accountId
     * @param {{ text: string, supersedes: string[] }} request
     */
    ask(accountId, { text, supersedes }) {
        this.pending.set(String(accountId), { text, supersedes: [...supersedes], askedAt: this.now() })
        return this
    }

    /**
     * @param {string} accountId
     * @returns {{ text: string, supersedes: string[] } | undefined}
     */
    take(accountId) {
        const key = String(accountId)
        const entry = this.pending.get(key)
        if (entry === undefined) return undefined
        this.pending.delete(key)
        if (this.now() - entry.askedAt > this.ttlMs) return undefined
        return { text: entry.text, supersedes: entry.supersedes }
    }

    /** @param {string} accountId */
    clear(accountId) {
        this.pending.delete(String(accountId))
    }
}

/**
 * The sentence the bot sends when it finds a conflict.
 *
 * @param {{ text: string, supersedes: string[] }} conflict
 * @param {string | undefined} answer  'yes' / 'no' when the user already replied
 * @returns {string}
 */
export function conflictReply(conflict, answer) {
    const old = conflict.supersedes[0] ?? ''
    if (answer === 'yes') return `好，那就改成「${conflict.text}」。`
    if (answer === 'no') return `那我还是记着「${old}」，这条先不记。`
    return `我记得你说过「${old}」。现在要改成「${conflict.text}」吗？回「是」我就换掉，回「不用」我就保留原来的。`
}

/**
 * Whether a message is a yes/no answer to the last question. Only exact、短句
 * 才算：一句长话里带个「是」字，多半是在说别的事。
 *
 * @param {string} text
 * @returns {'yes' | 'no' | undefined}
 */
export function parseConflictAnswer(text) {
    // The slash form is how the router recognises the answer (`/是`), so the
    // parser strips it too — otherwise the command arrives here and is read as
    // neither yes nor no, which silently drops the question.
    const source = String(text ?? '').trim().replace(/^\//, '').toLowerCase().replace(/[。！!？?，,、\s]/g, '')
    if (source === '') return undefined
    if (['是', '是的', '对', '对的', '嗯', '嗯嗯', '好', '好的', '改', '改成', '换', '换掉', 'yes', 'y', 'sure', 'ok'].includes(source)) return 'yes'
    if (['不用', '不是', '不', '别', 'no', 'n', '算了', '保留', '留着', '别改'].includes(source)) return 'no'
    return undefined
}