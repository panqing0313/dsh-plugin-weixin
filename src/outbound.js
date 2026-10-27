// Outbound delivery: the part of the plugin that gets text and files out of the
// process and onto Weixin.
//
// These functions used to sit at the bottom of src/index.js, next to 2000 lines
// of wiring they have nothing to do with. The dependencies they used to reach
// for through module-scope `let`s (journal sink, outbox, hook bus, logger) are
// injected once at setup through configureOutbound.
import { channelFor } from './channel.js'
import { HOOK_POINTS } from './hooks.js'
import { chunkText } from './message/chunker.js'
import { markdownToPlainText, resolveMarkdownMode } from './message/markdown.js'
import { planRichContent, writeSnippets } from './message/rich-content.js'
import { listProducedFiles } from './media/outbound.js'

/** Wired in setup; every field defaults so a test can exercise one sender. */
const runtime = {
  journal: null,
  outbox: undefined,
  hooks: undefined,
  // Where long code blocks are written before they are sent as attachments.
  snippetsDir: '',
  warn: () => {},
}

/** Hand the send path its collaborators (journal sink, outbox, hook bus, logger). */
export function configureOutbound(deps = {}) {
  if ('journal' in deps) runtime.journal = deps.journal
  if ('outbox' in deps) runtime.outbox = deps.outbox
  if ('hooks' in deps) runtime.hooks = deps.hooks
  if ('snippetsDir' in deps) runtime.snippetsDir = deps.snippetsDir
  if (typeof deps.warn === 'function') runtime.warn = deps.warn
}

/**
 * Deliver the files the agent PRODUCED during the turn but never referenced.
 *
 * The reference path (`resolveOutboundReply`) only fires when the reply text
 * names a file. An agent that converts a document or takes a screenshot has
 * still produced a deliverable — writing it and then describing it in prose
 * left the user to ask for it again ("发我微信"), which is exactly the round
 * trip this removes. After the text reply, the agent working directory is
 * scanned for new deliverable files ({@link listProducedFiles}) and each one
 * that the reply did not already send is uploaded.
 *
 * Failure of one file (over the size cap, refused kind) costs one log line,
 * never the reply — the text has already gone out above.
 *
 * @param {object} params
 * @param {{ autoSendFiles?: boolean, maxMediaBytes?: number }} params.config
 * @param {ILinkTransport} params.transport
 * @param {string} params.agentCwd  The agent working directory to scan.
 * @param {number} params.sinceMs  Turn start; only newer files are products.
 * @param {string[]} params.alreadySent  Absolute paths resolveOutboundReply sent.
 * @param {string} params.conversationId
 * @param {string} [params.contextToken]
 * @param {(line: string) => void} params.warn
 * @param {{ info: (line: string) => void }} [params.fileLog]
 */
export async function sendProducedFiles(params) {
  const fileLog = params.fileLog ?? { info: () => {} }
  if (params.config.autoSendFiles === false) return
  if (typeof params.agentCwd !== 'string' || params.agentCwd === '') return
  let produced
  try {
    produced = await listProducedFiles({ dir: params.agentCwd, sinceMs: params.sinceMs })
  } catch (error) {
    params.warn(`scanning produced files failed: ${String(error)}`)
    return
  }
  const pending = produced.filter((filePath) => !params.alreadySent.includes(filePath))
  for (const filePath of pending) {
    try {
      await channelFor(params.transport).sendMedia({
        filePath,
        conversationId: params.conversationId,
        contextToken: params.contextToken,
        cdnBaseUrl: params.transport.cdnBaseUrl,
        ...(params.config.maxMediaBytes === undefined ? {} : { maxBytes: params.config.maxMediaBytes }),
      })
      params.warn(`sent produced file ${filePath}`)
      fileLog.info(`sent produced file: ${filePath}`)
    } catch (error) {
      const reason = String(error?.message ?? error)
      params.warn(`sending produced file ${filePath} failed: ${reason}`)
      fileLog.info(`sending produced file ${filePath} failed: ${reason}`)
    }
  }
}

/**
 * Send one outbound text body, filtered and then split to fit Weixin.
 *
 * Order matters: the reply is converted to plain text *before* it is chunked,
 * because the filter changes the length (stripping `**`/`#####`/image markup)
 * and every chunk must be measured against the converted text. Chunking first
 * would both ship markdown markers and risk an over-length message.
 *
 * @param {ILinkTransport} transport
 * @param {{ maxMessageLength: number, markdownMode?: 'strip'|'off', richContent?: boolean, codeFileThreshold?: number }} config
 * @param {{ conversationId: string, text: string, contextToken?: string }} message
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function sendChunked(transport, config, message) {
  // Rich replies (C17). Weixin has one body kind — plain text — so the useful
  // move is not to "support Markdown" but to stop losing what Markdown carried:
  // a long code block becomes a real file attachment (indentation, language and
  // line count intact) and a table becomes column-aligned text. Short snippets
  // stay inline; a two-line example reads better in the bubble.
  const plan = config.richContent === false
    ? { text: message.text ?? '', files: [] }
    : planRichContent(message.text ?? '', { codeFileChars: config.codeFileThreshold })
  const text = markdownToPlainText(plan.text, resolveMarkdownMode(config))
  runtime.journal?.({
    accountId: transport.accountId,
    conversationId: message.conversationId,
    text,
  })
  // `bubbles` is the human-pacing split (already plain text, one entry per
  // bubble). Without it this is the plain length-based chunking every other
  // send has always used. A bubble that is still over the length cap is cut
  // again, so pacing can never produce an oversized message.
  const chunks = Array.isArray(message.bubbles) && message.bubbles.length > 0
    ? message.bubbles.flatMap((bubble) => chunkText(bubble, config.maxMessageLength))
    : chunkText(text, config.maxMessageLength)
  const gapMs = Number(message.gapMs)
  for (let index = 0; index < chunks.length; index += 1) {
    if (index > 0 && Number.isFinite(gapMs) && gapMs > 0) await sleep(gapMs)
    // Everything downstream of here talks to a Channel, not a transport: the
    // shape of a text send lives in one place (src/channel.js) instead of being
    // re-derived by every caller.
    const channel = channelFor(transport)
    const chunk = { conversationId: message.conversationId, text: chunks[index], contextToken: message.contextToken }
    runtime.hooks?.emit(HOOK_POINTS.outboundReady, { accountId: transport.accountId, conversationId: message.conversationId, text: chunk.text })
    try {
      await channel.sendText(chunk)
      runtime.hooks?.emit(HOOK_POINTS.outboundSettled, { accountId: transport.accountId, conversationId: message.conversationId, sent: true })
    } catch (error) {
      // A send that fails here used to lose the text forever: the model had
      // already written it and nothing held a copy. Queue it instead — the
      // outbox retries with backoff and survives a restart. Only the first
      // failing chunk is queued together with the rest, so a reply does not
      // arrive half-delivered out of order later on.
      const pending = chunks.slice(index).join('')
      if (runtime.outbox !== undefined) {
        runtime.outbox.enqueue({ accountId: transport.accountId, conversationId: message.conversationId, text: pending, contextToken: message.contextToken })
        runtime.hooks?.emit(HOOK_POINTS.outboundSettled, { accountId: transport.accountId, conversationId: message.conversationId, sent: false, queued: pending.length })
        runtime.warn(`send failed (${String(error?.message ?? error)}); queued ${pending.length} chars for retry`)
        return
      }
      throw error
    }
  }
  if (plan.files.length > 0) await sendSnippets(transport, message, plan.files)
}

/**
 * Attach the snippet files a rich reply planned.
 *
 * A file that cannot be written or sent costs one log line: the note in the
 * text already told the reader a file was sent, but losing the whole reply over
 * a pretty-printed code block would be worse.
 */
async function sendSnippets(transport, message, files) {
  const dir = runtime.snippetsDir
  if (dir === '') {
    runtime.warn('rich reply produced snippet files but no snippet directory is configured; sending them inline is not possible at this point')
    return
  }
  const { written } = writeSnippets(files, dir, { warn: runtime.warn })
  const channel = channelFor(transport)
  if (channel === undefined || channel.capabilities?.media !== true) return
  for (const file of written) {
    try {
      await channel.sendMedia({
        conversationId: message.conversationId,
        filePath: file.path,
        text: '',
        contextToken: message.contextToken,
      })
    } catch (error) {
      runtime.warn(`snippet ${file.name} could not be sent: ${String(error?.message ?? error)}`)
    }
  }
}
