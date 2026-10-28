/**
 * 共享清单：群里的一句话，不该只活在某个人的记忆里。
 *
 * 没有它的时候，「周末买什么」「谁去取快递」这类事只在聊天记录里漂着，
 * 第二天谁也说不清做没做。清单按**账号**存，不按会话 —— 同一个机器人待的
 * 群和私聊看到的是同一份，这才是「共享」的意思。
 *
 * 每条记下是谁在哪个会话里加的、什么时候完成；上限 100 条，防止一个
 * 从不清的清单无限长下去。状态是 `lists.json`，原子写。
 *
 * @module dsh-weixin/message/lists
 */

import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'

export const LISTS_SCHEMA_VERSION = 1
/** 一个清单最多留多少条；到顶后明确拒绝，而不是悄悄挤掉旧的。 */
export const MAX_ITEMS = 100
export const DEFAULT_LIST = '待办'
const MAX_TEXT = 200

/** @param {string} stateRoot */
function fileOf(stateRoot) {
  return path.join(stateRoot, 'lists.json')
}

function readStore(stateRoot, warn) {
  return readJsonFile(fileOf(stateRoot), {
    version: LISTS_SCHEMA_VERSION,
    fallback: () => ({ accounts: {} }),
    warn,
  })
}

function writeStore(stateRoot, store, warn) {
  atomicWriteJson(fileOf(stateRoot), { schemaVersion: LISTS_SCHEMA_VERSION, accounts: store.accounts ?? {} }, { warn })
}

function entryOf(store, accountId, name) {
  const lists = store.accounts?.[accountId]?.lists
  return lists?.[name]
}

function ensureEntry(store, accountId, name, at) {
  store.accounts ??= {}
  store.accounts[accountId] ??= { lists: {} }
  store.accounts[accountId].lists ??= {}
  store.accounts[accountId].lists[name] ??= { createdAt: at, items: [] }
  return store.accounts[accountId].lists[name]
}

function newId(at) {
  return `${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ list?: string, warn?: (message: string) => void }} [options]
 * @returns {Array<{ id: string, text: string, by: string, at: number, done: boolean, doneAt?: number }>}
 */
export function listItems(stateRoot, accountId, { list = DEFAULT_LIST, warn } = {}) {
  return entryOf(readStore(stateRoot, warn), accountId, list)?.items ?? []
}

/**
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ text: string, list?: string, by?: string, at?: number,
 *   warn?: (message: string) => void }} input
 */
export function addItem(stateRoot, accountId, { text, list = DEFAULT_LIST, by = '', at = Date.now(), warn } = {}) {
  const clean = String(text ?? '').trim().slice(0, MAX_TEXT)
  if (clean === '') return { ok: false, reason: 'empty' }
  const store = readStore(stateRoot, warn)
  const entry = ensureEntry(store, accountId, list, at)
  if (entry.items.length >= MAX_ITEMS) return { ok: false, reason: 'full' }
  const item = { id: newId(at), text: clean, by, at, done: false }
  entry.items.push(item)
  writeStore(stateRoot, store, warn)
  return { ok: true, item, count: entry.items.length }
}

function locate(entry, index) {
  const position = Number(index)
  if (!Number.isInteger(position) || position < 1 || position > entry.items.length) return undefined
  return position - 1
}

/**
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ index: number | string, list?: string, at?: number,
 *   warn?: (message: string) => void }} input
 */
export function completeItem(stateRoot, accountId, { index, list = DEFAULT_LIST, at = Date.now(), warn } = {}) {
  const store = readStore(stateRoot, warn)
  const entry = entryOf(store, accountId, list)
  if (entry === undefined) return { ok: false, reason: 'missing' }
  const position = locate(entry, index)
  if (position === undefined) return { ok: false, reason: 'range' }
  const item = entry.items[position]
  if (item.done) return { ok: false, reason: 'already', item }
  item.done = true
  item.doneAt = at
  writeStore(stateRoot, store, warn)
  return { ok: true, item, remaining: entry.items.filter((candidate) => !candidate.done).length }
}

/**
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ index: number | string, list?: string, warn?: (message: string) => void }} input
 */
export function removeItem(stateRoot, accountId, { index, list = DEFAULT_LIST, warn } = {}) {
  const store = readStore(stateRoot, warn)
  const entry = entryOf(store, accountId, list)
  if (entry === undefined) return { ok: false, reason: 'missing' }
  const position = locate(entry, index)
  if (position === undefined) return { ok: false, reason: 'range' }
  const [item] = entry.items.splice(position, 1)
  writeStore(stateRoot, store, warn)
  return { ok: true, item }
}

/** @param {string} list @param {Array<{text: string, done: boolean}>} items */
export function formatList(list = DEFAULT_LIST, items = []) {
  if (items.length === 0) return `「${list}」还是空的。发 /todo add 买牛奶 加一条。`
  const open = items.filter((item) => !item.done).length
  const lines = items.map((item, i) => `${i + 1}. ${item.done ? '✅' : '⬜'} ${item.text}`)
  return `「${list}」${open}/${items.length} 条未完成\n${lines.join('\n')}`
}

/**
 * @param {{ stateRoot: string, accountId: string, warn?: (message: string) => void,
 *   now?: () => number }} options
 * @returns {{ todo: (arg?: string) => string }}
 */
export function createListCommands({ stateRoot, accountId, warn, now = () => Date.now() }) {
  const show = () => formatList(DEFAULT_LIST, listItems(stateRoot, accountId, { list: DEFAULT_LIST, warn }))

  return {
    todo(arg = '') {
      const raw = String(arg ?? '').trim()
      if (raw === '') return show()
      const [verb, ...rest] = raw.split(/\s+/)
      const text = rest.join(' ').trim()

      if (verb === 'add' || verb === '加') {
        if (text === '') return '用法：/todo add 买牛奶'
        const result = addItem(stateRoot, accountId, { text, by: accountId, at: now(), warn })
        if (!result.ok) {
          return result.reason === 'full'
            ? `「${DEFAULT_LIST}」已经 ${MAX_ITEMS} 条了，先 /todo done 或 /todo rm 清几条。`
            : '没写内容，没加。'
        }
        return `加好了（第 ${result.count} 条）：${result.item.text}`
      }

      if (verb === 'done' || verb === '完成') {
        if (text === '') return '用法：/todo done 2'
        const result = completeItem(stateRoot, accountId, { index: text, at: now(), warn })
        if (!result.ok) {
          if (result.reason === 'already') return `第 ${text} 条已经完成过了。`
          return result.reason === 'range' ? '没有这个序号，发 /todo 看看。' : '清单还是空的。'
        }
        return `完成：${result.item.text}（还剩 ${result.remaining} 条）`
      }

      if (verb === 'rm' || verb === 'del' || verb === '删') {
        if (text === '') return '用法：/todo rm 2'
        const result = removeItem(stateRoot, accountId, { index: text, warn })
        if (!result.ok) return result.reason === 'range' ? '没有这个序号。' : '清单还是空的。'
        return `删掉了：${result.item.text}`
      }

      // 不带动词就当成新增，少打三个字。
      const result = addItem(stateRoot, accountId, { text: raw, by: accountId, at: now(), warn })
      if (!result.ok) return result.reason === 'full' ? `「${DEFAULT_LIST}」满 ${MAX_ITEMS} 条了。` : '没写内容，没加。'
      return `加好了（第 ${result.count} 条）：${result.item.text}`
    },
  }
}
