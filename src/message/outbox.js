/**
 * The outbox: a reply that was written but not yet delivered.
 *
 * Today a send is fire-and-forget. If the socket is down at that moment — the
 * laptop slept, the phone is on a train, the server hiccups — the reply the
 * model already produced is simply gone, and the user is left talking to a bot
 * that "ignored" them. Reminders and /subscribe messages are worse: they are
 * the whole point of the feature and nobody will ever retype them.
 *
 * So a failed text send is persisted here and retried with backoff. This is not
 * a general queue: it holds outbound text per conversation, in order, and tries
 * again until it lands or the operator drops it. Media is deliberately not
 * queued — a file that missed its moment is worse resent late than not at all,
 * and the file may be gone from disk.
 *
 * Delivery is at-least-once. WeChat's API has no idempotency key we can rely on,
 * so a send that succeeded but whose response was lost can be delivered twice;
 * the alternative (dropping it) is worse for a reminder.
 *
 * @module dsh-weixin/message/outbox
 */

import { statePath } from '../state-layout.js'
import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'
import fs from 'node:fs'

/** Attempts before an item is parked (kept, but no longer retried by the timer). */
export const MAX_ATTEMPTS = 8
/** First retry delay, doubling per attempt, capped. */
export const BASE_RETRY_MS = 30_000
export const MAX_RETRY_MS = 30 * 60_000
/** How many undelivered items are kept before the oldest are dropped. */
export const MAX_ITEMS = 50
/** Timer period. */
export const FLUSH_INTERVAL_MS = 30_000

/** @param {string} stateRoot */
export function outboxFile(stateRoot) {
  return statePath(stateRoot, 'outbox')
}

/**
 * @param {string} stateRoot
 * @param {{ warn?: (message: string) => void }} [options]
 * @returns {{ items: any[] }}
 */
export function readOutbox(stateRoot, { warn = () => {} } = {}) {
  return readJsonFile(outboxFile(stateRoot), {
    warn,
    version: 1,
    fallback: () => ({ items: [] }),
    migrate: (parsed) => ({ items: Array.isArray(parsed.items) ? parsed.items.filter((item) => item && typeof item.text === 'string' && typeof item.conversationId === 'string') : [] }),
  })
}

/** @param {number} attempts */
export function retryDelayMs(attempts) {
  const delay = BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1)
  return Math.min(MAX_RETRY_MS, delay)
}

/**
 * A durable outbox bound to one state root.
 *
 * @param {object} options
 * @param {string} options.stateRoot
 * @param {(accountId: string) => { send: (message: any) => Promise<void> } | undefined} options.transportFor
 * @param {(message: string) => void} [options.warn]
 * @param {(message: string) => void} [options.log]
 * @param {() => number} [options.now]
 */
export function createOutbox({ stateRoot, transportFor, warn = () => {}, log = () => {}, now = () => Date.now() }) {
  /** @param {{ items: any[] }} store */
  const save = (store) => atomicWriteJson(outboxFile(stateRoot), { schemaVersion: 1, ...store }, { warn })

  /**
   * Persist one undelivered text. Returns the item id.
   *
   * @param {{ accountId: string, conversationId: string, text: string, contextToken?: string }} entry
   */
  const enqueue = (entry) => {
    const store = readOutbox(stateRoot, { warn })
    const at = now()
    const item = {
      id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      accountId: entry.accountId,
      conversationId: entry.conversationId,
      text: entry.text,
      ...(entry.contextToken ? { contextToken: entry.contextToken } : {}),
      createdAt: at,
      attempts: 0,
      notBefore: at,
      lastError: '',
    }
    store.items.push(item)
    // Oldest first: the newest message is the one the user is waiting on.
    while (store.items.length > MAX_ITEMS) store.items.shift()
    save(store)
    log(`outbox: queued ${store.items.length} undelivered message(s) for ${entry.conversationId}`)
    return item.id
  }

  /**
   * Try to deliver everything that is due. Items stay in order per conversation.
   *
   * @param {{ force?: boolean }} [options] force ignores notBefore (manual retry)
   * @returns {Promise<{ sent: number, failed: number, remaining: number }>}
   */
  const flush = async (options = {}) => {
    const store = readOutbox(stateRoot, { warn })
    if (store.items.length === 0) return { sent: 0, failed: 0, remaining: 0 }
    const at = now()
    const remaining = []
    let sent = 0
    let failed = 0
    // Grouped by conversation so one conversation's stuck item does not let the
    // next one overtake it.
    const byConversation = new Map()
    for (const item of store.items) {
      const key = `${item.accountId}|${item.conversationId}`
      if (!byConversation.has(key)) byConversation.set(key, [])
      byConversation.get(key).push(item)
    }
    for (const queue of byConversation.values()) {
      let blocked = false
      for (const item of queue) {
        if (blocked) {
          remaining.push(item)
          continue
        }
        if (item.attempts >= MAX_ATTEMPTS) {
          remaining.push(item)
          blocked = false
          continue
        }
        if (options.force !== true && Number(item.notBefore ?? 0) > at) {
          remaining.push(item)
          blocked = true
          continue
        }
        const transport = transportFor(item.accountId)
        if (transport === undefined) {
          item.lastError = 'no live transport'
          remaining.push(item)
          blocked = true
          continue
        }
        try {
          await transport.send({ conversationId: item.conversationId, type: 'text', text: item.text, contextToken: item.contextToken })
          sent += 1
        } catch (error) {
          item.attempts = Number(item.attempts ?? 0) + 1
          item.lastError = String(error?.message ?? error)
          item.notBefore = at + retryDelayMs(item.attempts)
          remaining.push(item)
          failed += 1
          blocked = true
        }
      }
    }
    store.items = remaining
    save(store)
    if (sent > 0) log(`outbox: delivered ${sent} queued message(s), ${remaining.length} still waiting`)
    return { sent, failed, remaining: remaining.length }
  }

  /** @returns {any[]} the parked items, oldest first */
  const pending = () => readOutbox(stateRoot, { warn }).items

  /** Drop one item (the card's 「丢弃」). */
  const drop = (id) => {
    const store = readOutbox(stateRoot, { warn })
    const before = store.items.length
    store.items = store.items.filter((item) => item.id !== id)
    if (store.items.length !== before) save(store)
    return store.items.length !== before
  }

  let timer
  const start = () => {
    timer = setInterval(() => {
      void flush().catch((error) => warn(`outbox flush failed: ${String(error?.message ?? error)}`))
    }, FLUSH_INTERVAL_MS)
    timer.unref?.()
  }
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  return { enqueue, flush, pending, drop, start, stop }
}

/**
 * Whether a file the outbox points at still exists (used by media suggestions
 * in the card; text items do not need it).
 *
 * @param {string} file
 */
/**
 * 待重发队列的人话版（`/outbox`）。只读，不触发发送。
 *
 * @param {Array<{id:string,createdAt:number,attempts?:number,lastError?:string,text?:string}>} items
 * @param {{ now?: number, limit?: number }} [options]
 */
export function formatOutbox(items, { now = Date.now(), limit = 5 } = {}) {
  if (!Array.isArray(items) || items.length === 0) return '重发队列是空的。'
  const shown = items.slice(0, limit)
  const lines = shown.map((item, index) => {
    const minutes = Math.max(0, Math.round((now - Number(item.createdAt ?? now)) / 60_000))
    const preview = String(item.text ?? '').replace(/\s+/g, ' ').slice(0, 40)
    const failure = item.lastError ? ` · 上次失败：${String(item.lastError).slice(0, 60)}` : ''
    return `${index + 1}. ${item.id} · ${minutes} 分钟前 · 尝试 ${item.attempts ?? 0} 次${failure}\n   ${preview}${String(item.text ?? '').length > 40 ? '…' : ''}`
  })
  const more = items.length > limit ? `\n…还有 ${items.length - limit} 条。` : ''
  return `待重发 ${items.length} 条：\n${lines.join('\n')}${more}\n\n/outbox retry 立即重试；/outbox drop <id> 丢弃一条。`
}

export function stillOnDisk(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}
