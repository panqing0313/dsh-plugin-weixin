/**
 * Allowlist gate: decide whether a Weixin sender may drive the agent at all.
 *
 * WeChat text is not an authorization credential — anyone who learns the bot's
 * id can send it a message, and a personal-WeChat bot has no directory or
 * membership check. The allowlist is therefore the first gate, applied before
 * dedupe, before session resolution and before the agent is ever woken.
 *
 * Empty `allowedSenders` means DENY-ALL, never allow-all: a misconfigured
 * plugin must fail closed, because failing open would hand a shell-capable
 * agent to every sender on the account.
 * @module dsh-weixin/security/allowlist
 */

/**
 * @param {{ allowedSenders?: readonly string[], allowedChats?: readonly string[] }} config
 * @param {string} senderId
 * @param {string} [conversationId]
 * @returns {boolean}
 */
export function isAllowedSender(config, senderId, conversationId) {
  const senders = config.allowedSenders ?? []
  if (senders.length === 0) return false
  if (!senders.includes(senderId)) return false
  const chats = config.allowedChats ?? []
  if (chats.length === 0) return true
  return conversationId !== undefined && chats.includes(conversationId)
}

/** Short human-readable reason for a denial (used in the log and the reply). */
export function denialReason(config, senderId, conversationId) {
  const senders = config.allowedSenders ?? []
  if (senders.length === 0) return 'no sender allowlist is configured; refusing every sender'
  if (!senders.includes(senderId)) return `sender ${senderId} is not on the allowlist`
  const chats = config.allowedChats ?? []
  if (chats.length > 0 && (conversationId === undefined || !chats.includes(conversationId))) {
    return `conversation ${conversationId ?? '(none)'} is not on the allowlist`
  }
  return 'denied'
}
