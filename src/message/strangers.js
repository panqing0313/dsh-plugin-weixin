/**
 * 陌生人留痕：谁被 allowlist 拒过、说了什么，给设置卡一块「一键加白」的面板。
 *
 * 拒收本身是静默的（这正是 allowlist deny-by-default 的意义），但静默有两种：
 * 一种是真的没人找你，另一种是同事换了微信号、朋友重新扫码后 id 变了 ——
 * 只看文件日志的话，第二种和第一种看起来一模一样。这个模块把第二种捞出来：
 * 每次拒绝都记一条「谁、哪个会话、最后一次说了什么（截断）」，按账号分开存，
 * 最多 50 人，最旧的先淘汰。设置卡读这份名单，一键把人加进 `allowedSenders`
 * 并把记录清掉 —— 配置是每条消息实时读的，所以下一条消息就生效。
 *
 * 状态是 `strangers.json`，`{schemaVersion, accounts:{[accountId]:{senders:{
 * [senderId]:{firstAt,lastAt,count,conversationId,lastText}}}}}`，原子写。
 *
 * @module dsh-weixin/message/strangers
 */

import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'

export const STRANGERS_SCHEMA_VERSION = 1
/** 名单里最多留多少人：超过就淘汰最近没动静的。 */
export const MAX_STRANGERS = 50
/** 留痕的最后一句话截断到这个长度 —— 面板只需要「是谁想说什么」。 */
export const MAX_STRANGER_TEXT_CHARS = 120

function fileOf(stateRoot) {
  return path.join(stateRoot, 'strangers.json')
}

function readStore(stateRoot, warn) {
  return readJsonFile(fileOf(stateRoot), {
    fallback: () => ({ accounts: {} }),
    warn,
  })
}

function listFrom(bucket) {
  const senders = bucket?.senders
  if (senders === null || typeof senders !== 'object') return []
  return Object.entries(senders)
    .map(([senderId, entry]) => ({ senderId, ...entry }))
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
}

/**
 * @param {string} stateRoot
 * @param {string} accountId
 * @returns {Array<{senderId: string, conversationId: string, firstAt: number, lastAt: number, count: number, lastText: string}>}
 */
export function readStrangers(stateRoot, accountId, { warn } = {}) {
  const bucket = readStore(stateRoot, warn).accounts?.[accountId]
  return listFrom(bucket)
}

/**
 * 记一次拒绝。同一发送者反复被拒只更新计数与时间，不新增条目。
 * @returns {Array} 更新后的名单（最新在前）。
 */
export function recordStranger(stateRoot, accountId, { senderId, conversationId = '', text = '', at = Date.now(), warn } = {}) {
  const who = String(senderId ?? '').trim()
  if (who === '') return readStrangers(stateRoot, accountId, { warn })

  const store = readStore(stateRoot, warn)
  store.accounts ??= {}
  const bucket = (store.accounts[accountId] ??= {})
  bucket.senders ??= {}

  const previous = bucket.senders[who]
  const clipped = String(text ?? '').slice(0, MAX_STRANGER_TEXT_CHARS)
  bucket.senders[who] = {
    firstAt: previous?.firstAt ?? at,
    lastAt: at,
    count: (Number.isFinite(previous?.count) ? previous.count : 0) + 1,
    conversationId: String(conversationId ?? previous?.conversationId ?? ''),
    lastText: clipped,
  }

  // 上限淘汰：名单只回答「最近谁想进来」，最久没动静的先走。
  const kept = listFrom(bucket).slice(0, MAX_STRANGERS)
  bucket.senders = Object.fromEntries(kept.map((entry) => [entry.senderId, (() => {
    const { senderId: _drop, ...rest } = entry
    return rest
  })()]))

  atomicWriteJson(fileOf(stateRoot), { schemaVersion: STRANGERS_SCHEMA_VERSION, accounts: store.accounts }, { warn })
  return listFrom(bucket)
}

/**
 * 把一个人从所有账号的名单里拿掉（加白之后调用 —— 名单只该剩还进不来的人）。
 * 加白是全局动作（`allowedSenders` 在配置层），而留痕按账号分文件存，所以
 * 清理要跨账号。@returns {number} 一共删掉的条数。
 */
export function clearStrangerEverywhere(stateRoot, senderId, { warn } = {}) {
  const who = String(senderId ?? '').trim()
  if (who === '') return 0
  const store = readStore(stateRoot, warn)
  const accounts = store.accounts ?? {}
  let removed = 0
  for (const bucket of Object.values(accounts)) {
    if (bucket?.senders === null || typeof bucket?.senders !== 'object') continue
    if (who in bucket.senders) {
      delete bucket.senders[who]
      removed += 1
    }
  }
  if (removed > 0) {
    atomicWriteJson(fileOf(stateRoot), { schemaVersion: STRANGERS_SCHEMA_VERSION, accounts }, { warn })
  }
  return removed
}

/**
 * 把一个人从名单里拿掉（加白之后调用 —— 名单只该剩还进不来的人）。
 * @returns {boolean} 是否真的删掉了。
 */
export function clearStranger(stateRoot, accountId, senderId, { warn } = {}) {
  const who = String(senderId ?? '').trim()
  if (who === '') return false
  const store = readStore(stateRoot, warn)
  const bucket = store.accounts?.[accountId]
  if (bucket?.senders === null || typeof bucket?.senders !== 'object' || !(who in bucket.senders)) return false
  delete bucket.senders[who]
  atomicWriteJson(fileOf(stateRoot), { schemaVersion: STRANGERS_SCHEMA_VERSION, accounts: store.accounts }, { warn })
  return true
}