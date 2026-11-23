/**
 * The model-facing `weixin_say` tool (issue #10: 实时汇报).
 *
 * A long turn is invisible on WeChat: the user sees `（thinking… (5m58s)）` and
 * nothing else until the reply lands, so "is it stuck?" is unanswerable. This
 * tool lets the model say ONE short human sentence mid-turn — "在查了，先回你
 * 一句" — through the same outbound path the reply uses, so it lands in the
 * same WeChat conversation and the same journal.
 *
 * Design constraints that shaped it:
 *  - It is registered in the AGENT's own scoped context (see
 *    {@link installWeixinSayTool} and AgentBridge's `onAgentSetup`), so the
 *    model can only reach the conversation it is already talking in. The
 *    conversation id comes from `exec.agent`, never from a model-supplied
 *    parameter — a tool that accepted a conversationId would let the model post
 *    into any chat.
 *  - The throttle (per-turn cap, minimum gap, not-after-cancel) lives in the
 *    bridge's `announce`, not here, because the bridge is what knows the turn
 *    state. This file only translates a model argument into that call and
 *    formats the verdict back as a sentence.
 *
 * The tool is deliberately tiny: one required `text` string. Everything about
 * "should this go out" is decided downstream.
 *
 * @module dsh-weixin/tool-realtime
 */
import { REALTIME_REFUSAL_TEXT, DEFAULT_REALTIME_MAX_CHARS } from './message/realtime.js'

/** The one tool name this module registers. Reserved here so other code can name it. */
export const WEIXIN_SAY_TOOL_NAME = 'weixin_say'

/**
 * The description shown to the model. It states the behaviour (one short line
 * to the person you are talking to, throttled), not the implementation.
 * @param {{ maxChars?: number }} [options]
 */
export function weixinSayDescription({ maxChars = DEFAULT_REALTIME_MAX_CHARS } = {}) {
  return [
    'Say one short sentence to the person you are currently chatting with on WeChat, in the middle of your turn.',
    `Use it when a task is taking a while, so they know you are still working and roughly what is happening ("在查了", "找到两条，继续看第三条").`,
    `Keep it under about ${maxChars} characters, one sentence, natural spoken language — it is a courtesy note, not the answer.`,
    'This is rate limited: only a few lines per turn and an interval between them; it stays silent during quiet hours and after the turn ends. It returns whether the line was actually sent, and if not, why — do not retry a refused line, put anything still unsaid into your final reply instead.',
    'Do not use it for the final answer (write that normally) or to repeat progress the plugin already shows.',
  ].join(' ')
}

/**
 * Build the tool definition for a given call target.
 *
 * Kept separate from the registration so a test can call `execute` directly
 * without a host ToolsService.
 *
 * @param {object} params
 * @param {(input: { text: string, agent: any }) => Promise<{ ok: boolean, text?: string, reason?: string, message?: string }>} params.say
 *   performs the announcement through the bridge; receives the raw text and
 *   the calling agent (whose session identifies the conversation).
 * @param {object} params.defineTool  the host's `defineTool` from `@deepseek-ai/dsh-tools`.
 * @param {number} [params.maxChars]
 * @returns {object} a definition ready for `ctx.tools.register`.
 */
export function buildWeixinSayTool({ say, defineTool, maxChars = DEFAULT_REALTIME_MAX_CHARS }) {
  return defineTool({
    name: WEIXIN_SAY_TOOL_NAME,
    description: weixinSayDescription({ maxChars }),
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'One short, natural sentence to show the person now (e.g. "还在跑测试，快了"). No Markdown.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sent: { type: 'boolean', description: 'Whether the line actually reached the conversation.' },
          text: { type: 'string', description: 'The line as sent (clipped/cleaned), when sent is true.' },
          reason: { type: 'string', description: 'Why it was not sent, when sent is false.' },
          message: { type: 'string', description: 'A human sentence to act on, when sent is false.' },
        },
        required: ['sent'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.sent
        ? `已发送：「${value.text}」`
        : `没发送：${value.message ?? REALTIME_REFUSAL_TEXT[value.reason] ?? '原因未知'}` }],
    },
    async execute(args, exec) {
      const result = await say({ text: args.text, agent: exec?.agent })
      if (result?.ok === true) return { sent: true, text: result.text }
      return {
        sent: false,
        reason: result?.reason ?? 'failed',
        message: result?.message ?? REALTIME_REFUSAL_TEXT[result?.reason ?? 'failed'] ?? '没发送。',
      }
    },
    // A realtime line is a courtesy; it must never hold the step open or be
    // retried by the model. Cheap and side-effecting, so not concurrency-safe.
    isConcurrencySafe: () => false,
  })
}

/**
 * Register `weixin_say` in one agent's scoped context.
 *
 * Best-effort by contract: it returns the disposer when it registered, and
 * `undefined` when the host tools service (or `defineTool`) is unavailable, so
 * a host without the API simply does not offer the tool rather than breaking
 * the session. It never throws past a failed import — the caller wraps it.
 *
 * @param {object} params
 * @param {any} params.agentCtx  the agent's scoped Cordis context (offers `.tools`).
 * @param {(input: { text: string, agent: any }) => Promise<any>} params.say
 * @param {(line: string) => void} [params.warn]
 * @param {number} [params.maxChars]
 * @returns {Promise<(() => void) | undefined>} the disposer, or undefined
 */
export async function installWeixinSayTool({ agentCtx, say, warn = () => {}, maxChars = DEFAULT_REALTIME_MAX_CHARS }) {
  const tools = agentCtx?.tools
  if (tools === undefined || typeof tools.register !== 'function') return undefined
  let defineTool
  try {
    ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch (error) {
    warn(`weixin_say unavailable: cannot load @deepseek-ai/dsh-tools (${String(error?.message ?? error)})`)
    return undefined
  }
  if (typeof defineTool !== 'function') {
    warn('weixin_say unavailable: @deepseek-ai/dsh-tools has no defineTool')
    return undefined
  }
  const definition = buildWeixinSayTool({ say, defineTool, maxChars })
  const dispose = tools.register(definition)
  return typeof dispose === 'function' ? dispose : () => {}
}
