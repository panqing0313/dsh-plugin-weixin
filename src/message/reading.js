/**
 * 稍后读：把「等一下看」真的留到一个地方。
 *
 * 链接在聊天里被转发两次就找不到了。这里按账号收一份清单：贴一条链接，
 * 插件去取网页标题（取不到就退回域名），`/later` 随时看，看完 `done`。
 * 它不替人读全文，也不调模型 —— 只是把「待读」从聊天记录里捞出来。
 *
 * 状态是 `reading.json`，按账号分，原子写；上限 50 条。
 *
 * @module dsh-weixin/message/reading
 */

import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'
import { fetchLinkText } from './links.js'

export const READING_SCHEMA_VERSION = 1
export const MAX_READING = 50
const MAX_TITLE = 120
const MAX_TEXT = 2000

/** @param {string} stateRoot */
function fileOf(stateRoot) {
  return path.join(stateRoot, 'reading.json')
}

function readStore(stateRoot, warn) {
  return readJsonFile(fileOf(stateRoot), {
    version: READING_SCHEMA_VERSION,
    fallback: () => ({ accounts: {} }),
    warn,
  })
}

function writeStore(stateRoot, store, warn) {
  atomicWriteJson(fileOf(stateRoot), { schemaVersion: READING_SCHEMA_VERSION, accounts: store.accounts ?? {} }, { warn })
}

function itemsOf(store, accountId) {
  const items = store.accounts?.[accountId]?.items
  return Array.isArray(items) ? items : []
}

/**
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ warn?: (message: string) => void }} [options]
 */
export function readingItems(stateRoot, accountId, { warn } = {}) {
  return itemsOf(readStore(stateRoot, warn), accountId)
}

function isHttp(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function hostOf(raw) {
  try {
    return new URL(raw).hostname
  } catch {
    return ''
  }
}

/**
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ url: string, title?: string, text?: string, at?: number,
 *   warn?: (message: string) => void }} input
 */
export function addReading(stateRoot, accountId, { url, title = '', text = '', at = Date.now(), warn } = {}) {
  const cleanUrl = String(url ?? '').trim().slice(0, MAX_TEXT)
  const cleanText = String(text ?? '').trim().slice(0, MAX_TEXT)
  if (cleanUrl === '' && cleanText === '') return { ok: false, reason: 'empty' }
  const store = readStore(stateRoot, warn)
  store.accounts ??= {}
  store.accounts[accountId] ??= { items: [] }
  const items = store.accounts[accountId].items ??= []
  const same = (item) =>
    cleanUrl !== ''
      ? item.url === cleanUrl
      : item.url === '' && item.text === cleanText
  if (items.some((item) => !item.done && same(item))) return { ok: false, reason: 'duplicate' }
  if (items.length >= MAX_READING) return { ok: false, reason: 'full' }

  const item = {
    id: `${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    url: cleanUrl,
    title: String(title ?? '').trim().slice(0, MAX_TITLE),
    text: cleanText,
    at,
    done: false,
  }
  items.push(item)
  writeStore(stateRoot, store, warn)
  return { ok: true, item, count: items.length }
}

function locate(items, index) {
  const position = Number(index)
  if (!Number.isInteger(position) || position < 1 || position > items.length) return undefined
  return position - 1
}

/** @param {string} stateRoot @param {string} accountId */
export function completeReading(stateRoot, accountId, { index, at = Date.now(), warn } = {}) {
  const store = readStore(stateRoot, warn)
  const items = itemsOf(store, accountId)
  const position = locate(items, index)
  if (position === undefined) return { ok: false, reason: 'range' }
  const item = items[position]
  if (item.done) return { ok: false, reason: 'already', item }
  item.done = true
  item.doneAt = at
  writeStore(stateRoot, store, warn)
  return { ok: true, item, remaining: items.filter((candidate) => !candidate.done).length }
}

/** @param {string} stateRoot @param {string} accountId */
export function removeReading(stateRoot, accountId, { index, warn } = {}) {
  const store = readStore(stateRoot, warn)
  const items = itemsOf(store, accountId)
  const position = locate(items, index)
  if (position === undefined) return { ok: false, reason: 'range' }
  const [item] = items.splice(position, 1)
  writeStore(stateRoot, store, warn)
  return { ok: true, item }
}

/** @param {Array<{ title?: string, url: string, text?: string, done: boolean }>} items */
export function formatReading(items = []) {
  if (items.length === 0) return '稍后读还是空的。发 /later https://… 存一条。'
  const open = items.filter((item) => !item.done).length
  const lines = items.map((item, i) => {
    const label = item.title !== '' ? item.title : item.text !== '' ? item.text : item.url
    return `${i + 1}. ${item.done ? '✅' : '📖'} ${label}`
  })
  return `稍后读 ${open}/${items.length} 条未读\n${lines.join('\n')}`
}

/**
 * @param {{ stateRoot: string, accountId: string, warn?: (message: string) => void,
 *   now?: () => number, fetchTitle?: (url: string) => Promise<string> }} options
 * @returns {{ later: (arg?: string) => Promise<string> }}
 */
export function createReadingCommands({ stateRoot, accountId, warn, now = () => Date.now(), fetchTitle } = {}) {
  const titleOf =
    fetchTitle ??
    (async (url) => {
      try {
        const result = await fetchLinkText(url)
        return result.ok ? result.title ?? '' : ''
      } catch {
        return ''
      }
    })

  return {
    async later(arg = '') {
      const raw = String(arg ?? '').trim()
      if (raw === '') return formatReading(readingItems(stateRoot, accountId, { warn }))

      const [verb, ...rest] = raw.split(/\s+/)
      if (verb === 'done' || verb === '看完') {
        const text = rest.join(' ').trim()
        if (text === '') return '用法：/later done 2'
        const result = completeReading(stateRoot, accountId, { index: text, at: now(), warn })
        if (!result.ok) {
          if (result.reason === 'already') return `第 ${text} 条已经标记过了。`
          return result.reason === 'range' ? '没有这个序号，发 /later 看看。' : '稍后读还是空的。'
        }
        return `标记读完：${result.item.title !== '' ? result.item.title : result.item.url}（还剩 ${result.remaining} 条）`
      }
      if (verb === 'rm' || verb === 'del' || verb === '删') {
        const text = rest.join(' ').trim()
        if (text === '') return '用法：/later rm 2'
        const result = removeReading(stateRoot, accountId, { index: text, warn })
        return result.ok ? `删掉了：${result.item.title !== '' ? result.item.title : result.item.url}` : '没有这个序号。'
      }

      // 一条链接（或一段想留到以后看的文字）直接存。
      const target = verb === 'add' || verb === '加' ? rest.join(' ').trim() : raw
      if (target === '') return '用法：/later https://…'
      const url = isHttp(target) ? target : ''
      const title = url === '' ? '' : (await titleOf(url)).trim() || hostOf(url)
      const result = addReading(stateRoot, accountId, { url: url === '' ? '' : target, title, text: url === '' ? target : '', at: now(), warn })
      if (!result.ok) {
        if (result.reason === 'duplicate') return '这条已经在清单里了。'
        if (result.reason === 'full') return `稍后读满 ${MAX_READING} 条了，先 done 或 rm 几条。`
        return '没写内容，没存。'
      }
      return `存好了（第 ${result.count} 条）：${title !== '' ? title : target}`
    },
  }
}
