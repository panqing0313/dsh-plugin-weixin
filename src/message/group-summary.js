/**
 * 群聊上下文摘要。
 *
 * 群里被点到名字回话时，模型看到的只有那一条消息：前面二十条说过什么、
 * 大家在聊哪件事，全都在它的窗口之外。人不是这样参与群聊的。
 *
 * 这个模块在后台把「最近一段群聊」压成几行（一次 `wx-grp-` 会话），下次
 * 被叫到时把那几行折进提示词。三条刻意的取舍：
 *
 * 1. **默认关闭**。它每次都要花一次后台调用，静默花钱不是好默认；`groupSummaryEnabled`
 *    打开后才有动作，设置卡里跟着开关。
 * 2. **环形缓冲只在内存里**。最近 40 条群消息用来生成摘要，不落盘：重启后
 *    等新的消息把缓冲填回来，摘要本身（落盘的）仍然可用。省掉每条群消息一次写盘。
 * 3. **摘要会过期**。默认 3 小时，超过就不注入 —— 三天前聊的事不该出现在今天的
 *    提示词里冒充「上下文」。
 *
 * @module dsh-weixin/message/group-summary
 */

import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'

export const GROUP_SUMMARY_SCHEMA_VERSION = 1
/** 攒够这么多条群消息才做一次摘要。 */
export const DEFAULT_GROUP_SUMMARY_EVERY = 12
/** 摘要的新鲜期（分钟）：过期不注入。 */
export const DEFAULT_GROUP_SUMMARY_TTL_MINUTES = 180
/** 内存里最多留多少条原始消息喂给摘要。 */
export const GROUP_RING_MAX = 40
/** 摘要本身最多留多少字符，防止它挤掉真正的上下文。 */
export const MAX_SUMMARY_CHARS = 600

export function groupSummaryFile(stateRoot) {
  return path.join(stateRoot, 'group-summary.json')
}

/**
 * The prompt for one background summarization. Kept short on purpose: the
 * output lands in a prompt, so a paragraph of instructions is the ceiling.
 */
export function groupSummaryPrompt(lines) {
  return [
    '下面是一个微信群最近的聊天记录（每行「谁：说了什么」）。',
    '请用不超过三句话、中文，概括大家正在聊什么、有哪些待办或约定，以及谁在等谁回复。',
    '只写记录里出现过的信息，不要推测，不要复述每一条。',
    '',
    ...lines,
  ].join('\n')
}

/**
 * A stored summary as a prompt block, or '' when it is stale/absent.
 * @param {{ summary?: string, at?: number } | undefined} entry
 * @param {{ now?: number, ttlMinutes?: number }} [options]
 */
export function buildGroupSummaryBlock(entry, { now = Date.now(), ttlMinutes = DEFAULT_GROUP_SUMMARY_TTL_MINUTES } = {}) {
  const summary = typeof entry?.summary === 'string' ? entry.summary.trim() : ''
  if (summary === '') return ''
  const at = Number(entry?.at)
  if (Number.isFinite(at) && now - at > ttlMinutes * 60_000) return ''
  const minutes = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60_000)) : undefined
  const when = minutes === undefined ? '' : minutes < 1 ? '刚刚' : `${minutes} 分钟前`
  return `<weixin_group_summary${when === '' ? '' : ` at="${when}"`}>\n群里最近聊到：${summary}\n</weixin_group_summary>`
}

function readStore(stateRoot, warn) {
  return readJsonFile(groupSummaryFile(stateRoot), { fallback: () => ({ accounts: {} }), warn })
}

/** Read one conversation's stored summary. */
export function readGroupSummary(stateRoot, accountId, conversationId, { warn } = {}) {
  const store = readStore(stateRoot, warn)
  const entry = store.accounts?.[accountId]?.conversations?.[conversationId]
  return entry === undefined ? undefined : { ...entry }
}

/** Everything stored for one account, for `/diag` or tests. */
export function readAccountGroupSummaries(stateRoot, accountId, { warn } = {}) {
  const store = readStore(stateRoot, warn)
  return { ...(store.accounts?.[accountId]?.conversations ?? {}) }
}

/**
 * Group chit-chat accumulates in memory until there is enough of it to be
 * worth a background call.
 *
 * @param {{ stateRoot: string, warn?: (line: string) => void, now?: () => number }} options
 */
export function createGroupSummaries({ stateRoot, warn, now = () => Date.now() }) {
  /** `${accountId}|${conversationId}` → recent lines, newest last. */
  const rings = new Map()

  const keyOf = (accountId, conversationId) => `${accountId}|${conversationId}`

  /**
   * @returns {{ due: boolean, count: number, lines: string[] }}
   */
  const note = (accountId, conversationId, { sender = '', text = '', at = now() } = {}) => {
    const body = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (body === '') return { due: false, count: 0, lines: [] }
    const key = keyOf(accountId, conversationId)
    const ring = rings.get(key) ?? []
    ring.push(`${String(sender ?? '').slice(0, 24) || '有人'}：${body.slice(0, 160)}`)
    while (ring.length > GROUP_RING_MAX) ring.shift()
    rings.set(key, ring)

    const store = readStore(stateRoot, warn)
    store.accounts ??= {}
    const account = (store.accounts[accountId] ??= { conversations: {} })
    account.conversations ??= {}
    const entry = (account.conversations[conversationId] ??= {})
    entry.sinceSummary = Number.isFinite(entry.sinceSummary) ? entry.sinceSummary + 1 : 1
    entry.lastAt = at
    atomicWriteJson(groupSummaryFile(stateRoot), { schemaVersion: GROUP_SUMMARY_SCHEMA_VERSION, accounts: store.accounts }, { warn })
    return { due: false, count: entry.sinceSummary, lines: ring.slice() }
  }

  /** Would this conversation be worth a background call right now? */
  const due = (accountId, conversationId, every = DEFAULT_GROUP_SUMMARY_EVERY) => {
    const store = readStore(stateRoot, warn)
    const entry = store.accounts?.[accountId]?.conversations?.[conversationId]
    const count = Number.isFinite(entry?.sinceSummary) ? entry.sinceSummary : 0
    return { due: count >= Math.max(1, every), count, lines: (rings.get(keyOf(accountId, conversationId)) ?? []).slice() }
  }

  /** Store what the background call produced and start the next batch. */
  const save = (accountId, conversationId, { summary, covered, at = now() }) => {
    const text = String(summary ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS)
    if (text === '') return undefined
    const store = readStore(stateRoot, warn)
    store.accounts ??= {}
    const account = (store.accounts[accountId] ??= { conversations: {} })
    account.conversations ??= {}
    const entry = (account.conversations[conversationId] ??= {})
    const next = { summary: text, at, covered: Number.isFinite(covered) ? covered : undefined, sinceSummary: 0 }
    account.conversations[conversationId] = next
    atomicWriteJson(groupSummaryFile(stateRoot), { schemaVersion: GROUP_SUMMARY_SCHEMA_VERSION, accounts: store.accounts }, { warn })
    rings.set(keyOf(accountId, conversationId), [])
    return { ...next }
  }

  return { note, due, save }
}