/**
 * Long-poll inbound transport for the Weixin iLink Bot API, built on the
 * vendored Tencent transport (`vendor/openclaw-weixin`, MIT).
 *
 * Implements the seam the channel core expects: `start(onMessage)`, `send()`,
 * `stop()`.
 *
 * Why the loop lives here instead of reusing the upstream monitor: upstream's
 * `src/monitor/monitor.ts` requires a full OpenClaw `channelRuntime`
 * (it throws "channelRuntime missing on monitor opts") and routes each message
 * through OpenClaw's own ingress/dispatch. dsh-weixin owns its own dispatch —
 * one Weixin conversation maps to one DSH agent session — so it reuses only the
 * pure HTTP layer and drives getUpdates itself. The retry policy mirrors the
 * upstream monitor: three consecutive failures trigger a 30s backoff, single
 * failures retry after 2s.
 * @module dsh-weixin/transport/ilink
 */
import { getUpdates, sendMessage, getConfig, sendTyping, notifyStart, notifyStop, classifyFetchError } from '../../vendor/openclaw-weixin/api/api.js'
import { MessageItemType, MessageState, MessageType, TypingStatus } from '../../vendor/openclaw-weixin/api/types.js'
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from '../../vendor/openclaw-weixin/storage/sync-buf.js'
import { CDN_BASE_URL as DEFAULT_CDN_BASE_URL } from '../../vendor/openclaw-weixin/auth/accounts.js'
import { OutboundPacer } from '../message/rate-limit.js'

/** Consecutive failures tolerated before the long backoff kicks in. */
const MAX_CONSECUTIVE_FAILURES = 3
const BACKOFF_DELAY_MS = 30_000
const RETRY_DELAY_MS = 2_000

/**
 * `errcode` the Bot API returns once the saved token stops being accepted. The
 * credential is a session, not a permanent key, so it expires and the account
 * has to be logged in again.
 */
export const SESSION_EXPIRED_ERRCODE = -14

/**
 * The server refused the request because the session is no longer valid.
 *
 * Distinct from a transport fault: retrying cannot help, and the only recovery
 * is a fresh login. The caller uses this to stop polling and say so once,
 * instead of spinning on an error that will never clear.
 */
export class SessionRejectedError extends Error {
  /**
   * @param {number} errcode
   * @param {string} [errmsg]
   */
  constructor(errcode, errmsg) {
    super(`getUpdates errcode=${errcode} errmsg=${errmsg ?? '(none)'}`)
    this.name = 'SessionRejectedError'
    this.errcode = errcode
    /** True only for the expiry code, where a re-login is the actual fix. */
    this.sessionExpired = errcode === SESSION_EXPIRED_ERRCODE
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A timer whose only job is to bound another promise.
 *
 * Unlike {@link sleep} it must not keep the event loop alive on its own: the
 * deadline is normally *lost* (notifyStart/notifyStop answer long before it),
 * and an armed 80 s timer would then hold the process open for the remainder of
 * the timeout after `stop()` — which is exactly what a disposed plugin must not
 * do, and what made one transport test take 80 s to finish.
 *
 * @param {number} ms
 */
const deadline = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

/**
 * Recognise the abort the platform raises when a fetch/`res.text()` is
 * cancelled through an AbortController. The watchdog and `stop()` both abort
 * the loop's controller, so the catch path needs to tell "we cancelled this
 * request on purpose" from any other network failure.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
const isAbortError = (error) => error instanceof Error && error.name === 'AbortError'

/**
 * Wait `ms`, but return early when `isRunning()` turns false.
 *
 * The retry/backoff sleeps run between poll rounds. A plain `sleep` makes
 * `stop()` wait out a 30s backoff before `loopPromise` settles, which stalls
 * plugin dispose and (in tests) hangs the harness. Stepping in 100ms slices
 * costs nothing and makes shutdown immediate.
 *
 * @param {number} ms
 * @param {() => boolean} isRunning
 * @returns {Promise<void>}
 */
const interruptibleSleep = async (ms, isRunning) => {
  const step = 100
  let waited = 0
  while (waited < ms && isRunning()) {
    await sleep(Math.min(step, ms - waited))
    waited += step
  }
}

/**
 * Reduce an iLink `WeixinMessage` to the channel's {@link InboundMessage}.
 *
 * Returns `null` for messages that carry nothing this channel can act on
 * (bot echoes, non-final states, or items of a kind with no decoder here) so
 * the caller can skip them without special-casing upstream shapes.
 *
 * @param {any} raw
 * @returns {any|null}
 */
/** iLink sends `""` for "not a group"; only a non-blank value is a group id. */
function blankToUndefined(value) {
  return typeof value === 'string' && value.trim() === '' ? undefined : value
}

/**
 * Which payload field each media item kind carries, and the media kind name
 * this channel uses for it.
 *
 * The field names come straight from the protocol: an `ImageItem` nests its
 * CDN reference under `image_item`, a `FileItem` under `file_item`, and so on.
 * Keeping the map here (rather than a chain of `if`s) means the four kinds
 * cannot drift apart in how they are unwrapped or in what they are called
 * downstream.
 */
const MEDIA_ITEM_KINDS = new Map([
  [MessageItemType.IMAGE, { kind: 'image', field: 'image_item' }],
  [MessageItemType.VOICE, { kind: 'voice', field: 'voice_item' }],
  [MessageItemType.FILE, { kind: 'file', field: 'file_item' }],
  [MessageItemType.VIDEO, { kind: 'video', field: 'video_item' }],
])

/**
 * Pull one media item into the flat descriptor the downloader consumes.
 *
 * Only fields the downloader actually reads are copied, and `undefined` values
 * are dropped so the descriptor stays comparable with a literal in tests. An
 * item with no CDN reference at all still yields a descriptor — it just carries
 * `media: {}`, which `src/media/inbound.js` reports as a download failure
 * rather than silently ignoring. Returning a descriptor for a reference-less
 * item is deliberate: "WeChat sent a picture we cannot fetch" is information
 * the user must receive, and the old `unsupported` path is what hid it.
 *
 * @param {any} item
 * @param {{ kind: string, field: string }} shape
 */
function normalizeMediaItem(item, shape) {
  const payload = item[shape.field] ?? {}
  const media = payload.media ?? {}
  /** @type {Record<string, any>} */
  const out = { kind: shape.kind }
  const put = (key, value) => {
    if (value !== undefined && value !== null) out[key] = value
  }
  put('encryptQueryParam', media.encrypt_query_param)
  put('aesKey', media.aes_key)
  put('fullUrl', media.full_url)
  // FileItem names the attachment; VoiceItem carries a playtime. Both are
  // display metadata only — never a path (see src/media/inbound.js).
  put('fileName', payload.file_name)
  put('size', payload.len ?? payload.file_size ?? payload.mid_size ?? payload.video_size)
  // ImageItem keeps the AES key hex-encoded beside the media block instead of
  // inside it; the downloader prefers this one when present.
  put('aesKeyHex', payload.aeskey)
  return out
}

export function normalizeInbound(raw) {
  // Our own echoes: never feed them back to the agent (loop guard).
  if (raw.message_type === MessageType.BOT) return null
  if (raw.message_state !== undefined && raw.message_state !== MessageState.FINISH && raw.message_state !== MessageState.NEW) {
    return null
  }
  const items = Array.isArray(raw.item_list) ? raw.item_list : []
  const from = raw.from_user_id ?? ''
  // A 1:1 message carries `group_id: ""`, not an absent field, so `??` alone
  // would make the conversation id the empty string and every reply would be
  // addressed to nobody. Treat blank as absent the way the peer id must be.
  const conversationId = blankToUndefined(raw.group_id) ?? from
  const contextToken = raw.context_token ?? ''
  const id = String(raw.message_id ?? raw.client_id ?? '')
  const timestamp = raw.create_time_ms ?? Date.now()

  // A WeChat photo arrives as an IMAGE item plus a TEXT item holding the
  // caption the sender typed with it, so both are collected in one pass
  // instead of the text winnowing the media out.
  /** @type {Array<Record<string, any>>} */
  const media = []
  let caption
  for (const item of items) {
    if (item?.type === MessageItemType.TEXT && typeof item?.text_item?.text === 'string' && item.text_item.text !== '') {
      caption ??= item.text_item.text
      continue
    }
    const shape = MEDIA_ITEM_KINDS.get(item?.type)
    if (shape !== undefined) media.push(normalizeMediaItem(item, shape))
  }

  if (media.length > 0) {
    return {
      id,
      senderId: from,
      conversationId,
      contextToken,
      type: media.length === 1 ? media[0].kind : 'media',
      media,
      ...(caption === undefined ? {} : { text: caption }),
      timestamp,
    }
  }
  if (caption !== undefined) {
    return { id, senderId: from, conversationId, type: 'text', text: caption, contextToken, timestamp }
  }
  // Carry the routing fields anyway, so the caller can send a "not
  // supported" notice back to the conversation that produced it.
  const kind = items.length > 0 ? `item type ${items[0]?.type}` : 'no items'
  return { id, senderId: from, conversationId, contextToken, unsupported: kind }
}

/**
 * Dispatch inbound messages to the handler without letting a long turn block
 * the poll loop.
 *
 * WHY this exists — measured on a real account, 2026-10-23: the loop used to
 * `await` the handler, and the handler awaits the whole agent turn. So while a
 * turn ran (a 180 s `sleep` in that test) the loop sat inside one message and
 * every later message stayed unread on the server. `/cancel` is *defined* as
 * "interrupt the turn that is running right now", and it could never do that:
 * the four cancel messages the operator sent during that turn were all answered
 * only after it finished, each with "当前没有正在跑的回合" — the turn they were
 * aimed at had already ended.
 *
 * The fix has two halves, because they solve different halves of the problem:
 *
 *  1. The loop awaits nothing any more, so the next `getUpdates` goes out while
 *     a turn is still running and a cancel can arrive mid-turn.
 *  2. Messages are still delivered **in order per conversation**, by chaining
 *     them here: turn N+1 starts only once turn N has settled. Dropping the
 *     await without this chain would let two turns of the same conversation
 *     interleave their tool use and their replies. The bridge's own queue is
 *     not a substitute — it only engages once `deliver()` has been called, i.e.
 *     after the handler has already run for that message.
 *
 * Messages the host marks with `bypass(message)` skip the chain and run at
 * once. That is exactly `/cancel`: it must not queue behind the turn it was
 * sent to stop.
 *
 * @param {object} options
 * @param {(message: any) => Promise<void>} options.onMessage
 * @param {(line: string) => void} options.errLog
 * @param {(message: any) => boolean} [options.bypass]
 */
export function createInboundScheduler({ onMessage, errLog, bypass = () => false }) {
  /** @type {Map<string, Promise<void>>} conversation id → tail of its chain */
  const chains = new Map()
  /** @type {Set<Promise<void>>} everything still running, for {@link drain} */
  const running = new Set()

  const track = (promise) => {
    running.add(promise)
    promise.catch(() => {}).finally(() => running.delete(promise))
    return promise
  }

  // The handler gets its own error boundary: a failing turn (bad send, agent
  // error) is not a poll failure, and folding it into the loop would trip the
  // poll backoff for an unrelated reason.
  const run = async (message) => {
    try {
      await onMessage(message)
    } catch (error) {
      errLog(`message ${message.id || '(no id)'} failed: ${String(error)}`)
    }
  }

  return {
    /**
     * Start handling one message. The returned promise settles with the
     * handler, but the poll loop must not await it — awaiting is exactly the
     * stall this scheduler removes.
     *
     * @param {any} message
     */
    dispatch(message) {
      if (bypass(message) === true) return track(run(message))
      const previous = chains.get(message.conversationId)
      // No queue for this conversation: start now, so a batch of messages keeps
      // the server's order (deferring to a resolved promise would let a later
      // bypassed `/cancel` start ahead of this one for no reason).
      const next = previous === undefined
        ? run(message)
        // `.then(run, run)` rather than `.then(run)`: a previous message that
        // rejected must not poison the chain for every later message.
        : previous.then(() => run(message), () => run(message))
      chains.set(message.conversationId, next)
      return track(next.finally(() => {
        if (chains.get(message.conversationId) === next) chains.delete(message.conversationId)
      }))
    },

    /** How many handler runs are still in flight. */
    get pending() {
      return running.size
    },

    /** Wait for everything dispatched so far; used by stop(), never by the loop. */
    async drain() {
      while (running.size > 0) await Promise.allSettled([...running])
    },
  }
}

/**
 * Long-poll driver for one Weixin account.
 */
export class ILinkTransport {
  /**
   * @param {object} options
   * @param {string} options.accountId
   * @param {string} options.baseUrl
   * @param {string} options.token
   * @param {string} [options.userId]  The bound operator's `ilink_user_id`, as
   *   saved at login. Required by getConfig; without it no typing ticket can be
   *   obtained.
   * @param {string} [options.cdnBaseUrl]  Weixin CDN root for outbound media; the
   *   upstream default when unset.
   * @param {number} [options.longPollTimeoutMs]
   * @param {(line: string) => void} [options.log]
   * @param {(line: string) => void} [options.errLog]
   * @param {(error: SessionRejectedError) => void} [options.onSessionRejected]
   *   Called once when the server refuses the session, so the host can surface
   *   "log in again" somewhere the operator will actually see it.
   * @param {(message: any) => boolean} [options.bypassQueue]
   *   Messages that must be handled immediately instead of in per-conversation
   *   order. The host passes `/cancel` here: it exists to interrupt a turn that
   *   is already running, so queueing it behind that turn would make it useless
   *   (see {@link createInboundScheduler}).
   * @param {number} [options.sendIntervalMs]  Floor between two outbound sends.
   * @param {number} [options.sendCooldownMs]  Cooldown armed by repeated failures.
   * @param {import('../message/rate-limit.js').OutboundPacer} [options.pacer]
   *   Test seam: a pre-built pacer (the tests inject a fake clock through it).
   * @param {boolean} [options.voiceOutbound]  Audio attachments go out as Weixin
   *   voice messages (SILK) instead of file attachments. Default true; a failed
   *   voice send falls back to the file path inside {@link sendMedia}.
   */
  constructor(options) {
    this.accountId = options.accountId
    this.baseUrl = options.baseUrl
    this.token = options.token
    this.userId = options.userId?.trim() || undefined
    this.cdnBaseUrl = options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL
    this.longPollTimeoutMs = options.longPollTimeoutMs ?? 35_000
    this.log = options.log ?? (() => {})
    this.errLog = options.errLog ?? options.log ?? (() => {})
    // Outbound pacing lives on the transport, not in the send call sites: every
    // outbound item kind (text chunk, image, video, file) funnels through this
    // object, so one gate covers a chunked reply plus its media. The defaults
    // come from the pacer module, which documents the measured ban threshold.
    this.pacer = options.pacer ?? new OutboundPacer({
      ...(options.sendIntervalMs === undefined ? {} : { minIntervalMs: options.sendIntervalMs }),
      ...(options.sendCooldownMs === undefined ? {} : { cooldownMs: options.sendCooldownMs }),
      log: this.log,
      warn: this.errLog,
    })
    this.voiceOutbound = options.voiceOutbound !== false
    this.#onSessionRejected = options.onSessionRejected
    this.#bypassQueue = options.bypassQueue ?? (() => false)
    this.syncBufPath = getSyncBufFilePath(this.accountId)
    this.abort = new AbortController()
    this.running = false
    this.loopPromise = null
    this.typingTicket = undefined
    this.#sessionExpired = false
  }

  /**
   * Whether the last poll was refused because the saved session expired.
   *
   * Exposed so the settings card can say "log in again" instead of showing a
   * healthy-looking plugin that quietly receives nothing.
   */
  get sessionExpired() {
    return this.#sessionExpired
  }

  /** Set once the server refuses the session; see {@link SessionRejectedError}. */
  #onSessionRejected
  #sessionExpired = false
  /** @type {(message: any) => boolean} */
  #bypassQueue
  /** @type {ReturnType<typeof createInboundScheduler> | undefined} */
  #scheduler

  /**
   * @param {(message: any) => Promise<void>} onMessage
   */
  async start(onMessage) {
    if (this.running) return
    this.running = true
    this.abort = new AbortController()
    // Best-effort startup notification; a failure here must not block polling.
    // Bounded: the vendor's own timeout is cleared the moment response HEADERS
    // arrive, so a server that stalls the body leaves notifyStart pending
    // FOREVER — and start() awaits it before arming the loop, which would keep
    // the whole transport dead (no poll, no watchdog) against exactly the kind
    // of server this file's watchdog exists for. Race it with a deadline; a
    // lost race just skips the notification.
    const notified = notifyStart({ baseUrl: this.baseUrl, token: this.token })
    const notifyDeadline = deadline(this.longPollTimeoutMs * 2 + 10_000).then(() => 'deadline')
    const outcome = await Promise.race([notified.then(() => 'notified', (error) => { this.log(`notifyStart failed (continuing): ${String(error)}`); return 'notified' }), notifyDeadline])
    if (outcome === 'deadline') {
      this.log(`notifyStart did not answer within ${this.longPollTimeoutMs * 2 + 10_000}ms (headers arrived, body never did); continuing without it`)
    }
    this.#scheduler = createInboundScheduler({ onMessage, errLog: this.errLog, bypass: this.#bypassQueue })
    this.loopPromise = this.#loop()
  }

  async #loop() {
    let consecutiveFailures = 0
    while (this.running && !this.abort.signal.aborted) {
      let buf = loadGetUpdatesBuf(this.syncBufPath)
      // The vendor's own timeout only covers the fetch() call — it is cleared
      // the moment response HEADERS arrive, and `res.text()` (the body read)
      // has no deadline of its own. A server that sends headers and then
      // stalls the body leaves getUpdates pending forever: the loop hangs on
      // one dead request, sync stops advancing, and the phone shows "cannot
      // reach openclaw" while the TCP connection itself looks ESTABLISHED
      // (observed 2026-10-16 21:05–21:17: no log line, no sync progress, one
      // frozen TLS connection). This watchdog is the hard outer bound: if one
      // poll round takes longer than the long-poll window plus margin, the
      // request is aborted underneath and the round counts as a failure so the
      // existing retry/backoff machinery runs.
      const pollDeadlineMs = this.longPollTimeoutMs * 2 + 10_000
      const pollWatchdog = setTimeout(() => this.abort.abort(), pollDeadlineMs)
      let polled
      try {
        polled = await getUpdates({
          baseUrl: this.baseUrl,
          token: this.token,
          get_updates_buf: buf ?? '',
          timeoutMs: this.longPollTimeoutMs,
          abortSignal: this.abort.signal,
        })
      } finally {
        clearTimeout(pollWatchdog)
      }
      // getUpdates swallows AbortError and returns an empty `{ret:0}` (vendor
      // treats a long-poll timeout and an external abort as the same normal
      // exit), so a watchdog abort lands HERE, not in a catch: the signal is
      // left aborted and the `while` guard would silently end the loop — the
      // exact "no log, no sync, connection frozen" state. Reset the signal so
      // the loop keeps polling and surface one line saying what happened.
      if (!this.running) break
      if (this.abort.signal.aborted) {
        this.errLog(`getUpdates watchdog: one poll round exceeded ${pollDeadlineMs}ms (headers arrived, body never did); aborted underneath and retrying`)
        this.abort = new AbortController()
        consecutiveFailures += 1
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.errLog(`getUpdates failed ${consecutiveFailures} times; backing off ${BACKOFF_DELAY_MS}ms`)
          await interruptibleSleep(BACKOFF_DELAY_MS, () => this.running)
          consecutiveFailures = 0
        } else {
          await interruptibleSleep(RETRY_DELAY_MS, () => this.running)
        }
        continue
      }
      try {
        const resp = polled
        if (resp.ret !== undefined && resp.ret !== 0) {
          throw new Error(`getUpdates ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`)
        }
        // The API reports most failures through `errcode`, NOT `ret`: an
        // expired session comes back as `{errcode:-14, errmsg:"session timeout"}`
        // with `ret` absent, so the check above passes, `msgs` is empty, and the
        // loop keeps polling forever while receiving nothing. Messaging then
        // silently stops working with no error anywhere. Every non-zero
        // `errcode` is a real failure and has to be raised.
        if (typeof resp.errcode === 'number' && resp.errcode !== 0) {
          this.#sessionExpired = resp.errcode === SESSION_EXPIRED_ERRCODE
          throw new SessionRejectedError(resp.errcode, resp.errmsg)
        }
        consecutiveFailures = 0
        if (typeof resp.get_updates_buf === 'string' && resp.get_updates_buf !== buf) {
          saveGetUpdatesBuf(this.syncBufPath, resp.get_updates_buf)
        }
        // Honour a server-directed shorter poll interval.
        if (typeof resp.longpolling_timeout_ms === 'number' && resp.longpolling_timeout_ms > 0) {
          this.longPollTimeoutMs = resp.longpolling_timeout_ms
        }
        const msgs = Array.isArray(resp.msgs) ? resp.msgs : []
        for (const raw of msgs) {
          const message = normalizeInbound(raw)
          if (message === null) continue
          // Hand off and move on. The scheduler keeps per-conversation order
          // and lets `/cancel` jump the queue; awaiting here would park the
          // loop inside the turn, so no later message (cancel included) could
          // be read until it finished — the defect this replaced.
          this.#scheduler?.dispatch(message)
        }
      } catch (error) {
        // stop() flips `running` before aborting, so a watchdog abort on a
        // still-running loop is distinguishable from a real stop here too.
        if (!this.running) break
        // A refused session never recovers on its own, so retrying is pointless
        // and would bury the one line the operator needs. Report it once, at
        // the level that reaches the GUI log, and stop polling.
        if (error instanceof SessionRejectedError) {
          this.#sessionExpired = error.sessionExpired
          this.errLog(
            error.sessionExpired
              ? 'the Weixin session has expired; messaging is stopped until you log in again (run bin/login.js, then reload)'
              : `the Weixin API rejected this session (${error.message}); messaging is stopped until you log in again`,
          )
          this.#onSessionRejected?.(error)
          break
        }
        if (isAbortError(error)) {
          // Headers arrived but the body never did and the watchdog fired.
          // A fresh controller for the next round; this round is a failure.
          this.errLog(`getUpdates watchdog: poll round aborted after ${pollDeadlineMs}ms; retrying`)
          this.abort = new AbortController()
        } else {
          const classified = classifyFetchError(error)
          this.errLog(`getUpdates failed (${classified.type}): ${classified.description}`)
        }
        consecutiveFailures += 1
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.errLog(`getUpdates failed ${consecutiveFailures} times; backing off ${BACKOFF_DELAY_MS}ms`)
          await interruptibleSleep(BACKOFF_DELAY_MS, () => this.running)
          consecutiveFailures = 0
        } else {
          await interruptibleSleep(RETRY_DELAY_MS, () => this.running)
        }
      }
    }
  }

  /**
   * Send one text reply, split into chunks by the caller.
   * @param {any} message
   */
  async send(message) {
    const item = { type: MessageItemType.TEXT, text_item: { text: message.text ?? '' } }
    // Pace every send, then tell the pacer what happened: three failures in a
    // row arm the cooldown that stops a retry storm from becoming a send ban.
    await this.pacer.acquire()
    try {
      await sendMessage({
        baseUrl: this.baseUrl,
        token: this.token,
        body: this.#body({ conversationId: message.conversationId, item, contextToken: message.contextToken }),
      })
    } catch (error) {
      this.pacer.noteFailure()
      throw error
    }
    this.pacer.noteSuccess()
  }

  /**
   * Upload one local file to the Weixin CDN and send it as an IMAGE, VIDEO or
   * FILE item, routed by MIME type.
   *
   * This is the transport's half of the outbound-media seam: it owns the iLink
   * credentials, the routing fields and the context-token echo, and delegates
   * the decision (is this path allowed? is it a file? how big?) as well as the
   * upload itself to `src/media/outbound.js`. Keeping the item construction here
   * — rather than in the media layer — means FILE/IMAGE/VIDEO items go through
   * the same `#body()` envelope as text, so they cannot drift apart on
   * `message_type`, `message_state` or `context_token`.
   *
   * The context-token echo is mandatory for media too: iLink routes the reply
   * by it exactly as it does for text.
   *
   * @param {object} params
   * @param {string} params.filePath  Local file to upload.
   * @param {string} params.conversationId  Peer id (`to_user_id`).
   * @param {string} [params.contextToken]
   * @param {string} [params.cdnBaseUrl]
   * @param {string} [params.caption]  Optional text sent as its own item first.
   * @returns {Promise<{ kind: string, filekey?: string, serverMessageId?: string }>}
   * @throws when the upload or the send fails; the caller degrades to text.
   */
  async sendMedia({ filePath, conversationId, contextToken, cdnBaseUrl, caption }) {
    const { sendOutboundMedia, sendOutboundVoice, mediaSendOptions } = await import('../media/outbound.js')
    const { isVoiceCandidate } = await import('../media/voice-encode.js')
    const opts = mediaSendOptions({
      baseUrl: this.baseUrl,
      token: this.token,
      accountId: this.accountId,
    })
    // One media call is two server-side sends when a caption is present (the
    // caption goes as its own text item first), but the pacer gates the pair
    // as a unit: both go out inside this one acquire, and a failure is
    // reported once. Media is the heavier half of a reply, so counting it
    // matters for the rolling ban threshold.
    await this.pacer.acquire()
    let result
    try {
      const mediaParams = {
        filePath,
        to: conversationId,
        contextToken: contextToken ?? this.#fallbackContextToken(),
        cdnBaseUrl: cdnBaseUrl ?? this.cdnBaseUrl,
        opts,
        ...(caption === undefined || caption === '' ? {} : { text: caption }),
      }
      // Audio rides the voice path (SILK voice_item) instead of file_item.
      // A voice failure degrades to the file path rather than dropping the
      // audio: the shape is newer than every other item kind here, and the
      // worst case of a bad wire shape must be "arrives as a file", not
      // "the reply loses its attachment".
      if (this.voiceOutbound && isVoiceCandidate(filePath)) {
        try {
          result = await sendOutboundVoice(mediaParams)
        } catch (voiceError) {
          this.log(`voice send failed (${String(voiceError?.message ?? voiceError)}); sending ${filePath} as a file instead`)
          result = await sendOutboundMedia(mediaParams)
        }
      } else {
        result = await sendOutboundMedia(mediaParams)
      }
    } catch (error) {
      this.pacer.noteFailure()
      throw error
    }
    this.pacer.noteSuccess()
    this.log(`sent ${result.kind} media ${filePath} to ${conversationId}`)
    return result
  }

  /**
   * Build the iLink envelope shared by every outbound item kind.
   *
   * One place for the invariants: the bot message type, the FINISH state (iLink
   * ignores a non-final item), a fresh client id per request, and the echoed
   * `context_token` that routes the reply. `item_list` is always exactly one
   * item because that is what upstream's send pipeline does for the same reason.
   *
   * @param {object} params
   * @param {string} params.conversationId
   * @param {any} params.item
   * @param {string} [params.contextToken]
   */
  #body({ conversationId, item, contextToken }) {
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: conversationId,
        client_id: `dsh-weixin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
      },
    }
    // iLink routes a reply by context token; without the echo the message can
    // be rejected or delivered to the wrong conversation.
    const token = contextToken ?? this.#fallbackContextToken()
    if (token) body.msg.context_token = token
    return body
  }

  /**
   * Last-resort context token when the inbound message carried none: the
   * account's `typing_ticket` from getConfig. Usually absent, in which case the
   * send proceeds without a token (the upstream contract allows it).
   */
  #fallbackContextToken() {
    return this.typingTicket
  }

  /**
   * Refresh the typing ticket used as a fallback context token.
   *
   * The request needs the bound operator's `ilink_user_id`. It used to be sent
   * empty, and the API answers that with `{ret:-2, errmsg:"ilink_user_id
   * required"}` — which nothing noticed, because `getConfig` does not raise on a
   * non-zero `ret` and the caller only looked for a missing `typing_ticket`. The
   * result was a permanent no-op: no typing indicator, and every reply that
   * arrived without a context token lost its fallback and could be rejected.
   */
  async refreshConfig() {
    if (!this.userId) {
      // Nothing to send. Say so once instead of issuing a request that is
      // guaranteed to be refused.
      this.log('getConfig skipped: this account has no saved ilink_user_id (typing ticket unavailable)')
      return
    }
    try {
      const resp = await getConfig({ baseUrl: this.baseUrl, token: this.token, ilinkUserId: this.userId })
      if (typeof resp?.typing_ticket === 'string' && resp.typing_ticket) {
        this.typingTicket = resp.typing_ticket
        return
      }
      // A refused request still looks like a healthy one from here, so name the
      // reason rather than leaving the operator to guess why typing never shows.
      this.log(
        `getConfig returned no typing ticket (ret=${resp?.ret ?? '(none)'} errmsg=${resp?.errmsg ?? '(none)'})`,
      )
    } catch (error) {
      this.log(`getConfig failed (typing ticket unavailable): ${String(error)}`)
    }
  }

  /**
   * Show (or clear) the "typing" indicator in the Weixin conversation.
   *
   * iLink needs a `typing_ticket` from getConfig, not the message's context
   * token; without a ticket the indicator is silently unavailable and this is a
   * no-op. The ticket is per-account, not per-conversation, but `ilink_user_id`
   * selects the peer.
   */
  async setTyping(active, conversationId) {
    if (!this.typingTicket) return
    try {
      await sendTyping({
        baseUrl: this.baseUrl,
        token: this.token,
        body: {
          ilink_user_id: conversationId,
          typing_ticket: this.typingTicket,
          status: active ? TypingStatus.TYPING : TypingStatus.CANCEL,
        },
      })
    } catch {
      // A typing indicator is cosmetic; never fail a turn over it.
    }
  }

  async stop() {
    if (!this.running) return
    this.running = false
    this.abort.abort()
    try {
      await this.loopPromise
    } catch {
      // The loop swallows its own errors; nothing to propagate.
    }
    // The loop no longer awaits handlers, so a turn started a moment ago is
    // still running: wait for it, exactly as the old `await dispatchMessage`
    // made stop() wait. Skipping this would let a disposed plugin keep sending
    // replies for a session it no longer owns.
    try {
      await this.#scheduler?.drain()
    } catch {
      // Handler errors are already reported by the scheduler's own boundary.
    }
    try {
      // Bounded for the same reason as notifyStart in start(): the vendor's
      // timeout is cleared at headers, so a body-stalling server would hang
      // shutdown forever. Best-effort either way.
      await Promise.race([
        notifyStop({ baseUrl: this.baseUrl, token: this.token }),
        deadline(this.longPollTimeoutMs * 2 + 10_000),
      ])
    } catch {
      // Shutting down; a failed notification is not actionable.
    }
  }
}
