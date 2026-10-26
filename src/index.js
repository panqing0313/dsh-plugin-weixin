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
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { configureWeixinStateDir, accountsDir, ensureSessionsDir, withSavedConfig } from './state.js'
import { isAllowedSender, denialReason } from './security/allowlist.js'
import { ILinkTransport } from './transport/ilink.js'
import { AgentBridge } from './agent-bridge.js'
import { chunkText } from './message/chunker.js'
import { appendJournal } from './message/journal.js'
import { appendToolAudit } from './message/audit.js'
import { DEFAULT_SEND_INTERVAL_MS, DEFAULT_COOLDOWN_MS } from './message/rate-limit.js'

/**
 * Module-level outbound journal sink, wired once in setup (see sendChunked).
 * `sendChunked` is a module-level function with no apply scope, so the wiring
 * has to cross scopes exactly once — null before setup means "not recording".
 */
let journalOutboundRef = null
import { MessageDeduper } from './message/dedupe.js'
import { markdownToPlainText, resolveMarkdownMode } from './message/markdown.js'
import { extractUrls, fetchLinkText, describeLinkResults } from './message/links.js'
import { ReminderScheduler } from './message/scheduler.js'
import { SubscriptionScheduler, formatStamp } from './message/subscriptions.js'
import { allowedMediaDirs, deliverOutboundMedia, DEFAULT_MAX_MEDIA_BYTES, listProducedFiles } from './media/outbound.js'
import { AsrBridge, DEFAULT_ASR_TIMEOUT_MS, resolveAsrSettings } from './media/asr.js'
import { WeixinLoginController } from './login-remote.js'
import { AsrController } from './asr-remote.js'
import { ConfigController } from './config-remote.js'
import { isAccountPaused, touchAccount, allowlistForAccount, readRegistry, enrolFirstContact } from './account-registry.js'
// `/cancel` is the one message the transport must be able to deliver while a
// turn is still running; the predicate lives beside the parser so the two
// cannot drift apart.
import { isInterruptCommand } from './sessions.js'
// Persona modes + conversation memory: the prompt seam and the /mode,
// /remember, /forget, /memory handlers both need the same store.
import {
  buildPersonaBlock,
  readPersonaStore,
  resolveMode,
  activeModeFor,
  setActiveMode,
  DEFAULT_MODE_ID,
} from './persona.js'
import {
  buildMemoryBlock,
  readGlobalMemory,
  readConvMemory,
  readRecentWindow,
  addGlobalFact,
  removeGlobalFact,
  bondLine,
} from './memory.js'
import { readJournalRange, renderChatMarkdown, writeChatExport } from './message/chat-export.js'
import { createMemorySummarizer } from './memory-summarizer.js'
// The vendored logger is the only channel guaranteed to land on disk at INFO:
// ctx.logger can drop levels depending on the host's exporter config, and a
// refusal that leaves no trace turns an allowlist mismatch into "the bot just
// ignores me" with nothing to grep afterwards.
import { logger as vendorLogger } from '../vendor/openclaw-weixin/util/logger.js'
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
 * Directory this file was loaded from — the plugin package root (one level
 * above `src/`), in the repository, in a profile install, and in an npm install
 * alike. The shipped ASR bridge lives at `<root>/bin/asr-bridge.py`, and the
 * operator is invited to point `asr.args` at that path; using this as the
 * child's cwd makes a *relative* bridge path work too, regardless of the
 * directory the DSH host happened to be started in.
 */
const PLUGIN_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')

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
  sendIntervalMs: z.number().min(1).default(DEFAULT_SEND_INTERVAL_MS).description('Minimum interval between two outbound Weixin sends, in milliseconds. Raising it costs latency on a chunked reply; lowering it moves closer to the measured send-ban threshold (about twenty messages in a few minutes).'),
  sendCooldownMs: z.number().min(1).default(DEFAULT_COOLDOWN_MS).description('How long to stop sending after three consecutive send failures, in milliseconds. Hammering a rejecting server is what turns a temporary rejection into an account ban.'),
  voiceOutbound: z.boolean().default(false).description(
    'Send audio attachments (wav, mp3, m4a, ogg, flac, silk, ...) as Weixin voice messages instead of file attachments. wav and silk are transcoded in-process; the rest need ffmpeg on PATH. A voice send that FAILS falls back to the plain file path — but the iLink server currently ACCEPTS a bot voice_item (ret=0) without ever delivering it (measured 2026-06 and again 2026-10-26 with a fresh token; upload and send both succeed), so with this on an audio attachment can silently vanish. Off by default until the server actually delivers bot voice.',
  ),
  messageJournal: z.boolean().default(true).description('Record recent inbound and outbound messages (message journal, shown on the settings card).'),
  personaDefaultMode: z.string().default(DEFAULT_MODE_ID).description(
    'The conversation style used when a Weixin chat has not picked one with /mode. Built-in modes: default (plain assistant), girlfriend 女友, boyfriend 男友, friend 朋友; custom modes are edited on the settings card\'s 个性化 tab. An unknown id here quietly falls back to default.',
  ),
  memoryEnabled: z.boolean().default(true).description(
    'Inject a <weixin_memory> block into every prompt: global facts saved with /remember, the conversation\'s rolling summary (refreshed automatically every memorySummaryTurns turns), and the last few messages of this chat. /memory shows what is stored, /forget deletes. Turning this off stops the injection AND the /remember /forget commands.',
  ),
  memorySummaryTurns: z.number().min(1).default(10).description(
    'How often (in agent turns per conversation) the background summarizer rewrites the conversation summary. The summarizer runs as a hidden side turn after a real turn finishes; it never sends anything to WeChat. 1 disables nothing — set memoryEnabled false for that.',
  ),
  memoryGlobalMaxFacts: z.number().min(1).default(30).description('How many global /remember facts to keep per account. Full refuses new facts instead of silently dropping the oldest — delete some with /forget.'),
  memoryConvMaxChars: z.number().min(1).default(1200).description('Character budget for the conversation summary in the injected memory block.'),
  toolAudit: z.boolean().default(true).description(
    'Append one JSONL line per tool the agent runs (tool name, truncated arguments, which Weixin account/conversation/sender caused it, and whether the result carried an error) under <state>/audit/. Off by default nothing would ever answer "who ran that destructive tool yesterday"; a missing directory or a full disk only warns, it never fails a turn.',
  ),
  markdownMode: z
    .union([z.const('strip'), z.const('off')])
    .default('strip')
    .description('How to render the agent Markdown reply for WeChat: "strip" filters unsupported syntax, "off" sends it verbatim.'),
  busyMessageMode: z
    .union([z.const('queue'), z.const('steer')])
    .default('queue')
    .description('What happens to a message that arrives while a reply is still being written: "queue" waits and delivers it as the next turn, "steer" injects it into the running turn. "/steer <instruction>" always injects.'),
  sourceContext: z.boolean().default(false).description('Prepend a <weixin_source …> block to each prompt so the agent knows the message came from WeChat and who sent it.'),
  readLinks: z.boolean().default(true).description('When an inbound message contains http(s) links, fetch each one and fold the readable text into the prompt, so the agent can answer questions about the page. A link that fails to fetch is reported to the agent as one line, never as a failed message.'),
  progressAfterMs: z.number().default(45_000).description('Send the first progress note to the user after this many milliseconds.'),
  progressEveryMs: z.number().default(60_000).description('Re-send a changed progress note at most this often, so tool changes stay visible without repeating an unchanged state.'),
  maxTurnWaitMs: z.number().default(1_200_000).description('Give up waiting for a turn after this many milliseconds.'),
  typingIndicator: z.boolean().default(true).description('Show a typing indicator while the agent works, when a typing ticket is available.'),
  mediaEnabled: z.boolean().default(true).description('Send local files the agent references in its reply as Weixin images/videos/file attachments.'),
  autoSendFiles: z.boolean().default(true).description('Also deliver files the agent wrote into its working directory during a turn, even when the reply text never references them.'),
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
      hfProxy: z
        .string()
        .default('')
        .description(
          'Proxy for the model downloader (e.g. http://127.0.0.1:7897). HTTPS destinations are tunnelled with CONNECT. Leave empty to connect directly, which is what the default mirror needs. Set this only on a network that cannot reach the mirror at all: the download is then exactly as fast as the proxy, and no faster.',
        ),
      hfEndpoint: z
        .string()
        .default('https://hf-mirror.com')
        .description(
          'Endpoint the model downloader fetches from. Defaults to https://hf-mirror.com, which is reachable from mainland China without a proxy and serves weights at high speed. Set it to https://huggingface.co to use the official site, or to a corporate mirror. The download is a plain HTTP transfer: it is exactly as fast as the route to this host, and no faster.',
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
  const fileLog = vendorLogger.withAccount('dsh-weixin')

  // Settings the operator saved through the UI live beside the credentials, so
  // they survive a reinstall of the package. They fill in what the composition
  // did not set; an explicit value in the profile YAML still wins, because the
  // YAML is the live decision and an overlay must not make it lie.
  config = withSavedConfig(config ?? {})

  const disabled = config.enabled === false
  if (disabled) {
    // Deliberately NOT an early return. The settings card is the only way to
    // turn the plugin back on, and it reads its own options from the
    // ConfigController registered below -- so returning here would leave a
    // disabled plugin with a card that cannot reach the very switch that
    // re-enables it. The controllers register first; only the long-poll loop is
    // skipped.
    log('disabled by configuration; registering the settings services and starting no loop')
  }

  // Settings-page services: QR login orchestration, ASR model management, and
  // the options form. Registered regardless of enabled so a disabled plugin can
  // still be configured and logged in from the UI before being turned on.
  //
  // Kept in a variable because the poll loop reports a refused session back to
  // it (markSessionExpired), which is what lets the card say "log in again"
  // instead of showing a healthy-looking bound account that receives nothing.
  //
  // Constructing a Cordis `Service` IS the registration: the base class calls
  // `ctx.reflect.provide(name, self, ...)` in its own constructor, so the
  // instance is reachable on the context immediately and is disposed with the
  // plugin's fiber. Do NOT also hand it to `ctx.plugin()` — a plugin must be a
  // function or an object with `apply`, and a service instance is neither, so
  // that call throws "invalid plugin, expect function or object with an "apply"
  // method, received object".
  //
  // That throw used to sit inside these try blocks, where it was recorded as
  // "settings login service unavailable" and the controller was set to
  // `undefined`. Nothing looked broken — the poll loop started, the card
  // rendered, a scan wrote a credential — but there was no controller left to
  // hear "the login finished", so the inbound loop never moved to the new
  // credential and WeChat kept reporting that it could not reach openclaw.
  let loginController
  try {
    loginController = new WeixinLoginController(ctx, {})
  } catch (error) {
    warn(`settings login service unavailable: ${String(error)}`)
    loginController = undefined
  }
  // Kept in a variable because the settings UI can change the model directory
  // at runtime (setModelDir); the ASR bridge must use the current value, not
  // the one the process started with.
  let asrController
  try {
    // Same as the login controller above: the Service constructor registers
    // itself, and passing the instance to `ctx.plugin()` throws. That throw used
    // to be swallowed here too, which silently disabled the whole ASR service.
    asrController = new AsrController(ctx, {
      modelDir: config.asr?.modelDir?.trim() || undefined,
      hfEndpoint: config.asr?.hfEndpoint?.trim() || undefined,
      hfProxy: config.asr?.hfProxy?.trim() || undefined,
    })
  } catch (error) {
    warn(`settings ASR service unavailable: ${String(error)}`)
    asrController = undefined
  }
  // The settings form's view of every configurable option. It is handed the
  // *merged* config so the form can show effective values, and it reads the
  // saved overlay itself on every call — so a value written from the form, or
  // by hand while DSH is running, is reflected without a reload.
  let configController
  try {
    configController = new ConfigController(ctx, { config })
  } catch (error) {
    warn(`settings config service unavailable: ${String(error)}`)
    configController = undefined
  }
  // Constructing it IS the registration, so there is nothing else to do with
  // the reference here; it is kept for the effect below, which asserts the
  // service outlived the try block before anything tries to read options.
  if (configController === undefined) warn('the options form will not be available')

  ctx.effect(() => {
    let cancelled = false
    /**
     * One transport per bound account, keyed by accountId. Multi-account is
     * the steady state now: each account owns a long poll, its own deduper and
     * its own backoff, so one account's stall never blocks another's traffic.
     * The map replaces the single `transport` variable that assumed exactly
     * one account could be bound.
     * @type {Map<string, ILinkTransport>}
     */
    const transports = new Map()
    /** @type {AgentBridge | undefined} */
    let bridge
    /** @type {ReturnType<typeof createMemorySummarizer> | undefined} */
    let memorySummarizer
    /** @type {AsrBridge | undefined} */
    let asrBridge
    /** @type {string} */
    let cwd
    let reminderScheduler
    let subscriptionScheduler
    // Serializes loop hand-offs across ALL accounts. A login can complete while
    // a previous hand-off is still tearing a transport down, and two live loops
    // on one credential deliver every inbound message twice — the server hands
    // it to whichever poll arrives first. One chain keeps the whole effect's
    // bring-up/tear-down operations strictly ordered.
    let handoff = Promise.resolve()

    // Working directory, agent bridge and voice bridge do not depend on which
    // account is bound, so they are built once and reused when a re-login swaps
    // the transport underneath them.
    //
    // Startup is async (working directory, account lookup, typing ticket, loop
    // start), but the effect disposer is synchronous-safe: it awaits the startup
    // promise, then tears down whatever got as far as existing.
    const setup = (async () => {
      cwd = await resolveCwd(ctx, config, warn)
      bridge = new AgentBridge({
        ctx,
        cwd,
        progressAfterMs: config.progressAfterMs,
        progressEveryMs: config.progressEveryMs,
        maxWaitMs: config.maxTurnWaitMs,
        log,
        errLog: warn,
        // Tool audit lands on disk, not in the log: the log rotates away, and
        // the question this answers ("who triggered that tool, with what
        // arguments") is asked after the fact. Wired here rather than inside
        // the bridge so the bridge stays testable without a state root.
        ...(config.toolAudit === false
          ? {}
          : { onToolAudit: (entry) => appendToolAudit(stateRoot, entry, { warn }) }),
      })

      // The P2 memory summarizer: folds recent turns into conv memory every
      // memorySummaryTurns settled turns. Reads the CURRENT account config per
      // call (the card can flip the knobs live); account-scoped per call.
      memorySummarizer = createMemorySummarizer({
        bridge,
        stateRoot,
        config: () => config,
        logger: { log: (line) => log(line), errLog: (line) => warn(line) },
      })

      // Voice transcription is opt-in and out of tree: with no bridge configured
      // this stays undefined and voice notes are delivered as files, exactly as
      // they were before ASR existed. The process is started lazily by the first
      // voice message (model load costs seconds), so an unused install pays
      // nothing for it.
      const asrSettings = resolveAsrSettings(config, asrController?.modelDir, PLUGIN_ROOT)
      asrBridge =
        asrSettings === undefined ? undefined : new AsrBridge(asrSettings, { log: (line) => log(line), warn: (line) => warn(line) })
      if (asrBridge !== undefined) log(`voice transcription enabled via ${asrSettings.command}`)

      reminderScheduler = new ReminderScheduler({
        stateRoot,
        warn,
        fire: async (reminder) => {
          const transport = transports.get(reminder.accountId)
          if (transport === undefined) {
            warn(`reminder ${reminder.id} has no live transport for ${reminder.accountId}; dropped`)
            return
          }
          await sendChunked(transport, config, {
            conversationId: reminder.conversationId,
            text: `（提醒：${reminder.text}）`,
          })
          log(`reminder ${reminder.id} delivered to ${reminder.conversationId}`)
        },
      })
      if (loginController !== undefined) loginController.remindersProvider = reminderScheduler
      if (config.messageJournal === true) {
        journalOutboundRef = (entry) => appendJournal(stateRoot, { dir: 'out', ...entry }, { warn })
      }

      // Scheduled proactive messages (/subscribe): the bot speaks first
      // through its own side session. The prompt re-uses the exact injection
      // blocks the reply path builds — persona mode, memory, the recent
      // window — so a proactive bubble sounds like the same entity the user
      // has been talking to, not a different bot.
      const subscriptionBusy = new Set()
      subscriptionScheduler = new SubscriptionScheduler({
        stateRoot,
        warn,
        fire: async (item) => {
          const transport = transports.get(item.accountId)
          if (transport === undefined) {
            warn(`subscription ${item.id} has no live transport for ${item.accountId}; skipped`)
            return
          }
          if (subscriptionBusy.has(item.conversationId)) {
            warn(`subscription ${item.id} skipped: another fire is running for ${item.conversationId}`)
            return
          }
          subscriptionBusy.add(item.conversationId)
          try {
            const now = Date.now()
            const personaBlock = buildPersonaBlock(resolveMode(
              readPersonaStore(stateRoot, { warn }),
              activeModeFor(stateRoot, item.accountId, item.conversationId, config.personaDefaultMode, { warn }),
            ))
            const memoryBlock = config.memoryEnabled === true
              ? buildMemoryBlock({
                  global: readGlobalMemory(stateRoot, item.accountId, { warn }),
                  conv: readConvMemory(stateRoot, item.accountId, item.conversationId, { warn }),
                  recent: readRecentWindow(stateRoot, item.accountId, item.conversationId, {}),
                  now,
                })
              : ''
            const prompt = [
              personaBlock,
              memoryBlock,
              `<weixin_subscription>`,
              `现在是 ${formatStamp(now)}。你之前和对方约定：到这个时间点，就由你主动给对方发一条消息，主题是「${item.prompt}」。`,
              `直接输出这条消息的正文，就像你在微信里自己发起的一条消息。不要复述或解释这个约定本身。`,
              `</weixin_subscription>`,
            ].filter((part) => part !== '').join('\n\n')
            const result = await bridge.summarize({ conversationId: item.conversationId, accountId: item.accountId, prompt, sessionPrefix: 'wx-sub-' })
            const text = typeof result?.text === 'string' ? result.text.trim() : ''
            if (text === '' || text === '（已取消）') {
              log(`subscription ${item.id} produced nothing to send`)
              return
            }
            await sendChunked(transport, config, { conversationId: item.conversationId, text })
            log(`subscription ${item.id} delivered to ${item.conversationId}`)
          } finally {
            subscriptionBusy.delete(item.conversationId)
          }
        },
      })

    })()

    // Bring the loop up for one account (or every account on disk), replacing a
    // transport that is already running for it. Called for every account when
    // the plugin loads, and again for just the account whose login completed on
    // the settings card: a fresh install has no credential at load time (the
    // operator scans afterwards), and a re-bind replaces the previous token.
    // Without the second call the loop stays down until the next reload — the
    // "the phone says bound, but WeChat says it cannot reach openclaw" symptom.
    //
    // `wantedAccountId` selects the account; undefined means "every account
    // currently saved". One call touching one account must never blink another
    // account's live transport — that is why the map lookup happens per call
    // and why a per-account failure only skips that account.
    const bringUpLoop = async (wantedAccountId, { force = false } = {}) => {
      await setup
      if (cancelled) return

      const accounts = await resolveAccounts(config, wantedAccountId, warn)
      if (accounts.length === 0) {
        // Say so rather than returning in silence. "Loaded, but nothing is
        // listening because no credential is saved yet" is the first thing an
        // operator needs when messages do not arrive, and an unlogged return
        // here is indistinguishable from a loop that started and then hung.
        if (!cancelled) log('no saved Weixin credential yet; nothing is being listened to')
        return
      }

      for (const account of accounts) {
        if (cancelled) return
        try {
          await bringUpAccount(account, { force })
        } catch (error) {
          // One bad credential (corrupt file, unreachable CDN, rejected ticket)
          // must not stop the accounts after it from being served.
          warn(`could not start the loop for ${account.accountId}: ${String(error)}`)
        }
      }
    }

    /**
     * Arm (or re-arm) the long poll for exactly one account.
     *
     * `force` skips the same-credential dedup guard: the handler resolves the
     * account's allowlist once per bring-up, so a settings-card allowlist
     * change must re-arm even though the token is unchanged — otherwise the
     * override sits in the registry while the running handler keeps ruling
     * with the list it read when it came up.
     */
    const bringUpAccount = async (account, { force = false } = {}) => {
      const running = transports.get(account.accountId)
      // Nothing to do when the running loop already holds this credential: a
      // repeat call must not blink the connection, and the first call after a
      // login is the only one that has work to do.
      if (!force && running !== undefined && running.token === account.token) {
        log(`account ${account.accountId} is already being listened to; keeping the running loop`)
        return
      }

      const next = new ILinkTransport({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
        token: account.token,
        // getConfig answers {ret:-2,"ilink_user_id required"} when the id is
        // empty, and the typing ticket it returns doubles as the fallback
        // context token for replies that arrive without one — so the bound
        // operator's id has to travel with the transport.
        userId: account.userId,
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
        // Outbound pacing. Both values are schema-validated (positive numbers),
        // so they can be handed over as-is; the transport falls back to the
        // pacer module's defaults when a caller omits them (tests, bin/ scripts).
        sendIntervalMs: config.sendIntervalMs,
        sendCooldownMs: config.sendCooldownMs,
        // Audio as voice bubbles. Default off: the server accepts a bot
        // voice_item (ret=0) without delivering it, which would swallow the
        // attachment — an operator opts in (schema description has the
        // measurements). The transport still degrades to a file send when a
        // voice upload/send is REJECTED.
        ...(config.voiceOutbound === true ? { voiceOutbound: true } : {}),
        // `/cancel` must reach the bridge while the turn it targets is still
        // running. Every other message is queued in conversation order by the
        // transport; this one skips the queue for the obvious reason.
        bypassQueue: (message) => message?.type === 'text' && isInterruptCommand(message.text),
        // Transport internals (send outcomes, voice fallbacks) go to the host
        // logger AND the weixin log file the operator actually watches. Before
        // 2026-10-26 only the host logger got them, and diagnosing a "did the
        // voice even go out?" question meant finding out no transport line had
        // ever been written anywhere readable.
        log: (line) => {
          log(line)
          fileLog.info(`dsh-weixin: ${line}`)
        },
        errLog: (line) => {
          warn(line)
          fileLog.warn(`dsh-weixin: ${line}`)
        },
        // An expired session stops inbound messaging with no other symptom —
        // the plugin looks healthy and simply never replies. Record it on the
        // login controller so the settings card can say "log in again", and put
        // the same line in the log the operator watches.
        onSessionRejected: (error) => {
          try {
            loginController?.markSessionExpired?.()
          } catch {
            // the card is a convenience; never let it break the loop's report
          }
          warn(
            error.sessionExpired
              ? `Weixin session expired for ${account.accountId}: log in again from Settings (or run bin/login.js), then reload`
              : `Weixin session rejected for ${account.accountId} (${error.message}): log in again, then reload`,
          )
        },
      })
      // The typing ticket doubles as the fallback context token for replies
      // that arrive without one; refreshing it once per loop start is enough.
      await next.refreshConfig()
      if (cancelled) return

      // iLink can redeliver a message after a reconnect; the cache is bounded
      // so a long-running bot does not grow without limit.
      const seen = new MessageDeduper()
      const handler = createInboundHandler({
        config,
        accountId: account.accountId,
        transport: next,
        bridge,
        memorySummarizer,
        asrBridge,
        seen,
        log,
        warn,
        fileLog,
        stateRoot,
        // Resolved once: the allowlist is a property of the deployment, not of
        // the message, and re-resolving per reply would re-stat every directory.
        mediaDirs: allowedMediaDirs({ cwd, stateDir: stateRoot }),
        // The directory produced-file delivery scans after a turn (see
        // sendProducedFiles). The same value the agent bridge registers as the
        // workspace, so "what the agent wrote" is well defined.
        agentCwd: cwd,
        reminderScheduler,
        subscriptionScheduler,
        journalInbound: (entry) => appendJournal(stateRoot, { dir: 'in', ...entry }, { warn }),
      })

      const previous = transports.get(account.accountId)
      transports.set(account.accountId, next)
      if (previous !== undefined) {
        // Stop before start, never the other way round. The server hands each
        // message to whichever poll asks first, so two live long-polls on one
        // credential split the inbound queue between them instead of
        // duplicating it — half the messages would land on a loop whose reply
        // path is already being torn down.
        await previous.stop().catch((error) => warn(`transport stop failed: ${String(error)}`))
      }
      // The transport already isolates per-message failures, so no extra catch
      // here: an error must not be reported twice or swallowed twice.
      await next.start(handler)
      log(`listening as account ${account.accountId} (state: ${stateRoot})`)
    }

    // One hand-off at a time. A login can complete while the previous hand-off
    // is still tearing its transport down, and interleaving them would leave two
    // loops running or none.
    const startLoop = (wantedAccountId, { force = false } = {}) => {
      const run = handoff.then(
        () => bringUpLoop(wantedAccountId, { force }),
        () => bringUpLoop(wantedAccountId, { force }),
      )
      handoff = run.then(
        () => {},
        () => {},
      )
      return run
    }

    // A completed login writes a credential this loop has not read yet. Coming
    // up now is the whole difference between "scan, then reload DSH" and
    // "scan" — the operator has already been told the phone shows bound, and
    // WeChat is still saying it cannot reach openclaw. Only the account that
    // just bound is (re-)armed: the other accounts' live transports must not
    // blink because somebody logged into a second WeChat bot.
    const onAccountBound = (accountId) => {
      // A disabled plugin must not begin listening even if a scan completes:
      // `enabled` is the operator's switch, and a login is not a re-enabling
      // action. The credential is still saved, so turning the plugin back on
      // picks it up without a second scan.
      if (disabled) {
        log('a login completed while the plugin is disabled; not starting the loop')
        return
      }
      startLoop(accountId).catch((error) => warn(`restart after login failed: ${String(error)}`))
    }
    if (loginController !== undefined) loginController.onAccountBound = onAccountBound

    // Pause/resume from the settings card. Pausing must take effect now, not on
    // the next reload — an operator who pauses an account is usually stopping
    // noise *this minute* — so pause stops that account's transport here; resume
    // brings the loop straight back up. `accountId` travels with the call so one
    // card action never touches another account's live transport.
    const onAccountControlChange = (accountId) => {
      const id = typeof accountId === 'string' ? accountId.trim() : ''
      if (id === '') return
      if (isAccountPaused(id)) {
        const running = transports.get(id)
        if (running === undefined) return
        transports.delete(id)
        running.stop().catch((error) => warn(`pause stop failed for ${id}: ${String(error)}`))
        log(`account ${id} paused; its inbound loop is stopped`)
      } else if (!disabled) {
        // Forced: the resume may also follow an allowlist change (the card's
        // allowlist method lands here), and the handler resolves that list once
        // per bring-up — a same-credential resume must still rebuild it.
        startLoop(id, { force: true }).catch((error) => warn(`resume after unpause failed: ${String(error)}`))
      }
    }
    if (loginController !== undefined) loginController.onAccountControlChange = onAccountControlChange

    const started = disabled ? Promise.resolve() : startLoop()

    return async () => {
      cancelled = true
      reminderScheduler?.stop()
      subscriptionScheduler?.stop()
      if (loginController !== undefined && loginController.onAccountBound === onAccountBound) {
        // The controller outlives this effect when the card is left mounted, so
        // the hook is cleared rather than left pointing at a dead loop.
        loginController.onAccountBound = undefined
      }
      if (loginController !== undefined && loginController.onAccountControlChange === onAccountControlChange) {
        loginController.onAccountControlChange = undefined
      }
      await started.catch((error) => warn(`startup failed: ${String(error)}`))
      await handoff.catch(() => {})
      // Every account gets its own stop, and one failure must not skip the
      // rest — a teardown that dies on the first account would leave every
      // later account's long poll running past the plugin unload.
      for (const [id, t] of transports) {
        transports.delete(id)
        await t.stop().catch((error) => warn(`transport stop failed for ${id}: ${String(error)}`))
      }
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
 * Load credentials for the accounts this bring-up pass should serve.
 *
 * `wantedAccountId` names one account (a completed login on the card); the
 * wildcard undefined means "every account on disk". The old single-account
 * rule — refuse to serve when several accounts exist but none is configured —
 * is gone: multi-account is the steady state, so every saved credential gets
 * its own loop unless a specific account was asked for.
 *
 * Returns [] (and logs) when nothing usable is saved; never throws for a
 * missing file, so a fresh install logs one actionable line instead of failing
 * plugin load.
 *
 * @param {{ accountId?: string }} config
 * @param {string | undefined} wantedAccountId
 * @param {(line: string) => void} warn
 * @returns {Promise<Array<{accountId: string, baseUrl: string, cdnBaseUrl: string | undefined, token: string, userId: string | undefined}>>}
 */
async function resolveAccounts(config, wantedAccountId, warn) {
  const { DEFAULT_BASE_URL, listWeixinAccountIds, loadWeixinAccount, resolveWeixinAccount } =
    await import('../vendor/openclaw-weixin/auth/accounts.js')

  // A configured account id still wins: the operator asked for exactly that
  // one. wantedAccountId (a just-completed login) narrows the pass to that
  // account too — other accounts' transports must not blink.
  const configured = config.accountId?.trim() || wantedAccountId?.trim() || ''
  const ids = configured !== '' ? [configured] : listWeixinAccountIds({})
  if (ids.length === 0) {
    warn(`no Weixin account is saved (expected under ${accountsDir()}); run the login command first`)
    return []
  }

  const accounts = []
  for (const accountId of ids) {
    const data = loadWeixinAccount(accountId)
    if (data === null || !data.token) {
      warn(`account "${accountId}" has no saved token (expected ${accountsDir()}/${accountId}.json); run the login command`)
      continue
    }

    // A paused account keeps its credentials but gets no loop: pausing is
    // "stop listening on purpose", not "log out". Logged, so an operator who
    // paused an account yesterday can tell deliberate silence from breakage.
    // `warn` because `log` only exists inside apply's closure — this module
    // function has never had it, and a ReferenceError here would be swallowed
    // by the caller's per-account catch as "could not start the loop",
    // disguising a deliberate pause as a broken credential.
    if (isAccountPaused(accountId)) {
      warn(`account "${accountId}" is paused; not starting its loop`)
      continue
    }

    // resolveWeixinAccount applies the upstream defaults and config overrides
    // (baseUrl, cdnBaseUrl, enabled) that the transport expects.
    let resolved
    try {
      resolved = resolveWeixinAccount({ channels: { 'openclaw-weixin': { accounts: { [accountId]: {} } } } }, accountId)
    } catch {
      resolved = undefined
    }
    accounts.push({
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
    })
  }
  return accounts
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
/**
 * Build the opt-in source block prepended to a turn's prompt when
 * `sourceContext` is enabled. Kept on one self-closing tag line so it is
 * cheap to strip by either the model or the operator.
 *
 * @param {{ senderId?: string, conversationId?: string, timestamp?: number, type?: string }} message
 * @returns {string}
 */
export function weixinSourceBlock(message) {
  const fields = [
    'channel="weixin"',
    `senderId="${String(message.senderId ?? '')}"`,
    `conversationId="${String(message.conversationId ?? '')}"`,
    `kind="${String(message.type ?? 'text')}"`,
  ]
  if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    fields.push(`timestamp="${new Date(message.timestamp).toISOString()}"`)
  }
  return `<weixin_source ${fields.join(' ')} />`
}

function createInboundHandler({ config, accountId, transport, bridge, memorySummarizer, asrBridge, seen, log, warn, fileLog, stateRoot, mediaDirs, agentCwd, reminderScheduler, subscriptionScheduler, journalInbound }) {
  // The effective allowlist is per account: an account-level override in the
  // registry narrows (or replaces) the global list. Resolved once per handler
  // — the same "deployment property, not message property" rule as mediaDirs.
  // `accountId` is always set here (bringUpAccount passes it), but the
  // fallback keeps the helper's contract honest.
  const accountConfig = { ...config, ...allowlistForAccount(accountId, config) }
  // The enrolment branch below re-resolves the allowlist mid-flight; the
  // handler reads the config for THIS message through this cell so a
  // first-contact enrolment takes effect on the very message that triggered
  // it, without touching the per-handler `accountConfig` capture above.
  const effectiveConfig = { current: accountConfig }
  // Persona + memory command handlers (/mode /remember /forget /memory), one
  // bundle per conversation. Every call re-reads its store: the settings card
  // can edit the mode table or the operator can /forget between two messages,
  // and answering from a cached snapshot would quietly lie. Memory commands
  // honour memoryEnabled being off; /mode does not — the mode table and the
  // memory store are separate features.
  const personaCommands = (conversationId) => {
    const memoryOn = () => effectiveConfig.current.memoryEnabled !== false
    const modeConfig = () => effectiveConfig.current
    return {
      mode: (arg) => {
        const store = readPersonaStore(stateRoot, { warn })
        const currentId = activeModeFor(stateRoot, accountId, conversationId, effectiveConfig.current.personaDefaultMode ?? DEFAULT_MODE_ID, { warn })
        if (arg === undefined || arg === '') {
          const current = resolveMode(store, currentId)
          const render = (m) => `${m.id === currentId ? '→' : '　'}${m.id === DEFAULT_MODE_ID ? '默认助手（不扮演角色）' : m.name} — /mode ${m.name === '' ? m.id : m.name}`
          const roles = store.filter((m) => m.game !== true)
          const games = store.filter((m) => m.game === true)
          return [
            `当前对话模式：${current?.name ?? currentId}。`,
            ...roles.map(render),
            // Games are modes too (a fresh conversation line is a fresh board),
            // but they read better as their own section.
            ...(games.length > 0 ? ['—— 小游戏（玩完 /mode 默认 就退出）——', ...games.map(render)] : []),
          ].join('\n')
        }
        // Users type the display name (女友), not the id (girlfriend) — match
        // either, case-insensitively. The default mode additionally answers to
        // the bare 「默认」, which is what a user says when they mean "no
        // persona" (its display name 默认助手 is clunky to type).
        const wanted = arg.trim().toLowerCase()
        const matches = (m) => m.id.toLowerCase() === wanted
          || m.name.toLowerCase() === wanted
          || (m.id === DEFAULT_MODE_ID && wanted === '默认')
        const match = store.find(matches)
        if (match === undefined) {
          return `没有叫「${arg}」的模式。可用：${store.map((m) => (m.id === DEFAULT_MODE_ID ? '默认' : m.name)).join('、')}`
        }
        if (match.id === currentId) return `已经是「${match.name}」模式了，没有变化。`
        // Pin even `default`: the global default may be a persona, and "this
        // conversation back to the plain assistant" is exactly what /mode 默认
        // should mean here.
        setActiveMode(stateRoot, accountId, conversationId, match.id, { warn })
        // A mode switch opens a fresh session line (the approved behaviour):
        // the previous persona is already in the old transcript, and starting
        // clean is what makes the switch feel real. Same mechanics as /new.
        bridge.lines.create(conversationId, accountId)
        return `${match.id === DEFAULT_MODE_ID ? '已切回默认助手' : `已切换到「${match.name}」`}模式，并开启了一条新会话线。\n（之前的会话保留，/list 可以切回）`
      },
      // /summary: an on-demand look at where the conversation stands. Unlike
      // the background summarizer it replies to the user and never writes the
      // conv file — 「看一眼」 and 「记住」 stay separate concerns.
      summary: async () => {
        const prior = readConvMemory(stateRoot, accountId, conversationId, { warn })
        const recent = readRecentWindow(stateRoot, accountId, conversationId, { turns: 20, textChars: 200 })
        const transcript = recent
          .map((entry) => `${entry.dir === 'in' ? '用户' : '助手'}：${entry.text}`)
          .join('\n')
        if (transcript === '') return '这段会话还没有可总结的消息（消息流水里是空的）。'
        const prompt = [
          '以下是这段微信会话最近的对话记录。',
          ...(String(prior.summary ?? '') !== '' ? [`【已有摘要】\n${prior.summary}`] : []),
          `【最近对话】\n${transcript}`,
          '请总结我们聊到哪了：正在讨论的话题、已经决定的事、还没做完的待办、彼此的约定。',
          '不超过 300 字，直接输出总结本身，不要任何解释或前缀。',
        ].join('\n')
        const result = await bridge.summarize({ conversationId, accountId, prompt, sessionPrefix: 'wx-sum-' })
        if (result === undefined) return '当前有对话在跑，等这轮结束再试 /summary。'
        const text = String(result.text ?? '').trim()
        if (text === '' || text === '（已取消）') return '这次没总结出来（侧会话没有返回内容），稍后再试。'
        return text
      },
      // /export: render this conversation's journal as Markdown. Short
      // exports ride the normal reply; long ones land in
      // `<stateRoot>/exports/` and the reply carries the path (the settings
      // card's 消息流水 tab also has a one-click export).
      export: (rawDays) => {
        const days = Math.min(365, Math.max(1, Number(rawDays) || 30))
        const entries = readJournalRange(stateRoot, { accountId, conversationId, days })
        if (entries.length === 0) return `这个会话在最近 ${days} 天没有消息流水。`
        const markdown = renderChatMarkdown(entries, { title: `聊天记录 · ${conversationId} · 最近 ${days} 天` })
        if (markdown.length <= 3000) return markdown
        const file = writeChatExport(stateRoot, accountId, conversationId, markdown)
        return `聊天记录比较长（${entries.length} 条，${markdown.length} 字），已导出成文件：\n${file}\n完整内容也可以在设置卡「消息流水」页签里一键导出。`
      },
      remember: (arg) => {
        if (memoryOn() === false) return '记忆功能当前是关闭的（设置里的「会话记忆」），先打开再用 /remember。'
        if (arg === undefined || String(arg).trim() === '') return '用法：/remember <要记住的内容>，例如 /remember 我对花生过敏'
        const result = addGlobalFact(stateRoot, accountId, arg, { warn, maxFacts: modeConfig().memoryGlobalMaxFacts })
        if (result.added === true) return `已记住：${arg}\n（/memory 可以查看全部，/forget <编号> 可以删除）`
        if (result.reason === 'duplicate') return '这条已经记过了，不用再记一遍。'
        if (result.reason === 'cap') return `长期记忆已经存满（${modeConfig().memoryGlobalMaxFacts} 条）。用 /forget 先删掉一些再记。`
        return '没存上，写入记忆文件失败了（详见日志）。'
      },
      forget: (arg) => {
        if (memoryOn() === false) return '记忆功能当前是关闭的。'
        const facts = readGlobalMemory(stateRoot, accountId, { warn }).facts
        if (facts.length === 0) return '长期记忆还是空的，没有可忘掉的。'
        if (arg === undefined || String(arg).trim() === '') {
          return ['长期记忆（/forget <编号> 删除某一条）：', ...facts.map((f, i) => `${i + 1}. ${f.text}`)].join('\n')
        }
        const asIndex = Number(arg)
        if (Number.isInteger(asIndex) === true) {
          const removed = removeGlobalFact(stateRoot, accountId, asIndex, { warn })
          return removed.removed === true ? `已忘掉：${removed.text}` : `没有第 ${asIndex} 条（现在共 ${facts.length} 条）。`
        }
        const keyword = String(arg).toLowerCase()
        const hits = facts.map((f, i) => ({ index: i + 1, text: f.text })).filter((f) => f.text.toLowerCase().includes(keyword))
        if (hits.length === 0) return `没有找到含「${arg}」的记忆。`
        if (hits.length === 1) {
          const removed = removeGlobalFact(stateRoot, accountId, hits[0].index, { warn })
          return removed.removed === true ? `已忘掉：${removed.text}` : '没删掉，写入记忆文件失败了（详见日志）。'
        }
        return ['好几个都带这个词，用编号指明删哪条：', ...hits.map((h) => `${h.index}. ${h.text}`)].join('\n')
      },
      memory: () => {
        if (memoryOn() === false) return '记忆功能当前是关闭的。'
        const facts = readGlobalMemory(stateRoot, accountId, { warn }).facts
        const conv = readConvMemory(stateRoot, accountId, conversationId, { warn })
        const recent = readRecentWindow(stateRoot, accountId, conversationId, { warn })
        const parts = []
        const bond = bondLine(readConvMemory(stateRoot, accountId, conversationId, { warn }).bond)
        if (bond !== '') parts.push(bond)
        parts.push(facts.length === 0 ? '长期记忆：还没有，用 /remember 教我。' : ['长期记忆：', ...facts.map((f, i) => `${i + 1}. ${f.text}`)].join('\n'))
        parts.push(conv.summary !== '' ? `本会话记忆：${conv.summary}` : '本会话记忆：还没有摘要（会自动按回合记一次）。')
        parts.push(`最近消息窗口：${recent.length} 条`)
        return parts.join('\n\n')
      },
    }
  }
  return async (message) => {
    if (config.messageJournal === true && message.type === 'text') {
      journalInbound?.({
        accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        text: message.text,
      })
    }
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
    if (!isAllowedSender(effectiveConfig.current, message.senderId, message.conversationId)) {
      // First contact enrolment: at scan time only the bot id is known — the
      // human's WeChat id first appears HERE, on the first inbound message.
      // So the very first sender an account without an allowlist override
      // hears is treated as the person who scanned (whoever scans owns the
      // account), enrolled into that account's own allowlist, and let
      // through. Every later stranger is refused exactly as before.
      let enrolled = false
      if (accountId) {
        const hasOverride = () => {
          const entry = readRegistry()[accountId]
          return (Array.isArray(entry?.allowedSenders) && entry.allowedSenders.length > 0) || Boolean(entry?.firstContactEnrolledAt)
        }
        enrolled = enrolFirstContact(accountId, message.senderId, hasOverride, (line) => {
          log(`${line}`)
          fileLog.info(`dsh-weixin: ${line} (the scanner's first message; add more senders on the card or in the registry)`)
        }, config.allowedSenders)
        if (enrolled) {
          // Re-resolve the effective config so the rest of this message runs
          // under the list that now contains the sender.
          const enrolledConfig = { ...config, ...allowlistForAccount(accountId, config) }
          if (isAllowedSender(enrolledConfig, message.senderId, message.conversationId)) {
            effectiveConfig.current = enrolledConfig
          } else {
            // The enrolment did not actually authorize the sender (chat
            // allowlist still denies, say): refuse after all, do not pretend.
            enrolled = false
          }
        }
      }
      if (!enrolled) {
        // Log the refusal to the file logger too, with the full allowlist: the
        // rebind flow generates a fresh sender id per bot, so the most common
        // refusal is a stale allowedSenders entry, and this line is both the
        // diagnosis and the exact value the operator needs to paste into config.
        fileLog.info(
          `refused message from ${message.senderId} (conversation ${message.conversationId}): ` +
            `${denialReason(accountConfig, message.senderId, message.conversationId)}; ` +
            `allowedSenders=${JSON.stringify(accountConfig.allowedSenders ?? [])}`,
        )
        warn(`refused message from ${message.senderId}: ${denialReason(accountConfig, message.senderId, message.conversationId)}`)
        return
      }
    }

    // 3. Dedupe: iLink can redeliver a message after a reconnect.
    if (!seen.accept(message.id)) {
      log(`skipping duplicate message ${message.id}`)
      fileLog.info(`skipping duplicate message ${message.id} from ${message.senderId}`)
      return
    }

    // 3.5. Last-seen bookkeeping: the card shows "silent since" from this
    // timestamp, so it is written once a message is actually accepted — not on
    // every poll, which would make a busy loop mask a dead inbound path. A
    // registry write failure is a warning, never a dropped message.
    touchAccount(accountId, warn)

    // 4. Session-control commands (`/new`, `/list`, `/use`) are answered by the
    //    plugin itself, before any media download or agent turn. A command must
    //    not cost a model turn: `/list` would otherwise burn context to print a
    //    list the plugin already knows, and `/new` would run in the very session
    //    it is meant to leave. Placed after the allowlist and dedupe so a
    //    refused or replayed message still cannot steer a conversation.
    //    `/status` additionally gets account-level facts read fresh here (the
    //    registry entry may have changed since this handler was built).
    const registryEntry = accountId ? readRegistry()[accountId] : undefined
    // /summary answers asynchronously (a side session); awaiting a plain
    // string is a no-op, so one call site covers both command shapes.
    const commandReply = await bridge.handleCommand(message.conversationId, message.text, accountId, {
      accountId,
      accountLabel: registryEntry?.label ?? null,
      paused: accountId ? isAccountPaused(accountId) : false,
      lastSeenAt: typeof registryEntry?.lastSeenAt === 'string' ? registryEntry.lastSeenAt : undefined,
      allowlist: {
        source: Array.isArray(registryEntry?.allowedSenders) && registryEntry.allowedSenders.length > 0 ? 'account' : 'global',
        senders: effectiveConfig.current.allowedSenders ?? [],
      },
      reminders: reminderScheduler,
      subscription: subscriptionScheduler,
      // Affinity rides /status when memory is on; computed fresh per message
      // like the rest of the status facts (the card can edit between messages).
      bondLine: effectiveConfig.current.memoryEnabled !== false
        ? bondLine(readConvMemory(stateRoot, accountId, message.conversationId, { warn }).bond)
        : '',
      persona: personaCommands(message.conversationId),
    })
    if (commandReply !== undefined) {
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: commandReply,
        contextToken: message.contextToken,
      })
      fileLog.info(`answered session command ${JSON.stringify(message.text.trim())} for ${message.conversationId}`)
      return
    }

    // 4.5 Link enrichment: if the message carries URLs, fetch each one and
    //    fold the readable text into the prompt. A failed link NEVER fails the
    //    message — the agent gets a one-line reason instead, and the user's
    //    question still reaches the model. Best-effort by design: a dead host
    //    costs a bounded fetch, not the turn.
    let prompt = message.text
    const linkUrls = config.readLinks === true ? extractUrls(message.text) : []
    if (linkUrls.length > 0) {
      log(`fetching ${linkUrls.length} link(s) from inbound message ${message.id}`)
      const linkResults = []
      for (const url of linkUrls.slice(0, 3)) {
        linkResults.push(await fetchLinkText(url))
      }
      const linkBlock = describeLinkResults(linkResults)
      if (linkBlock !== undefined) prompt = `${message.text}\n\n${linkBlock}`
    }
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

    // Source context: the agent has no other way to know where a message came
    // from. Opt-in, because the block spends tokens on every turn and a
    // single-user deployment rarely needs it.
    if (config.sourceContext === true) {
      prompt = weixinSourceBlock(message) + (prompt === '' ? '' : `\n\n${prompt}`)
    }

    // Persona + memory: the same seam, right before the user's text. Persona
    // (who the assistant is talking as) precedes memory (what it keeps
    // knowing). Both re-read their stores per message — the settings card can
    // switch a mode or /forget can run between two messages. A persona only
    // changes tone; every builtin prompt says so, and the block is skipped
    // entirely for `default` so a stock deployment spends zero extra tokens.
    // Memory injects global facts, the conversation summary, and a recent
    // window folded from the journal, each section omitted when empty.
    const personaModes = readPersonaStore(stateRoot, { warn })
    const personaBlock = buildPersonaBlock(resolveMode(personaModes, activeModeFor(stateRoot, accountId, message.conversationId, effectiveConfig.current.personaDefaultMode ?? DEFAULT_MODE_ID, { warn })))
    const memoryBlock = effectiveConfig.current.memoryEnabled === true
      ? buildMemoryBlock({
          global: readGlobalMemory(stateRoot, accountId, { warn }),
          conv: readConvMemory(stateRoot, accountId, message.conversationId, { warn }),
          recent: readRecentWindow(stateRoot, accountId, message.conversationId, { warn }),
        })
      : ''
    // Prepend in ONE join so the order stays persona → memory → user text
    // (a per-block prepend loop would silently reverse it).
    const blocks = [personaBlock, memoryBlock].filter((block) => block !== '')
    if (blocks.length > 0) prompt = [...blocks, prompt].filter((part) => part !== '').join('\n\n')

    // 5. Drive the agent, then send the reply back in chunks.
    if (config.typingIndicator) await transport.setTyping(true, message.conversationId)
    try {
      const startedAt = Date.now()
      const reply = await bridge.deliver({
        conversationId: message.conversationId,
        accountId,
        text: prompt,
        // Who caused the turn, for the tool audit: the sender is the only party
        // an operator can hold responsible for a destructive tool call.
        senderId: message.senderId,
        busyMessageMode: config.busyMessageMode,
        onProgress: async (note) => {
          await sendChunked(transport, config, {
            conversationId: message.conversationId,
            text: `（${note}）`,
            contextToken: message.contextToken,
          })
        },
        // A turn that outlives the wait still owes the user its answer: the
        // notice goes out through the caller's context token, and the late
        // reply is delivered later with a freshly fetched typing ticket (the
        // original one is one-shot and long expired by then).
        onLateReply: async (late) => {
          if (late.kind === 'timeout-notice') {
            await sendChunked(transport, config, {
              conversationId: message.conversationId,
              text: '（这条消息处理时间较长，先回复别的消息不影响它；结果出来后会直接发到这里）',
              contextToken: message.contextToken,
            })
            return
          }
          await transport.refreshConfig()
          const outbound = await resolveOutboundReply({
            config,
            transport,
            mediaDirs,
            stateRoot,
            reply: late.text,
            conversationId: message.conversationId,
            contextToken: '',
            warn,
            fileLog,
          })
          await sendChunked(transport, config, {
            conversationId: message.conversationId,
            text: outbound.text,
            contextToken: '',
          })
          await sendProducedFiles({
            config,
            transport,
            agentCwd,
            sinceMs: startedAt,
            alreadySent: outbound.sent,
            conversationId: message.conversationId,
            contextToken: '',
            warn,
            fileLog,
          })
          log(`late reply delivered for ${message.conversationId}`)
          fileLog.info(`late reply delivered to ${message.conversationId} after the wait gave up`)
        },
      })
      log(`turn settled in ${Date.now() - startedAt}ms for ${message.conversationId}`)
      fileLog.info(`accepted message ${message.id} from ${message.senderId} (conversation ${message.conversationId}); agent turn settled in ${Date.now() - startedAt}ms`)
      // One settled agent turn = one memory turn. The summarizer counts it,
      // and every memorySummaryTurns of them fires a background summary into
      // conv memory — fire-and-forget, it must never delay or fail the reply.
      memorySummarizer?.afterTurn(accountId, message.conversationId)
      // A late reply already went out through onLateReply; sending the empty
      // text here would be a stray message.
      if (reply.late === true) return
      // A cancelled turn has nothing to say: `/cancel` already sent its own
      // receipt, and an empty chunk would be a blank bubble in the chat.
      if (reply.cancelled === true) {
        fileLog.info(`turn cancelled by user for ${message.conversationId}`)
        return
      }
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
        fileLog,
      })
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: outbound.text,
        contextToken: message.contextToken,
      })
      await sendProducedFiles({
        config,
        transport,
        agentCwd,
        sinceMs: startedAt,
        alreadySent: outbound.sent,
        conversationId: message.conversationId,
        contextToken: message.contextToken,
        warn,
        fileLog,
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
 * @param {{ info: (line: string) => void }} [params.fileLog]  Durable record.
 * @returns {Promise<string>} text to send, with a failure note when applicable
 */
async function resolveOutboundReply(params) {
  const text = params.reply ?? ''
  const fileLog = params.fileLog ?? { info: () => {} }
  if (params.config.mediaEnabled === false) return { text, sent: [] }
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
      // Every delivery decision is recorded durably, not only on the host
      // logger: `ctx.logger` drops levels depending on the host's exporter
      // config, and a refusal that leaves no trace is indistinguishable from a
      // detector that never matched — which is exactly how a relative-path
      // refusal stayed invisible.
      warn: (line) => {
        params.warn(line)
        fileLog.info(`outbound media: ${line}`)
      },
      // deliverOutboundMedia's send seam passes `to` (the peer id; see
      // OutboundMedia and deliverOutboundMedia in src/media/outbound.js), while
      // `sendMedia` names the same value `conversationId`. Forwarding
      // mediaParams verbatim dropped the peer id on the floor: every
      // plugin-driven attachment went out as `to=undefined`, the getUploadUrl
      // request lost `to_user_id`, and the server answered `{ret:-2}` — the
      // file never reached the upload path at all. Adapt the differing key.
      send: ({ filePath, to, contextToken, cdnBaseUrl }) =>
        params.transport.sendMedia({ filePath, conversationId: to, contextToken, cdnBaseUrl }),
    })
    if (result.sent.length > 0) {
      const names = result.sent.map((filePath) => filePath.split('/').pop()).join(', ')
      params.warn(`sent ${result.sent.length} outbound media file(s)`)
      fileLog.info(`sent ${result.sent.length} outbound media file(s): ${names}`)
    }
    return { text: result.text, sent: result.sent }
  } catch (error) {
    // deliverOutboundMedia is written not to throw; if a future edit breaks
    // that, the reply must still go out rather than the turn dying here.
    params.warn(`outbound media step failed, sending text only: ${String(error)}`)
    fileLog.info(`outbound media step failed: ${String(error)}`)
    return { text, sent: [] }
  }
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
async function sendProducedFiles(params) {
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
      await params.transport.sendMedia({
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
 * @param {{ maxMessageLength: number, markdownMode?: 'strip'|'off' }} config
 * @param {{ conversationId: string, text: string, contextToken?: string }} message
 */
async function sendChunked(transport, config, message) {
  const text = markdownToPlainText(message.text ?? '', resolveMarkdownMode(config))
  journalOutboundRef?.({
    accountId: transport.accountId,
    conversationId: message.conversationId,
    text,
  })
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
