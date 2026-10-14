/**
 * Split an outbound reply into Weixin-sized chunks.
 *
 * iLink accepts a single text item per message and WeChat clients render very
 * long bodies badly, so a long assistant reply is sent as several messages.
 * Splits prefer line boundaries and then spaces, so a chunk never breaks a
 * table row or a URL mid-token when avoidable.
 * @module dsh-weixin/message/chunker
 */

/**
 * @param {string} text
 * @param {number} maxLength  Must be a positive integer.
 * @returns {string[]}  At least one chunk; never empty unless `text` is empty.
 */
export function chunkText(text, maxLength) {
  const limit = Math.max(1, Math.floor(maxLength))
  if (text === '') return []
  if (text.length <= limit) return [text]

  /** @type {string[]} */
  const chunks = []
  let rest = text
  while (rest.length > limit) {
    let cut = -1
    const window = rest.slice(0, limit)
    const newline = window.lastIndexOf('\n')
    if (newline > limit * 0.5) {
      cut = newline + 1 // keep the newline on the previous chunk
    } else {
      const space = window.lastIndexOf(' ')
      if (space > limit * 0.5) cut = space + 1
    }
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}
