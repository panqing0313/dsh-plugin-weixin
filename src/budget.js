/**
 * 后台预算闸门：给「不面向用户的那几次模型调用」设一个每天的上限。
 *
 * 后台调用（记忆折叠、日报、记忆核对、订阅到点、主动开口）每一次都真的花钱，
 * 但它们没有一条用户消息触发，出问题时也不会有人立刻发现 —— 一个循环 bug 或
 * 一个话痨的日报可以在夜里把额度烧光。这里给它们一个**按天**的闸门：默认 0
 * （不限），配了正数就只在当天还没用完时放行；跨天自动归零。
 *
 * 只统计后台调用，不碰主对话：用户主动说话永远不被预算挡住。
 *
 * @module dsh-weixin/budget
 */

import path from 'node:path'

import { atomicWriteJson, readJsonFile } from './atomic.js'

export const BUDGET_SCHEMA_VERSION = 1

/** 本地日期的 YYYY-MM-DD（与 journal 的按天文件同一口径）。 */
export function budgetDay(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function budgetFile(stateRoot) {
  return path.join(stateRoot, 'budget.json')
}

/**
 * 读当天的计数；文件缺失/损坏/跨天都当作「今天还没用过」。
 *
 * @param {string} stateRoot
 * @param {{ now?: Date, warn?: (line: string) => void }} [options]
 * @returns {{ day: string, used: number }}
 */
export function readBudget(stateRoot, { now = new Date(), warn } = {}) {
  const day = budgetDay(now)
  const stored = readJsonFile(budgetFile(stateRoot), {
    fallback: () => ({ schemaVersion: BUDGET_SCHEMA_VERSION, day, used: 0 }),
    warn,
  })
  if (stored?.day !== day || !Number.isFinite(stored?.used)) return { day, used: 0 }
  return { day, used: Math.max(0, Math.floor(stored.used)) }
}

/**
 * 今天还能不能再来一次后台调用。
 *
 * @param {string} stateRoot
 * @param {{ limit: number, now?: Date, warn?: (line: string) => void }} options
 * @returns {{ allowed: boolean, used: number, limit: number, reason?: string }}
 */
export function backgroundBudget(stateRoot, { limit, now = new Date(), warn } = {}) {
  const cap = Number.isFinite(limit) ? Math.floor(limit) : 0
  if (cap <= 0) return { allowed: true, used: readBudget(stateRoot, { now, warn }).used, limit: 0 }
  const { used } = readBudget(stateRoot, { now, warn })
  if (used >= cap) {
    return { allowed: false, used, limit: cap, reason: `background budget ${used}/${cap} used today` }
  }
  return { allowed: true, used, limit: cap }
}

/**
 * 记一次后台调用。只应该在实际发起调用之后记 —— 被闸门挡下的不算。
 *
 * @param {string} stateRoot
 * @param {{ now?: Date, warn?: (line: string) => void }} [options]
 * @returns {{ day: string, used: number }}
 */
export function recordBackgroundCall(stateRoot, { now = new Date(), warn } = {}) {
  const { day, used } = readBudget(stateRoot, { now, warn })
  const next = { schemaVersion: BUDGET_SCHEMA_VERSION, day, used: used + 1 }
  atomicWriteJson(budgetFile(stateRoot), next, { warn })
  return next
}
