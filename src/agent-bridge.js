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

/** Session ids are opaque strings; DSH only requires stability. */
const SESSION_PREFIX = 'weixin-'

/**
 * Deterministic session id for a Weixin conversation.
 *
 * Stable across restarts so the conversation survives a plugin reload, and
 * prefixed so a session can be recognized as Weixin-owned in the GUI.
 * Non-alphanumerics are folded to `-` to keep the id filesystem- and
 * URL-safe.
 * @param {string} conversationId
 */
export function sessionIdFor(conversationId) {
  const slug = String(conversationId ?? '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${SESSION_PREFIX}${slug || 'default'}`
}

/**
 * @typedef {Object} AgentBridgeOptions
 * @property {any} ctx            Cordis context of the plugin.
 * @property {string} [cwd]       Working directory the agent operates in.
 * @property {(line: string) => void} [log]
 * @property {(line: string) => void} [errLog]
 * @property {number} [createTimeoutMs]
 * @property {number} [progressAfterMs]  Send a progress line after this long.
 * @property {number} [maxWaitMs]        Give up on a turn after this long.
 * @property {number} [pollMs]           Session-log polling interval.
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
    this.maxWaitMs = options.maxWaitMs ?? 20 * 60_000
    this.pollMs = options.pollMs ?? 1_000
    /** @type {Map<string, { agent: any, dispose: () => Promise<void>, busy: boolean }>} */
    this.sessions = new Map()
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
   * @param {string} conversationId
   */
  async attach(conversationId) {
    const sessionId = sessionIdFor(conversationId)
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing

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

    const record = { agent: handle.agent, dispose: handle.dispose, busy: false }
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
   * @param {string} params.text
   * @param {(note: string) => Promise<void>|void} [params.onProgress]
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<{ text: string, sessionId: string }>}
   */
  async deliver({ conversationId, text, onProgress, signal }) {
    const record = await this.attach(conversationId)
    if (record.busy) {
      return { text: '（上一条消息还在处理中，请稍后再发）', sessionId: sessionIdFor(conversationId) }
    }
    record.busy = true
    try {
      const createUserMessage = await loadCreateUserMessage()
      const before = this.#lastSeq(record.agent)
      // followup() wakes the driver for a turn; inject() would only queue
      // context, and steer() would wait for the next step boundary.
      record.agent.followup(
        createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      )
      return await this.#awaitReply({ record, before, onProgress, signal })
    } finally {
      record.busy = false
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

  async #awaitReply({ record, before, onProgress, signal }) {
    const sessionId = record.agent.session?.id ?? ''
    const startedAt = Date.now()
    const deadline = startedAt + this.maxWaitMs
    let progressSent = false

    while (Date.now() < deadline) {
      if (signal?.aborted === true) return { text: '（已取消）', sessionId }
      const events = record.agent.session?.snapshotEvents?.() ?? []
      const reply = readAssistantReply({ events, afterSeq: before })
      if (reply.text !== '') return { text: reply.text, sessionId }

      // A long tool run is invisible in WeChat; one progress line keeps the
      // user informed without spamming the conversation.
      if (!progressSent && onProgress && Date.now() - startedAt >= this.progressAfterMs) {
        progressSent = true
        await onProgress(describePending(reply.pendingTools))
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs))
    }
    return { text: '（处理超时，请稍后查看会话）', sessionId }
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
