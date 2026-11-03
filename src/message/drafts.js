/**
 * 「今天是她的生日」这条提醒，缺的从来不是提醒，是那句话。
 *
 * 重要日子提醒以前只说事实（`dates.js`），剩下的靠你自己当场想。这个模块把
 * 那句话先拟好、存一份，提醒后面跟一行「要不要发这句」，一个词就能发出去。
 *
 * 三条刻意的取舍：
 *
 * 1. **不调模型**。日历提醒这条路一直是本地的（不花额度、不依赖网络），拟稿
 *    也不破例：用的是模板 + 你档案里的称呼，不是生成式文本。想让它自己写，
 *    在聊天里直接说一句「帮我写句祝福」更合适。
 * 2. **不自动发**。替你把话说错，比不说更糟。草稿只是待发，`/draft send` 才出口。
 * 3. **会过期**。草稿 36 小时没人理就作废，免得隔周回一句「/draft send」把过期的
 *    祝福发出去。
 *
 * 状态文件 `drafts.json`：`{schemaVersion, accounts:{[accountId]:{text, forLabel,
 * conversationId, at, turns}}}`。
 *
 * @module dsh-weixin/message/drafts
 */

import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'

export const DRAFTS_SCHEMA_VERSION = 1
/** 一句能发出去的话，不该比这更长。 */
export const MAX_DRAFT_CHARS = 120
/** 过了这个点，草稿就是过期的（生日祝福隔天发很怪）。 */
export const DRAFT_TTL_MS = 36 * 60 * 60 * 1000

function fileOf(stateRoot) {
  return path.join(stateRoot, 'drafts.json')
}

function readStore(stateRoot, warn) {
  const store = readJsonFile(fileOf(stateRoot), { fallback: () => ({ accounts: {} }), warn })
  return store && typeof store === 'object' ? store : { accounts: {} }
}

function labelOf(item) {
  if (item?.kind === 'date') return String(item.label ?? '')
  if (item?.kind === 'event') return String(item.text ?? '')
  return ''
}

function firstName(memory, fallback) {
  const person = memory?.profile?.name ?? memory?.profile?.nickname
  if (typeof person === 'string' && person.trim() !== '') return person.trim()
  return fallback
}

/**
 * Template bank. Deliberately plain sentences a person could have written —
 * the point is to save you the typing, not to sound like a greeting-card bot.
 *
 * @param {{ kind?: string, label?: string, years?: number, text?: string }} item
 * @param {{ who?: string }} [options] `who` is what to call them (defaults to 你).
 */
export function draftVariants(item, { who } = {}) {
  const you = typeof who === 'string' && who !== '' ? who : '你'
  const label = labelOf(item)
  if (item?.kind === 'event') {
    return [
      `上次说好的：${label}。今天到期啦。`,
      `记着今天要做的事：${label}。`,
      `提醒一下——${label}，今天。`,
    ]
  }
  if (/生日/.test(label)) {
    return [
      `生日快乐！🎂 今天别忘了许愿。`,
      `生日快乐呀～新的一岁也要开开心心。`,
      `今天是${you}的生日，生日快乐！`,
    ]
  }
  if (/纪念|结婚|周年/.test(label)) {
    const nth = Number.isFinite(item?.years) && item.years > 0 ? `第 ${item.years} 年` : ''
    return [
      `今天是${nth || '我们的'}纪念日，谢谢你一直在。`,
      `又到这一天了——${label}。`,
      `记着今天：${label}。`,
    ]
  }
  return [`今天是${label}，记一下呀。`, `提醒你一句：今天是${label}。`, `${label}，今天。`]
}

/** First variant, or the nth one for `/draft again`. */
export function buildDraft(item, { who, turn = 0 } = {}) {
  const variants = draftVariants(item, { who })
  const index = Number.isFinite(turn) ? Math.abs(Math.trunc(turn)) % variants.length : 0
  return variants[index]
}

/**
 * Model output or pasted text → one sendable line. Quotes and 「草稿：」 prefixes
 * are stripped; anything longer than the cap is refused rather than truncated
 * (a half sentence is worse than none).
 *
 * @param {string} text
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function cleanDraft(text) {
  let line = String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
  line = line.replace(/^(草稿|draft)\s*[:：]\s*/iu, '')
  line = line.replace(/^["“「'](.*)["”」']$/u, '$1').trim()
  if (line === '') return { ok: false, reason: 'empty' }
  if (line.length > MAX_DRAFT_CHARS) return { ok: false, reason: 'long' }
  return { ok: true, text: line }
}

/**
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ text: string, forLabel?: string, conversationId?: string, at?: number, turn?: number, warn?: (line: string) => void }} options
 */
export function saveDraft(stateRoot, accountId, { text, item, conversationId, at = Date.now(), turn = 0, warn } = {}) {
  const store = readStore(stateRoot, warn)
  store.accounts ??= {}
  store.accounts[accountId] = {
    text: String(text ?? ''),
    forLabel: labelOf(item),
    kind: String(item?.kind ?? ''),
    ...(conversationId === undefined ? {} : { conversationId: String(conversationId) }),
    at,
    turns: Number.isFinite(turn) ? turn : 0,
  }
  atomicWriteJson(fileOf(stateRoot), { schemaVersion: DRAFTS_SCHEMA_VERSION, accounts: store.accounts }, { warn })
  return store.accounts[accountId]
}

/**
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ now?: number, warn?: (line: string) => void }} [options]
 * @returns {object | undefined} `undefined` when there is none or it has expired
 */
export function readDraft(stateRoot, accountId, { now = Date.now(), warn } = {}) {
  const draft = readStore(stateRoot, warn).accounts?.[accountId]
  if (draft === undefined || typeof draft.text !== 'string' || draft.text === '') return undefined
  if (Number.isFinite(draft.at) && now - draft.at > DRAFT_TTL_MS) return undefined
  return draft
}

export function clearDraft(stateRoot, accountId, { warn } = {}) {
  const store = readStore(stateRoot, warn)
  if (store.accounts?.[accountId] === undefined) return false
  delete store.accounts[accountId]
  atomicWriteJson(fileOf(stateRoot), { schemaVersion: DRAFTS_SCHEMA_VERSION, accounts: store.accounts }, { warn })
  return true
}

/**
 * The reminder plus its ready-to-send line.
 *
 * @param {string} reminderText output of `buildDateReminderText`
 * @param {{ text: string } | undefined} draft
 */
export function composeReminder(reminderText, draft) {
  const base = String(reminderText ?? '')
  if (draft === undefined || draft.text === '') return base
  return [
    base,
    '',
    '要不要发这句（`/draft send` 就发，`/draft` 换一句，`/draft skip` 算了）：',
    `> ${draft.text}`,
  ].join('\n')
}

/** What `/draft` prints on its own. */
export function formatDraft(draft, { forLabel } = {}) {
  if (draft === undefined) {
    return '现在没有待发的草稿。重要日子提醒到的时候我会先拟一句放在这儿。'
  }
  const why = forLabel ?? draft.forLabel
  const head = why === undefined || why === '' ? '待发的草稿：' : `待发的草稿（${why}）：`
  return [head, `> ${draft.text}`, '', '`/draft send` 发出去，`/draft` 换一句，`/draft skip` 丢掉。'].join('\n')
}

/**
 * `/draft` handler.
 *
 * @param {{
 *   stateRoot: string,
 *   accountId: string,
 *   item?: () => object | undefined,
 *   who?: () => string | undefined,
 *   send: (text: string) => Promise<unknown>,
 *   warn?: (line: string) => void,
 * }} options
 */
export function createDraftCommands({ stateRoot, accountId, item, who, send, warn }) {
  const current = () => (typeof item === 'function' ? item() : item)

  const store = (text, turn) => {
    const target = current()
    return saveDraft(stateRoot, accountId, { text, item: target, turn, warn })
  }

  return {
    draft: async (arg) => {
      const raw = String(arg ?? '').trim()
      const existing = readDraft(stateRoot, accountId, { warn })

      if (/^(send|发|发送)$/iu.test(raw)) {
        if (existing === undefined) return '现在没有草稿可发。'
        try {
          await send(existing.text)
        } catch (error) {
          warn?.(`draft send failed: ${String(error)}`)
          return `没发出去（${String(error)}），草稿还在，你可以再试一次。`
        }
        clearDraft(stateRoot, accountId, { warn })
        return '发了。'
      }

      if (/^(skip|算了|不用|丢掉|清空)$/iu.test(raw)) {
        return clearDraft(stateRoot, accountId, { warn }) ? '草稿丢了。' : '本来就没有草稿。'
      }

      // `/draft` on its own never overwrites what is waiting: looking at it and
      // rotating it are different intentions, and only the second one costs the
      // sentence you were about to send.
      if (raw === '') {
        if (existing !== undefined) return formatDraft(existing)
        const created = current()
        if (created === undefined) {
          return '现在没有待发的草稿。重要日子提醒到的时候我会先拟一句放在这儿。'
        }
        const first = buildDraft(created, { who: typeof who === 'function' ? who() : who, turn: 0 })
        return formatDraft(store(first, 0), { forLabel: labelOf(created) })
      }

      if (!/^(again|换一句|换|其它|其他|重来|再来)$/iu.test(raw)) {
        return '用法：`/draft` 看草稿，`/draft send` 发出去，`/draft 换一句` 重拟，`/draft skip` 丢掉。'
      }

      const target = current()
      if (target === undefined) {
        return existing === undefined
          ? '现在没有待发的草稿，也不知道要为什么日子拟一句。'
          : `${formatDraft(existing)}\n\n（这次没有具体日子可依据，所以先没换。）`
      }
      const turn = Number.isFinite(existing?.turns) ? existing.turns + 1 : 0
      const text = buildDraft(target, { who: typeof who === 'function' ? who() : who, turn })
      const saved = store(text, turn)
      return `${formatDraft(saved, { forLabel: labelOf(target) })}\n\n（这句是按模板 + 你的称呼拼的，不花额度；想让我另写一句，直接在聊天里说。）`
    },
  }
}