/**
 * 习惯打卡：把「每天做一点」变成能看见的连续天数。
 *
 * 提醒负责在到点时喊一声，但喊完就没了 —— 做了没有、连着做了几天、这周
 * 漏了几次，谁都不知道。这个模块只记一件事：**某天打了卡**。连续天数、
 * 本周完成率都由这一串日期算出来，不再存第二份会因为写入失败而对不上的
 * 计数器。
 *
 * 状态是 `habits.json`，按账号分，原子写；每个账号最多 20 个习惯。
 *
 * @module dsh-weixin/message/habits
 */

import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'

export const HABITS_SCHEMA_VERSION = 1
/** 一个账号最多追踪多少个习惯。 */
export const MAX_HABITS = 20
const MAX_NAME = 40

function fileOf(stateRoot) {
  return path.join(stateRoot, 'habits.json')
}

function readStore(stateRoot, warn) {
  return readJsonFile(fileOf(stateRoot), {
    version: HABITS_SCHEMA_VERSION,
    fallback: () => ({ accounts: {} }),
    warn,
  })
}

function writeStore(stateRoot, store, warn) {
  atomicWriteJson(fileOf(stateRoot), { schemaVersion: HABITS_SCHEMA_VERSION, accounts: store.accounts ?? {} }, { warn })
}

/** 本地日期键 YYYY-MM-DD —— 习惯属于「人过的今天」，不是 UTC 的一天。 */
export function dayKey(now = Date.now()) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function shiftDay(key, days) {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() + days)
  return dayKey(date.getTime())
}

function entryOf(store, accountId) {
  store.accounts ??= {}
  store.accounts[accountId] ??= { habits: [] }
  store.accounts[accountId].habits ??= []
  return store.accounts[accountId].habits
}

function findHabit(habits, key) {
  const raw = String(key ?? '').trim()
  const position = Number(raw)
  if (Number.isInteger(position) && position >= 1 && position <= habits.length) return habits[position - 1]
  return habits.find((habit) => habit.name === raw)
}

/** @param {string} stateRoot @param {string} accountId */
export function habitsList(stateRoot, accountId, { warn } = {}) {
  return readStore(stateRoot, warn).accounts?.[accountId]?.habits ?? []
}

/**
 * @param {string} stateRoot @param {string} accountId
 * @param {{ name: string, at?: number, warn?: (line: string) => void }} input
 */
export function addHabit(stateRoot, accountId, { name, at = Date.now(), warn } = {}) {
  const text = String(name ?? '').trim().slice(0, MAX_NAME)
  if (text === '') return { ok: false, reason: 'empty' }
  const store = readStore(stateRoot, warn)
  const habits = entryOf(store, accountId)
  if (habits.some((habit) => habit.name === text)) return { ok: false, reason: 'duplicate' }
  if (habits.length >= MAX_HABITS) return { ok: false, reason: 'full' }
  const habit = { id: `${at.toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: text, createdAt: at, days: [] }
  habits.push(habit)
  writeStore(stateRoot, store, warn)
  return { ok: true, habit, count: habits.length }
}

/**
 * @param {string} stateRoot @param {string} accountId
 * @param {{ key: string, day?: string, warn?: (line: string) => void }} input
 */
export function checkHabit(stateRoot, accountId, { key, day = dayKey(), warn } = {}) {
  const store = readStore(stateRoot, warn)
  const habits = entryOf(store, accountId)
  const habit = findHabit(habits, key)
  if (habit === undefined) return { ok: false, reason: 'missing' }
  if (!Array.isArray(habit.days)) habit.days = []
  if (habit.days.includes(day)) return { ok: false, reason: 'already', habit }
  habit.days.push(day)
  habit.days.sort()
  writeStore(stateRoot, store, warn)
  return { ok: true, habit, streak: streakOf(habit, day) }
}

/**
 * @param {string} stateRoot @param {string} accountId
 * @param {{ key: string, warn?: (line: string) => void }} input
 */
export function removeHabit(stateRoot, accountId, { key, warn } = {}) {
  const store = readStore(stateRoot, warn)
  const habits = entryOf(store, accountId)
  const habit = findHabit(habits, key)
  if (habit === undefined) return { ok: false, reason: 'missing' }
  store.accounts[accountId].habits = habits.filter((candidate) => candidate !== habit)
  writeStore(stateRoot, store, warn)
  return { ok: true, habit }
}

/**
 * 连续天数：从 `today`（默认今天）往回数，今天没打不算断 —— 今天还有机会，
 * 所以从昨天起算连续，只有昨天也没打才归零。
 */
export function streakOf(habit, today = dayKey()) {
  const days = new Set(Array.isArray(habit?.days) ? habit.days : [])
  let cursor = days.has(today) ? today : shiftDay(today, -1)
  if (!days.has(cursor)) return 0
  let streak = 0
  while (days.has(cursor)) {
    streak += 1
    cursor = shiftDay(cursor, -1)
  }
  return streak
}

/** 历史最长连续；习惯可能积攒很多天，逐日扫一遍就够。 */
export function bestStreakOf(habit, today = dayKey()) {
  const days = [...new Set(Array.isArray(habit?.days) ? habit.days : [])].sort()
  let best = 0
  let run = 0
  let previous
  for (const day of days) {
    if (day > today) break
    run = previous !== undefined && shiftDay(previous, 1) === day ? run + 1 : 1
    previous = day
    if (run > best) best = run
  }
  return best
}

/** 最近 7 天（含今天）打了几次。 */
export function weekCount(habit, today = dayKey()) {
  const days = new Set(Array.isArray(habit?.days) ? habit.days : [])
  let count = 0
  for (let offset = 0; offset < 7; offset += 1) {
    if (days.has(shiftDay(today, -offset))) count += 1
  }
  return count
}

/** @param {ReturnType<typeof habitsList>} habits */
export function formatHabits(habits = [], { today = dayKey() } = {}) {
  if (habits.length === 0) return '还没有习惯。发 /habit add 早起 加一个。'
  const lines = habits.map((habit, index) => {
    const done = Array.isArray(habit.days) && habit.days.includes(today)
    const streak = streakOf(habit, today)
    const week = weekCount(habit, today)
    return `${index + 1}. ${done ? '✅' : '⬜'} ${habit.name} · 连续 ${streak} 天 · 本周 ${week}/7`
  })
  const doneToday = habits.filter((habit) => Array.isArray(habit.days) && habit.days.includes(today)).length
  return `习惯 · 今天 ${doneToday}/${habits.length}\n${lines.join('\n')}\n\n/habit done <名字或序号> 打卡；/habit add <名字> 新增。`
}

/** 给日报用的一行；没有习惯或今天全空时返回空串。 */
export function habitDigestLine(habits = [], { today = dayKey() } = {}) {
  if (habits.length === 0) return ''
  const parts = habits.map((habit) => {
    const done = Array.isArray(habit.days) && habit.days.includes(today)
    return `${habit.name}${done ? '✅' : '⬜'}（连续 ${streakOf(habit, today)} 天）`
  })
  const done = habits.filter((habit) => Array.isArray(habit.days) && habit.days.includes(today)).length
  return `习惯打卡 ${done}/${habits.length}：${parts.join('、')}`
}

/**
 * @param {{ stateRoot: string, accountId: string, warn?: (line: string) => void, now?: () => number }} options
 * @returns {{ habit: (arg?: string) => string }}
 */
export function createHabitCommands({ stateRoot, accountId, warn, now = () => Date.now() }) {
  return {
    habit(arg = '') {
      const raw = String(arg ?? '').trim()
      const today = dayKey(now())
      if (raw === '') return formatHabits(habitsList(stateRoot, accountId, { warn }), { today })

      const [verb, ...rest] = raw.split(/\s+/)
      const text = rest.join(' ').trim()

      if (verb === 'add' || verb === '加' || verb === 'new') {
        if (text === '') return '用法：/habit add 早起'
        const result = addHabit(stateRoot, accountId, { name: text, at: now(), warn })
        if (!result.ok) {
          return result.reason === 'duplicate'
            ? `「${text}」已经在追踪了。`
            : result.reason === 'full'
              ? `最多追踪 ${MAX_HABITS} 个习惯，先 /habit rm 删一个。`
              : '没写名字，没加。'
        }
        return `开始追踪：${result.habit.name}（第 ${result.count} 个）`
      }

      if (verb === 'done' || verb === '打卡' || verb === '✓') {
        if (text === '') return '用法：/habit done 早起 或 /habit done 2'
        const result = checkHabit(stateRoot, accountId, { key: text, day: today, warn })
        if (!result.ok) {
          if (result.reason === 'already') return `今天已经打过卡了：${result.habit.name}（连续 ${streakOf(result.habit, today)} 天）`
          return '没有这个习惯，发 /habit 看看有哪些。'
        }
        const week = weekCount(result.habit, today)
        return `打卡成功：${result.habit.name} · 连续 ${result.streak} 天 · 本周 ${week}/7`
      }

      if (verb === 'rm' || verb === 'del' || verb === '删') {
        if (text === '') return '用法：/habit rm 早起'
        const result = removeHabit(stateRoot, accountId, { key: text, warn })
        return result.ok ? `不再追踪：${result.habit.name}` : '没有这个习惯。'
      }

      return '用法：/habit 查看 · /habit add 早起 · /habit done 早起 · /habit rm 早起'
    },
  }
}