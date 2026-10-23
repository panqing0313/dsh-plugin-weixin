/**
 * Bind one Weixin conversation to one DSH agent session.
 *
 * The pattern is the one dsh-better-sidebar's sidechat proves works
 * (`src/sidechat-routes.ts`): create an agent through the `agents` service with
 * a chosen session id, admit each user message with `agent.followup(...)`, and
 * read the reply out of `agent.session.snapshotEvents()`.
 *
 * Differences from sidechat, and why:
 *  - No seed and no parent session. A WeChat conversation is a top-level
 *    conversation, not a fork of a GUI thread, so it needs neither
 *    `isSeeded`/`inheritedEventCount` fork markers nor the inbox `clear()` that
 *    fences the inherited-inbox replay leak sidechat works around.
 *  - Preset composition is applied through `agentPresets.resolve/mount` when the
 *    service is present, so the conversation inherits the deployment's tools and
 *    system prompt the same way a GUI thread does.
 *  - Sessions are durable across plugin restarts: the id is derived from the
 *    Weixin conversation id, so a cold start resumes the recorded session
 *    instead of opening a fresh one.
 * @module dsh-weixin/agent-bridge
 */
import { readAssistantReply, describePending } from './session-reader.js'
import { baseSessionIdFor, scopedLineKey, SessionLines, runSessionCommand } from './sessions.js'

/**
 * `@deepseek-ai/dsh-llm` resolves only from inside a DSH profile, so it is
 * imported lazily: the module itself stays loadable (and testable) outside the
 * host, and a missing service surfaces as a delivery error rather than a
 * plugin-load failure.
 */
let createUserMessageRef = null
async function loadCreateUserMessage() {
  if (createUserMessageRef === null) {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod.createUserMessage !== 'function') {
      throw new Error('@deepseek-ai/dsh-llm does not export createUserMessage')
    }
    createUserMessageRef = mod.createUserMessage
  }
  return createUserMessageRef
}

/**
 * Load `installModelSelection`, which couples a mutable provider/model choice to
 * prompt assembly and request routing.
 *
 * Without it an agent created through `agents.create` has no selected route, so
 * the persona section's `{{model}}` reference never resolves. Returns undefined
 * (instead of throwing) when the host exposes a different surface, so a version
 * skew degrades the persona rather than killing the plugin.
 */
let installModelSelectionRef
async function loadInstallModelSelection() {
  if (installModelSelectionRef === undefined) {
    try {
      const mod = await import('@deepseek-ai/dsh-agent')
      installModelSelectionRef =
        typeof mod.installModelSelection === 'function' ? mod.installModelSelection : null
    } catch {
      installModelSelectionRef = null
    }
  }
  return installModelSelectionRef ?? undefined
}

/**
 * Deterministic session id for a Weixin conversation.
 *
 * Stable across restarts so the conversation survives a plugin reload, and
 * prefixed so a session can be recognized as Weixin-owned in the GUI.
 * Non-alphanumerics are folded to `-` to keep the id filesystem- and
 * URL-safe.
 *
 * This is now the id of a conversation's FIRST session line; see
 * `src/sessions.js` for why a conversation can have several and why this id
 * must never change.
 * @param {string} conversationId
 */
export function sessionIdFor(conversationId) {
  return baseSessionIdFor(conversationId)
}

/**
 * Recognize `/steer <instruction>` and return the instruction, or undefined
 * when the text is not a steer command.
 *
 * @param {string} text
 * @returns {string | undefined}
 */
export function parseSteerCommand(text) {
  const match = /^\s*\/steer(?:\s+([\s\S]+))?\s*$/.exec(String(text ?? ''))
  if (match === null) return undefined
  const instruction = (match[1] ?? '').trim()
  return instruction === '' ? undefined : instruction
}

/**
 * @typedef {Object} AgentBridgeOptions
 * @property {any} ctx            Cordis context of the plugin.
 * @property {string} [cwd]       Working directory the agent operates in.
 * @property {(line: string) => void} [log]
 * @property {(line: string) => void} [errLog]
 * @property {number} [createTimeoutMs]
 * @property {number} [progressAfterMs]  Send the first progress line after this long.
 * @property {number} [progressEveryMs]  Re-send a CHANGED progress line at most
 *   this often, so a turn that moves from one tool to the next stays visible
 *   without spamming an unchanged state.
 * @property {number} [maxWaitMs]        Give up on a turn after this long.
 * @property {number} [pollMs]           Session-log polling interval.
 * @property {SessionLines} [lines]      Session-line index. Defaults to the
 *   on-disk store, so a bridge built without one still supports `/new`.
 * @property {(entry: { kind: 'tool/call' | 'tool/result', accountId: string,
 *   conversationId: string, sessionId: string, senderId?: string, tool?: string,
 *   callId?: string, args?: unknown, ok?: boolean, durationMs?: number,
 *   at: number }) => void} [onToolAudit] Called once per tool event observed
 *   during a turn. The plugin wires this to the on-disk audit log; tests use it
 *   to assert what a turn would have recorded. Absent means "no audit", which
 *   is the default so a bare bridge writes nothing.
 */

export class AgentBridge {
  /** @param {AgentBridgeOptions} options */
  constructor(options) {
    this.ctx = options.ctx
    this.cwd = options.cwd
    this.log = options.log ?? (() => {})
    this.errLog = options.errLog ?? options.log ?? (() => {})
    this.createTimeoutMs = options.createTimeoutMs ?? 30_000
    this.progressAfterMs = options.progressAfterMs ?? 45_000
    this.progressEveryMs = options.progressEveryMs ?? 60_000
    this.maxWaitMs = options.maxWaitMs ?? 20 * 60_000
    this.pollMs = options.pollMs ?? 1_000
    // Session lines: which of a conversation's sessions the next message goes
    // to. Injectable so tests do not touch the operator's real state root.
    this.lines = options.lines ?? new SessionLines({ warn: (message) => this.errLog(message) })
    // Tool audit sink. The bridge owns the event stream (it is the only place
    // that polls the session log), so it is the only place that can say which
    // tool ran; where the lines go is the caller's decision.
    this.onToolAudit = options.onToolAudit
    // Conversation id -> the session id its next message must reach. Needed
    // because `deliver` is handed a session id but must still be able to route
    // a late reply and, for a brand-new line, share one in-flight creation.
    /** @type {Map<string, string>} */
    this.conversationTargets = new Map()
    // How long the post-timeout listener keeps waiting for an answer to hand
    // to onLateReply. Configurable so tests do not have to wait an hour.
    this.lateReplyMaxWaitMs = options.lateReplyMaxWaitMs ?? 60 * 60_000
    /** @type {Map<string, { agent: any, dispose: () => Promise<void>, busy: boolean, queue: any[], cancelled: boolean }>} */
    this.sessions = new Map()
    /**
     * In-flight attach() creations, so two messages for the same conversation
     * never build two sessions.
     * @type {Map<string, Promise<{ agent: any, dispose: () => Promise<void>, busy: boolean, queue: any[], cancelled: boolean }>>}
     */
    this.attachPromises = new Map()
    /**
     * Memoized Workspace lookup, so the registry is consulted once per plugin
     * generation rather than on every message.
     * @type {Promise<any> | undefined}
     */
    this.workspacePromise = undefined
  }

  #agents() {
    return this.ctx.get('agents')
  }

  /**
   * The session id a conversation's next message must reach.
   *
   * Remembers the target so {@link deliver} — which receives a session id, not
   * a conversation id — can still map back to the conversation for a late reply
   * and for the first-message title.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {string}
   */
  #activeSessionId(conversationId, accountId) {
    const key = scopedLineKey(accountId, conversationId)
    const sessionId = this.lines.active(conversationId, accountId)
    this.conversationTargets.set(key, sessionId)
    return sessionId
  }

  /**
   * Handle a session-control command (`/new`, `/list`, `/use`).
   *
   * Returns the reply text when the message was a command, or undefined when it
   * was an ordinary message that must go to the agent. The caller sends the
   * returned text directly, so a control command costs no model turn and no
   * context: it is answered by the plugin itself.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   * @param {string} text
   * @param {{ accountId?: string, accountLabel?: string | null, paused?: boolean,
   *   lastSeenAt?: string, allowlist?: { source: 'account' | 'global', senders: string[] } }} [statusContext]
   *   account-level facts for `/status`, threaded from the inbound handler
   * @returns {string | undefined}
   */
  handleCommand(conversationId, text, accountId, statusContext) {
    // Capture the target BEFORE the command runs: `/clear` replaces the line,
    // and the id to orphan is the one that was active up to now.
    const key = scopedLineKey(accountId, conversationId)
    const previouslyActive = this.conversationTargets.get(key)
    // `/cancel` needs the live agent handle, which only this class holds; the
    // command module stays transport-free and just relays the sentence.
    const reply = runSessionCommand(this.lines, conversationId, text, accountId, {
      ...statusContext,
      cancelRunningTurn: () => this.#cancelRunningTurn(key, conversationId, accountId),
    })
    if (reply === undefined) return undefined
    // `/clear` orphans the line that was active: its session id is no longer
    // in the list and the fresh line has a different id, so the old in-memory
    // record must not keep answering (a queued message would otherwise reach a
    // session the user believes is gone). Disposal is best-effort; the host
    // transcript stays on disk as an orphan, untouched.
    if (reply.includes('已清空') && typeof previouslyActive === 'string') {
      const record = this.sessions.get(previouslyActive)
      if (record !== undefined) {
        this.sessions.delete(previouslyActive)
        void Promise.resolve()
          .then(() => record.dispose())
          .catch((error) => this.errLog(`cleared session dispose failed: ${String(error)}`))
      }
    }
    // A command can change which line is active, so the next message must not
    // reuse a mapping taken before it ran.
    this.conversationTargets.delete(key)
    this.log?.(`session command handled for ${conversationId}: ${String(text).trim()}`)
    return reply
  }

  /**
   * Interrupt the turn running on a conversation's active line.
   *
   * `/cancel` is answered as a command precisely because it has to work WHILE
   * the conversation is busy — an ordinary message would be queued behind the
   * turn the user wants to stop. The host owns the actual abort
   * (`agent.cancel({ kind: 'user' })`), so this method only decides whether
   * there is something to interrupt and translates the outcome into one
   * sentence the user can act on.
   *
   * @param {string} key scoped conversation key (account + conversation)
   * @param {string} conversationId
   * @param {string} [accountId]
   * @returns {string} the reply text sent back to WeChat
   */
  #cancelRunningTurn(key, conversationId, accountId) {
    const sessionId = this.conversationTargets.get(key) ?? this.lines.active(conversationId, accountId)
    const record = sessionId === undefined ? undefined : this.sessions.get(sessionId)
    if (record === undefined) return '当前没有正在跑的回合，不需要取消。'
    if (record.busy !== true) return '当前没有正在跑的回合，不需要取消。'
    const agent = record.agent
    if (typeof agent?.cancel !== 'function') {
      // An older host without cancel() would otherwise look like success while
      // the turn keeps running — say so instead of lying.
      return '这个宿主版本不支持中断回合，只能等它自己跑完。'
    }
    try {
      // Marked BEFORE the call: the turn's own wait loop polls this flag and
      // must not race the abort into reporting a model failure.
      record.cancelled = true
      agent.cancel({ kind: 'user' })
    } catch (error) {
      record.cancelled = false
      this.errLog(`cancel failed for ${sessionId}: ${String(error)}`)
      return `取消失败：${String(error)}`
    }
    this.log?.(`cancelled the running turn on ${sessionId} for ${conversationId}`)
    return '已请求取消当前回合。'
  }

  /**
   * Session lines recorded for a conversation, for the settings card.
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   */
  sessionLines(conversationId, accountId) {
    return this.lines.list(conversationId, accountId)
  }

  /**
   * Resolve (creating if needed) the Workspace that owns our conversations.
   *
   * A session only appears under a named group in the GUI when some Workspace
   * lists it in `sessionIds`; otherwise the client files it under "Ungrouped".
   * Registering the directory is therefore not cosmetic — it is what makes these
   * conversations findable again.
   *
   * Returns undefined when the registry is unavailable, in which case the agent
   * still runs and the conversation simply shows as ungrouped. Losing the GUI
   * grouping is a far smaller failure than losing the ability to reply.
   */
  async #workspace() {
    if (this.workspacePromise === undefined) {
      this.workspacePromise = this.#resolveWorkspace()
    }
    return await this.workspacePromise
  }

  async #resolveWorkspace() {
    if (this.cwd === undefined) return undefined
    const registry = this.ctx.get('workspaceRegistry')
    if (registry?.resolveByPath === undefined) return undefined
    try {
      const existing = await registry.resolveByPath(this.cwd)
      if (existing !== undefined) return existing
      if (typeof registry.create !== 'function') return undefined
      return await registry.create(this.cwd)
    } catch (error) {
      this.errLog(`could not register the workspace at ${this.cwd}: ${String(error)}`)
      return undefined
    }
  }

  /**
   * Resolve the route this conversation runs on and the setup that binds it.
   *
   * A prompt assembly needs a provider/model pair, and the agent only learns it
   * from either `agentOptions` or a model-selection listener on the agent context.
   * Supplying neither leaves `{{model}}` empty and the deployment persona section
   * throws at the first step — so both are always supplied here.
   *
   * `installModelSelection` comes from `@deepseek-ai/dsh-agent`, which resolves
   * only inside a DSH profile; a profile showing a different shape degrades to
   * running without the listener rather than failing to load.
   */
  async #setup() {
    const route = await this.#route()
    const agentOptions =
      route === undefined
        ? undefined
        : {
            provider: route.provider,
            model: route.model,
          }
    const presets = this.ctx.get('agentPresets')
    const presetId = await this.#presetId(presets)

    const setup = async (agentCtx) => {
      if (presetId !== undefined) await presets.mount(agentCtx, presetId)
      if (route !== undefined) {
        const install = await loadInstallModelSelection()
        if (install !== undefined) {
          install(agentCtx, { current: route, assembled: undefined })
        }
      }
    }
    const hasSetup = presetId !== undefined || route !== undefined
    return { agentOptions, setup: hasSetup ? setup : undefined }
  }

  /**
   * The deployment's default provider/model route, or undefined when the
   * service is absent (a host that routes some other way).
   */
  async #route() {
    const defaults = this.ctx.get('agentDefaultModel')
    try {
      const selection = defaults?.currentSelection?.()
      if (selection?.provider && selection?.model) return selection
    } catch (error) {
      this.errLog(`agentDefaultModel.currentSelection failed: ${String(error)}`)
    }
    return undefined
  }

  /** The preset id this conversation should compose, when presets exist. */
  async #presetId(presets) {
    if (!presets?.resolve) return undefined
    try {
      const resolved = await presets.resolve(undefined)
      return resolved?.id
    } catch (error) {
      this.errLog(`agentPresets.resolve failed (continuing without a preset): ${String(error)}`)
      return undefined
    }
  }

  /**
   * Attach (or resume) the agent session backing a Weixin conversation.
   *
   * Resolves the conversation's ACTIVE session line, not a fixed id: after
   * `/new` or `/use`, the next message must reach a different session than the
   * previous one. The session id is read synchronously before any await, so two
   * concurrent messages for the same conversation cannot disagree about which
   * line is active.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   */
  async attach(conversationId, accountId) {
    const sessionId = this.#activeSessionId(conversationId, accountId)
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing

    // Two messages for the same conversation can race here: the first
    // deliver() is still inside the awaits below (its record is not in the
    // map yet), so a second attach() would create a second session for the
    // same id and both would run unserialized. Memoize the in-flight
    // creation so concurrent attaches share one record.
    const inflight = this.attachPromises.get(sessionId)
    if (inflight !== undefined) return inflight

    const creation = this.#attachNew(sessionId)
    this.attachPromises.set(sessionId, creation)
    try {
      return await creation
    } finally {
      this.attachPromises.delete(sessionId)
    }
  }

  async #attachNew(sessionId) {
    const agents = this.#agents()
    if (agents === undefined) throw new Error('the agents service is unavailable')

    const { agentOptions, setup } = await this.#setup()
    /** @type {{ agent: any, dispose: () => Promise<void> }} */
    let handle
    /** Created here rather than adopted, so {@link #create} already filed it. */
    let created = false
    const live = agents.get?.(sessionId)
    if (live !== undefined) {
      handle = { agent: live, dispose: async () => {} }
    } else if (typeof agents.resume === 'function') {
      // Cold start: the session was persisted by a previous run.
      try {
        handle = await agents.resume({
          resumeSessionId: sessionId,
          setup,
          ...(agentOptions === undefined ? {} : { agentOptions }),
        })
      } catch {
        handle = await this.#create(sessionId, setup, agentOptions)
        created = true
      }
    } else {
      handle = await this.#create(sessionId, setup, agentOptions)
      created = true
    }

    // A stale record from a previous plugin generation can leave its inbox
    // holding unclaimed input; clearing it fences the same replay leak
    // sidechat documents (queued input claimed before our first prompt).
    try {
      handle.agent.inbox?.clear?.()
    } catch {
      // Not fatal: the worst case is one stale message in the first turn.
    }

    // An archived session cannot run a single step: the host's
    // ArchivedSessionGate rejects every pre-step, so a turn ends `blocked`
    // 25ms after it starts — the message was received, typing was shown, and
    // no reply ever came (observed 2026-10-15). The archive set is GUI state
    // (workspace.json), not anything this plugin writes, so an archive made
    // from the GUI would otherwise silently kill the WeChat bot forever.
    // Lifting it here keeps the conversation reachable; a user who truly wants
    // it gone can log the bot out instead.
    try {
      const registry = this.ctx.get('workspaceRegistry')
      const archived = registry?.archivedSessionIds
      if (Array.isArray(archived) && archived.includes(sessionId) && typeof registry.unarchiveSession === 'function') {
        await registry.unarchiveSession(sessionId)
        this.log?.(`session ${sessionId} was archived; unarchived it so the conversation can reply again`)
      }
    } catch {
      // Best effort only: if unarchiving is refused the turn will end blocked
      // and the refusal is visible in the host log, not lost silently here.
    }

    // `cancelled` is set by `/cancel` for the duration of one turn: it tells
    // the reply wait that the abort it will observe is wanted, so it must not
    // be reported as a model failure. Cleared when the turn settles.
    // `auditSeq` is the last event seq already audited, so a poll that sees the
    // same tool call twice does not write it twice. `auditCalls` pairs a
    // tool/result back to the tool/call that started it, for the duration.
    const record = {
      agent: handle.agent,
      dispose: handle.dispose,
      busy: false,
      queue: [],
      cancelled: false,
      auditSeq: -1,
      auditCalls: new Map(),
    }
    this.sessions.set(sessionId, record)
    // Resume can resurrect a session this plugin never filed (created by an
    // earlier generation, before grouping existed), so those paths register
    // here. A session created above is already filed; attaching twice would be
    // harmless but would mean two registry writes per first message.
    if (!created) await this.#register(sessionId, await this.#workspace())
    return record
  }

  async #create(sessionId, setup, agentOptions) {
    const agents = this.#agents()
    if (typeof agents.create !== 'function') throw new Error('the agents service cannot create sessions')
    // The session's cwd must equal the Workspace path byte for byte, because
    // `attachSession` re-resolves the stored header's cwd and refuses anything
    // that differs. Adopting the registry's own path removes the chance of a
    // mismatch (a trailing slash, a symlinked /tmp, a relative config value)
    // that would file the conversation under "Ungrouped" forever.
    const workspace = await this.#workspace()
    const cwd = workspace?.path ?? this.cwd
    const handle = await agents.create({
      sessionId,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      // Meta is validated against the session header schema: only cwd,
      // parentSession, isSeeded, origin ('subagent'), delegationDepth and
      // agentPreset are admitted. A Weixin conversation is a top-level
      // conversation, so it needs no origin marker at all — writing a custom
      // one would fail validation ("header origin must be \"subagent\"").
      meta: {
        ...(cwd === undefined ? {} : { cwd }),
      },
      setup,
      signal: AbortSignal.timeout(this.createTimeoutMs),
    })
    await this.#register(sessionId, workspace)
    return handle
  }

  /**
   * File a freshly created session under its Workspace for GUI grouping.
   *
   * `attachSession` re-validates the stored header's cwd against the workspace
   * path and throws on a mismatch, so this must run after the session exists and
   * only ever against the workspace whose path the session was created with. A
   * failure is logged and swallowed: the conversation works, it just shows as
   * ungrouped.
   */
  async #register(sessionId, workspace) {
    if (workspace === undefined || typeof workspace.attachSession !== 'function') return
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      this.errLog(`could not file session ${sessionId} under ${workspace.path}: ${String(error)}`)
    }
  }

  /**
   * Deliver one Weixin message and wait for the agent's settled reply.
   *
   * @param {object} params
   * @param {string} params.conversationId
   * @param {string} [params.accountId] owning bot account; bare key when absent
   * @param {string} params.text
   * @param {(note: string) => Promise<void>|void} [params.onProgress]
   * @param {AbortSignal} [params.signal]
   * @param {string} [params.senderId] the Weixin user whose message started the
   *   turn; carried into the tool audit so a line answers "who caused this".
   * @returns {Promise<{ text: string, sessionId: string }>}
   */
  async deliver({ conversationId, accountId, text, onProgress, signal, busyMessageMode, onLateReply, senderId }) {
    const record = await this.attach(conversationId, accountId)
    const sessionId = this.conversationTargets.get(scopedLineKey(accountId, conversationId))
    // Name the line after the first message that runs in it. Done before the
    // turn so `/list` shows what the topic is even while the first reply is
    // still being written; a later message never renames it.
    // A freshly set title is ALSO mirrored into the host session
    // (sessionTitle.rename): the GUI sidebar renders the HOST's title, not
    // this store's, so without the mirror the sidebar shows its own
    // AI-generated name while /list and the card show `label: message`.
    // Best-effort: the store title is the source of truth; a failed host
    // rename (service absent, session not live, title rejected) only costs
    // the sidebar echo, never the message.
    if (sessionId !== undefined) {
      const storeTitle = this.lines.title(conversationId, sessionId, text, accountId)
      if (storeTitle !== undefined) void this.#mirrorTitle(record.agent, storeTitle)
    }
    const mode = busyMessageMode === 'steer' ? 'steer' : 'queue'

    if (record.busy) {
      // `/steer <instruction>` is always an injection, whatever the mode: the
      // command exists precisely to reach a turn that is already running.
      const steerCommand = parseSteerCommand(text)
      if (mode === 'steer' || steerCommand !== undefined) {
        const payload = steerCommand !== undefined ? steerCommand : text
        const createUserMessage = await loadCreateUserMessage()
        record.agent.steer?.(
          createUserMessage({ content: [{ type: 'text', text: payload }], source: { kind: 'user' } }),
        )
        // The steered turn keeps running; the caller's awaitReply is for a
        // turn this delivery did not start, so return immediately with a
        // receipt. The steered turn's eventual reply belongs to the turn's
        // own delivery wait.
        return { text: '（已把补充指令插入正在进行的回复中）', sessionId: record.agent.session?.id ?? sessionId ?? baseSessionIdFor(conversationId) }
      }
      // queue (default): FIFO tail drained when the running turn settles.
      return await this.#enqueue({ record, conversationId, accountId, text, onProgress, signal, onLateReply, senderId })
    }
    record.busy = true
    try {
      const createUserMessage = await loadCreateUserMessage()
      const before = this.#lastSeq(record.agent)
      this.#beginAuditTurn(record, { accountId, conversationId, senderId })
      // followup() wakes the driver for a turn; inject() would only queue
      // context, and steer() would wait for the next step boundary.
      record.agent.followup(
        createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      )
      return await this.#awaitReply({ record, before, onProgress, signal, onLateReply })
    } finally {
      record.busy = false
      // The turn is over, so a stale cancel flag would suppress the NEXT
      // turn's reply entirely.
      record.cancelled = false
      await this.#drainQueue({ record, conversationId, onProgress, signal })
    }
  }

  /**
   * Park one message on the conversation's FIFO tail and wait until it has
   * been delivered as its own turn (possibly by an earlier drain).
   *
   * The receipt goes out through `onProgress` immediately — that is the only
   * send channel this layer has — and the resolved value is the queued turn's
   * own reply, so the caller delivers the real answer through its normal
   * reply path once the turn runs.
   */
  async #enqueue({ record, conversationId, accountId, text, onProgress, signal, onLateReply, senderId }) {
    const sessionId = record.agent.session?.id ?? this.conversationTargets.get(scopedLineKey(accountId, conversationId)) ?? baseSessionIdFor(conversationId)
    const entry = { text, onProgress, signal, onLateReply, senderId, accountId, conversationId }
    entry.done = new Promise((resolve) => { entry.resolveDone = resolve })
    record.queue.push(entry)
    // The receipt must reach WeChat even when the caller ignores onProgress:
    // a plain-notification wrapper is safe either way.
    const notify = onProgress ?? (() => {})
    void Promise.resolve(notify('已排队，等当前回复完成后自动发送')).catch(() => {})
    // If the turn already settled between the busy check and this push, the
    // drain ran without our entry; run it now.
    if (!record.busy && record.queue[record.queue.length - 1] === entry) {
      record.queue.pop()
      record.busy = true
      try {
        const result = await this.#runQueuedTurn({ record, conversationId, entry })
        entry.resolveDone(result)
        return result
      } finally {
        record.busy = false
      }
    }
    return entry.done
  }
  /**
   * Run one queued text as a full turn, serially after whatever is running.
   * Resolves with that turn's reply; the queue notification happens in
   * {@link #drainQueue}.
   */
  async #runQueuedTurn({ record, conversationId, entry }) {
    const createUserMessage = await loadCreateUserMessage()
    const before = this.#lastSeq(record.agent)
    this.#beginAuditTurn(record, {
      accountId: entry.accountId,
      conversationId: entry.conversationId ?? conversationId,
      senderId: entry.senderId,
    })
    record.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: entry.text }], source: { kind: 'user' } }),
    )
    return this.#awaitReply({ record, before, onProgress: entry.onProgress, signal: entry.signal, onLateReply: entry.onLateReply })
  }

  /**
   * Drain the FIFO tail after a turn settles, one entry at a time.
   * Called from the deliver() finally block; owns record.busy while draining.
   */
  async #drainQueue({ record, conversationId, onProgress, signal }) {
    while (record.queue.length > 0) {
      const entry = record.queue.shift()
      if (entry === undefined) return
      record.busy = true
      try {
        const result = await this.#runQueuedTurn({ record, conversationId, entry })
        entry.resolveDone(result)
      } catch (error) {
        this.errLog(`queued turn failed: ${String(error)}`)
        entry.resolveDone({ text: '（排队消息处理失败，请重发）', sessionId: record.agent.session?.id ?? '' })
      } finally {
        record.busy = false
      }
    }
  }

  /**
   * Start a fresh audit cursor for a turn that is about to run.
   *
   * The cursor is the last event seq already audited, so a poll that sees the
   * same tool call twice writes one line, and a turn never re-audits the
   * conversation's earlier history. The meta rides on the record because the
   * turn is serialized (one busy lock per line) — a queued turn overwrites it
   * when it starts, which is exactly when the previous turn has finished.
   *
   * @param {any} record
   * @param {{ accountId?: string, conversationId?: string, senderId?: string }} meta
   */
  #beginAuditTurn(record, meta) {
    record.auditSeq = -1
    record.auditCalls = new Map()
    record.auditMeta = meta
  }

  /**
   * Turn this poll's new events into audit lines.
   *
   * Called before the reply is read, so a fast turn that settles in the same
   * poll still gets its tools audited. One line per `tool/call` (tool, args,
   * who, when) and one per `tool/result` (ok, duration) joined by `callId`:
   * two lines rather than one mutable record keeps the file append-only.
   *
   * A throwing sink must never fail the turn — the audit is observation.
   *
   * @param {any} record
   * @param {readonly any[]} events snapshotEvents() of the current poll
   * @param {number} before last seq before the turn started
   */
  #auditEvents(record, events, before) {
    const sink = this.onToolAudit
    if (sink === undefined) return
    // The session id is read at emit time, not at turn start: `/new` can switch
    // the line's active session while a message waits in the queue, and the
    // audit must name the session the tool actually ran in.
    const meta = { ...(record.auditMeta ?? {}), sessionId: record.agent?.session?.id ?? '' }
    for (const event of events ?? []) {
      if (typeof event?.seq !== 'number') continue
      if (event.seq <= before || event.seq <= record.auditSeq) continue
      try {
        if (event.type === 'tool/call') {
          const callId = event.data?.callId
          const tool = typeof event.data?.name === 'string' ? event.data.name : 'tool'
          if (typeof callId === 'string') {
            record.auditCalls.set(callId, { tool, at: typeof event.time === 'number' ? event.time : Date.now() })
          }
          sink({
            kind: 'tool/call',
            at: Date.now(),
            ...meta,
            tool,
            ...(typeof callId === 'string' ? { callId } : {}),
            args: event.data?.arguments,
          })
        } else if (event.type === 'tool/result') {
          const callId = event.data?.message?.source?.callId
          const known = typeof callId === 'string' ? record.auditCalls.get(callId) : undefined
          const error = event.data?.message?.source?.error ?? event.data?.error
          const durationMs = known !== undefined && typeof event.time === 'number' ? event.time - known.at : undefined
          sink({
            kind: 'tool/result',
            at: Date.now(),
            ...meta,
            ...(known === undefined ? {} : { tool: known.tool }),
            ...(typeof callId === 'string' ? { callId } : {}),
            ok: error === undefined,
            ...(durationMs === undefined ? {} : { durationMs }),
          })
          if (typeof callId === 'string') record.auditCalls.delete(callId)
        }
      } catch (failure) {
        this.errLog(`tool audit sink failed: ${String(failure)}`)
      }
      record.auditSeq = event.seq
    }
  }

  #lastSeq(agent) {
    const events = agent.session?.snapshotEvents?.() ?? []
    let seq = -1
    for (const event of events) {
      if (typeof event?.seq === 'number' && event.seq > seq) seq = event.seq
    }
    return seq
  }

  /**
   * Mirror a freshly set line title into the host session, so the GUI
   * sidebar (which renders the HOST's title, not this store's) shows the
   * same `label: message` text /list does.
   *
   * The host renames through its `sessionTitle` service: rename(session,
   * title) appends a `session/title` event with source `user`, which pins the
   * title — the host's own automatic title generation is superseded and later
   * messages schedule none. That pinning is exactly what we want: the first
   * WeChat message names the sidebar row and nothing overwrites it.
   *
   * Never throws: the store title already stands; this only echoes it to the
   * sidebar. A missing service (bare CLI), a session not live in the host
   * store, or a title the host rejects are all logged and dropped.
   *
   * @param {any} agent live agent handle from attach()
   * @param {string} title the title the store just set
   */
  #mirrorTitle(agent, title) {
    try {
      const session = agent?.session
      if (session === undefined || typeof session.id !== 'string' || session.id === '') return
      const titles = this.ctx.get('sessionTitle')
      if (titles === undefined || typeof titles.rename !== 'function') return
      titles.rename(session, title)
      this.log?.(`session title mirrored: ${title}`)
    } catch (error) {
      // The host rejects a rename when the session is not live in its store
      // (cold-start races) or the title normalizes to empty — both leave the
      // sidebar with its own title, which is cosmetic, so warn and move on.
      this.errLog?.(`sessionTitle.rename failed (sidebar keeps its own title): ${String(error)}`)
    }
  }

  async #awaitReply({ record, before, onProgress, signal, onLateReply }) {
    const sessionId = record.agent.session?.id ?? ''
    const startedAt = Date.now()
    const deadline = startedAt + this.maxWaitMs
    let lastProgressAt = 0
    let lastProgressNote = ''
    let lateAnnounced = false

    while (Date.now() < deadline) {
      if (signal?.aborted === true) return { text: '（已取消）', sessionId }
      // `/cancel` set this flag before asking the host to abort. The abort ends
      // the turn with an error event, and reporting that as "模型调用失败"
      // would blame the model for something the user asked for — so the flag
      // wins, and the empty text means the command's own receipt is the only
      // message the user gets.
      if (record.cancelled === true) return { text: '', sessionId, cancelled: true }
      const events = record.agent.session?.snapshotEvents?.() ?? []
      this.#auditEvents(record, events, before)
      const reply = readAssistantReply({ events, afterSeq: before })
      if (reply.text !== '') return { text: reply.text, sessionId }
      // A failed turn is OVER: no assistant message will ever arrive, and the
      // turn/end(error) event is already durable. Waiting out the deadline
      // here holds record.busy for the whole budget, so the user's NEXT
      // message queues behind a turn that can never answer — the "one model
      // failure and everything after is stuck" report. Answer immediately.
      if (reply.turnError !== undefined) {
        return { text: `（模型调用失败：${reply.turnError}）`, sessionId }
      }

      // A long tool run is invisible in WeChat. The first note goes out after
      // progressAfterMs; after that a CHANGED tool set is re-announced at most
      // every progressEveryMs, so "running: bash" becoming "running: read"
      // reaches the user while one long unchanged tool never spams.
      if (onProgress) {
        const note = describePending(reply.pendingTools)
        const due = lastProgressAt === 0
          ? Date.now() - startedAt >= this.progressAfterMs
          : note !== lastProgressNote && Date.now() - lastProgressAt >= this.progressEveryMs
        if (due) {
          lastProgressAt = Date.now()
          lastProgressNote = note
          await onProgress(note)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs))
    }

    // The user was told the wait gave up — but the turn is still running and
    // its answer would be lost if we simply returned. Keep listening at a
    // slow cadence until the turn settles, then hand the final text to the
    // late-reply callback so the caller can deliver it out of band.
    if (onLateReply === undefined) return { text: '（处理超时，请稍后查看会话）', sessionId }
    if (!lateAnnounced) {
      lateAnnounced = true
      try {
        await onLateReply({ kind: 'timeout-notice' })
      } catch {
        // The notice is best effort; the late answer still gets delivered.
      }
    }
    // Keep the normal cadence: the loop is cheap (an in-memory event
    // snapshot), and a slower tick risks missing a short late window.
    const latePollMs = this.pollMs
    const lateDeadline = Date.now() + (this.lateReplyMaxWaitMs ?? 60 * 60_000)
    while (Date.now() < lateDeadline) {
      if (signal?.aborted === true) return { text: '', sessionId, late: true }
      // A cancelled turn is over; the late wait must not keep polling for a
      // reply the user explicitly asked not to receive.
      if (record.cancelled === true) return { text: '', sessionId, late: true }
      const events = record.agent.session?.snapshotEvents?.() ?? []
      this.#auditEvents(record, events, before)
      const reply = readAssistantReply({ events, afterSeq: before })
      if (reply.text !== '') {
        try {
          await onLateReply({ kind: 'reply', text: reply.text })
        } catch (error) {
          this.errLog(`late reply delivery failed: ${String(error)}`)
        }
        // The answer went out through the late-reply channel; the caller must
        // not send the normal reply path again.
        return { text: '', sessionId, late: true }
      }
      // Same failure rule as the primary loop: an errored turn is over, and
      // the late wait must not spin for its full hour either.
      if (reply.turnError !== undefined) return { text: '', sessionId, late: true }
      await new Promise((resolve) => setTimeout(resolve, latePollMs))
    }
    this.errLog(`late reply wait gave up for ${sessionId}`)
    return { text: '', sessionId, late: true }
  }

  /** Tear down every session this bridge created. */
  async dispose() {
    const records = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(
      records.map(async (record) => {
        try {
          await record.dispose()
        } catch (error) {
          this.errLog(`session dispose failed: ${String(error)}`)
        }
      }),
    )
  }
}
