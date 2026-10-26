/**
 * The background conversation-memory summarizer (P2 of the persona/memory
 * feature).
 *
 * After every `memorySummaryTurns` settled agent turns in a conversation the
 * summarizer folds the recent journal window plus the previous summary into a
 * short digest and writes it into `memory/conv-<account>-<conversation>.json`.
 * The digest reaches future prompts through `buildMemoryBlock` (【本会话记忆】)
 * and nowhere else: the summarizer runs on a bridge side session and never
 * sends outbound, so the user never sees it happen.
 *
 * Failures are logged and swallowed — memory is an enhancement, and a failed
 * summary must never take down a reply that already went out.
 *
 * @module dsh-weixin/memory-summarizer
 */

import { readConvMemory, setConvSummary, setConvTurn, readRecentWindow, DEFAULT_MEMORY_CONV_MAX_CHARS } from './memory.js'

const noopWarn = () => {}

/**
 * @param {object} params
 * @param {any} params.bridge AgentBridge — only `summarize()` is used.
 * @param {string} params.stateRoot
 * @param {() => any} params.config returns the CURRENT effective config (must
 *   be re-read per call: the settings card can change the knobs live)
 * @param {{ log?: (line: string) => void, errLog?: (line: string) => void }} [params.logger]
 */
export function createMemorySummarizer({ bridge, stateRoot, config, logger = {} }) {
    const log = logger.log ?? noopWarn
    const errLog = logger.errLog ?? noopWarn
    // One summary in flight per conversation: turns settle serially, but a
    // slow summary easily spans the NEXT turn, and two concurrent side-session
    // prompts for one conversation would interleave garbage.
    const inFlight = new Set()

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
        // re-enabling memory mid-conversation keeps a meaningful cadence.
        const conv = readConvMemory(stateRoot, accountId, conversationId, { warn: errLog })
        const turn = (conv.updatedTurn ?? 0) + 1
        setConvTurn(stateRoot, accountId, conversationId, turn, { warn: errLog })

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
            const recent = readRecentWindow(stateRoot, accountId, conversationId, {
                turns: 10,
                textChars: 200,
            })
            const transcript = recent
                .map((entry) => `${entry.dir === 'in' ? '用户' : '助手'}：${entry.text}`)
                .join('\n')
            if (transcript === '') return
            const maxChars = Number(current.memoryConvMaxChars) || DEFAULT_MEMORY_CONV_MAX_CHARS
            const prompt = [
                '以下是这段微信会话最近的对话记录。',
                '请把值得跨回合保留的信息（话题、正在做的事、用户的偏好与背景）浓缩成一段摘要。',
                `不超过 ${Math.min(400, maxChars)} 字，只输出摘要本身，不要任何解释或前缀。`,
                '',
                '【已有摘要】',
                prior.summary === '' ? '（还没有）' : prior.summary,
                '',
                '【最近对话】',
                transcript,
            ].join('\n')
            const result = await bridge.summarize({ conversationId, accountId, prompt })
            if (result === undefined) return
            const text = String(result.text ?? '').trim()
            if (text === '' || text === '（已取消）') return
            setConvSummary(stateRoot, accountId, conversationId, text, { warn: errLog })
            log(`memory: conversation ${conversationId} summarized at turn ${turn}`)
        } catch (error) {
            errLog(`memory summary failed for ${conversationId}: ${String(error)}`)
        }
    }

    return { afterTurn }
}
