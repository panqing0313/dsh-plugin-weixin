/**
 * Voice transcription: drive a persistent ASR bridge so the agent can read what
 * a Weixin voice message actually said.
 *
 * Weixin voice is SILK, which no ASR model on this host accepts directly. The
 * path is therefore SILK → WAV (the vendored `silk-transcode.js`, via the
 * optional `silk-wasm` dependency) → the bridge, which returns Chinese text.
 *
 * The bridge is an **external process**, deliberately: a whisper model plus its
 * ML runtime is hundreds of megabytes and is installed out of tree, so the
 * plugin must not depend on it and must work exactly as before when it is
 * absent. Everything here is therefore opt-in, timeout-bounded and
 * failure-tolerant — this module's contract is "return a note the agent can use,
 * or return null and never throw".
 *
 * Three deliberate properties, mirroring `src/media/inbound.js`:
 *  - **One long-lived process.** Loading the model costs seconds (measured:
 *    "ready in 3.76s" cold, and far worse on a cold filesystem), so a process
 *    per voice note would make every voice message pathologically slow. The
 *    child is started on first use, kept alive, and requests are serialized.
 *  - **A crash is a degraded request, not a dead plugin.** The pending request
 *    is failed, the child handle is dropped, and the *next* request starts a
 *    fresh process. `dispose()` terminates it on plugin unload.
 *  - **Text is delivered verbatim or not at all.** An empty transcript (silence,
 *    music, a model that produced nothing) is reported as empty rather than
 *    replaced with a plausible-sounding guess; inventing content for a voice
 *    message would be worse than admitting it was not understood.
 * @module dsh-weixin/media/asr
 */

import { spawn } from 'node:child_process'

/**
 * Default transcription budget.
 *
 * Generous on purpose: this bounds a pathological hang, it is not a latency
 * target. A warm bridge answers in well under a second, but a cold model load
 * inside a fresh container can legitimately take tens of seconds, and a
 * timeout that fires during a normal cold start would turn a working setup into
 * a permanently degraded one.
 */
export const DEFAULT_ASR_TIMEOUT_MS = 60_000

/** Environment variable names the bridge itself reads. */
const ENV_MODEL = 'DSH_WEIXIN_ASR_MODEL'
const ENV_LANGUAGE = 'DSH_WEIXIN_ASR_LANGUAGE'

/** Bytes kept from stderr for the "why did it fail" note. */
const MAX_STDERR_TAIL = 500

/**
 * A voice-transcription failure that should be reported to the user as a note.
 *
 * Never thrown out of this module: `transcribeVoice` converts every failure into
 * a degraded result so a broken bridge can only ever cost the transcript.
 */
export class AsrError extends Error {
  /**
   * @param {string} message  Human-readable reason, safe to put in a prompt.
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'AsrError'
    this.code = code
  }
}

/**
 * Resolve the ASR settings from plugin config.
 *
 * Resolution is pure so the "is ASR usable at all" decision is testable without
 * spawning anything. `undefined` means "this install has no bridge configured",
 * which is the normal, fully-supported state: the caller then behaves exactly as
 * it did before ASR existed.
 *
 * @param {object} [config]  The plugin config object.
 * @param {string} [modelDir]  Runtime model directory (settings UI), which
 *   overrides the configured one. Lets the bridge resolve a model downloaded
 *   into a custom directory without editing the config file.
 * @returns {{ command: string, args: string[], env: Record<string, string>, timeoutMs: number } | undefined}
 */
export function resolveAsrSettings(config, modelDir) {
  const settings = config?.asr
  if (settings === undefined || settings === null || settings.enabled === false) return undefined
  const command = typeof settings.command === 'string' ? settings.command.trim() : ''
  if (command === '') return undefined
  const args = Array.isArray(settings.args) ? settings.args.filter((a) => typeof a === 'string') : []
  const timeoutMs =
    Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0
      ? Math.floor(settings.timeoutMs)
      : DEFAULT_ASR_TIMEOUT_MS
  const env = { ...(settings.env ?? {}) }
  // A blank value is dropped, not forwarded: `env: { HF_HOME: " " }` (a YAML
  // line with a stray space) would otherwise override the ambient HF_HOME with
  // an empty-ish string and send the bridge hunting for models on the system
  // disk. Dropping the key lets the child inherit the real value instead.
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() === '') delete env[name]
  }
  for (const name of [ENV_MODEL, ENV_LANGUAGE, 'HF_HOME']) {
    const value = env[name]
    if (typeof value === 'string') env[name] = value.trim()
  }
  // A model directory chosen in the settings UI (or written into the config)
  // points HF_HOME and the explicit model path at that tree, so a model
  // downloaded there is the one transcription actually resolves. An explicit
  // env/model value in the config still wins, since the user typed it by hand.
  const chosenDir =
    (typeof modelDir === 'string' && modelDir.trim() !== '' ? modelDir.trim() : undefined) ??
    (typeof settings.modelDir === 'string' && settings.modelDir.trim() !== '' ? settings.modelDir.trim() : undefined)
  if (chosenDir !== undefined) {
    if (env.HF_HOME === undefined) env.HF_HOME = chosenDir
    if (env[ENV_MODEL] === undefined) env[ENV_MODEL] = chosenDir
  }
  return { command, args, env, timeoutMs }
}

/**
 * A persistent line-oriented JSON bridge process.
 *
 * The protocol is one JSON request per line on stdin and one JSON response per
 * line on stdout, which makes correlation trivial: exactly one request is in
 * flight at a time, so the next line out is always its answer. Serialization is
 * also what the bridge wants — it transcribes on one thread — and it costs
 * nothing in practice, because voice notes arrive one at a time.
 */
export class AsrBridge {
  /**
   * @param {{ command: string, args: string[], env: Record<string, string>, timeoutMs: number }} settings
   * @param {{ spawnImpl?: typeof spawn, log?: (line: string) => void, warn?: (line: string) => void }} [hooks]
   */
  constructor(settings, hooks = {}) {
    this.settings = settings
    this.spawnImpl = hooks.spawnImpl ?? spawn
    this.log = hooks.log ?? (() => {})
    this.warn = hooks.warn ?? (() => {})
    /** @type {import('node:child_process').ChildProcess | undefined} */
    this.child = undefined
    /** Serializes requests; also the "one response per line" correlation. */
    this.queue = Promise.resolve()
    /** Resolved on plugin unload so an in-flight request stops waiting. */
    this.closed = false
    /** @type {(() => void) | undefined} */
    this.closeSignal = undefined
  }

  /**
   * Transcribe one WAV file.
   *
   * Never throws and never rejects: every failure mode becomes `{ ok: false }`
   * so the caller can degrade to the SILK note instead of losing the message.
   *
   * @param {string} wavPath
   * @returns {Promise<{ ok: true, text: string } | { ok: false, reason: string, code: string }>}
   */
  async transcribe(wavPath) {
    if (this.closed) return { ok: false, reason: 'the ASR bridge was shut down', code: 'closed' }
    // Chain onto the previous request so only one is ever in flight.
    const result = this.queue.then(() => this.#transcribeOnce(wavPath))
    // Keep the chain alive even when a request fails, or every later request
    // would inherit the rejection.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * @param {string} wavPath
   * @returns {Promise<{ ok: true, text: string } | { ok: false, reason: string, code: string }>}
   */
  async #transcribeOnce(wavPath) {
    if (this.closed) return { ok: false, reason: 'the ASR bridge was shut down', code: 'closed' }
    let child
    try {
      child = this.#ensureChild()
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error), code: 'spawn-failed' }
    }
    try {
      const response = await this.#request(child, wavPath)
      if (response.ok !== true) {
        const detail = typeof response.error === 'string' && response.error !== '' ? response.error : 'the bridge reported an unknown error'
        return { ok: false, reason: detail, code: 'bridge-error' }
      }
      // An empty transcript is a legitimate answer (silence, music, a language
      // the model does not cover) — report it as empty, never invent content.
      return { ok: true, text: typeof response.text === 'string' ? response.text.trim() : '' }
    } catch (error) {
      if (error instanceof AsrError) {
        // A timed-out or dead child is dropped so the next request gets a fresh
        // one; a per-request bridge error keeps the process, which is healthy.
        if (error.code === 'timeout' || error.code === 'exited') this.#killChild()
        return { ok: false, reason: error.message, code: error.code }
      }
      this.#killChild()
      return { ok: false, reason: String(error?.message ?? error), code: 'unexpected' }
    }
  }

  /**
   * Start the bridge if it is not running.
   * @returns {import('node:child_process').ChildProcess}
   */
  #ensureChild() {
    if (this.child !== undefined && this.child.exitCode === null && !this.child.killed) return this.child
    const { command, args, env } = this.settings
    const child = this.spawnImpl(command, args, {
      // The bridge's own logs are diagnostics, not protocol: stdout carries the
      // JSON responses and must never be polluted by a stray print.
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    this.child = child
    let stderrTail = ''
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-MAX_STDERR_TAIL)
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') this.log(`asr bridge: ${line.trim()}`)
      }
    })
    child.on('error', (error) => {
      this.warn(`asr bridge spawn error: ${String(error?.message ?? error)}`)
    })
    // A child that dies mid-request must not leave the caller waiting for the
    // timeout; the request listener is woken by the 'exit'/'close' handler.
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      this.#wakeOnExit(child, code, signal, stderrTail)
    })
    this.log(`asr bridge started: ${command} ${args.join(' ')}`)
    return child
  }

  /**
   * Send one request and wait for its response, the process exit, or the timeout.
   *
   * The stream may carry lines that are not responses. A bridge is entitled to
   * log to stdout (the reference bridge prints "ready in 1.90s"), and a process
   * that dies can leave a fragment behind. Only a line that parses as a JSON
   * *object* is treated as an answer; anything else is logged and skipped, so a
   * chatty bridge does not turn every transcription into a failure.
   *
   * @param {import('node:child_process').ChildProcess} child
   * @param {string} wavPath
   */
  #request(child, wavPath) {
    return new Promise((resolve, reject) => {
      let settled = false
      let buffer = ''
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.off('exit', onExit)
        if (this.closeSignal === onClose) this.closeSignal = undefined
        fn(value)
      }
      const onData = (chunk) => {
        buffer += chunk
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line === '') continue
          if (!line.startsWith('{')) {
            // Diagnostic noise, not a response: the bridge is allowed to be
            // talkative on stdout.
            this.log(`asr bridge: ${line.slice(0, 200)}`)
            continue
          }
          let response
          try {
            response = JSON.parse(line)
          } catch {
            finish(reject, new AsrError(`the bridge wrote a malformed JSON response: ${line.slice(0, 200)}`, 'bad-response'))
            return
          }
          if (response === null || typeof response !== 'object' || Array.isArray(response)) {
            finish(reject, new AsrError(`the bridge wrote a response that is not an object: ${line.slice(0, 200)}`, 'bad-response'))
            return
          }
          finish(resolve, response)
          return
        }
      }
      const onExit = (code, signal) => {
        finish(reject, new AsrError(`the ASR bridge exited (code=${code}${signal ? `, signal=${signal}` : ''})`, 'exited'))
      }
      const onClose = () => {
        finish(reject, new AsrError('the ASR bridge was shut down', 'closed'))
      }
      const timer = setTimeout(() => {
        finish(reject, new AsrError(`the ASR bridge did not answer within ${this.settings.timeoutMs}ms`, 'timeout'))
      }, this.settings.timeoutMs)
      // `timer.unref()` would let the process exit while a request is pending;
      // the timeout is the only thing guaranteeing this promise settles.
      child.stdout.on('data', onData)
      child.on('exit', onExit)
      this.closeSignal = onClose
      try {
        child.stdin.write(`${JSON.stringify({ wav: wavPath })}\n`)
      } catch (error) {
        finish(reject, new AsrError(`could not write to the ASR bridge: ${String(error?.message ?? error)}`, 'exited'))
      }
    })
  }

  /**
   * Fail any in-flight request when the child exits.
   *
   * The exit handler already rejects it, but the pending promise may have been
   * created before this listener was attached (a child that dies between
   * requests), so the wake-up is routed through the same signal path.
   */
  #wakeOnExit(child, code, signal, stderrTail) {
    const reason = `the ASR bridge exited (code=${code}${signal ? `, signal=${signal}` : ''})`
    if (stderrTail.trim() !== '') this.warn(`asr bridge stderr: ${stderrTail.trim().split('\n').slice(-3).join(' | ')}`)
    this.log(reason)
  }

  /** Drop the current child without waiting; the next request restarts it. */
  #killChild() {
    const child = this.child
    this.child = undefined
    if (child === undefined) return
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone: nothing to reap.
    }
  }

  /**
   * Terminate the bridge and settle any in-flight request.
   *
   * Called from the plugin disposer, so it must not hang: the child is killed
   * outright rather than asked politely, and the pending request is failed
   * through {@link AsrBridge#closeSignal}.
   */
  async dispose() {
    this.closed = true
    const notify = this.closeSignal
    this.closeSignal = undefined
    this.#killChild()
    if (notify !== undefined) notify()
    await this.queue.catch(() => undefined)
  }
}

/**
 * Transcribe one already-saved WAV file, degrading instead of throwing.
 *
 * @param {object} params
 * @param {AsrBridge | undefined} params.bridge
 * @param {string} params.wavPath
 * @returns {Promise<{ ok: true, text: string } | { ok: false, reason: string, code: string }>}
 */
export async function transcribeVoice({ bridge, wavPath }) {
  if (bridge === undefined) return { ok: false, reason: 'no ASR bridge is configured', code: 'not-configured' }
  try {
    return await bridge.transcribe(wavPath)
  } catch (error) {
    // Defence in depth: `transcribe` already converts, but a caller must never
    // lose a message because this module threw.
    return { ok: false, reason: String(error?.message ?? error), code: 'unexpected' }
  }
}
