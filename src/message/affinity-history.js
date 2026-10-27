/**
 * A day-by-day record of a relationship, so "how are we doing" is a line and not
 * a guess.
 *
 * `bond` already counts messages and remembers the first day, but it only ever
 * holds the present. A sparkline needs history, and history needs one row per day
 * written in one place — the turn that already bumped the bond.
 *
 * Deliberately tiny: one row per local day, updated in place, ninety days kept.
 * The energy column is the life-state energy at the last turn of the day, not an
 * average: an average of a body that recovers while asleep describes nothing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'

export const AFFINITY_KEEP_DAYS = 90
export const AFFINITY_SCHEMA_VERSION = 1
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** Local calendar day, matching what the rest of the plugin calls a day. */
export function dayString(now = Date.now()) {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function safeName(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9@._-]/g, '_').slice(0, 120) || 'unknown'
}

export function affinityFilePath(stateRoot, accountId, conversationId) {
  return path.join(stateRoot, 'memory', `affinity-${safeName(accountId)}-${safeName(conversationId)}.json`)
}

/** @returns {{schemaVersion: number, days: Array<{day: string, msgs: number, energy: number, mood: string}>}} */
export function readAffinityHistory(stateRoot, accountId, conversationId, { warn } = {}) {
  const file = affinityFilePath(stateRoot, accountId, conversationId)
  const parsed = readJsonFile(file, {
    version: AFFINITY_SCHEMA_VERSION,
    fallback: () => ({ schemaVersion: AFFINITY_SCHEMA_VERSION, days: [] }),
    warn,
  })
  const days = Array.isArray(parsed.days) ? parsed.days.filter((entry) => typeof entry?.day === 'string') : []
  return { ...parsed, days }
}

/**
 * Record today. Called at every settled turn, so it must be cheap and idempotent:
 * the day's row is replaced, never appended twice.
 */
export function recordAffinitySnapshot(stateRoot, accountId, conversationId, { now = Date.now(), bond, life, warn } = {}) {
  const history = readAffinityHistory(stateRoot, accountId, conversationId, { warn })
  const day = dayString(now)
  const row = {
    day,
    msgs: Number(bond?.msgs ?? 0),
    energy: Number.isFinite(Number(life?.energy)) ? Math.round(Number(life.energy)) : 0,
    mood: typeof life?.mood === 'string' ? life.mood.slice(0, 40) : '',
  }
  const days = history.days.filter((entry) => entry.day !== day)
  days.push(row)
  days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const kept = days.slice(-AFFINITY_KEEP_DAYS)
  const file = affinityFilePath(stateRoot, accountId, conversationId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  atomicWriteJson(file, { schemaVersion: AFFINITY_SCHEMA_VERSION, days: kept }, { warn })
  return kept
}

/**
 * A sparkline of a numeric column.
 *
 * Scaling is min→max across the window, because the absolute numbers say nothing
 * on their own (a new relationship's energy of 60 and an old one's 90 are the same
 * picture). A flat series is drawn flat, not as full blocks.
 */
export function sparkline(values, { width = 30 } = {}) {
  const numbers = (values ?? []).map((value) => Number(value)).filter((value) => Number.isFinite(value))
  if (numbers.length === 0) return ''
  const window = numbers.slice(-width)
  const min = Math.min(...window)
  const max = Math.max(...window)
  if (max === min) return BLOCKS[3].repeat(window.length)
  return window
    .map((value) => BLOCKS[Math.min(BLOCKS.length - 1, Math.round(((value - min) / (max - min)) * (BLOCKS.length - 1)))])
    .join('')
}

/** One line for `/memory` and for the card. */
export function describeAffinity(history, { width = 30 } = {}) {
  const days = (history?.days ?? []).slice(-width)
  if (days.length === 0) return ''
  const energy = sparkline(days.map((entry) => entry.energy), { width })
  const msgs = sparkline(days.map((entry) => entry.msgs), { width })
  const first = days[0].day
  const last = days[days.length - 1].day
  return `近 ${days.length} 天 · 精力 ${energy} · 消息 ${msgs}（${first} → ${last}）`
}
