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
import { habitDigestLine, habitsList } from './habits.js'
import { buildDigestPrompt } from './reports.js'

/**
 * @param {{
 *   stateRoot: string,
 *   accountId: string,
 *   conversationId: string,
 *   now?: number,
 *   warn?: (line: string) => void,
 *   day: string,
 * }} input
 * @returns {{ prompt: string, total: { in: number, out: number, all: number }, conversations: Array<{ conversationId: string, all: number }> }}
 */
export function composeDigest({ stateRoot, accountId, conversationId, now = Date.now(), warn = () => {}, day }) {
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
  const prompt = buildDigestPrompt({
    day,
    total,
    conversations,
    events,
    summary: conv.summary,
    ...(habits === '' ? {} : { habits }),
  })
  return { prompt, total, conversations }
}