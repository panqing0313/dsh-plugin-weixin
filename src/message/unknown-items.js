/**
 * Learn from traffic we cannot name.
 *
 * The wire has one `item_list` with numbered item types, and the vendored client
 * only understands five of them. `appmsg` (link cards) and `refermsg` (quoted
 * replies) are the two shapes people keep asking about, and neither is in the
 * vendored types — but "not in the observed types" is not the same as "the server
 * never sends it". This module makes the plugin a passive listener: when an item
 * arrives that is not one of the known types, or a known item carries fields nobody
 * has seen, one redacted line goes into the audit log. That is the whole feature —
 * it cannot render a link card, it can only tell us whether the server sends them.
 *
 * Redaction matters: an unknown item may carry anything, including a token.
 */
import { redactSecrets } from '../credentials.js'

/** Item types the vendored client renders. Anything else is a candidate. */
export const KNOWN_ITEM_TYPES = Object.freeze([1, 2, 3, 4, 5, 11, 12])

/** Keys that suggest a documented-but-unimplemented shape is present. */
export const INTERESTING_KEYS = Object.freeze(['appmsg', 'refermsg', 'quote', 'link', 'card', 'miniprogram'])

/**
 * Describe what is unfamiliar about one inbound message.
 *
 * @param {object} message normalised inbound message (`items` = raw item_list)
 * @returns {string[]} lines to log; empty when everything is understood
 */
export function describeUnknownItems(message) {
  const items = Array.isArray(message?.items) ? message.items : []
  const lines = []
  for (const item of items) {
    const type = Number(item?.type)
    if (!KNOWN_ITEM_TYPES.includes(type)) {
      lines.push(`unknown item type ${type} with keys ${Object.keys(item ?? {}).join(',')}`)
      continue
    }
    for (const key of INTERESTING_KEYS) {
      if (item?.[key] !== undefined) lines.push(`item type ${type} carries "${key}"`)
    }
  }
  if (lines.length === 0) {
    // A message can also be unfamiliar without a new item type: an extra top-level
    // field is how a server announces a feature before anyone documents it.
    const known = new Set(['id', 'at', 'type', 'senderId', 'conversationId', 'text', 'items', 'media', 'contextToken', 'raw'])
    const extra = Object.keys(message ?? {}).filter((key) => !known.has(key))
    if (extra.length > 0) lines.push(`message carries unknown top-level keys: ${extra.join(',')}`)
  }
  return lines.map((line) => redactSecrets(line))
}

/** Collapse repeats: one line per kind per day is plenty for a passive listener. */
export function firstSighting(seen, line, key = line) {
  if (seen.has(key)) return false
  seen.add(key)
  return true
}
