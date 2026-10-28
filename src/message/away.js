/**
 * 离开模式：把「我现在不在」说清楚，而不是让模型猜。
 *
 * 没有这个模式时，离开的人只有两个选择：让机器人对每条消息都答一遍（贵，
 * 而且它并不知道你不在），或者干脆关掉账号（回来还要重连）。这里把缺席
 * 记录成一段有截止时间的状态：
 *
 *  - 窗口内到达的消息在入站路径上就被拦下，不进 agent —— 二十句「在吗」
 *    不花一个 token；
 *  - 每个会话每 30 分钟回一句「我不在，大概几点回来」，不让对方以为被无视；
 *  - 记下谁说了什么（最多 30 条），`/back` 或到点时用一条汇总交代清楚。
 *
 * 状态是 `away.json` 里按账号分的一份记录，原子写；截止时间由调用方的
 * 分钟级定时器检查，而不是靠文件本身。
 *
 * @module dsh-weixin/message/away
 */

import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'

export const AWAY_SCHEMA_VERSION = 1
/** 记多少条就够交代了；再多的「在吗」也只是重复。 */
export const MAX_MISSED = 30
/** 同一个会话每半小时最多自动回一句，避免变成复读机。 */
export const AWAY_REPLY_EVERY_MS = 30 * 60_000
export const DEFAULT_AWAY_REPLY = '我现在不在，看到会回你～'

/** @param {string} stateRoot */
function fileOf(stateRoot) {
  return path.join(stateRoot, 'away.json')
}

function readStore(stateRoot, warn) {
  return readJsonFile(fileOf(stateRoot), {
    version: AWAY_SCHEMA_VERSION,
    fallback: () => ({ accounts: {} }),
    warn,
  })
}

/**
 * The away record for one account, or undefined. `active` is computed against
 * `now` so a caller never has to compare timestamps itself.
 *
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ now?: number, warn?: (message: string) => void }} [options]
 */
export function readAway(stateRoot, accountId, { now = Date.now(), warn = () => {} } = {}) {
  const away = readStore(stateRoot, warn).accounts?.[accountId]
  if (away === undefined) return undefined
  return { ...away, active: away.until > now }
}

/**
 * Open (or extend) an away window. Extending keeps whatever was missed.
 *
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ until: number, note?: string, now?: number, warn?: (message: string) => void }} input
 */
export function startAway(stateRoot, accountId, { until, note = '', now = Date.now(), warn = () => {} }) {
  const store = readStore(stateRoot, warn)
  const previous = store.accounts?.[accountId]
  const next = {
    startedAt: previous?.startedAt ?? now,
    until,
    note: String(note ?? '').slice(0, 200),
    missed: Array.isArray(previous?.missed) ? previous.missed : [],
    replied: previous?.replied ?? {},
  }
  const accounts = { ...store.accounts, [accountId]: next }
  atomicWriteJson(fileOf(stateRoot), { ...store, accounts, schemaVersion: AWAY_SCHEMA_VERSION }, { warn })
  return next
}

/**
 * Close the window and return what it held (undefined when it was not open).
 *
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ warn?: (message: string) => void }} [options]
 */
export function clearAway(stateRoot, accountId, { warn = () => {} } = {}) {
  const store = readStore(stateRoot, warn)
  const removed = store.accounts?.[accountId]
  if (removed === undefined) return undefined
  const accounts = { ...store.accounts }
  delete accounts[accountId]
  atomicWriteJson(fileOf(stateRoot), { ...store, accounts, schemaVersion: AWAY_SCHEMA_VERSION }, { warn })
  return removed
}

/**
 * Record an inbound message that arrived while away. Returns whether this
 * conversation has earned an auto-reply yet (once per 30 minutes).
 *
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ senderId?: string, conversationId: string, text?: string, at?: number, warn?: (message: string) => void }} input
 * @returns {{ away: any | undefined, shouldReply: boolean, count: number }}
 */
export function noteMissed(stateRoot, accountId, { senderId = '', conversationId, text = '', at = Date.now(), warn = () => {} }) {
  const away = readAway(stateRoot, accountId, { now: at, warn })
  if (away === undefined || !away.active) return { away, shouldReply: false, count: away?.missed?.length ?? 0 }
  const missed = [...away.missed, { senderId, conversationId, text: String(text ?? '').slice(0, 200), at }].slice(-MAX_MISSED)
  const lastReply = away.replied?.[conversationId]
  const shouldReply = lastReply === undefined || at - lastReply >= AWAY_REPLY_EVERY_MS
  const replied = shouldReply ? { ...away.replied, [conversationId]: at } : away.replied
  const next = { ...away, missed, replied }
  delete next.active
  const store = readStore(stateRoot, warn)
  const accounts = { ...store.accounts, [accountId]: next }
  atomicWriteJson(fileOf(stateRoot), { ...store, accounts, schemaVersion: AWAY_SCHEMA_VERSION }, { warn })
  return { away: { ...next, active: true }, shouldReply, count: missed.length }
}

/**
 * The auto-reply for one conversation. A custom reply is used verbatim; the
 * default carries the return time, which is the only part the sender needs.
 *
 * @param {{ until: number }} away
 * @param {{ reply?: string }} [options]
 */
export function buildAwayReply(away, { reply = '' } = {}) {
  const custom = String(reply ?? '').trim()
  if (custom !== '') return custom
  const at = new Date(away.until)
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return `${DEFAULT_AWAY_REPLY}（大概 ${time} 回来）`
}

/**
 * One message that accounts for the window: how many, from how many people,
 * and the last few lines. No model, so it costs nothing to produce.
 *
 * @param {{ startedAt: number, missed: Array<{ conversationId: string, text: string, at: number }> } | undefined} away
 */
export function awaySummary(away) {
  if (away === undefined) return ''
  const missed = Array.isArray(away.missed) ? away.missed : []
  const since = new Date(away.startedAt)
  const sinceLabel = `${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}`
  if (missed.length === 0) return `欢迎回来。你不在的这段时间（从 ${sinceLabel} 起）没有新消息。`
  const people = new Set(missed.map((item) => item.conversationId))
  const lines = missed.slice(-8).map((item) => `· ${item.text === '' ? '（非文字消息）' : item.text}`)
  const more = missed.length > 8 ? `\n…还有 ${missed.length - 8} 条` : ''
  return `欢迎回来。你不在的这段时间（从 ${sinceLabel} 起）有 ${missed.length} 条消息、${people.size} 个人找你：\n${lines.join('\n')}${more}`
}

/**
 * The `/away` and `/back` handlers, bound to one account. Kept out of the
 * inbound handler so tests can drive them without a transport.
 *
 * @param {{ stateRoot: string, accountId: string, warn?: (message: string) => void, now?: () => number, parseWhen: (spec: string) => { ok: true, fireAt: number, label: string } | { ok: false, reason: string } }} input
 */
export function createAwayCommands({ stateRoot, accountId, warn = () => {}, now = Date.now, parseWhen }) {
  const away = (arg) => {
    const raw = String(arg ?? '').trim()
    if (raw === '') {
      const current = readAway(stateRoot, accountId, { now: now(), warn })
      if (current === undefined || !current.active) return '现在没在离开模式。用法：/away 2h 开会'
      const minutes = Math.max(1, Math.round((current.until - now()) / 60_000))
      const note = current.note === '' ? '' : `（${current.note}）`
      return `离开模式中：还有约 ${minutes} 分钟${note}，已记下 ${current.missed.length} 条消息。发 /back 提前结束并看汇总。`
    }
    const [when, ...rest] = raw.split(/\s+/)
    const note = rest.join(' ')
    const parsed = parseWhen(when)
    if (parsed.ok === false) return `没有开启：${parsed.reason}`
    startAway(stateRoot, accountId, { until: parsed.fireAt, note, now: now(), warn })
    return `好，${parsed.label} 前我不回消息${note === '' ? '' : `（${note}）`}，有人找我先记下来。急事发 /back。`
  }
  const back = () => {
    const current = readAway(stateRoot, accountId, { now: now(), warn })
    if (current === undefined) return '现在没在离开模式。'
    const removed = clearAway(stateRoot, accountId, { warn })
    return awaySummary(removed ?? current)
  }
  return { away, back }
}
