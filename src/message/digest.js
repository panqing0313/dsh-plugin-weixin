/**
 * 日报的「现算」部分：把今天真实的流水与记忆压成一段提示词。
 *
 * 定时日报（21:00）和手动 `/digest` 必须说同一件事 —— 数字全部来自流水、
 * 事件来自记忆、习惯来自打卡。所以两处共用这一个函数，而不是各写一遍，
 * 免得某天定时版修了 bug、手动版还留着旧口径。
 *
 * 这里不调模型、不写 journal、不碰定时器：只读，然后返回提示词与几个数字，
 * 由调用方决定是发给侧会话还是原样展示。
 *
 * @module dsh-weixin/message/digest
 */

import { readConvMemory, readGlobalMemory } from '../memory.js'
import { readJournalRange } from './chat-export.js'
import { dayKey, habitDigestLine, habitsList } from './habits.js'
import { staleDigestLine, staleFacts } from './memory-stale.js'
import { findPromotionCandidates, formatPromotionHint, readConversationFacts, withoutKnown } from './promotions.js'
import { buildDigestPrompt } from './reports.js'

/** 昨天最多引几句原话：日报是一句话的东西，不是会议纪要。 */
export const RECAP_SNIPPETS = 3
const RECAP_SNIPPET_CHARS = 40
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 昨天聊了什么。日报只讲今天，于是昨晚没说完的事在第二天被当成新话题；
 * 这里把昨天收到的条数、聊得最多的会话、最后几句话取出来，让日报能顺一句。
 *
 * 只要条数与最后几句原话，不做总结 —— 总结交给模型，数字必须是流水里真有的。
 *
 * @param {{ stateRoot: string, accountId: string, now?: number, warn?: (line: string) => void }} input
 * @returns {{ all: number, in: number, out: number, conversations: number, snippets: string[], day: string }}
 */
export function yesterdayRecap({ stateRoot, accountId, now = Date.now(), warn = () => {} }) {
  const day = dayKey(now - DAY_MS)
  const entries = readJournalRange(stateRoot, { accountId, days: 2, now })
  const mine = entries.filter((entry) => dayKey(Number(entry.at ?? 0)) === day)
  const recap = { all: mine.length, in: 0, out: 0, conversations: new Set(), snippets: [], day }
  for (const entry of mine) {
    if (entry.dir === 'in') recap.in += 1
    else recap.out += 1
    recap.conversations.add(entry.conversationId ?? '')
  }
  for (const entry of mine.filter((item) => item.dir === 'in').slice(-RECAP_SNIPPETS)) {
    const text = String(entry.text ?? '').replace(/\s+/g, ' ').trim()
    if (text !== '') recap.snippets.push(text.slice(0, RECAP_SNIPPET_CHARS))
  }
  recap.conversations = recap.conversations.size
  if (mine.length === 0) warn(`no journal entries for ${day}; the digest will skip yesterday`)
  return recap
}

/** 一行话；昨天没消息时返回空串（日报不该天天多一句「昨天没聊」）。 */
export function recapLine(recap) {
  if (recap === undefined || recap.all === 0) return ''
  const parts = [`昨天收到 ${recap.in} 条、发出 ${recap.out} 条`]
  if (recap.snippets.length > 0) parts.push(`最后说到「${recap.snippets.join('」「')}」`)
  return parts.join('，')
}

/**
 * @param {{
 *   stateRoot: string,
 *   accountId: string,
 *   conversationId: string,
 *   now?: number,
 *   warn?: (line: string) => void,
 *   day: string,
 *   staleDays?: number,
 * }} input
 * @returns {{ prompt: string, total: { in: number, out: number, all: number }, conversations: Array<{ conversationId: string, all: number }>, yesterday: { all: number, in: number, out: number, conversations: number, snippets: string[], day: string } }}
 */
/**
 * The promotion line for the digest: statements that recur across different
 * conversations, minus anything already in long-term memory.
 *
 * Errors are swallowed on purpose — a digest must still go out when one
 * conversation's memory file is unreadable.
 */
export function promotionsLine(stateRoot, accountId, { now = Date.now(), warn = () => {}, known = [] } = {}) {
  try {
    const conversations = readConversationFacts(stateRoot, accountId, { now, warn })
    const candidates = withoutKnown(findPromotionCandidates(conversations), known)
    return formatPromotionHint(candidates)
  } catch (error) {
    warn(`could not look for cross-conversation facts: ${error?.message ?? error}`)
    return ''
  }
}

export function composeDigest({ stateRoot, accountId, conversationId, now = Date.now(), warn = () => {}, day, staleDays, promote = false }) {
  const entries = readJournalRange(stateRoot, { accountId, conversationId, days: 1, now })
  const total = { in: 0, out: 0, all: entries.length }
  const perConversation = new Map()
  for (const entry of entries) {
    if (entry.dir === 'in') total.in += 1
    else total.out += 1
    const id = entry.conversationId ?? conversationId
    perConversation.set(id, (perConversation.get(id) ?? 0) + 1)
  }
  const conversations = [...perConversation]
    .map(([id, all]) => ({ conversationId: id, all }))
    .sort((a, b) => b.all - a.all)

  const global = readGlobalMemory(stateRoot, accountId, { warn, now })
  const events = (global.events ?? []).filter((event) => event.done !== true)
  const conv = readConvMemory(stateRoot, accountId, conversationId, { warn })
  const habits = habitDigestLine(habitsList(stateRoot, accountId, { warn }), { today: day })
  // ③ One line, and only when something actually went stale: a digest that ends
  // with a chore list every day is a digest nobody reads.
  const stale = staleDigestLine(staleFacts(global.facts ?? [], { now, staleDays }))
  // ⑤ The morning after: one line about yesterday, so "接着昨天那句" is possible.
  const yesterday = yesterdayRecap({ stateRoot, accountId, now, warn })
  const recap = recapLine(yesterday)
  // ⓒ Cross-conversation promotion, only when asked for: it reads every
  // conversation's facts, which is more than the digest strictly needs.
  const promoted = promote === true ? promotionsLine(stateRoot, accountId, { now, warn, known: global.facts }) : ''
  const prompt = buildDigestPrompt({
    day,
    total,
    conversations,
    events,
    summary: conv.summary,
    ...(habits === '' ? {} : { habits }),
    ...(stale === '' ? {} : { stale }),
    ...(recap === '' ? {} : { recap }),
    ...(promoted === '' ? {} : { promote: promoted }),
  })
  return { prompt, total, conversations, yesterday, promoted }
}