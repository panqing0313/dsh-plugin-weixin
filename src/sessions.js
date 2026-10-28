/**
 * Persistent "session lines" per Weixin conversation.
 *
 * A Weixin conversation used to map to exactly one DSH session, derived
 * deterministically from the conversation id ({@link sessionIdFor}). That made
 * the binding simple and restart-proof, but it also meant a user could never
 * start a fresh topic or return to an earlier one: every message, forever, went
 * into the same context window.
 *
 * A **line** is one agent session under a conversation. Each conversation has
 * an ordered list of them plus a pointer to the active one:
 *
 * ```json
 * {
 *   "lines": [
 *     { "sessionId": "weixin-abc-im-bot",        "title": "帮我看看构建报错", "createdAt": "...", "lastUsedAt": "..." },
 *     { "sessionId": "weixin-abc-im-bot--m2k1",  "title": "翻译这段话",       "createdAt": "...", "lastUsedAt": "..." }
 *   ],
 *   "active": "weixin-abc-im-bot--m2k1"
 * }
 * ```
 *
 * Lines are **kept in parallel**: switching away from a line does not end,
 * archive or clear it. The user can switch back and the earlier context is
 * still there, which is what makes `/list` + `/use` useful rather than a
 * one-way reset.
 *
 * The first line keeps the historical deterministic id, so a conversation that
 * existed before this feature was added carries its context forward instead of
 * appearing to lose it on upgrade.
 *
 * @module dsh-weixin/src/sessions
 */
import fs from 'node:fs'
import { createTranslator, translate } from './i18n.js'
import path from 'node:path'

import { stateDir } from './state.js'
import { labelForAccount } from './account-registry.js'
import { parseWhen } from './message/scheduler.js'
import { parseSubscriptionWhen, describeSubscription } from './message/subscriptions.js'

/** Filename under the state root holding every conversation's line list. */
const LINES_FILE = 'sessions.json'

/**
 * How many lines `/list` shows at once.
 *
 * Not a cap on how many lines exist — a user who wants fifty topics gets
 * fifty — only on how many are rendered into one WeChat message. The most
 * recent ones are shown because those are what a user switches back to.
 */
export const LIST_LIMIT = 10

/**
 * Fold an arbitrary conversation id into a filesystem- and URL-safe slug.
 *
 * Kept byte-identical to the historical {@link sessionIdFor} behavior: the
 * first line's id must not change on upgrade, or every existing conversation
 * would start from an empty context.
 *
 * @param {string} conversationId
 * @returns {string}
 */
export function conversationSlug(conversationId) {
  const slug = String(conversationId ?? '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'default'
}

/**
 * Store key for one conversation under one account.
 *
 * Accounts are separated at the store level: two bots that somehow report the
 * same conversation id must never share a line list, or a message meant for
 * one account could land in the other's session. The slug is the same fold
 * used for session ids, so the key stays readable even though it is only ever
 * a JSON key.
 *
 * With no account (or a blank one) the bare conversation id is used, which
 * keeps pre-multi-account entries working unchanged.
 *
 * @param {string | undefined} accountId
 * @param {string} conversationId
 * @returns {string}
 */
export function scopedLineKey(accountId, conversationId) {
  const slug = String(accountId ?? '').trim()
  if (slug === '') return conversationId
  return `${conversationSlug(slug)}:${conversationId}`
}

/**
 * Session id for the FIRST line of a conversation.
 *
 * This is the historical id and must stay stable forever: it is what every
 * session created before session lines existed is named.
 *
 * @param {string} conversationId
 * @returns {string}
 */
export function baseSessionIdFor(conversationId) {
  return `weixin-${conversationSlug(conversationId)}`
}

/**
 * Session id for a NEW line of a conversation.
 *
 * Distinct from {@link baseSessionIdFor} so a new line never collides with the
 * original one, and derived from a timestamp plus a random suffix so two lines
 * created in the same millisecond cannot share an id.
 *
 * @param {string} conversationId
 * @param {number} [now]
 * @returns {string}
 */
export function newSessionIdFor(conversationId, now = Date.now()) {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${baseSessionIdFor(conversationId)}--${now.toString(36)}${suffix}`
}

/** Absolute path of the line store. */
export function linesFile() {
  return path.join(stateDir(), LINES_FILE)
}

/**
 * Read the whole line store.
 *
 * A missing, unreadable or malformed file resolves to `{}` — the same posture
 * as {@link readSavedConfig}: losing the *index* of session lines must never
 * cost the plugin its ability to load and reply. The worst case is that a
 * conversation falls back to its first line, which is where it started.
 *
 * @returns {Record<string, { lines: Array<{sessionId: string, title?: string, createdAt?: string, lastUsedAt?: string}>, active?: string }>}
 */
export function readLines() {
  let text
  try {
    text = fs.readFileSync(linesFile(), 'utf8')
  } catch {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    process.emitWarning(`dsh-weixin: ignoring malformed ${linesFile()}: ${String(error?.message ?? error)}`)
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.emitWarning(`dsh-weixin: ignoring ${linesFile()}: expected a JSON object`)
    return {}
  }
  return parsed
}

/**
 * Write the line store.
 *
 * Written through a temp file and renamed, so a crash mid-write cannot leave a
 * truncated index that would silently reset every conversation to its first
 * line. Failures are swallowed with a warning: the in-memory state is still
 * correct for this process, and refusing to reply because an index could not
 * be written would be a far worse trade.
 *
 * @param {ReturnType<typeof readLines>} lines
 * @returns {boolean} whether it was persisted
 */
export function writeLines(lines) {
  const file = linesFile()
  const temp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, `${JSON.stringify(lines, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temp, file)
    return true
  } catch (error) {
    process.emitWarning(`dsh-weixin: could not write ${file}: ${String(error?.message ?? error)}`)
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // Best effort: the temp file is already useless.
    }
    return false
  }
}

/**
 * Derive a short, human-readable title from the first user message of a line.
 *
 * The user never names a topic, so the only honest title is the first thing
 * they said. It is trimmed and collapsed to one line because it is rendered
 * into a WeChat message where a newline would break the list layout.
 *
 * @param {string} text
 * @returns {string}
 */
export function titleFrom(text, limit = 24) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat === '') return '(无标题)'
  // Count by code point so an emoji is not cut in half.
  const points = [...flat]
  if (points.length <= limit) return flat
  return `${points.slice(0, limit).join('')}…`
}

/**
 * Title for one line, prefixed with the owning account when it has one.
 *
 * Multi-account users could not tell which WeChat account a sidebar row
 * belongs to. A separate hint element beside the row glyph was tried twice
 * and the host's row squeezed the glyph both times, so the marker now lives
 * IN the title itself (`备注名: 标题`) — text flows, nothing can be squeezed.
 * Bare-key lines (pre-multi-account history) stay unprefixed.
 *
 * Registry reads are failure-tolerant by its own rule; a missing label falls
 * back to the short form of the account id, and any problem reads as no
 * prefix at all rather than blocking the title.
 *
 * @param {string} text first user message of the line
 * @param {string | undefined} accountId owning bot account
 * @returns {string}
 */
export function titledWithAccount(text, accountId) {
  const title = titleFrom(text)
  const who = String(accountId ?? '').trim()
  if (who === '') return title
  let label = ''
  try {
    label = labelForAccount(who)
  } catch {
    label = ''
  }
  const name = label !== '' ? label : who.split('@')[0]
  if (name === '') return title
  return `${name}: ${title}`
}

/**
 * In-memory session-line index for one plugin instance.
 *
 * Holds the persisted store in memory so a turn does not re-read the file, and
 * writes back after every mutation. Every method is synchronous: the decisions
 * it drives (which session id to attach) happen before any await, and making
 * them async would open a window where two concurrent inbound messages could
 * both decide to create a line.
 */
export class SessionLines {
  /**
   * @param {object} [options]
   * @param {(message: string) => void} [options.warn] diagnostics sink
   */
  constructor(options = {}) {
    this.warn = options.warn ?? (() => {})
    /** @type {ReturnType<typeof readLines>} */
    this.store = readLines()
  }

  /**
   * Lines recorded for a conversation, oldest first.
   *
   * A conversation that has never been seen reports its first line as
   * existing-but-unrecorded, so the caller attaches the historical id without
   * writing anything to disk. Persisting on read would create an entry for
   * every conversation that ever merely sent a message, including ones whose
   * allowlist check later refused them.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {Array<{sessionId: string, title?: string, createdAt?: string, lastUsedAt?: string}>}
   */
  list(conversationId, accountId) {
    const key = scopedLineKey(accountId, conversationId)
    const entry = this.store[key]
    if (entry === undefined || !Array.isArray(entry.lines) || entry.lines.length === 0) {
      return [{ sessionId: baseSessionIdFor(conversationId), title: undefined }]
    }
    return entry.lines
  }

  /**
   * The line the next message should go to.
   *
   * Falls back to the first line when the recorded active id is not in the
   * list — which happens if the index was hand-edited, or if a `--` suffix
   * survived a partial write. Returning a line that no longer exists would make
   * `attach` create a brand-new empty session under a stale name.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {string} session id
   */
  active(conversationId, accountId) {
    const key = scopedLineKey(accountId, conversationId)
    const lines = this.list(conversationId, accountId)
    const active = this.store[key]?.active
    if (typeof active === 'string' && lines.some((line) => line.sessionId === active)) return active
    return lines[0].sessionId
  }

  /**
   * Drop every recorded line for a conversation and start a fresh one.
   *
   * `/clear` semantics: the current conversation's context is gone and the
   * next message opens a brand-new line. The recorded line entries are removed
   * from `sessions.json` so `/list` no longer shows them (a list that keeps
   * growing through `/new` was the reason /clear was asked for); the host-side
   * transcript files are NOT touched — they are the host's data, and an
   * orphaned transcript is harmless.
   *
   * The new line gets a fresh id (a `--`-stamped suffix), so a stale in-memory
   * record for an old id can never answer again, and `/use` cannot switch back
   * into cleared context.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {string} the fresh line's session id
   */
  clear(conversationId, accountId) {
    // Write the fresh line directly rather than going through create(): the
    // empty list would make list() synthesize the historical base id and
    // create() would push onto it, silently resurrecting the line /clear was
    // asked to remove.
    const now = new Date().toISOString()
    const sessionId = newSessionIdFor(conversationId)
    this.#set(scopedLineKey(accountId, conversationId), { lines: [{ sessionId, createdAt: now, lastUsedAt: now }], active: sessionId })
    return sessionId
  }

  /**
   * Create a new line and make it active. Lines already present are untouched,
   * so switching away and back preserves the earlier context.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {string} the new line's session id
   */
  create(conversationId, accountId) {
    const now = new Date().toISOString()
    const sessionId = newSessionIdFor(conversationId)
    const lines = this.list(conversationId, accountId).slice()
    lines.push({ sessionId, createdAt: now, lastUsedAt: now })
    this.#set(scopedLineKey(accountId, conversationId), { lines, active: sessionId })
    return sessionId
  }

  /**
   * Remove one line from a conversation's list.
   *
   * The card's answer to "this line is dead weight" — distinct from `/clear`,
   * which resets the CURRENT line: remove takes an index and never moves the
   * conversation off the line it is on, so deleting an old line cannot throw
   * away live context. Removing the active line falls back to the first
   * remaining one, because `active()` would otherwise return a deleted id and
   * `attach` would open a brand-new empty session under it.
   *
   * Refusing to remove the last line was tried and reverted: a conversation
   * that only ever had one line then had no Delete button at all. Removing the
   * LAST line now removes the whole conversation entry — the next inbound
   * message re-creates a fresh line under the same key, so nothing becomes
   * unreachable.
   *
   * @param {string} conversationId
   * @param {number} index 1-based position as shown by `/list`
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {string | '' | undefined} the session id still active after the
   *   removal, '' when the whole entry was removed, undefined on a bad index
   */
  remove(conversationId, index, accountId) {
    const key = scopedLineKey(accountId, conversationId)
    const existing = this.store[key]
    const lines = Array.isArray(existing?.lines) ? existing.lines.slice() : this.list(conversationId, accountId).slice()
    if (!Number.isInteger(index) || index < 1 || index > lines.length) return undefined
    if (lines.length === 1) {
      // Last line: the entry goes with it. The distinct '' return (not
      // undefined, which means "bad index") lets the caller report success.
      delete this.store[key]
      this.#write()
      return ''
    }
    const [removed] = lines.splice(index - 1, 1)
    const active = existing?.active === removed.sessionId ? lines[0].sessionId : existing.active
    this.#set(key, { lines, active })
    return active
  }

  /**
   * Point a conversation at an existing line.
   *
   * The index is 1-based because `/use 2` is what a user reads off `/list`;
   * an out-of-range index returns undefined rather than clamping, so the reply
   * can tell the user the number was wrong instead of silently switching to
   * some other line.
   *
   * @param {string} conversationId
   * @param {number} index 1-based position as shown by `/list`
   * @returns {string | undefined} the session id, or undefined when out of range
   */
  use(conversationId, index, accountId) {
    const lines = this.list(conversationId, accountId).slice()
    if (!Number.isInteger(index) || index < 1 || index > lines.length) return undefined
    const target = lines[index - 1]
    target.lastUsedAt = new Date().toISOString()
    this.#set(scopedLineKey(accountId, conversationId), { lines, active: target.sessionId })
    return target.sessionId
  }

  /**
   * Give a line its title, derived from the first message that ran in it.
   *
   * Only the first message sets the title: later edits would make `/list` show
   * whatever was said most recently rather than what the topic is, and a title
   * that changes under the user is worse than an imperfect stable one.
   *
   * @param {string} conversationId
   * @param {string} sessionId
   * @param {string} text
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {string | undefined} the title this call SET (first message
   *   only), or undefined when the line was already named / not found — the
   *   caller mirrors a fresh title into the host session so the GUI sidebar
   *   shows the same text (`titleHostSync` in agent-bridge.js)
   */
  title(conversationId, sessionId, text, accountId) {
    // A conversation whose first message has just arrived has no entry on disk
    // yet — `list()` synthesizes its first line rather than persisting one, so
    // that merely receiving a message does not write state. Materialize the
    // entry here instead of dropping the title.
    const key = scopedLineKey(accountId, conversationId)
    const existing = this.store[key]
    const lines = Array.isArray(existing?.lines) && existing.lines.length > 0
      ? existing.lines
      : this.list(conversationId, accountId).slice()
    const line = lines.find((candidate) => candidate.sessionId === sessionId)
    if (line === undefined) return undefined
    // Only the first message names a line: re-titling on every message would
    // make `/list` show whatever was said most recently.
    if (typeof line.title === 'string' && line.title !== '') return undefined
    const now = new Date().toISOString()
    if (line.createdAt === undefined) line.createdAt = now
    line.lastUsedAt = now
    line.title = titledWithAccount(text, accountId)
    this.#set(key, { lines, active: existing?.active ?? sessionId })
    return line.title
  }

  /**
   * Render the line list as the text `/list` replies with.
   *
   * @param {string} conversationId
   * @param {string} [accountId] owning bot account; bare key when absent
   * @returns {string}
   */
  render(conversationId, accountId) {
    const all = this.list(conversationId, accountId)
    const activeId = this.active(conversationId, accountId)
    // Newest first: the lines a user wants to switch back to are the recent
    // ones, and the list is capped.
    const numbered = all.map((line, index) => ({ line, index: index + 1 }))
    const shown = numbered.slice(-LIST_LIMIT)
    const rows = shown.map(({ line, index }) => {
      const marker = line.sessionId === activeId ? '▶' : ' '
      const title = line.title ?? '(尚无对话)'
      return `${marker} ${index}. ${title}`
    })
    const hidden = numbered.length - shown.length
    const header = `共 ${all.length} 条会话，当前使用第 ${numbered.find(({ line }) => line.sessionId === activeId)?.index ?? 1} 条：`
    const footer = hidden > 0 ? `\n（只显示最近 ${LIST_LIMIT} 条，更早的 ${hidden} 条仍在，可用 /use <序号> 切换）` : ''
    const usage = '\n\n/new 开新会话 ｜ /use <序号> 切换'
    return `${header}\n${rows.join('\n')}${footer}${usage}`
  }

  /**
   * Record a line list and persist.
   * @param {string} conversationId
   * @param {{lines: Array<any>, active: string}} entry
   */
  #set(conversationId, entry) {
    this.store[conversationId] = entry
    this.#write()
  }

  #write() {
    if (!writeLines(this.store)) {
      this.warn(`could not persist ${linesFile()}; session lines are correct for this process only`)
    }
  }
}

/** The one command whose purpose is to interrupt a turn that is already running. */
const CANCEL_COMMAND = /^\/(?:cancel|取消)$/i

/**
 * Whether a message is a cancel request.
 *
 * The transport asks this before it queues a message, because `/cancel` is the
 * one command that must run *ahead* of a turn still in flight: it exists to
 * stop that turn. Everything else is delivered in per-conversation order.
 *
 * @param {unknown} text
 */
export const USE_USAGE = '用法：/use <序号>，序号来自 /list'

export function isInterruptCommand(text) {
  return typeof text === 'string' && CANCEL_COMMAND.test(text.trim())
}

/**
 * Parse a Weixin control command out of a message.
 *
 * Recognized only as the ENTIRE message, matching how `/steer` already works:
 * a message that merely mentions `/new` inside a sentence is a message, not a
 * command. That matters because the user is talking to an agent about their
 * code, and silently swallowing a sentence that starts with a slash would be a
 * worse failure than requiring the exact form.
 *
 * @param {string} text
 * @returns {{command: 'new'|'list'|'use'|'clear', index?: number} | undefined}
// ---------------------------------------------------------------------------
// The command table
//
// Every command the bot answers is one entry below: how it is recognised, what
// it says in /help, and what it does. Adding a command used to mean editing
// three places (a regex chain, a dispatch if-chain, the help array) and it was
// easy to ship one and forget the other two — /subscribe shipped once with no
// bare-command rule and fell through to the model.
//
// `parse` is a pattern plus a small builder; the order of the array is the
// order the patterns are tried, which is why the more specific forms come
// first (/subscribe <time> <text> before the bare form is irrelevant, but
// /subscribe before /subscribelist is not).
// ---------------------------------------------------------------------------

/** @typedef {{ id: string, pattern: RegExp, build: (match: RegExpExecArray) => object, help?: string, helpRank?: number, run?: (state: CommandState) => string | Promise<string> | undefined }} CommandRule */

/**
 * @typedef {object} CommandState
 * @property {SessionLines} lines
 * @property {string} conversationId
 * @property {string | undefined} accountId
 * @property {{ command: string } & Record<string, unknown>} command
 * @property {object | undefined} context
 */

const identity = () => ({})

/** @type {CommandRule[]} */
const COMMANDS = [
  { id: 'new', pattern: /^\/new$/i, build: identity, helpRank: 1, helpKey: 'help.new' },
  { id: 'list', pattern: /^\/(?:list|sessions)$/i, build: identity, helpRank: 2, helpKey: 'help.list' },
  {
    id: 'use',
    pattern: /^\/use(?:\s+(\d+))?$/i,
    build: (match) => ({ index: match[1] === undefined ? undefined : Number(match[1]) }),
    helpRank: 3,
    helpKey: 'help.use',
  },
  { id: 'clear', pattern: /^\/clear$/i, build: identity, helpRank: 4, helpKey: 'help.clear' },
  // `/cancel`（或 `/取消`）interrupts the turn that is running right now. It is
  // a command rather than a busy-mode action on purpose: it has to be answerable
  // WHILE the conversation is busy, which is exactly when a plain message would
  // be queued behind the turn the user wants to stop.
  //
  // Being a command is necessary but NOT sufficient: the transport used to
  // await the whole turn inside its poll loop, so a cancel sent mid-turn was
  // only read after that turn ended. `isInterruptCommand` (above) is what lets
  // the transport recognise this one command and handle it out of order.
  { id: 'cancel', pattern: CANCEL_COMMAND, build: identity, helpRank: 5, helpKey: 'help.cancel' },
  {
    id: 'status',
    pattern: /^\/status$/i,
    build: identity,
    helpRank: 15,
    helpKey: 'help.status',
    run: (state) => runStatus(state),
  },
  { id: 'help', pattern: /^\/(?:help|帮助|指令)$/i, build: identity, run: ({ context }) => buildCommandsHelp(context?.t) },
  // 离开模式：一段有截止时间的缺席。命令只负责开启/结束；窗口内的拦截在
  // 入站路径上，否则「不回消息」仍然会花掉每条消息的一次模型调用。
  {
    id: 'away',
    pattern: /^\/away(?:\s+([\s\S]+))?$/i,
    build: (match) => ({ arg: match[1] ?? '' }),
    helpRank: 20,
    helpKey: 'help.away',
  },
  { id: 'back', pattern: /^\/back$/i, build: identity, helpRank: 21, helpKey: 'help.back' },
  // `/remind 10m 内容`：时间与内容之间以第一个空格切分，内容允许为空以便
  // 单独报「缺内容」而非「看不懂命令」。
  {
    id: 'remind',
    pattern: /^\/remind\s+(\S+)(?:\s+([\s\S]+))?$/i,
    build: (match) => ({ when: match[1], text: match[2] ?? '' }),
    helpRank: 16,
    helpKey: 'help.remind',
  },
  { id: 'remindlist', pattern: /^\/remindlist$/i, build: identity, helpRank: 17, helpKey: 'help.remindlist' },
  {
    id: 'remindcancel',
    pattern: /^\/remindcancel\s+(\S+)$/i,
    build: (match) => ({ id: match[1] }),
    helpRank: 18,
    helpKey: 'help.remindcancel',
  },
  // Bare `/subscribe` (and `/订阅`) answers with usage instead of reaching
  // the agent: a bare time command read as a chat message would silently
  // schedule nothing and confuse the sender.
  {
    id: 'subscribe',
    pattern: /^\/(?:subscribe|订阅)\s+((?:每天|每日|daily)\s+\d{1,2}:\d{2}|每周[一二三四五六日天]\s+\d{1,2}:\d{2}|\d{1,2}:\d{2}|\S+)(?:\s+([\s\S]+))?$/i,
    build: (match) => ({ when: match[1], text: match[2] ?? '' }),
    helpRank: 19,
    helpKey: 'help.subscribe',
  },
  {
    id: 'subscribe',
    pattern: /^\/(?:subscribe|订阅)$/i,
    build: () => ({ when: '', text: '' }),
  },
  { id: 'summary', pattern: /^\/(?:summary|总结)$/i, build: identity, helpRank: 11, helpKey: 'help.summary' },
  {
    id: 'export',
    pattern: /^\/(?:export|导出)(?:\s+(\d{1,3}))?$/i,
    build: (match) => ({ days: match[1] === undefined ? undefined : Number(match[1]) }),
    helpRank: 12,
    helpKey: 'help.export',
  },
  { id: 'subscribelist', pattern: /^\/(?:subscribelist|订阅列表)$/i, build: identity, helpRank: 20, helpKey: 'help.subscribelist' },
  {
    id: 'subscribecancel',
    pattern: /^\/(?:subscribecancel|订阅取消)\s+(\S+)$/i,
    build: (match) => ({ id: match[1] }),
    helpRank: 21,
    helpKey: 'help.subscribecancel',
  },
  // Persona + memory commands (personalization round). Parsing stays pure:
  // each one is ANSWERED by a handler the inbound handler provides under
  // context.persona, because the store and the mode table live with the
  // plugin's state root, not in this module.
  { id: 'mode', pattern: /^\/(?:mode|模式)(?:\s+([\S\s]+))?$/i, build: (match) => ({ arg: match[1]?.trim() }), helpRank: 6, helpKey: 'help.mode' },
  { id: 'remember', pattern: /^\/(?:remember|记住)(?:\s+([\S\s]+))?$/i, build: (match) => ({ arg: match[1]?.trim() ?? '' }), helpRank: 7, helpKey: 'help.remember' },
  { id: 'forget', pattern: /^\/(?:forget|忘记)(?:\s+([\S\s]+))?$/i, build: (match) => ({ arg: match[1]?.trim() }), helpRank: 8, helpKey: 'help.forget' },
  { id: 'memory', pattern: /^\/(?:memory|记忆)$/i, build: identity, helpRank: 9, helpKey: 'help.memory' },
  { id: 'recall', pattern: /^\/(?:recall|回忆|翻记录)(?:\s+([\S\s]+))?$/i, build: (match) => ({ arg: match[1]?.trim() ?? '' }), helpRank: 10, helpKey: 'help.recall' },
  { id: 'todo', pattern: /^\/(?:todo|待办)(?:\s+([\S\s]+))?$/i, build: (match) => ({ arg: match[1]?.trim() ?? '' }), helpRank: 11, helpKey: 'help.todo' },
  { id: 'later', pattern: /^\/(?:later|稍后读|稍后)(?:\s+([\S\s]+))?$/i, build: (match) => ({ arg: match[1]?.trim() ?? '' }), helpRank: 12, helpKey: 'help.later' },
]

/** Commands answered by the inbound handler's persona bundle (state root lives there). */
const PERSONA_COMMANDS = new Set(['mode', 'remember', 'forget', 'memory', 'summary', 'export', 'recall', 'away', 'back', 'todo', 'later'])

/**
 * The help text in one locale (C33). Command rules carry a `helpKey` into the
 * catalogue rather than a sentence, so the same list can be spoken in any
 * language we ship; Chinese is the default and what `/help` produced before.
 *
 * @param {(key: string) => string} [t]
 */
export function buildCommandsHelp(t = (key) => translate(key, undefined)) {
  return [
    t('help.header'),
    ...COMMANDS
      .filter((rule) => rule.helpKey !== undefined)
      .sort((left, right) => (left.helpRank ?? 99) - (right.helpRank ?? 99))
      .map((rule) => t(rule.helpKey)),
  ].join('\n')
}

/** Chinese help, for callers that never configure a locale (tests, tooling). */
export const SESSION_COMMANDS_HELP = buildCommandsHelp()

/**
 * Recognise a control command, or return undefined so the caller can treat the
 * text as an ordinary message. Pure: it touches no store and no transport.
 */
export function parseSessionCommand(text) {
  const trimmed = String(text ?? '').trim()
  for (const rule of COMMANDS) {
    const match = rule.pattern.exec(trimmed)
    if (match !== null) return { command: rule.id, ...rule.build(match) }
  }
  return undefined
}

/** Every command id the table knows, for tests and for the card. */
export function commandIds() {
  return [...new Set(COMMANDS.map((rule) => rule.id))]
}

function runStatus({ lines, conversationId, accountId, context }) {
  // Session-line facts are always available (the store owns them); the
  // account-level facts ride in `context` — undefined when a caller without
  // an inbound handler (some tests, some tools) runs a bare command, in
  // which case /status still works but says only what the lines know.
  const statusLines = lines.list(conversationId, accountId)
  const active = lines.active(conversationId, accountId)
  const activeLine = statusLines.find((candidate) => candidate.sessionId === active)
  const parts = []
  if (context?.accountId !== undefined) {
    parts.push(`账号：${context.accountLabel ? `${context.accountLabel}（${context.accountId}）` : context.accountId}`)
    if (typeof context.paused === 'boolean') parts.push(`状态：${context.paused ? '已暂停（不收发消息）' : '正常收发'}`)
    if (context.lastSeenAt) parts.push(`最近收发：${context.lastSeenAt}`)
    if (typeof context.bondLine === 'string' && context.bondLine !== '') parts.push(context.bondLine)
    if (context.allowlist) {
      const source = context.allowlist.source === 'account' ? '本账号专属名单' : '全局名单'
      parts.push(`发信人白名单：${context.allowlist.senders.length} 人（${source}）`)
    }
  }
  parts.push(`本微信会话共 ${statusLines.length} 条会话线，当前使用第 ${statusLines.findIndex((candidate) => candidate.sessionId === active) + 1 || '?'} 条：${activeLine?.title ?? '(尚无对话)'}`)
  return parts.join('\n')
}

/**
 * Execute a control command against a conversation's lines.
 *
 * Returns the reply text, or undefined when the message is not a command, so
 * the caller can continue down the normal agent path. Kept free of transport
 * concerns: the caller sends the returned text.
 *
 * @param {SessionLines} lines
 * @param {string} conversationId
 * @param {string} text
 * @param {string} [accountId] owning bot account; bare key when absent
 * @param {{ accountId?: string, accountLabel?: string | null, paused?: boolean,
 *   lastSeenAt?: string, allowlist?: { source: 'account' | 'global', senders: string[] },
 *   reminders?: import('./message/scheduler.js').ReminderScheduler,
 *   subscription?: import('./message/subscriptions.js').SubscriptionScheduler,
 *   cancelRunningTurn?: () => string,
 *   persona?: Record<string, (arg?: string) => string | Promise<string>> }} [context]
 *   account-level facts for `/status`, assembled by the inbound handler;
 *   optional so the command works for bare callers too. `reminders` is the
 *   live scheduler for remind commands; without it /remind reports that
 *   scheduling is unavailable rather than crashing. `cancelRunningTurn` is the
 *   bridge's abort hook for `/cancel`: only the bridge holds the live agent
 *   handles, so this module asks it to do the interrupting and only relays the
 *   sentence it returns. `persona` bundles the handlers for /mode, /remember,
 *   /forget, /memory, /summary, /export and /recall — the store lives at the
 *   state root, which only the inbound handler knows.
 * @returns {string | Promise<string> | undefined}
 */
export function runSessionCommand(lines, conversationId, text, accountId, context) {
  const command = parseSessionCommand(text)
  if (command === undefined) return undefined

  const rule = COMMANDS.find((candidate) => candidate.id === command.command)
  if (rule?.run !== undefined) return rule.run({ lines, conversationId, accountId, command, context })

  if (command.command === 'new') {
    const sessionId = lines.create(conversationId, accountId)
    const ordinal = lines.list(conversationId, accountId).length
    // Deliberately no title yet: the line is named by its first real message,
    // and stamping a placeholder here would count as "already titled" and keep
    // the user looking at "(无标题)" forever.
    return `已开启第 ${ordinal} 条会话，接下来的消息进入这里。\n（之前那条仍然保留，/list 可以切回去）`
  }
  if (command.command === 'list') {
    return lines.render(conversationId, accountId)
  }
  if (command.command === 'clear') {
    // Deliberately refuses an argument: `/clear 3` would read like `/use 3`
    // with a reset bolted on, and picking one line out of the list to wipe is
    // a rarer need than "start over" — misfiring it destroys context, so the
    // safer surface is the one that cannot be aimed at the wrong line.
    lines.clear(conversationId, accountId)
    return `已清空当前会话，接下来是一条全新的会话。\n之前的上下文不再使用，也没有别的影响。`
  }
  if (command.command === 'cancel') {
    // The bridge owns the live agent handles; a bare caller (tests, tooling)
    // has no turn to interrupt and says so instead of pretending.
    const cancel = context?.cancelRunningTurn
    if (cancel === undefined) return '当前没有可中断的回合（这个入口拿不到正在运行的会话）。'
    return cancel()
  }
  if (PERSONA_COMMANDS.has(command.command)) {
    // All of them are answered by the inbound handler's persona bundle: it knows the
    // state root, the mode table, the memory files and the session bridge (the
    // /summary side session). A bare caller says so instead of pretending it
    // stored something. The handler may be async (/summary) — return the
    // promise as-is; the inbound handler awaits command replies.
    const handler = context?.persona?.[command.command]
    if (typeof handler !== 'function') return '个性化功能在这个入口不可用（拿不到模式与记忆的存储）。'
    return handler(command.arg)
  }
  if (command.command === 'remind') {
    // Scheduling needs the live scheduler; a caller without one (bare tests,
    // tooling) gets an honest refusal rather than a silently dropped remind.
    const scheduler = context?.reminders
    if (scheduler === undefined) return '当前无法安排提醒（调度器不可用）。'
    if (String(command.text ?? '').trim() === '') {
      return '用法：/remind <时间> <内容>，例如 /remind 10m 该喝水了\n时间支持 10m / 2h / 1d30m、14:30、2026-10-19 09:00'
    }
    const when = parseWhen(command.when)
    if (when.ok === false) return `没有安排：${when.reason}`
    const accountIdForRemind = context?.accountId ?? accountId ?? ''
    const planned = scheduler.schedule({ accountId: accountIdForRemind, conversationId, text: command.text, fireAt: when.fireAt })
    if (planned.error !== undefined) return `没有安排：${planned.error}`
    return `好的，${when.label} 我会提醒你（编号 ${planned.id}）。\n用 /remindlist 可以查看，/remindcancel ${planned.id} 取消。`
  }
  if (command.command === 'remindlist') {
    const scheduler = context?.reminders
    if (scheduler === undefined) return '当前无法查看提醒（调度器不可用）。'
    const items = scheduler.list(context?.accountId ?? accountId ?? '')
    if (items.length === 0) return '这个账号现在没有待发的提醒。'
    return ['待发的提醒：', ...items.map((item) => `${item.id} · ${new Date(item.fireAt).toLocaleString()} · ${item.text}`)].join('\n')
  }
  if (command.command === 'remindcancel') {
    const scheduler = context?.reminders
    if (scheduler === undefined) return '当前无法取消提醒（调度器不可用）。'
    const removed = scheduler.cancel(command.id)
    return removed === true ? `已取消提醒 ${command.id}。` : `没有找到编号 ${command.id} 的提醒（/remindlist 可以看现有的）。`
  }
  if (command.command === 'subscribe') {
    const scheduler = context?.subscription
    if (scheduler === undefined) return '当前无法安排定时消息（调度器不可用）。'
    if (String(command.text ?? '').trim() === '') {
      return '用法：/subscribe <时间> <主题>，例如 /subscribe 每天 08:00 早安，问问我睡得怎么样\n时间支持 每天 HH:mm、每周日 HH:mm、裸 HH:mm（等于每天），以及一次性时间（10m、2026-11-01 09:00）'
    }
    const when = parseSubscriptionWhen(command.when)
    if (when.ok === false) return `没有安排：${when.reason}`
    const accountIdForSub = context?.accountId ?? accountId ?? ''
    const planned = scheduler.schedule({ accountId: accountIdForSub, conversationId, when, prompt: command.text })
    if (planned.error !== undefined) return `没有安排：${planned.error}`
    const recurring = planned.kind !== 'once'
    const tail = recurring
      ? `到点我会主动给你发一条（编号 ${planned.id}）。/subscribecancel ${planned.id} 取消。`
      : `到点我会主动给你发一条（编号 ${planned.id}，只发这一次）。/subscribecancel ${planned.id} 取消。`
    return `好的，${describeSubscription(planned)} ${tail}`
  }
  if (command.command === 'subscribelist') {
    const scheduler = context?.subscription
    if (scheduler === undefined) return '当前无法查看定时消息（调度器不可用）。'
    const items = scheduler.list(context?.accountId ?? accountId ?? '')
    if (items.length === 0) return '这个账号现在没有定时主动消息。用 /subscribe 安排一个。'
    return ['定时主动消息：', ...items.map((item) => `${item.id} · ${describeSubscription(item)} · ${item.prompt}`)].join('\n')
  }
  if (command.command === 'subscribecancel') {
    const scheduler = context?.subscription
    if (scheduler === undefined) return '当前无法取消定时消息（调度器不可用）。'
    const removed = scheduler.cancel(command.id)
    return removed === true ? `已取消定时消息 ${command.id}。` : `没有找到编号 ${command.id} 的定时消息（/subscribelist 可以看现有的）。`
  }
  if (command.index === undefined) {
    return `${USE_USAGE}\n\n${lines.render(conversationId, accountId)}`
  }
  const sessionId = lines.use(conversationId, command.index, accountId)
  if (sessionId === undefined) {
    return `没有第 ${command.index} 条会话。\n\n${lines.render(conversationId, accountId)}`
  }
  const line = lines.list(conversationId, accountId).find((candidate) => candidate.sessionId === sessionId)
  const title = line?.title ?? '(尚无对话)'
  return `已切换到第 ${command.index} 条会话：${title}\n接下来的消息进入这里，这条会话之前的上下文还在。`
}
