/**
 * 群成员名片的自动补全。
 *
 * 名片（`contacts.js`）只有一条来源：群消息里被 @ 到、模型顺手把话记下来。
 * 结果是「天天聊天的人，名片还是三个月前写的」—— 到点会注明「可能已过时」，
 * 但那只是提醒，事实还是旧的。
 *
 * 这个模块做的是另一半：把这个人**最近说过的话**交给后台模型，让它只从话里
 * 读出一张新名片（称呼、作息、喜欢什么、忌讳什么、重要日期），再写回去。
 *
 * 三条自律：
 *   1. 只给「已经过时」且「最近确实说过话」的人补 —— 不凭空猜；
 *   2. 只写能从话里看出来的字段，读不出来就留空，宁可空着也别编；
 *   3. 走后台预算（`backgroundDailyLimit`）与每天最多 `max` 张的上限。
 *
 * @module dsh-weixin/message/contact-refresh
 */

import path from 'node:path'

import { CONTACT_STALE_DAYS, isContactStale, listContacts, saveContact } from './contacts.js'
import { sanitizeProfile } from '../memory.js'
import { atomicWriteJson, readJsonFile } from '../atomic.js'

/** 往回看多久的话。 */
export const CONTACT_REFRESH_DAYS = 14
/** 少于这么多句话就不值得开一次模型。 */
export const CONTACT_REFRESH_MIN_LINES = 3
/** 一次最多补几张名片。 */
export const DEFAULT_CONTACT_REFRESH_MAX = 2
/** 每天最多跑几次。 */
export const CONTACT_REFRESH_EVERY_MS = 20 * 60 * 60 * 1000
/** 每句话截多长。 */
export const CONTACT_LINE_CHARS = 80
/** 最多带几句话给模型。 */
export const MAX_CONTACT_LINES = 12

/**
 * 某个人最近说过的话（只取入站、只看最近 `days` 天，尾部对齐 = 最近的靠后）。
 */
export function recentLinesForSender(entries = [], senderId, { days = CONTACT_REFRESH_DAYS, now = Date.now(), limit = MAX_CONTACT_LINES } = {}) {
  const since = now - days * 24 * 60 * 60 * 1000
  const wanted = String(senderId ?? '')
  const lines = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.dir !== 'in') continue
    if (String(entry.senderId ?? '') !== wanted) continue
    if (!Number.isFinite(entry.at) || entry.at < since) continue
    const text = String(entry.text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, CONTACT_LINE_CHARS)
    if (text !== '') lines.push(text)
  }
  return lines.slice(-limit)
}

/**
 * 挑出这次要补的名片：过时 + 最近说过话，按 `listContacts` 的顺序取前 `max` 个。
 *
 * @returns {Array<{ contact: object, lines: string[] }>}
 */
export function pickRefreshCandidates(stateRoot, accountId, entries, { now = Date.now(), staleDays = CONTACT_STALE_DAYS, max = DEFAULT_CONTACT_REFRESH_MAX, warn } = {}) {
  const out = []
  for (const contact of listContacts(stateRoot, accountId, { warn })) {
    if (out.length >= max) break
    if (!isContactStale(contact, { now, staleDays })) continue
    const lines = recentLinesForSender(entries, contact.contactId, { now })
    if (lines.length < CONTACT_REFRESH_MIN_LINES) continue
    out.push({ contact, lines })
  }
  return out
}

/**
 * 交给后台模型的提示词：只读话里有的，读不出来就空着。
 */
export function buildContactRefreshPrompt({ contact, lines, staleDays = CONTACT_STALE_DAYS, now = Date.now() } = {}) {
  const profile = contact?.profile ?? {}
  const age = Math.max(0, Math.round((now - Number(contact?.profileUpdatedAt ?? contact?.lastSeenAt ?? now)) / (24 * 60 * 60 * 1000)))
  const known = [
    profile.call ? `称呼：${profile.call}` : '',
    profile.schedule ? `作息：${profile.schedule}` : '',
    Array.isArray(profile.likes) && profile.likes.length > 0 ? `喜欢：${profile.likes.join('、')}` : '',
    Array.isArray(profile.dislikes) && profile.dislikes.length > 0 ? `忌讳：${profile.dislikes.join('、')}` : '',
  ].filter((line) => line !== '')
  const said = (lines ?? []).map((line) => `- ${line}`).join('\n')
  return [
    '你在维护一份群成员的「名片」。下面只有这个人在群里最近说过的话，没有别的材料。',
    '',
    `名片现在是这样（${age} 天没更新过）：`,
    known.length > 0 ? known.join('\n') : '（基本是空的）',
    '',
    '他最近说过：',
    said,
    '',
    '请只根据上面这些话，输出一张更新后的名片，JSON 一行：',
    '{"call":"怎么称呼他（没看出来就空字符串）","schedule":"作息（没看出来就空字符串）","likes":["喜欢/常做的事"],"dislikes":["明确不喜欢或忌讳的"],"dates":[{"label":"日子名","date":"YYYY-MM-DD"}]}',
    '规则：看不出来的字段留空或空数组；不要编造没出现在话里的信息；不要写推测的语气词；只输出 JSON。',
  ].join('\n')
}

/**
 * 把模型的回复读成一张名片。读不出来返回 `undefined`。
 *
 * 容忍三种常见形态：裸 JSON、```json 围栏、句子中间夹一段 JSON。
 */
export function parseContactRefresh(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return undefined
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const candidates = [fenced?.[1], raw]
  const inline = /\{[\s\S]*\}/.exec(raw)
  if (inline !== null) candidates.push(inline[0])
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    try {
      const value = JSON.parse(candidate.trim())
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const profile = sanitizeProfile(value)
      const empty = profile.call === '' && profile.schedule === '' && profile.likes.length === 0 && profile.dislikes.length === 0 && profile.dates.length === 0
      return empty ? undefined : profile
    } catch {
      // 试下一种形态。
    }
  }
  return undefined
}

/**
 * 写回名片。`saveContact` 会顺手把 `profileUpdatedAt` 推到现在，于是它就不再「过时」了。
 */
export function applyContactRefresh(stateRoot, accountId, contactId, profile, { now = Date.now(), warn } = {}) {
  const saved = saveContact(stateRoot, accountId, contactId, { profile }, { now, warn })
  return saved?.ok === true ? { ok: true, contact: saved.contact } : { ok: false, reason: saved?.reason ?? 'write-failed' }
}

function refreshFile(stateRoot) {
  return path.join(stateRoot, 'contact-refresh.json')
}

/**
 * 距上次跑满 `everyMs` 了没有。没有记录就是「该跑了」。
 */
export function contactRefreshDue(stateRoot, accountId, { now = Date.now(), everyMs = CONTACT_REFRESH_EVERY_MS, warn } = {}) {
  const store = readJsonFile(refreshFile(stateRoot), { fallback: () => ({ accounts: {} }), warn })
  const last = Number(store?.accounts?.[String(accountId)]?.lastRunAt ?? 0)
  return !Number.isFinite(last) || now - last >= everyMs
}

/** 记下这次跑过的时间（失败也记，否则坏掉的账号会每个 tick 重试一次）。 */
export function markContactRefreshRun(stateRoot, accountId, { now = Date.now(), warn } = {}) {
  const store = readJsonFile(refreshFile(stateRoot), { fallback: () => ({ accounts: {} }), warn })
  const accounts = { ...(store?.accounts ?? {}) }
  accounts[String(accountId)] = { lastRunAt: now }
  return atomicWriteJson(refreshFile(stateRoot), { schemaVersion: 1, accounts }, { warn })
}
