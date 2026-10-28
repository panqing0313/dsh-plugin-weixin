/**
 * Model routing by purpose (C20).
 *
 * A conversation, a background summary and a "speak first" message are three
 * different jobs with three different budgets: the conversation deserves the
 * good model, a memory fold does not, and a proactive greeting is twenty tokens
 * of personality. Before this file the only knob was memoryProvider/memoryModel,
 * so everything else sat on the session's model by default — or, worse, a
 * deployment could only route by changing the model for the whole session.
 *
 * Precedence is deliberate and boring: the most specific purpose wins, and
 * nothing is set means "the host's default", not "empty model".
 */

/** The jobs this plugin runs on a model. */
export const ROUTE_PURPOSES = Object.freeze(['chat', 'side', 'memory', 'proactive', 'report'])

/**
 * Which provider/model pair a purpose should use, or undefined for the host default.
 *
 * @param {'chat' | 'side' | 'memory' | 'proactive' | 'report'} purpose
 * @param {Record<string, unknown>} config live plugin config
 * @returns {{ provider: string, model: string } | undefined}
 */
export function routeFor(purpose, config) {
    const pairs = {
        // Memory keeps its own keys for back-compat (0.9.6 shipped those names).
        memory: ['memoryProvider', 'memoryModel'],
        side: ['sideProvider', 'sideModel'],
        chat: ['chatProvider', 'chatModel'],
        // 主动开口和日报是两种不同的花销：开口只值二十个 token 的人格化，
        // 日报要读流水再压缩，可以各自钉一个便宜模型。
        proactive: ['proactiveProvider', 'proactiveModel'],
        report: ['reportProvider', 'reportModel'],
    }
    const keys = pairs[purpose]
    if (keys === undefined) return undefined
    const provider = String(config?.[keys[0]] ?? '').trim()
    const model = String(config?.[keys[1]] ?? '').trim()
    // Half a pair is not a route: a provider without a model would leave the
    // host to guess, which is exactly the ambiguity this file exists to remove.
    return provider !== '' && model !== '' ? { provider, model } : undefined
}

/**
 * The side-session route: an explicit side route, else the memory route, so a
 * deployment that only configured one cheap model still gets it for everything
 * in the background.
 *
 * @param {Record<string, unknown>} config
 * @returns {{ provider: string, model: string } | undefined}
 */
export function sideRouteFor(config) {
    return routeFor('side', config) ?? routeFor('memory', config)
}

/** One-line description for logs and /status. */
export function describeRoute(route, fallback = '会话默认') {
    return route === undefined ? fallback : `${route.provider}/${route.model}`
}
