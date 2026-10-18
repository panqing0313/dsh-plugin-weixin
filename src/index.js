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
import { MessageDeduper } from './message/dedupe.js'
import { markdownToPlainText, resolveMarkdownMode } from './message/markdown.js'
import { allowedMediaDirs, deliverOutboundMedia, DEFAULT_MAX_MEDIA_BYTES, listProducedFiles } from './media/outbound.js'
import { AsrBridge, DEFAULT_ASR_TIMEOUT_MS, resolveAsrSettings } from './media/asr.js'
import { WeixinLoginController } from './login-remote.js'
import { AsrController } from './asr-remote.js'
import { ConfigController } from './config-remote.js'
import { isAccountPaused, touchAccount, allowlistForAccount } from './account-registry.js'
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
  markdownMode: z
    .union([z.const('strip'), z.const('off')])
    .default('strip')
    .description('How to render the agent Markdown reply for WeChat: "strip" filters unsupported syntax, "off" sends it verbatim.'),
  busyMessageMode: z
    .union([z.const('queue'), z.const('steer')])
    .default('queue')
    .description('What happens to a message that arrives while a reply is still being written: "queue" waits and delivers it as the next turn, "steer" injects it into the running turn. "/steer <instruction>" always injects.'),
  sourceContext: z.boolean().default(false).description('Prepend a <weixin_source …> block to each prompt so the agent knows the message came from WeChat and who sent it.'),
  progressAfterMs: z.number().default(45_000).description('Send one progress note to the user after this many milliseconds.'),
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
    /** @type {AsrBridge | undefined} */
    let asrBridge
    /** @type {string} */
    let cwd
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
        maxWaitMs: config.maxTurnWaitMs,
        log,
        errLog: warn,
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
        log,
        errLog: warn,
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

function createInboundHandler({ config, accountId, transport, bridge, asrBridge, seen, log, warn, fileLog, stateRoot, mediaDirs, agentCwd }) {
  // The effective allowlist is per account: an account-level override in the
  // registry narrows (or replaces) the global list. Resolved once per handler
  // — the same "deployment property, not message property" rule as mediaDirs.
  // `accountId` is always set here (bringUpAccount passes it), but the
  // fallback keeps the helper's contract honest.
  const accountConfig = { ...config, ...allowlistForAccount(accountId, config) }
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
    if (!isAllowedSender(accountConfig, message.senderId, message.conversationId)) {
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
    const commandReply = bridge.handleCommand(message.conversationId, message.text, accountId)
    if (commandReply !== undefined) {
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: commandReply,
        contextToken: message.contextToken,
      })
      fileLog.info(`answered session command ${JSON.stringify(message.text.trim())} for ${message.conversationId}`)
      return
    }

    // 5. Media: authorized and de-duplicated, so it is now safe to fetch the
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

    // Source context: the agent has no other way to know where a message came
    // from. Opt-in, because the block spends tokens on every turn and a
    // single-user deployment rarely needs it.
    if (config.sourceContext === true) {
      prompt = weixinSourceBlock(message) + (prompt === '' ? '' : `\n\n${prompt}`)
    }

    // 5. Drive the agent, then send the reply back in chunks.
    if (config.typingIndicator) await transport.setTyping(true, message.conversationId)
    try {
      const startedAt = Date.now()
      const reply = await bridge.deliver({
        conversationId: message.conversationId,
        accountId,
        text: prompt,
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
      // A late reply already went out through onLateReply; sending the empty
      // text here would be a stray message.
      if (reply.late === true) return
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
