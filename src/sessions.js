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
import path from 'node:path'

import { stateDir } from './state.js'
import { labelForAccount } from './account-registry.js'

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
    if (line === undefined) return
    // Only the first message names a line: re-titling on every message would
    // make `/list` show whatever was said most recently.
    if (typeof line.title === 'string' && line.title !== '') return
    const now = new Date().toISOString()
    if (line.createdAt === undefined) line.createdAt = now
    line.lastUsedAt = now
    line.title = titledWithAccount(text, accountId)
    this.#set(key, { lines, active: existing?.active ?? sessionId })
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
 */
export function parseSessionCommand(text) {
  const trimmed = String(text ?? '').trim()
  const newMatch = /^\/new$/i.exec(trimmed)
  if (newMatch !== null) return { command: 'new' }
  const listMatch = /^\/(?:list|sessions)$/i.exec(trimmed)
  if (listMatch !== null) return { command: 'list' }
  const useMatch = /^\/use(?:\s+(\d+))?$/i.exec(trimmed)
  if (useMatch !== null) {
    return { command: 'use', index: useMatch[1] === undefined ? undefined : Number(useMatch[1]) }
  }
  const clearMatch = /^\/clear$/i.exec(trimmed)
  if (clearMatch !== null) return { command: 'clear' }
  return undefined
}

/** Help text for a malformed `/use`. */
export const USE_USAGE = '用法：/use <序号>，序号来自 /list'

/** Help text shown for a bare `/use` with no argument. */
export const SESSION_COMMANDS_HELP = [
  '会话指令：',
  '/new 开一条新会话（当前这条会保留，之后可以切回来）',
  '/list 查看这个微信会话下的所有会话',
  '/use <序号> 切换到第几条',
  '/clear 清空当前会话并重新开始（当前这条从列表里移除，不再占地方）',
].join('\n')

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
 * @returns {string | undefined}
 */
export function runSessionCommand(lines, conversationId, text, accountId) {
  const command = parseSessionCommand(text)
  if (command === undefined) return undefined
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
