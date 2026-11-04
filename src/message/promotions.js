/**
 * 跨会话升格：某件事在几段不同的聊天里都被提到，就值得进长期记忆。
 *
 * 会话记忆是按会话存的：和 A 聊过的事，B 那条线不知道。长期记忆是全局的，
 * 但它默认只由「记忆整理」在**当前这条线**上写 —— 所以「下个月要搬家」如果在
 * 三个人的线里各说过一次，一次都不会升格。
 *
 * 这个模块只做**建议**：找出在多段会话里出现的同一件事，交给日报说一句
 * 「这几件事在 N 段聊天里都出现过，要不要记成长期记忆」。
 *
 * 三个刻意的取舍：
 *  - 不跨引擎写：升格必须由人确认（一句 `/remember`），因为长期记忆的额度很小，
 *    被自动写满之后，真正重要的那件事就挤不进去了；
 *  - 只数**不同会话**数，不数条数：同一段里说十遍不算十段会话说过；
 *  - 相似度用与去重同一套分词与阈值，两处不会各判各的。
 *
 * @module dsh-weixin/message/promotions
 */

import { readConvMemory } from '../memory.js'
import { readJournalRange } from './chat-export.js'
import { findDuplicateFacts, similarity } from './fact-dedupe.js'

/** 至少要在几段不同的会话里出现过，才值得提。 */
export const PROMOTION_MIN_CONVERSATIONS = 2
/** 一次日报最多提几件，多了就成了噪音。 */
export const MAX_PROMOTIONS = 3
/** 提示里每条截多少字，长句读起来像日志。 */
export const PROMOTION_TEXT_CHARS = 60

function clip(text, max = PROMOTION_TEXT_CHARS) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim()
    return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * Collect conversation facts that recur across different conversations.
 *
 * @param {Array<{ conversationId: string, label?: string, facts: Array<{ text: string }> }>} conversations
 * @param {{ threshold?: number, max?: number, minConversations?: number }} [options]
 * @returns {Array<{ text: string, conversations: string[], labels: string[], score: number, mention: string }>}
 */
export function findPromotionCandidates(conversations, {
    threshold = 0.6,
    max = MAX_PROMOTIONS,
    minConversations = PROMOTION_MIN_CONVERSATIONS,
} = {}) {
    const list = (Array.isArray(conversations) ? conversations : [])
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.conversationId === 'string')
    if (list.length < minConversations) return []

    // Flatten while remembering which conversation each statement came from.
    const flattened = []
    for (const entry of list) {
        for (const fact of Array.isArray(entry.facts) ? entry.facts : []) {
            const text = typeof fact === 'string' ? fact : fact?.text
            if (typeof text !== 'string' || text.trim() === '') continue
            flattened.push({
                text: text.trim(),
                conversationId: entry.conversationId,
                label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.conversationId,
            })
        }
    }
    if (flattened.length < minConversations) return []

    // Union by similar phrasing; the groups come back as 1-based positions in
    // the flattened list, which is the same order `/forget` counts in a line.
    const groups = findDuplicateFacts(flattened, { threshold, maxGroups: flattened.length })
    const candidates = []
    for (const group of groups) {
        const members = group.indexes.map((index) => flattened[index - 1]).filter(Boolean)
        const conversationIds = [...new Set(members.map((member) => member.conversationId))]
        if (conversationIds.length < minConversations) continue
        // The longest phrasing usually carries the most detail; the shortest is
        // the safer label when the longest is a run-on sentence.
        const representative = [...members].sort((a, b) => b.text.length - a.text.length)[0]?.text ?? group.texts[0]
        const labels = [...new Set(members.map((member) => member.label))]
        candidates.push({
            text: clip(representative),
            conversations: conversationIds,
            labels,
            score: group.score,
            mention: `（${conversationIds.length} 段聊天里都提到过）`,
        })
    }

    // Strongest first, then by how many conversations back it: a statement that
    // came up in three lines is a bigger deal than one repeated in two.
    candidates.sort((a, b) => b.conversations.length - a.conversations.length || b.score - a.score)
    return candidates.slice(0, Math.max(0, max))
}

/**
 * Which conversations actually have a conversation memory file.
 *
 * `listConvMemories` only lists lines with a summary, a fact or a bond — a line
 * can be talked in for a week and still have none, so the candidate set must
 * not be "the files that exist".
 */
export function conversationIdsWithMemory(stateRoot, accountId, { days = 30, now = Date.now() } = {}) {
    const ids = new Set()
    for (const entry of readJournalRange(stateRoot, { accountId, days, now })) {
        const id = String(entry?.conversationId ?? '')
        if (id !== '') ids.add(id)
    }
    return [...ids]
}

/**
 * Gather every conversation's facts for one account. A line with no memory file
 * simply contributes nothing.
 *
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ days?: number, now?: number, warn?: (line: string) => void }} [options]
 */
export function readConversationFacts(stateRoot, accountId, { days = 30, now = Date.now(), warn = () => {} } = {}) {
    return conversationIdsWithMemory(stateRoot, accountId, { days, now }).map((conversationId) => {
        const memory = readConvMemory(stateRoot, accountId, conversationId, { warn })
        return {
            conversationId,
            label: conversationId,
            facts: Array.isArray(memory?.facts) ? memory.facts : [],
            summary: typeof memory?.summary === 'string' ? memory.summary : '',
            at: Number(memory?.lastAt ?? 0) || 0,
        }
    }).filter((entry) => entry.facts.length > 0)
}

/**
 * One line for the digest, or `''` when there is nothing worth promoting.
 *
 * Phrased as a question, never as an automatic write: the user expects the
 * digest to report, not to change what the bot remembers.
 *
 * @param {Array<{ text: string, conversations: string[], mention?: string }>} candidates
 */
export function formatPromotionHint(candidates) {
    if (Array.isArray(candidates) === false || candidates.length === 0) return ''
    const lines = ['🗂 这几件事在不止一段聊天里出现过，要不要记成长期记忆？']
    for (const item of candidates) {
        lines.push(`- ${item.text}${item.mention ?? ''}`)
    }
    lines.push('要记的话发一句 /remember 原文就行；不记也没关系，下次还会再提一次。')
    return lines.join('\n')
}

/**
 * Whether two statements belong to the same conversation thread — used by the
 * digest to skip promoting something already in global memory.
 *
 * @param {string} a
 * @param {string} b
 * @param {number} [threshold]
 */
export function sameStatement(a, b, threshold = 0.6) {
    return similarity(a, b) >= threshold
}

/**
 * Drop candidates the user already has as a global fact (no point asking).
 *
 * @param {Array<{ text: string }>} candidates
 * @param {Array<{ text: string }>} globalFacts
 * @param {{ threshold?: number }} [options]
 */
export function withoutKnown(candidates, globalFacts, { threshold = 0.6 } = {}) {
    const known = (Array.isArray(globalFacts) ? globalFacts : [])
        .map((fact) => (typeof fact === 'string' ? fact : fact?.text))
        .filter((text) => typeof text === 'string' && text.trim() !== '')
    return (Array.isArray(candidates) ? candidates : [])
        .filter((candidate) => known.every((text) => sameStatement(candidate.text, text, threshold) === false))
}