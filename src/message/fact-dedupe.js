/**
 * 记忆去重：把「同一件事的两种说法」认出来。
 *
 * 已有的 `addGlobalFact` 只做**完全相同**的判定（大小写与空白归一后比较），
 * 所以「我住在杭州」与「住在杭州这边」会作为两条并存 —— 它们占用了稀缺的
 * 记忆额度（默认 30 条），在提示词里占两行，却只说了一件事。
 *
 * 这里做的是**建议**，不是自动改写：判定为近似的一组会带上一句「要合并成一条吗」，
 * 由人来决定。自动合并记忆的风险是它会悄悄丢掉一个细微区别（「喜欢咖啡」
 * 与「不喜欢咖啡」在分词层面几乎一样），所以这个模块只产出候选，写入仍走
 * `mergeFacts`（由明确的「合并」命令触发）。
 *
 * 判定用的是与 recall 同一套分词：CJK 二元 + 拉丁整词，然后 Jaccard 相似度。
 * 阈值 0.6 是经验值：改一个词（杭州→上海）仍会被认出（同一个句式），
 * 而「喜欢咖啡」和「不喜欢牛奶」不会。
 *
 * @module dsh-weixin/message/fact-dedupe
 */

import { tokenize } from './recall.js'

/** 两个说法的分词集合相似度达到这个值就算「说的可能是一件事」。 */
export const DUPLICATE_SIMILARITY = 0.5
/** 一次最多列几组建议，免得 /memory 被一串问号淹没。 */
export const MAX_DUPLICATE_GROUPS = 3

function normalizeKey(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

// 「我」「你」这类主语在两句话里出现与否几乎不影响「说的是不是一件事」，
// 但二元分词会把它们带进每个搭配（我住、我现、我不），让相似度被语气词拖低。
// 「我住在杭州」与「住在杭州这边」的真正差异在句尾，不在句首。
const STOP_TOKENS = new Set(['我住', '我现', '我不', '我要', '我的', '你住', '你的', '就是'])

function tokenSet(text) {
    const set = new Set()
    for (const token of tokenize(text)) {
        if (STOP_TOKENS.has(token) === false) set.add(token)
    }
    return set
}

/**
 * Similarity plus the reason a pair did or did not qualify. `sameSubject` is
 * the escape hatch: 「在杭州」与「还在杭州住」共享了「杭州」，但换了说法 —— 这种
 * 情况交给模型判断（`memorySimilarityRoute` 开着时），规则只负责找候选。
 *
 * @param {string} a
 * @param {string} b
 * @returns {{ score: number, shared: string[] }}
 */
export function similarityDetail(a, b) {
    const left = tokenSet(a)
    const right = tokenSet(b)
    if (left.size === 0 || right.size === 0) return { score: 0, shared: [] }
    const shared = []
    for (const token of left) if (right.has(token)) shared.push(token)
    return { score: shared.length / (left.size + right.size - shared.length), shared }
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
export function similarity(a, b) {
    return similarityDetail(a, b).score
}

/**
 * Find groups of facts that look like the same statement.
 *
 * Facts are compared pairwise and grouped transitively; a group keeps the order
 * of the input so the caller can address it by the same index /forget uses when
 * every fact is a group of one.
 *
 * @param {Array<{ text: string }>} facts
 * @param {{ threshold?: number, maxGroups?: number }} [options]
 * @returns {Array<{ indexes: number[], texts: string[], score: number }>}
 */
export function findDuplicateFacts(facts, { threshold = DUPLICATE_SIMILARITY, maxGroups = MAX_DUPLICATE_GROUPS, narrow = false } = {}) {
    const list = Array.isArray(facts) ? facts : []
    const parent = list.map((_, index) => index)
    const find = (index) => {
        let root = index
        while (parent[root] !== root) root = parent[root]
        return root
    }
    const union = (a, b) => {
        const rootA = find(a)
        const rootB = find(b)
        if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB)
    }

    const scores = []
    for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
            const detail = similarityDetail(list[i].text, list[j].text)
            // An exact repeat after whitespace/case normalisation is the strongest
            // signal there is, and addGlobalFact already refuses those — but an
            // imported file can carry one, so it belongs here too.
            if (detail.score >= threshold || normalizeKey(list[i].text) === normalizeKey(list[j].text)) {
                union(i, j)
                scores.push({ i, j, score: detail.score, shared: detail.shared })
            }
        }
    }

    const buckets = new Map()
    for (let index = 0; index < list.length; index += 1) {
        const root = find(index)
        if (buckets.has(root) === false) buckets.set(root, [])
        buckets.get(root).push(index)
    }

    const groups = []
    for (const indexes of buckets.values()) {
        if (indexes.length < 2) continue
        if (narrow) {
            // Narrow: a group only counts when the sharing is substantive. Two
            // statements that merely share one common word (「在杭州」/「还在杭州
            // 住」) are the ones a human would call different habits; a pair that
            // shares at least two tokens or half of the shorter one is the
            // phrasing-only repeat this module is for.
            const edges = scores.filter((entry) => indexes.includes(entry.i) && indexes.includes(entry.j))
            const substantial = edges.some((edge) => {
                const shorter = Math.min(tokenSet(list[edge.i].text).size, tokenSet(list[edge.j].text).size)
                return edge.shared.length >= 2 || edge.shared.length >= shorter / 2
            })
            if (substantial === false) continue
        }
        const best = scores
            .filter((entry) => indexes.includes(entry.i) && indexes.includes(entry.j))
            .reduce((max, entry) => Math.max(max, entry.score), 0)
        const shared = new Set()
        for (const entry of scores.filter((edge) => indexes.includes(edge.i) && indexes.includes(edge.j))) {
            for (const token of entry.shared) shared.add(token)
        }
        groups.push({
            indexes: indexes.map((index) => index + 1),
            texts: indexes.map((index) => list[index].text),
            score: Math.round(best * 100) / 100,
            shared: [...shared],
        })
    }
    // Most obviously-duplicate first: a higher score means the two statements
    // share more words, which is what a human would also rank first.
    groups.sort((a, b) => b.score - a.score || a.indexes[0] - b.indexes[0])
    return groups.slice(0, Math.max(0, maxGroups))
}

/**
 * The question `/memory` asks, or `''` when there is nothing to ask.
 *
 * @param {Array<{ indexes: number[], texts: string[] }>} groups
 */
export function formatDuplicateHint(groups) {
    if (Array.isArray(groups) === false || groups.length === 0) return ''
    const lines = ['（这几条看起来说的是同一件事，要合并成一条吗？）']
    for (const group of groups) {
        const numbered = group.indexes.map((index, position) => `${index}. ${group.texts[position]}`).join(' / ')
        lines.push(`- ${numbered}`)
    }
    lines.push(`合并：/memory merge ${groups[0].indexes.join(' ')} —— 我会保留最后确认的那条，其余进「改过的说法」。`)
    return lines.join('\n')
}

/**
 * Merge facts by 1-based index. The statement confirmed most recently is kept;
 * the others are recorded as superseded so `/undo` can bring them back.
 *
 * @param {object} memory  global memory as `readGlobalMemory` returns it
 * @param {number[]} indexes
 * @param {{ now?: number }} [options]
 * @returns {{ ok: boolean, reason?: string, kept?: string, dropped?: string[], removed?: number[] }}
 */
export function mergeFacts(memory, indexes, { now = Date.now() } = {}) {
    const facts = Array.isArray(memory?.facts) ? [...memory.facts] : []
    const positions = [...new Set((Array.isArray(indexes) ? indexes : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= facts.length))]
    if (positions.length < 2) return { ok: false, reason: 'need-two' }

    const stamp = (fact) => Math.max(0, Number(fact?.updatedAt ?? 0) || Number(fact?.at ?? 0) || 0)
    const ranked = positions.map((position) => ({ position, fact: facts[position - 1] }))
        .sort((a, b) => stamp(b.fact) - stamp(a.fact) || b.position - a.position)
    const keep = ranked[0]
    const drop = ranked.slice(1)

    const keptFact = { ...keep.fact, updatedAt: now }
    const nextFacts = []
    for (let index = 0; index < facts.length; index += 1) {
        const position = index + 1
        if (position === keep.position) nextFacts.push(keptFact)
        else if (drop.some((entry) => entry.position === position) === false) nextFacts.push(facts[index])
    }

    const superseded = [
        ...(Array.isArray(memory?.superseded) ? memory.superseded : []),
        ...drop.map((entry) => ({ text: entry.fact.text, by: keptFact.text, at: now })),
    ].slice(-20)

    memory.facts = nextFacts
    memory.superseded = superseded
    memory.history = [
        ...(Array.isArray(memory?.history) ? memory.history : []),
        {
            kind: 'merge',
            text: keptFact.text,
            at: now,
            by: 'merge',
            // Enough to put every dropped fact back exactly as it was.
            restore: drop.map((entry) => ({ text: entry.fact.text, at: entry.fact.at, weight: entry.fact.weight, origin: entry.fact.origin, updatedAt: entry.fact.updatedAt })),
        },
    ].slice(-20)

    return {
        ok: true,
        kept: keptFact.text,
        dropped: drop.map((entry) => entry.fact.text),
        removed: drop.map((entry) => entry.position),
    }
}

/**
 * The prompt the model answers when rules cannot decide.
 *
 * Rules are cheap and explainable, but they cannot see that 「在杭州」and
 * 「还在杭州住」 are the same habit. This asks a side model one narrow question,
 * with both statements verbatim, and demands a two-word answer — anything else
 * counts as "not the same", because the cost of a wrong merge is a lost fact.
 *
 * @param {string} sentinel  A random marker, so the answer can be picked out.
 * @param {string[]} texts
 */
export function buildSimilarityPrompt(sentinel, texts) {
    const list = texts.map((text, index) => `${index + 1}. ${text}`).join('\n')
    return [
        `【记忆去重 · ${sentinel}】`,
        '下面几段是同一台机器人对同一个人的记忆。它们说的是不是同一件事？',
        '',
        '只按这个格式回答，不要解释：',
        '合：1 2',
        '或',
        '不合',
        '',
        '判断标准：把两段换成同一个人会怎么说，如果它们描述的是同一个事实（同一件事的两种说法），'
            + '就回答「合」并写编号；如果它们描述不同的习惯、地点、时间或偏好，回答「不合」。',
        '拿不准的时候一律回答「不合」。',
        '',
        list,
    ].join('\n')
}

/**
 * Read the model's answer.
 *
 * @param {string} answer
 * @param {number} count  How many statements were offered.
 * @returns {{ judgeable: boolean, same: boolean, indexes: number[] }}
 */
export function parseSimilarityAnswer(answer, count) {
    const text = String(answer ?? '')
    if (/不合|不是同一|different|not the same/i.test(text)) return { judgeable: true, same: false, indexes: [] }
    const match = /合[：:]?\s*([\d\s,，]+)/.exec(text)
    if (match === null) return { judgeable: false, same: false, indexes: [] }
    const indexes = [...new Set(match[1].split(/[\s,，]+/).filter((part) => part !== '').map(Number))]
        .filter((index) => Number.isInteger(index) && index >= 1 && index <= count)
    if (indexes.length < 2) return { judgeable: true, same: false, indexes: [] }
    return { judgeable: true, same: true, indexes }
}
