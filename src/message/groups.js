// Group chats (C14): the transport already routes them — a message with a
// non-blank group_id becomes the conversation id — but nothing downstream knew.
// Three things go wrong without a policy, and they are all quiet:
//
//   1. the bot answers every message in a group chat, which in a real group is
//      indistinguishable from spam;
//   2. the group shares ONE conversation line, so member A's turn is the context
//      member B is answered from;
//   3. the memory block carries the owner's private facts, and a group is the
//      worst place to read those aloud.
//
// So: a group message is ignored unless it is addressed to the bot, and private
// memory/recall/threads are not injected into a group unless the operator opts in.
export const DEFAULT_GROUP_REPLY_WHEN = 'mention'

/** A group message is one whose conversation is not the sender. */
export function isGroupMessage(message) {
  const conversationId = typeof message?.conversationId === 'string' ? message.conversationId : ''
  const senderId = typeof message?.senderId === 'string' ? message.senderId : ''
  return conversationId !== '' && senderId !== '' && conversationId !== senderId
}

/**
 * Was the bot addressed?
 *
 * iLink does not hand us the group @-list, so this is a text heuristic: a leading
 * `@name`, or one of the configured names anywhere in the first line. False
 * negatives are the safe direction — a missed @ means one unanswered message,
 * a false positive means the bot talks over a group.
 */
export function mentionsBot(text, { names = [] } = {}) {
  const source = typeof text === 'string' ? text : ''
  if (source.trim() === '') return false
  // 微信会在 @ 后面插一个 U+2005（four-per-em space），也常见全角 ＠；
  // 统一成普通空格 + @，再匹配。名字比较不区分大小写（英文昵称很常见）。
  const firstLine = source
    .split('\n')[0]
    .replace(/[\u2005\u00a0\u3000]/g, ' ')
    .replace(/＠/g, '@')
  for (const name of names) {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (trimmed === '') continue
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // 允许「@名字」「名字」开头，或前面是空白；不要求名字后面是空格（微信
    // 的 @ 常常紧贴正文），但要求它出现在首行，避免正文深处误判。
    if (new RegExp(`(^|\\s)@?${escaped}`, 'i').test(firstLine)) return true
  }
  return false
}

/**
 * Should this group message get an answer?
 *
 * @returns {{ reply: boolean, reason: string }}
 */
export function groupReplyPolicy(message, config, { botNames = [] } = {}) {
  if (isGroupMessage(message) === false) return { reply: true, reason: 'direct' }
  if (config?.groupChatEnabled !== true) return { reply: false, reason: 'groups-disabled' }
  const when = config?.groupReplyWhen ?? DEFAULT_GROUP_REPLY_WHEN
  if (when === 'all') return { reply: true, reason: 'group-all' }
  return mentionsBot(message?.text, { names: botNames }) === true
    ? { reply: true, reason: 'group-mention' }
    : { reply: false, reason: 'not-addressed' }
}

/**
 * Private memory stays private: a group gets an answer, not the owner's dossier.
 * Opt in per install with `groupShareMemory` and the blocks come back.
 */
export function groupSharesMemory(message, config) {
  return isGroupMessage(message) === false || config?.groupShareMemory === true
}
