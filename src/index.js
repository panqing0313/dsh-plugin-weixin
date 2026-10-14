/**
 * dsh-weixin — a DSH channel plugin that turns Weixin (personal WeChat, via the
 * iLink Bot API) into a remote control surface for a DSH agent.
 *
 * Contract: a Cordis plugin module exports `name`, `inject` (required services)
 * and `apply(ctx, config)`. Everything registered through `ctx.on` / `ctx.effect`
 * is undone automatically when the plugin unloads, so `apply` only has to wire
 * the pipeline and hand back a disposer.
 *
 * The pipeline, in order, for every inbound Weixin message:
 *   allowlist → dedupe → agent session → markdown filter → chunked reply.
 *
 * Two deliberate safety properties:
 *  - The allowlist is deny-by-default. WeChat text is not an authorization
 *    credential, so a plugin with no allowlist drives nothing at all.
 *  - Credentials live only in a local file under ~/.dsh (0600). This plugin
 *    never accepts a password, and the QR login prints the code locally.
 * @module dsh-weixin
 */
import z from '@deepseek-ai/schemastery'
import { configureWeixinStateDir, accountsDir, ensureSessionsDir } from './state.js'
import { isAllowedSender, denialReason } from './security/allowlist.js'
import { ILinkTransport } from './transport/ilink.js'
import { AgentBridge } from './agent-bridge.js'
import { chunkText } from './message/chunker.js'
import { MessageDeduper } from './message/dedupe.js'
import { markdownToPlainText, resolveMarkdownMode } from './message/markdown.js'
import { allowedMediaDirs, deliverOutboundMedia, DEFAULT_MAX_MEDIA_BYTES } from './media/outbound.js'
import { AsrBridge, DEFAULT_ASR_TIMEOUT_MS, resolveAsrSettings } from './media/asr.js'
import { WeixinLoginController } from './login-remote.js'
import { AsrController } from './asr-remote.js'
import {
  DEFAULT_CDN_BASE_URL,
  DEFAULT_MAX_INBOUND_MEDIA_BYTES,
  downloadInboundMedia,
  downloadInboundVoice,
  describeInboundMedia,
  describeMediaFailures,
} from './media/inbound.js'

export const name = 'dsh-weixin'

/**
 * `agents` is required: without it there is no session to drive, so the plugin
 * would load and then silently do nothing. Everything else (settings, sessions,
 * the workspace registry) is optional and read through `ctx.get`, because a
 * missing grouping service must cost the GUI group label — not the ability to
 * reply.
 */
export const inject = ['agents']

/**
 * Every deploy-varying value is a config field rather than a constant, and an
 * invalid value fails load loudly instead of being clamped at runtime.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('Start the Weixin long-poll loop when the plugin loads.'),
  accountId: z.string().default('').description('Weixin account id to use; empty means the only saved account.'),
  cwd: z.string().default('').description('Working directory the agent operates in; empty inherits the session default.'),
  allowedSenders: z.array(z.string()).default([]).description('Weixin user ids allowed to drive the agent. Empty denies everyone.'),
  allowedChats: z.array(z.string()).default([]).description('Optional conversation allowlist. Empty allows any conversation from an allowed sender.'),
  maxMessageLength: z.number().default(1500).description('Maximum characters per outbound Weixin message.'),
  markdownMode: z
    .union([z.const('strip'), z.const('off')])
    .default('strip')
    .description('How to render the agent Markdown reply for WeChat: "strip" filters unsupported syntax, "off" sends it verbatim.'),
  progressAfterMs: z.number().default(45_000).description('Send one progress note to the user after this many milliseconds.'),
  maxTurnWaitMs: z.number().default(1_200_000).description('Give up waiting for a turn after this many milliseconds.'),
  typingIndicator: z.boolean().default(true).description('Show a typing indicator while the agent works, when a typing ticket is available.'),
  mediaEnabled: z.boolean().default(true).description('Send local files the agent references in its reply as Weixin images/videos/file attachments.'),
  maxMediaBytes: z.number().default(DEFAULT_MAX_MEDIA_BYTES).description('Largest referenced file that will be uploaded to the Weixin CDN.'),
  maxInboundMediaBytes: z
    .number()
    .default(DEFAULT_MAX_INBOUND_MEDIA_BYTES)
    .description('Largest attachment this channel will download from the Weixin CDN.'),
  cdnBaseUrl: z
    .string()
    .default('')
    .description(
      'Weixin CDN root for inbound media downloads and outbound uploads. Empty means "not configured here", which lets a saved account record supply it before falling back to the upstream default.',
    ),
  asr: z
    .object({
      enabled: z.boolean().default(true).description('Transcribe inbound voice messages; false keeps them as SILK/WAV files only.'),
      command: z
        .string()
        .default('')
        .description(
          'Executable of a line-oriented ASR bridge (one JSON request per line on stdin, one JSON response per line on stdout). Empty disables transcription.',
        ),
      args: z.array(z.string()).default([]).description('Arguments passed to the ASR bridge executable.'),
      timeoutMs: z.number().default(DEFAULT_ASR_TIMEOUT_MS).description('Give up on one transcription after this many milliseconds.'),
      env: z
        .dict(z.string())
        .default({})
        .description('Extra environment for the ASR bridge, e.g. HF_HOME, DSH_WEIXIN_ASR_MODEL or DSH_WEIXIN_ASR_LANGUAGE.'),
      model: z
        .string()
        .default('')
        .description(
          'Whisper model location for transcription. A Hugging Face repo id (mlx-community/whisper-small-mlx) or an absolute path to a local model directory. Empty lets the ASR bridge default apply.',
        ),
      modelDir: z
        .string()
        .default('')
        .description(
          'Directory where downloadable voice models are stored and looked up. Empty defaults to ~/.dsh/weixin/asr-models.',
        ),
    })
    .default({})
    .description('Voice transcription through an external bridge process. Absent or empty command means voice notes are delivered as files.'),
})

/**
 * @param {any} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  // Must precede any credential/sync-buffer path resolution in the vendored
  // transport, which reads OPENCLAW_STATE_DIR on every call.
  const stateRoot = configureWeixinStateDir()
  const log = (line) => ctx.logger?.info?.(`dsh-weixin: ${line}`)
  const warn = (line) => ctx.logger?.warn?.(`dsh-weixin: ${line}`)

  if (config.enabled === false) {
    log('disabled by configuration; not starting the Weixin loop')
    return
  }

  // Settings-page services: QR login orchestration and ASR model management.
  // Registered regardless of enabled so a disabled plugin can still be
  // configured and logged in from the UI before being turned on.
  try {
    ctx.plugin(WeixinLoginController, {})
  } catch (error) {
    warn(`settings login service unavailable: ${String(error)}`)
  }
  // Kept in a variable because the settings UI can change the model directory
  // at runtime (setModelDir); the ASR bridge must use the current value, not
  // the one the process started with.
  let asrController
  try {
    asrController = new AsrController(ctx, { modelDir: config.asr?.modelDir?.trim() || undefined })
    ctx.plugin(asrController)
  } catch (error) {
    warn(`settings ASR service unavailable: ${String(error)}`)
    asrController = undefined
  }

  ctx.effect(() => {
    let cancelled = false
    /** @type {ILinkTransport | undefined} */
    let transport
    /** @type {AgentBridge | undefined} */
    let bridge
    /** @type {AsrBridge | undefined} */
    let asrBridge

    // Startup is async (account lookup, typing ticket, loop start), but the
    // effect disposer is synchronous-safe: it awaits the startup promise, then
    // tears down whatever got as far as existing.
    const started = (async () => {
      const account = await resolveAccount(config, warn)
      if (account === undefined || cancelled) return

      transport = new ILinkTransport({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
        token: account.token,
        // Explicit configuration wins over the account record, which in turn
        // wins over the upstream default. The schema default is the empty
        // string precisely so "unset" stays distinguishable here: a real
        // default would make this fallback unreachable and silently pin every
        // install to the production CDN root.
        //
        // Whitespace is normalized to "unset" first. `||` treats "   " as
        // truthy, so a YAML `cdnBaseUrl:` with trailing spaces would otherwise
        // win the whole chain, discard a perfectly good account record, and
        // fail later as `Failed to parse URL from    /upload?...`. The account
        // side already trims (vendor .../auth/accounts.js), and so do cwd and
        // accountId above; this keeps the three consistent.
        cdnBaseUrl: config.cdnBaseUrl?.trim() || account.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
        log,
        errLog: warn,
      })
      const cwd = await resolveCwd(ctx, config, warn)
      bridge = new AgentBridge({
        ctx,
        cwd,
        progressAfterMs: config.progressAfterMs,
        maxWaitMs: config.maxTurnWaitMs,
        log,
        errLog: warn,
      })

      // Voice transcription is opt-in and out of tree: with no bridge configured
      // this stays undefined and voice notes are delivered as files, exactly as
      // they were before ASR existed. The process is started lazily by the first
      // voice message (model load costs seconds), so an unused install pays
      // nothing for it.
      const asrSettings = resolveAsrSettings(config, asrController?.modelDir)
      asrBridge =
        asrSettings === undefined ? undefined : new AsrBridge(asrSettings, { log: (line) => log(line), warn: (line) => warn(line) })
      if (asrBridge !== undefined) log(`voice transcription enabled via ${asrSettings.command}`)

      // The typing ticket doubles as the fallback context token for replies
      // that arrive without one; refreshing it once at startup is enough.
      await transport.refreshConfig()
      if (cancelled) return

      // iLink can redeliver a message after a reconnect; the cache is bounded
      // so a long-running bot does not grow without limit.
      const seen = new MessageDeduper()
      const handler = createInboundHandler({
        config,
        transport,
        bridge,
        asrBridge,
        seen,
        log,
        warn,
        stateRoot,
        // Resolved once: the allowlist is a property of the deployment, not of
        // the message, and re-resolving per reply would re-stat every directory.
        mediaDirs: allowedMediaDirs({ cwd, stateDir: stateRoot }),
      })
      // The transport already isolates per-message failures, so no extra catch
      // here: an error must not be reported twice or swallowed twice.
      await transport.start(handler)
      log(`listening as account ${account.accountId} (state: ${stateRoot})`)
    })()

    return async () => {
      cancelled = true
      await started.catch((error) => warn(`startup failed: ${String(error)}`))
      await transport?.stop().catch((error) => warn(`transport stop failed: ${String(error)}`))
      // Before the agent bridge: a transcription in flight is failed through the
      // ASR disposer, so the inbound handler stops waiting on it promptly.
      await asrBridge?.dispose().catch((error) => warn(`asr teardown failed: ${String(error)}`))
      await bridge?.dispose().catch((error) => warn(`session teardown failed: ${String(error)}`))
    }
  }, 'dsh-weixin/listen')
}

/**
 * Decide the working directory the agent runs in.
 *
 * The session header's `cwd` is not cosmetic: the prompt assembly reads it back
 * through the `{{cwd}}` variable, so a session created without one fails its
 * first turn outright ("prompt variable {{cwd}} has no value").
 *
 * An empty config therefore means "the Weixin group", not "no cwd": DSH groups
 * sessions by working directory, so defaulting to the deployment's own cwd would
 * mix these conversations into the profile's group. {@link ensureSessionsDir}
 * gives every Weixin conversation one shared home instead.
 *
 * A directory that cannot be created falls back to the process directory, since
 * a usable agent beats a dead turn.
 *
 * @param {any} ctx
 * @param {{ cwd?: string }} config
 * @param {(line: string) => void} warn
 * @returns {Promise<string>}
 */
async function resolveCwd(ctx, config, warn) {
  const configured = config.cwd?.trim()
  if (configured !== undefined && configured !== '') return configured
  try {
    return ensureSessionsDir()
  } catch (error) {
    warn(`could not create the Weixin sessions directory: ${String(error)}`)
  }
  try {
    const fs = ctx.get('fs')
    if (fs?.resolve !== undefined && fs?.processPath !== undefined) {
      return fs.processPath(await fs.resolve('.'))
    }
  } catch (error) {
    warn(`could not resolve the default working directory: ${String(error)}`)
  }
  return process.cwd()
}

/**
 * Load the configured account's credentials from the local state directory.
 *
 * Returns undefined (and logs) when nothing is saved yet: the user must run the
 * login command first. Never throws for a missing file, so a fresh install logs
 * one actionable line instead of failing plugin load.
 *
 * @param {{ accountId?: string }} config
 * @param {(line: string) => void} warn
 */
async function resolveAccount(config, warn) {
  const { DEFAULT_BASE_URL, listWeixinAccountIds, loadWeixinAccount, resolveWeixinAccount } =
    await import('../vendor/openclaw-weixin/auth/accounts.js')

  const configured = config.accountId?.trim()
  let accountId = configured
  if (accountId === undefined || accountId === '') {
    const ids = listWeixinAccountIds({})
    if (ids.length === 0) {
      warn(`no Weixin account is saved (expected under ${accountsDir()}); run the login command first`)
      return undefined
    }
    if (ids.length > 1) {
      warn(`${ids.length} Weixin accounts are saved; set config.accountId to pick one: ${ids.join(', ')}`)
      return undefined
    }
    accountId = ids[0]
  }

  const data = loadWeixinAccount(accountId)
  if (data === null || !data.token) {
    warn(`account "${accountId}" has no saved token (expected ${accountsDir()}/${accountId}.json); run the login command`)
    return undefined
  }

  // resolveWeixinAccount applies the upstream defaults and config overrides
  // (baseUrl, cdnBaseUrl, enabled) that the transport expects.
  let resolved
  try {
    resolved = resolveWeixinAccount({ channels: { 'openclaw-weixin': { accounts: { [accountId]: {} } } } }, accountId)
  } catch {
    resolved = undefined
  }
  return {
    accountId,
    baseUrl: data.baseUrl ?? resolved?.baseUrl ?? DEFAULT_BASE_URL,
    // The record's OWN CDN root, not a default. Deliberately only the saved
    // value: `resolveWeixinAccount` always fills in the upstream production
    // root, so consulting it here would make the caller's chain unable to tell
    // "the account chose this" from "nobody chose anything" — and would make
    // the caller's final fallback unreachable. Empty and whitespace-only values
    // mean "not set", hence `trim() ||` rather than `??`.
    cdnBaseUrl: data.cdnBaseUrl?.trim() || undefined,
    token: data.token,
    userId: data.userId,
  }
}

/**
 * One inbound Weixin message through the whole pipeline.
 *
 * @param {object} params
 * @param {any} params.config
 * @param {ILinkTransport} params.transport
 * @param {AgentBridge} params.bridge
 * @param {AsrBridge} [params.asrBridge]
 * @param {import('./message/dedupe.js').MessageDeduper} params.seen
 * @param {(line: string) => void} params.log
 * @param {(line: string) => void} params.warn
 * @param {string} params.stateRoot  Weixin state root, for the media allowlist.
 * @param {string[]} params.mediaDirs  Directories a reply may reference.
 */
function createInboundHandler({ config, transport, bridge, asrBridge, seen, log, warn, stateRoot, mediaDirs }) {
  return async (message) => {
    // 1. Truly unknown item kinds (TOOL_CALL_*, anything the protocol adds
    //    later) still get one short notice rather than silence. Media kinds are
    //    NOT unsupported — they are normalized into descriptors by the transport
    //    and downloaded below, after authorization.
    if (message.unsupported !== undefined) {
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: `（暂不支持这条消息：${message.unsupported}）`,
        contextToken: message.contextToken,
      })
      return
    }

    // 2. Authorization first: before dedupe, before a session exists, and —
    //    critically — before any download. An unauthorized sender must not be
    //    able to make this host issue requests to Tencent's CDN, so nothing
    //    below this point may run for a denied message.
    if (!isAllowedSender(config, message.senderId, message.conversationId)) {
      warn(`refused message from ${message.senderId}: ${denialReason(config, message.senderId, message.conversationId)}`)
      return
    }

    // 3. Dedupe: iLink can redeliver a message after a reconnect.
    if (!seen.accept(message.id)) {
      log(`skipping duplicate message ${message.id}`)
      return
    }

    // 4. Media: authorized and de-duplicated, so it is now safe to fetch the
    //    attachments. A failure here is reported and the turn continues with
    //    whatever text remains, rather than dropping the message.
    let prompt = message.text
    if (Array.isArray(message.media) && message.media.length > 0) {
      // `transport.cdnBaseUrl` is already normalized at construction, so only
      // the config value needs trimming here (see the transport options above).
      const cdnBaseUrl = config.cdnBaseUrl?.trim() || transport.cdnBaseUrl || DEFAULT_CDN_BASE_URL
      const maxInboundMediaBytes = config.maxInboundMediaBytes ?? DEFAULT_MAX_INBOUND_MEDIA_BYTES
      /** @type {Array<Record<string, any>>} */
      const saved = []
      /** @type {Array<{ kind: string, reason: string, code: string }>} */
      const failures = []
      for (const media of message.media) {
        const download = media.kind === 'voice' ? downloadInboundVoice : downloadInboundMedia
        const result = await download({ media, cdnBaseUrl, maxBytes: maxInboundMediaBytes, bridge: asrBridge })
        if (result.ok) {
          log(
            `saved inbound ${result.kind} to ${result.path} (${result.bytes} bytes)` +
              (result.kind === 'voice' ? ` transcoded=${result.transcoded === true} transcribed=${typeof result.transcript === 'string'}` : ''),
          )
          saved.push(result)
        } else {
          warn(`inbound ${media.kind} download failed: ${result.reason}`)
          failures.push({ kind: media.kind, reason: result.reason, code: result.code })
        }
      }
      const parts = []
      if (saved.length > 0) parts.push(describeInboundMedia(saved, message.text))
      // A failure with no caption and nothing saved is answered here rather
      // than by the agent: there is no content to reason about, only an error
      // to relay, and waking a full turn (with its model call) to repeat one
      // line back to the user would be a pointless expense and a slow reply.
      // With a caption — or with some attachments saved — the failure is folded
      // into the prompt instead, so the agent can answer the question the user
      // actually asked while mentioning what did not arrive.
      const nothingToReasonAbout = saved.length === 0 && (message.text ?? '') === ''
      if (failures.length > 0 && !nothingToReasonAbout) parts.push(describeMediaFailures(failures))
      if (nothingToReasonAbout) {
        await sendChunked(transport, config, {
          conversationId: message.conversationId,
          text: `（${describeMediaFailures(failures)}）`,
          contextToken: message.contextToken,
        })
        return
      }
      prompt = parts.join('\n\n')
    }

    // 5. Drive the agent, then send the reply back in chunks.
    if (config.typingIndicator) await transport.setTyping(true, message.conversationId)
    try {
      const startedAt = Date.now()
      const reply = await bridge.deliver({
        conversationId: message.conversationId,
        text: prompt,
        onProgress: async (note) => {
          await sendChunked(transport, config, {
            conversationId: message.conversationId,
            text: `（${note}）`,
            contextToken: message.contextToken,
          })
        },
      })
      log(`turn settled in ${Date.now() - startedAt}ms for ${message.conversationId}`)
      // Media first, text second: the send already degrades to text when an
      // upload fails, and everything the user is about to see is decided here.
      const outbound = await resolveOutboundReply({
        config,
        transport,
        mediaDirs,
        stateRoot,
        reply: reply.text,
        conversationId: message.conversationId,
        contextToken: message.contextToken,
        warn,
      })
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: outbound,
        contextToken: message.contextToken,
      })
    } catch (error) {
      warn(`turn failed: ${String(error)}`)
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: `（处理失败：${String(error)}）`,
        contextToken: message.contextToken,
      })
    } finally {
      if (config.typingIndicator) await transport.setTyping(false, message.conversationId)
    }
  }
}

/**
 * Turn one agent reply into what actually goes out: the referenced local files
 * uploaded and sent as attachments, plus the text that is left.
 *
 * This is the only place outbound media is triggered, and it is triggered by the
 * reply's own content — there is no tool the agent can call to send a file. The
 * rule, and its two gates, live in `src/media/outbound.js`:
 *
 *  1. the reply references a file (`![alt](path)` or a line that is just a path);
 *  2. that path resolves inside {@link mediaDirs} and is an existing regular file.
 *
 * A refusal or a failed upload never loses the answer: the reference stays in the
 * text and `deliverOutboundMedia` appends one line naming the file and why it did
 * not arrive. That ordering is deliberate — a caption the user can act on beats a
 * silently missing attachment.
 *
 * @param {object} params
 * @param {{ mediaEnabled?: boolean, maxMediaBytes?: number }} params.config
 * @param {ILinkTransport} params.transport
 * @param {string[]} params.mediaDirs
 * @param {string} params.stateRoot
 * @param {string} params.reply
 * @param {string} params.conversationId
 * @param {string} [params.contextToken]
 * @param {(line: string) => void} params.warn
 * @returns {Promise<string>} text to send, with a failure note when applicable
 */
async function resolveOutboundReply(params) {
  const text = params.reply ?? ''
  if (params.config.mediaEnabled === false) return text
  try {
    const result = await deliverOutboundMedia({
      text,
      to: params.conversationId,
      contextToken: params.contextToken,
      allowedDirs: params.mediaDirs,
      cdnBaseUrl: params.transport.cdnBaseUrl,
      opts: {
        baseUrl: params.transport.baseUrl,
        token: params.transport.token,
        accountId: params.transport.accountId,
      },
      ...(params.config.maxMediaBytes === undefined ? {} : { maxBytes: params.config.maxMediaBytes }),
      warn: params.warn,
      send: (mediaParams) => params.transport.sendMedia(mediaParams),
    })
    if (result.sent.length > 0) params.warn(`sent ${result.sent.length} outbound media file(s)`)
    return result.text
  } catch (error) {
    // deliverOutboundMedia is written not to throw; if a future edit breaks
    // that, the reply must still go out rather than the turn dying here.
    params.warn(`outbound media step failed, sending text only: ${String(error)}`)
    return text
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
 * @param {{ maxMessageLength: number, markdownMode?: 'strip'|'off' }} config
 * @param {{ conversationId: string, text: string, contextToken?: string }} message
 */
async function sendChunked(transport, config, message) {
  const text = markdownToPlainText(message.text ?? '', resolveMarkdownMode(config))
  const chunks = chunkText(text, config.maxMessageLength)
  for (const chunk of chunks) {
    await transport.send({
      conversationId: message.conversationId,
      type: 'text',
      text: chunk,
      contextToken: message.contextToken,
    })
  }
}
