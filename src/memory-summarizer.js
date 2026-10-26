/**
 * The background memory worker (P2 of the persona/memory feature, extended in
 * v2 with structured extraction and consolidation).
 *
 * After every `memorySummaryTurns` settled agent turns in a conversation it
 * runs ONE side-session prompt that returns a small JSON object: a rolling
 * summary, new durable facts about the person, dated events, and profile fields
 * (how to address them, their schedule, likes and dislikes). That is how memory
 * fills itself in — nothing has to be typed in by hand.
 *
 * A second pass, consolidation, runs at most every few hours and only when the
 * fact list has grown large: it merges duplicates into a short 人物小传 and a
 * tighter fact list. Left alone, a fact list only ever grows, and a long list is
 * both expensive to inject and worse at answering.
 *
 * Everything reaches future prompts through `buildMemoryBlock`; the worker
 * never sends outbound, so the user never sees it run. Failures are logged and
 * swallowed — memory is an enhancement, and a failed summary must never take
 * down a reply that already went out.
 *
 * @module dsh-weixin/memory-summarizer
 */

import {
    DEFAULT_MEMORY_CONV_MAX_CHARS,
    DEFAULT_MEMORY_GLOBAL_MAX_FACTS,
    addEvent,
    addGlobalFact,
    bumpTurnAndBond,
    readConvMemory,
    readGlobalMemory,
    readRecentWindow,
    replaceFacts,
    saveProfile,
    setConvSummary,
    setDigest,
} from './memory.js'

const noopWarn = () => {}

/** Consolidation only runs once the fact list is long enough to be worth it. */
export const CONSOLIDATE_MIN_FACTS = 10
/** …and at most this often, so a chatty day cannot rewrite the digest hourly. */
export const CONSOLIDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Facts the model inferred itself are more durable than an offhand line. */
export const EXTRACTED_FACT_WEIGHT = 4
export const MAX_EXTRACTED_FACTS = 3
export const MAX_EXTRACTED_EVENTS = 3

const unique = (items) => [...new Set(items.map((item) => String(item).trim()).filter((item) => item !== ''))]

/**
 * Pull the JSON object out of a model reply.
 *
 * The prompt asks for bare JSON, but models like to wrap it in a code fence or
 * prefix it with a sentence, so the outermost `{…}` is what gets parsed. A
 * reply that is not JSON at all returns undefined, and the caller falls back to
 * treating the whole text as a plain summary (the pre-v2 behaviour) — an old
 * side session, or a model that ignored the instruction, must not lose the
 * summary entirely.
 *
 * @param {string} text
 * @returns {{ summary: string, facts: string[], events: {text: string, when: string}[], profile: object } | undefined}
 */
export function parseMemoryReply(text) {
    const source = String(text ?? '').trim()
    if (source === '') return undefined
    const start = source.indexOf('{')
    const end = source.lastIndexOf('}')
    if (start === -1 || end <= start) return undefined
    let parsed
    try {
        parsed = JSON.parse(source.slice(start, end + 1))
    } catch {
        return undefined
    }
    if (parsed === null || typeof parsed !== 'object') return undefined
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 1200) : ''
    const facts = Array.isArray(parsed.facts)
        ? unique(parsed.facts.map((entry) => (typeof entry === 'string' ? entry : entry?.text)))
            .filter((entry) => entry.length <= 120)
            .slice(0, MAX_EXTRACTED_FACTS)
        : []
    const events = Array.isArray(parsed.events)
        ? parsed.events
            .map((entry) => (entry !== null && typeof entry === 'object'
                ? { text: String(entry.text ?? '').trim().slice(0, 120), when: String(entry.when ?? '').trim() }
                : undefined))
            .filter((entry) => entry !== undefined && entry.text !== '')
            .slice(0, MAX_EXTRACTED_EVENTS)
        : []
    const profile = parsed.profile !== null && typeof parsed.profile === 'object' ? parsed.profile : {}
    return { summary, facts, events, profile }
}

/** Union-merge a profile patch so an inference pass never erases the card's edits. */
function mergeProfile(current, patch) {
    const next = {
        call: current.call,
        schedule: current.schedule,
        likes: [...current.likes],
        dislikes: [...current.dislikes],
        dates: [...current.dates],
    }
    for (const key of ['call', 'schedule']) {
        const value = typeof patch?.[key] === 'string' ? patch[key].trim() : ''
        if (value !== '') next[key] = value.slice(0, 200)
    }
    for (const key of ['likes', 'dislikes']) {
        const incoming = Array.isArray(patch?.[key]) ? patch[key].map((item) => String(item ?? '')) : []
        next[key] = unique([...next[key], ...incoming]).slice(0, 10)
    }
    for (const entry of Array.isArray(patch?.dates) ? patch.dates : []) {
        const label = typeof entry?.label === 'string' ? entry.label.trim() : ''
        const date = typeof entry?.date === 'string' ? entry.date.trim() : ''
        if (label === '' || /^\d{4}-\d{2}-\d{2}$/.test(date) === false) continue
        if (next.dates.some((existing) => existing.label === label)) continue
        next.dates.push({ label, date })
    }
    next.dates = next.dates.slice(0, 10)
    return next
}

/**
 * @param {object} params
 * @param {any} params.bridge AgentBridge — `summarize()` is the only method used.
 * @param {string} params.stateRoot
 * @param {() => any} params.config returns the CURRENT effective config (must
 *   be re-read per call: the settings card can change the knobs live)
 * @param {() => ({ provider: string, model: string } | undefined)} [params.route]
 *   the memory model: summary and consolidation run on it instead of the
 *   conversation's model. Undefined means "follow the conversation".
 * @param {{ log?: (line: string) => void, errLog?: (line: string) => void }} [params.logger]
 */
export function createMemorySummarizer({ bridge, stateRoot, config, route, logger = {} }) {
    const log = logger.log ?? noopWarn
    const errLog = logger.errLog ?? noopWarn
    // One summary in flight per conversation: turns settle serially, but a
    // slow summary easily spans the NEXT turn, and two concurrent side-session
    // prompts for one conversation would interleave garbage.
    const inFlight = new Set()
    const consolidating = new Set()

    const memoryRoute = () => {
        try {
            return route?.()
        } catch (error) {
            errLog(`memory route lookup failed: ${String(error)}`)
            return undefined
        }
    }

    /**
     * Count one settled agent turn and fire a summary at the configured
     * cadence. Fire-and-forget: resolves before the summary finishes.
     *
     * @param {string} accountId owning bot account
     * @param {string} conversationId
     */
    function afterTurn(accountId, conversationId) {
        const current = config()
        // The counter counts real agent turns regardless of the toggle, so
        // re-enabling memory mid-conversation keeps a meaningful cadence. The
        // affinity bond rides the same write (zero extra IO).
        const bumped = bumpTurnAndBond(stateRoot, accountId, conversationId, { warn: errLog })
        const turn = bumped.turn

        const every = Math.max(1, Number(current.memorySummaryTurns) || 10)
        if (current.memoryEnabled !== true) return
        if (turn % every !== 0) return
        if (inFlight.has(conversationId)) return

        inFlight.add(conversationId)
        void summarizeNow(accountId, conversationId, turn, current).finally(() => {
            inFlight.delete(conversationId)
        })
    }

    async function summarizeNow(accountId, conversationId, turn, current) {
        try {
            const prior = readConvMemory(stateRoot, accountId, conversationId, { warn: errLog })
            const store = readGlobalMemory(stateRoot, accountId, { warn: errLog })
            const recent = readRecentWindow(stateRoot, accountId, conversationId, {
                turns: 10,
                textChars: 200,
            })
            const transcript = recent
                .map((entry) => `${entry.dir === 'in' ? '用户' : '助手'}：${entry.text}`)
                .join('\n')
            if (transcript === '') return
            const maxChars = Number(current.memoryConvMaxChars) || DEFAULT_MEMORY_CONV_MAX_CHARS
            const known = [
                ...(store.digest === '' ? [] : [store.digest]),
                ...store.facts.map((fact) => `- ${fact.text}`),
            ].join('\n')
            const prompt = [
                '你要为一段微信聊天维护长期记忆。下面是最近的对话记录，以及已经记下的东西。',
                '只输出一个 JSON 对象，不要代码块、不要解释。字段：',
                '{"summary": "这段会话的摘要，包含正在聊的话题、正在做的事、已经决定的事",',
                ' "facts": ["值得长期记住的关于对方的事实，最多三条；没有就给空数组"],',
                ' "events": [{"text": "约定要做或需要提醒的事", "when": "YYYY-MM-DD，没有明确日期就填空字符串"}],',
                ' "profile": {"call": "对方希望怎么被称呼，没有就空字符串",',
                '             "schedule": "对方作息的一句话，例如 早上七点起、夜里两点睡",',
                '             "likes": ["喜欢的东西"], "dislikes": ["不喜欢或忌口的东西"],',
                '             "dates": [{"label": "生日", "date": "YYYY-MM-DD"}]}}',
                `摘要不超过 ${Math.min(400, maxChars)} 字。facts 只写对方本人身上、以后还用得上的信息，不要把这次的闲聊复述一遍。`,
                '没有内容可填的字段留空字符串或空数组，不要编造。',
                '',
                '【已经记下的】',
                known === '' ? '（还没有）' : known,
                '',
                '【已有摘要】',
                prior.summary === '' ? '（还没有）' : prior.summary,
                '',
                '【最近对话】',
                transcript,
            ].join('\n')
            const result = await bridge.summarize({
                conversationId,
                accountId,
                prompt,
                route: memoryRoute(),
            })
            if (result === undefined) return
            const text = String(result.text ?? '').trim()
            if (text === '' || text === '（已取消）') return

            const extracted = parseMemoryReply(text)
            if (extracted === undefined) {
                // Old side sessions (and models that ignore the JSON shape) still
                // contribute their summary as plain text.
                setConvSummary(stateRoot, accountId, conversationId, text, { warn: errLog })
                log(`memory: conversation ${conversationId} summarized at turn ${turn}`)
                return
            }

            if (extracted.summary !== '') {
                setConvSummary(stateRoot, accountId, conversationId, extracted.summary, { warn: errLog })
            }
            const maxFacts = Number(current.memoryGlobalMaxFacts) || DEFAULT_MEMORY_GLOBAL_MAX_FACTS
            for (const fact of extracted.facts) {
                addGlobalFact(stateRoot, accountId, fact, { warn: errLog, weight: EXTRACTED_FACT_WEIGHT, maxFacts })
            }
            for (const event of extracted.events) {
                addEvent(stateRoot, accountId, event, { warn: errLog })
            }
            const patch = extracted.profile ?? {}
            const hasProfile = ['call', 'schedule'].some((key) => typeof patch[key] === 'string' && patch[key].trim() !== '')
                || ['likes', 'dislikes', 'dates'].some((key) => Array.isArray(patch[key]) && patch[key].length > 0)
            if (hasProfile) {
                saveProfile(stateRoot, accountId, mergeProfile(store.profile, patch), { warn: errLog })
            }
            log(`memory: conversation ${conversationId} summarized at turn ${turn}`
                + ` (+${extracted.facts.length} facts, +${extracted.events.length} events)`)
            void consolidate(accountId, conversationId).catch((error) => {
                errLog(`memory consolidation failed: ${String(error)}`)
            })
        } catch (error) {
            errLog(`memory summary failed for ${conversationId}: ${String(error)}`)
        }
    }

    /**
     * Merge the fact list into a 人物小传. Runs on its own schedule (not every
     * summary) and rewrites the whole fact list, which is why it is the only
     * caller of `replaceFacts`.
     */
    async function consolidate(accountId, conversationId) {
        if (consolidating.has(accountId)) return
        const store = readGlobalMemory(stateRoot, accountId, { warn: errLog })
        if (store.facts.length < CONSOLIDATE_MIN_FACTS) return
        if (Date.now() - store.digestAt < CONSOLIDATE_INTERVAL_MS) return
        consolidating.add(accountId)
        try {
            const prompt = [
                '你要整理一份关于某人的长期记忆。下面是一堆零散记下的事实，以及之前的小传（可能没有）。',
                '请把它们合并去重：同一件事只留一条，更具体的说法优先，互相矛盾的以最近的为准。',
                '只输出一个 JSON 对象，不要代码块、不要解释：',
                '{"digest": "一段 200 字以内的人物小传，写成一段连贯的话，说清这个人是谁、怎么相处、在意什么",',
                ' "facts": [{"text": "一条保留下来的事实", "weight": 1到5之间的重要度}]}',
                'facts 最多 10 条，按重要度从高到低。不要编造没记过的事。',
                '',
                '【之前的小传】',
                store.digest === '' ? '（还没有）' : store.digest,
                '',
                '【记下的事实】',
                store.facts.map((fact) => `- ${fact.text}`).join('\n'),
            ].join('\n')
            const result = await bridge.summarize({
                conversationId,
                accountId,
                prompt,
                sessionPrefix: 'wx-dig-',
                route: memoryRoute(),
            })
            if (result === undefined) return
            const text = String(result.text ?? '').trim()
            if (text === '' || text === '（已取消）') return
            const start = text.indexOf('{')
            const end = text.lastIndexOf('}')
            if (start === -1 || end <= start) {
                log('memory: consolidation reply was not JSON, keeping the old digest')
                return
            }
            let parsed
            try {
                parsed = JSON.parse(text.slice(start, end + 1))
            } catch {
                log('memory: consolidation reply was not JSON, keeping the old digest')
                return
            }
            const digest = typeof parsed?.digest === 'string' ? parsed.digest.trim() : ''
            const facts = Array.isArray(parsed?.facts)
                ? parsed.facts
                    .map((entry) => (typeof entry === 'string'
                        ? { text: entry, weight: EXTRACTED_FACT_WEIGHT }
                        : { text: String(entry?.text ?? ''), weight: entry?.weight }))
                    .filter((entry) => entry.text.trim() !== '')
                    .slice(0, 10)
                : []
            if (digest === '' || facts.length === 0) {
                log('memory: consolidation reply had no digest, keeping the old digest')
                return
            }
            setDigest(stateRoot, accountId, digest, { warn: errLog })
            replaceFacts(stateRoot, accountId, facts, { warn: errLog })
            log(`memory: consolidated ${store.facts.length} facts into a digest for ${accountId}`)
        } finally {
            consolidating.delete(accountId)
        }
    }

    return { afterTurn, consolidate }
}
