/**
 * 重要日子的当天提醒：生日、纪念日、以及写死日期的待办。
 *
 * 记忆里早就有 `profile.dates`（label + YYYY-MM-DD）和 `events`（可带 when），
 * 但过去它们只在提示词里「被看到」——模型得自己意识到「今天是 10 月 28 日」。
 * 这个模块把「今天」这件事算出来：每天到点检查一次，命中就发一条很短的提醒，
 * 不跑模型、不花 token。
 *
 * 状态是 `dates.json` 里按账号记的 `lastSent`，原子写；是否到点由调用方的
 * 分钟级定时器判断（和 away 一样，不依赖文件 mtime）。
 *
 * @module dsh-weixin/message/dates
 */

import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'

export const DATES_SCHEMA_VERSION = 1
export const DEFAULT_DATE_REMINDER_WHEN = '09:00'

function fileOf(stateRoot) {
  return path.join(stateRoot, 'dates.json')
}

function storeOf(stateRoot, warn) {
  const store = readJsonFile(fileOf(stateRoot), {
    version: DATES_SCHEMA_VERSION,
    fallback: () => ({ schemaVersion: DATES_SCHEMA_VERSION, accounts: {} }),
    warn,
  })
  const accounts = store?.accounts !== null && typeof store?.accounts === 'object' ? store.accounts : {}
  return { schemaVersion: DATES_SCHEMA_VERSION, accounts }
}

/** `HH:MM` → 当天分钟数；非法返回 undefined。 */
export function clockMinutes(spec) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(spec ?? '').trim())
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

function dayOf(now) {
  const date = now instanceof Date ? now : new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return { key: `${date.getFullYear()}-${month}-${day}`, month, day, year: date.getFullYear() }
}

/**
 * 今天命中的日期与待办。
 *
 * @param {{ profile?: { dates?: Array<{ label: string, date: string }> }, events?: Array<{ text: string, when?: string, done?: boolean }> }} memory
 * @param {Date|number} [now]
 * @returns {Array<{ kind: 'date'|'event', label?: string, text?: string, years?: number }>}
 */
export function datesOnThisDay(memory, now = new Date()) {
  const today = dayOf(now)
  const out = []
  for (const entry of Array.isArray(memory?.profile?.dates) ? memory.profile.dates : []) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(entry?.date ?? ''))
    if (match === null) continue
    if (match[2] !== today.month || match[3] !== today.day) continue
    const years = today.year - Number(match[1])
    out.push({ kind: 'date', label: entry.label, years: years > 0 ? years : 0 })
  }
  for (const event of Array.isArray(memory?.events) ? memory.events : []) {
    if (event?.done === true) continue
    if (String(event?.when ?? '') !== today.key) continue
    out.push({ kind: 'event', text: event.text })
  }
  return out
}

/**
 * 一条短提醒。不带任何「我注意到」的解释，也不调用模型。
 *
 * @param {ReturnType<typeof datesOnThisDay>} items
 * @returns {string}
 */
export function buildDateReminderText(items) {
  const lines = ['📅 今天是重要日子']
  for (const item of items) {
    if (item.kind === 'date') {
      lines.push(item.years > 0 ? `- ${item.label}（第 ${item.years} 年）` : `- ${item.label}`)
    } else {
      lines.push(`- ${item.text}`)
    }
  }
  return lines.join('\n')
}

/**
 * 今天该不该发：开关打开、到点、今天还没发过。
 *
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ now?: Date|number, at?: string, enabled?: boolean, warn?: (line: string) => void }} [options]
 * @returns {boolean}
 */
export function dateReminderDue(stateRoot, accountId, { now = Date.now(), at = DEFAULT_DATE_REMINDER_WHEN, enabled = true, warn } = {}) {
  if (enabled === false) return false
  const target = clockMinutes(at)
  if (target === undefined) return false
  const date = now instanceof Date ? now : new Date(now)
  if (date.getHours() * 60 + date.getMinutes() < target) return false
  const store = storeOf(stateRoot, warn)
  return store.accounts[accountId]?.lastSent !== dayOf(date).key
}

/** 记下今天已经提醒过，避免同一天重复。 */
export function markDateReminderSent(stateRoot, accountId, { now = Date.now(), warn } = {}) {
  const store = storeOf(stateRoot, warn)
  const accounts = { ...store.accounts, [accountId]: { ...(store.accounts[accountId] ?? {}), lastSent: dayOf(now).key } }
  atomicWriteJson(fileOf(stateRoot), { ...store, accounts }, { warn })
  return { lastSent: accounts[accountId].lastSent }
}
