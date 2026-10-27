// Counters in memory, nothing else.
//
// The audit's B23 was blunt: there were no numbers. Every question about
// behaviour ("was the bot slow today?", "how many messages got queued?") needed
// grepping a log. Prometheus would be overkill for a plugin that runs inside one
// desktop app; what is actually needed is a small, cheap registry with a stable
// shape that the settings card can read and a human can eyeball.
//
// Deliberate limits: process-lifetime only (a restart resets everything), no
// labels beyond a single optional dimension, and no exported text format. If this
// ever needs to survive a restart it should become a file-backed snapshot — the
// snapshot() shape would not have to change.

/**
 * Create a metrics registry.
 *
 * @param {{ now?: () => number }} [options]
 */
export function createMetrics(options = {}) {
  const now = options.now ?? (() => Date.now())
  const startedAt = now()
  const counters = new Map()
  const gauges = new Map()

  function key(name, label) {
    return label === undefined || label === '' ? name : `${name}[${label}]`
  }

  return {
    /** Add to a counter. Missing counters start at zero, which is what "first event" means. */
    inc(name, by = 1, label) {
      if (typeof name !== 'string' || name === '') return
      const at = key(name, label)
      counters.set(at, (counters.get(at) ?? 0) + (Number.isFinite(by) ? by : 1))
    },

    /** Set a gauge to its current value (queue depth, pending outbox items…). */
    gauge(name, value, label) {
      if (typeof name !== 'string' || name === '') return
      const at = key(name, label)
      if (Number.isFinite(value)) gauges.set(at, value)
      else gauges.delete(at)
    },

    /** Read one counter (0 when never touched). */
    get(name, label) {
      return counters.get(key(name, label)) ?? 0
    },

    /**
     * A plain, JSON-safe snapshot. `uptimeMs` rides along because a rate without
     * a denominator is the first thing anyone asks about.
     */
    snapshot() {
      const sortedCounters = {}
      for (const name of [...counters.keys()].sort()) sortedCounters[name] = counters.get(name)
      const sortedGauges = {}
      for (const name of [...gauges.keys()].sort()) sortedGauges[name] = gauges.get(name)
      return {
        startedAt,
        uptimeMs: Math.max(0, now() - startedAt),
        counters: sortedCounters,
        gauges: sortedGauges,
      }
    },

    /** Wire the standard hook bus counters. Returns the unsubscribe function. */
    observe(hooks, points) {
      const offs = []
      const bump = (name) => () => this.inc(name)
      for (const [point, name] of Object.entries(points)) {
        offs.push(hooks.on(point, bump(name)))
      }
      return () => { for (const off of offs) off() }
    },
  }
}
