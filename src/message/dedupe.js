/**
 * Bounded dedupe cache for inbound message ids.
 *
 * iLink redelivers messages after a reconnect, so a delivered id must be
 * remembered — but a long-running bot would otherwise grow the set without
 * limit. A bounded FIFO keeps only the most recent ids: a redelivery arrives
 * within seconds of the original, so a few thousand entries is far more than
 * enough, and evicting the oldest is safe.
 * @module dsh-weixin/message/dedupe
 */
export class MessageDeduper {
  /** @param {number} [capacity] */
  constructor(capacity = 4096) {
    this.capacity = Math.max(1, Math.floor(capacity))
    /** @type {Set<string>} */
    this.ids = new Set()
  }

  /**
   * @param {string} messageId  Empty ids are never deduped: a message with no
   *   id cannot be recognized as a redelivery, so it is always delivered.
   * @returns {boolean} true when the id is new (and now recorded).
   */
  accept(messageId) {
    if (messageId === '') return true
    if (this.ids.has(messageId)) return false
    if (this.ids.size >= this.capacity) {
      // Set iteration order is insertion order, so the first key is the oldest.
      const oldest = this.ids.values().next().value
      if (oldest !== undefined) this.ids.delete(oldest)
    }
    this.ids.add(messageId)
    return true
  }

  size() {
    return this.ids.size
  }
}
