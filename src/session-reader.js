/**
 * Read assistant output back out of a DSH agent session.
 *
 * Why this exists: DSH 0.1.5 removed the durable `assistant/chunk` event, so a
 * plugin cannot read a reply by watching chunk events. Text settles in
 * `assistant/message` (or `assistant/attempt` for a failed attempt), each with
 * an embedded `stream`; live deltas arrive only as process-local
 * `agent/assistant-stream` frames and are never durable.
 *
 * This reader therefore: (1) waits for the settled event, (2) reassembles text
 * from the embedded stream, and (3) optionally reports still-pending tool calls
 * so a WeChat user is not left staring at silence during a long task.
 *
 * The stream walk mirrors dsh-better-sidebar's own snapshot reader
 * (`src/sidechat-core.ts`, `streamTexts` / `messageTexts` / `liveTexts`).
 * @module dsh-weixin/session-reader
 */

/** Durable event types that carry settled assistant output. */
const SETTLED_TYPES = new Set(['assistant/message', 'assistant/attempt'])

/**
 * Sum the text of every text content block in a settled assistant message.
 * @param {any} message
 */
function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * Reassemble text from an embedded stream record.
 *
 * Two shapes occur in practice:
 *  - `{ type: 'text-chunks' | 'reasoning-chunks', texts: string[] }`
 *  - `{ type: 'chunk', chunk: { type: 'text-delta', text } }`
 * Only `text-*` kinds contribute: reasoning is deliberately not sent to WeChat.
 * @param {any} stream
 */
export function streamText(stream) {
  if (!Array.isArray(stream)) return ''
  let out = ''
  for (const entry of stream) {
    if (entry?.type === 'text-chunks' && Array.isArray(entry.texts)) {
      out += entry.texts.join('')
    } else if (entry?.type === 'chunk') {
      const chunk = entry.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    }
  }
  return out
}

/**
 * Read the latest settled assistant reply plus in-flight tool activity.
 *
 * @param {object} params
 * @param {readonly any[]} params.events  `agent.session.snapshotEvents()`.
 * @param {number} [params.afterSeq]      Ignore events at or below this seq, so a
 *   reply is never re-sent when the same conversation continues.
 * @returns {{ text: string, settledSeq: number, pendingTools: string[], sawTurnBoundary: boolean }}
 */
export function readAssistantReply({ events, afterSeq = -1 }) {
  let text = ''
  let settledSeq = -1
  let sawTurnBoundary = false
  /** @type {Map<string, string>} */
  const pending = new Map()

  for (const event of events ?? []) {
    if (typeof event?.seq === 'number' && event.seq <= afterSeq) continue
    switch (event?.type) {
      case 'turn/start':
        // A new turn invalidates anything collected from the previous one.
        sawTurnBoundary = true
        pending.clear()
        break
      case 'tool/call': {
        const callId = event.data?.callId
        if (typeof callId === 'string') {
          pending.set(callId, typeof event.data.name === 'string' ? event.data.name : 'tool')
        }
        break
      }
      case 'tool/result': {
        const callId = event.data?.message?.source?.callId
        if (typeof callId === 'string') pending.delete(callId)
        break
      }
      default:
        if (!SETTLED_TYPES.has(event.type)) break
        // Prefer the embedded stream when present; fall back to the message body.
        const fromStream = streamText(event.data?.stream)
        const fromMessage = messageText(event.data?.message)
        const body = fromStream !== '' ? fromStream : fromMessage
        if (body !== '') {
          text = body
          settledSeq = typeof event.seq === 'number' ? event.seq : settledSeq
        }
        break
    }
  }

  return { text, settledSeq, pendingTools: [...pending.values()], sawTurnBoundary }
}

/**
 * Build a short progress line for a turn that has not settled yet.
 * @param {readonly string[]} pendingTools
 */
export function describePending(pendingTools) {
  if (pendingTools.length === 0) return 'thinking…'
  const shown = pendingTools.slice(0, 3).join(', ')
  const more = pendingTools.length > 3 ? ` +${pendingTools.length - 3}` : ''
  return `running: ${shown}${more}`
}
