/**
 * 临时静默（`/quiet 2h`）：一段有尽头的「别出声」。
 *
 * 固定免打扰（`quietHoursStart/End`）解决的是「每天这个点都别吵」，但开会、
 * 看电影、开车这种两小时的临时状态只能去设置卡改配置再改回来。这里把
 * 「到某个时刻为止」存成一个账号级状态，让三类定时发送让路：
 *
 *   - 主动开口：静默期间不 tick（不花 token、不发消息）；
 *   - 定时提醒与 /subscribe：到点顺延到静默结束；
 *   - 离开模式的自动回复：不自动回，但仍记下未读。
 *
 * 入站消息的回复**不受影响** —— 人都在打字了，再静默就是装死。
 *
 * @module dsh-weixin/temp-quiet
 */

import fs from 'node:fs'
import path from 'node:path'

import { atomicWriteJson, readJsonFile } from '../atomic.js'

export const QUIET_SCHEMA_VERSION = 1
export const MAX_TEMP_QUIET_MS = 24 * 60 * 60 * 1000
export const MIN_TEMP_QUIET_MS = 60 * 1000

function quietFile(stateRoot) {
  return path.join(stateRoot, 'quiet.json')
}

/**
 * @param {string} stateRoot
 * @param {{ warn?: (line: string) => void }} [options]
 */
function readStore(stateRoot, { warn } = {}) {
  return readJsonFile(quietFile(stateRoot), {
    version: QUIET_SCHEMA_VERSION,
    fallback: () => ({ schemaVersion: QUIET_SCHEMA_VERSION, accounts: {} }),
    warn,
  })
}

/**
 * The active temporary quiet for one account, or undefined.
 *
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ now?: number, warn?: (line: string) => void }} [options]
 * @returns {{ until: number, setAt: number, remainingMs: number } | undefined}
 */
export function readTempQuiet(stateRoot, accountId, { now = Date.now(), warn } = {}) {
  const store = readStore(stateRoot, { warn })
  const entry = store?.accounts?.[accountId]
  if (entry === undefined || typeof entry.until !== 'number' || entry.until <= now) return undefined
  return { until: entry.until, setAt: Number(entry.setAt ?? 0), remainingMs: entry.until - now }
}

/**
 * How long until the temporary quiet ends; 0 when there is none.
 *
 * @param {number} nowMs
 * @param {string} stateRoot
 * @param {string | undefined} accountId
 * @param {{ warn?: (line: string) => void }} [options]
 */
export function tempQuietDelay(nowMs, stateRoot, accountId, { warn } = {}) {
  if (typeof accountId !== 'string' || accountId === '') return 0
  const quiet = readTempQuiet(stateRoot, accountId, { now: nowMs, warn })
  return quiet === undefined ? 0 : quiet.remainingMs
}

/**
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ until: number, now?: number, warn?: (line: string) => void }} options
 */
export function setTempQuiet(stateRoot, accountId, { until, now = Date.now(), warn }) {
  const span = until - now
  if (!Number.isFinite(until) || span < MIN_TEMP_QUIET_MS || span > MAX_TEMP_QUIET_MS) {
    throw new Error(`temporary quiet must last between 1 minute and 24 hours`)
  }
  const store = readStore(stateRoot, { warn })
  store.schemaVersion = QUIET_SCHEMA_VERSION
  store.accounts = { ...(store.accounts ?? {}), [accountId]: { until, setAt: now } }
  atomicWriteJson(quietFile(stateRoot), store, { warn })
  return { until, remainingMs: until - now }
}

/**
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ warn?: (line: string) => void }} [options]
 * @returns {boolean} whether anything was cleared
 */
export function clearTempQuiet(stateRoot, accountId, { warn } = {}) {
  const store = readStore(stateRoot, { warn })
  if (store?.accounts?.[accountId] === undefined) return false
  delete store.accounts[accountId]
  atomicWriteJson(quietFile(stateRoot), store, { warn })
  return true
}

/** A clock label for a moment later today (or tomorrow when it crosses midnight). */
export function quietLabel(until, now = Date.now()) {
  const end = new Date(until)
  const sameDay = new Date(now).toDateString() === end.toDateString()
  const hh = String(end.getHours()).padStart(2, '0')
  const mm = String(end.getMinutes()).padStart(2, '0')
  return sameDay ? `${hh}:${mm}` : `明天 ${hh}:${mm}`
}

/** 人话版状态，给 `/quiet` 与 `/diag` 用。 */
export function describeTempQuiet(quiet, now = Date.now()) {
  if (quiet === undefined) return '当前没有临时静默。'
  const minutes = Math.max(1, Math.round((quiet.until - now) / 60_000))
  return `临时静默到 ${quietLabel(quiet.until, now)}（还剩约 ${minutes} 分钟）：不主动开口、不自动回复、提醒顺延；你发消息仍会回。`
}

/** 仅供测试与诊断：直接看状态文件是否存在。 */
export function tempQuietFile(stateRoot) {
  return quietFile(stateRoot)
}

export function tempQuietExists(stateRoot) {
  return fs.existsSync(quietFile(stateRoot))
}
