/**
 * 群内每人每日配额。
 *
 * 已有两层限制都不够贴群：
 *   - `senderRatePerMinute` 是**每分钟**的，挡不住一个人一天发 300 条；
 *   - `backgroundDailyLimit` 是**整个账号**的后台预算，一个人把额度用完，
 *     别人的日报与记忆折叠也一起停了。
 *
 * 这个模块管的是第三种：每个发送者在**每个账号、每一天**内最多被回复几次。
 * 拒绝时按窗口只回一次话（沉默看起来像坏了），写审计，并在群里@到的是别人
 * 时也一样生效 —— 配额是「这个人今天已经占用了多少次」，不是「这条消息有没
 * 有被点名」。
 *
 * 状态是 `sender-daily.json`，按账号分、按本地日期滚；跨天自动归零。
 * 上限为 0 表示不限。
 *
 * @module dsh-weixin/message/sender-daily
 */

import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'

export const SENDER_DAILY_SCHEMA_VERSION = 1
/** 被拒绝后的静默时间：这之内不再重复回「今天聊得够多啦」。 */
export const DAILY_WARN_COOLDOWN_MS = 5 * 60_000

function fileOf(stateRoot) {
  return path.join(stateRoot, 'sender-daily.json')
}

/** 本地日期；跨天即归零。 */
export function dailyKey(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function readStore(stateRoot, warn) {
  return readJsonFile(fileOf(stateRoot), {
    fallback: () => ({ accounts: {} }),
    warn,
  })
}

/**
 * @param {{ stateRoot: string, limit: number, now?: () => number, warn?: (line: string) => void }} options
 */
export function createSenderDailyLimiter({ stateRoot, limit, now = () => Date.now(), warn }) {
  const cap = Number.isFinite(limit) ? Math.floor(limit) : 0
  /** sender key → 最后一次拒绝提示的时间（内存足够：重启后最多再提示一次）。 */
  const warned = new Map()

  /**
   * @param {string} accountId
   * @param {string} senderId
   * @returns {{ allowed: boolean, shouldWarn: boolean, used: number, limit: number, day: string }}
   */
  const check = (accountId, senderId) => {
    const day = dailyKey(new Date(now()))
    if (cap <= 0) return { allowed: true, shouldWarn: false, used: 0, limit: 0, day }

    const store = readStore(stateRoot, warn)
    store.accounts ??= {}
    const bucket = (store.accounts[accountId] ??= {})
    if (bucket.day !== day) {
      bucket.day = day
      bucket.senders = {}
    }
    bucket.senders ??= {}
    const key = String(senderId ?? '')
    const used = Number.isFinite(bucket.senders[key]) ? bucket.senders[key] : 0

    if (used >= cap) {
      const at = now()
      const last = warned.get(`${accountId}|${key}`) ?? 0
      const shouldWarn = at - last >= DAILY_WARN_COOLDOWN_MS
      if (shouldWarn) warned.set(`${accountId}|${key}`, at)
      return { allowed: false, shouldWarn, used, limit: cap, day }
    }

    bucket.senders[key] = used + 1
    atomicWriteJson(fileOf(stateRoot), { schemaVersion: SENDER_DAILY_SCHEMA_VERSION, accounts: store.accounts }, { warn })
    return { allowed: true, shouldWarn: false, used: used + 1, limit: cap, day }
  }

  /** Today's count for one sender, without counting another use. */
  const used = (accountId, senderId) => {
    const day = dailyKey(new Date(now()))
    const store = readStore(stateRoot, warn)
    const bucket = store.accounts?.[accountId]
    if (bucket?.day !== day) return 0
    const value = bucket?.senders?.[String(senderId ?? '')]
    return Number.isFinite(value) ? value : 0
  }

  return { check, used, limit: cap }
}