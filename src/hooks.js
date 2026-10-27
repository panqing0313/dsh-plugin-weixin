// A tiny hook bus.
//
// The plugin has grown a set of cross-cutting concerns that all want the same
// two moments: "a message came in" and "a reply is about to go out". Audit
// logging wants them, stats wants them, a future metrics exporter will want
// them, and every one of them is currently a direct call placed at a specific
// line inside the inbound handler — which is why that handler is hard to reason
// about and why adding the fifth observer meant editing it again.
//
// This module is deliberately not a plugin system: no config, no third-party
// registration, no dynamic import. It is an in-process list of named listeners
// with a fixed set of hook points, so the call sites say *what happened*
// instead of *who cares*.

/** The hook points. Adding one here is the only place a new moment is declared. */
export const HOOK_POINTS = Object.freeze({
  /** A message passed the gate and is about to reach the agent. */
  inboundAccepted: 'inboundAccepted',
  /** A message was refused (rate limit, allowlist, unsupported type). */
  inboundRefused: 'inboundRefused',
  /** The agent produced a reply and it is about to be sent. */
  outboundReady: 'outboundReady',
  /** A send finished, or was queued in the outbox after failing. */
  outboundSettled: 'outboundSettled',
  /** A turn finished, however it ended. */
  turnSettled: 'turnSettled',
});

const KNOWN = new Set(Object.values(HOOK_POINTS));

/**
 * Create a hook bus.
 *
 * Listeners are called in registration order, synchronously, and a throwing
 * listener cannot break the caller: every failure is reported through `warn`
 * and the remaining listeners still run. That is the whole contract — hook
 * failures must never cost a message.
 *
 * @param {{ warn?: (line: string) => void, logger?: { info?: Function } }} [options]
 */
export function createHooks({ warn, logger } = {}) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  const report = typeof warn === 'function' ? warn : () => {}

  function on(point, listener) {
    if (KNOWN.has(point) !== true) throw new Error(`unknown hook point: ${point}`)
    if (typeof listener !== 'function') throw new Error(`hook ${point} needs a function`)
    const bucket = listeners.get(point) ?? []
    bucket.push(listener)
    listeners.set(point, bucket)
    // Returns an unsubscribe function: a caller that registers per conversation
    // must be able to drop it again, or the list grows for the life of the process.
    return () => {
      const current = listeners.get(point) ?? []
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
    }
  }

  function emit(point, event) {
    const bucket = listeners.get(point)
    if (bucket === undefined || bucket.length === 0) return
    for (const listener of [...bucket]) {
      try {
        const result = listener(event)
        // A listener may be async; a rejection is reported, not awaited. Hooks
        // observe, they never hold up a reply.
        if (result !== undefined && typeof result.then === 'function') {
          result.then(undefined, (error) => report(`hook ${point} rejected: ${String(error)}`))
        }
      } catch (error) {
        report(`hook ${point} threw: ${String(error)}`)
      }
    }
  }

  function listenerCount(point) {
    return (listeners.get(point) ?? []).length
  }

  return { on, emit, listenerCount, points: () => Object.keys(HOOK_POINTS).map((key) => HOOK_POINTS[key]) };
}
