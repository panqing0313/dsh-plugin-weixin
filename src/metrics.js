// Counters in memory, nothing else.
//
// The audit's B23 was blunt: there were no numbers. Every question about
// behaviour ("was the bot slow today?", "how many messages got queued?") needed
// grepping a log. Prometheus would be overkill for a plugin that runs inside one
// desktop app; what is actually needed is a small, cheap registry with a stable
// shape that the settings card can read and a human can eyeball.
//
// Deliberate limits: process-lifetime only (a restart resets everything) and no
// labels beyond a single optional dimension. The registry itself never touches
// the disk; `writeMetricsSnapshot` is the separate, explicit hop that lets
// `npm run metrics` and a Prometheus sidecar see the same numbers.

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

/**
 * Prometheus text exposition format, version 0.0.4.
 *
 * Two deliberate choices:
 * - the snapshot's `name[label]` keys are split back into a metric name and one
 *   `label` label, because a single optional dimension is all the registry has;
 * - a counter becomes `_total` and a gauge does not, which is the convention that
 *   makes `rate()` work in a PromQL query without a rewrite.
 *
 * @param {{ counters?: Record<string, number>, gauges?: Record<string, number>, uptimeMs?: number }} snapshot
 * @param {{ prefix?: string, labels?: Record<string, string> }} [options]
 */
export function prometheusText(snapshot, options = {}) {
  const prefix = options.prefix ?? 'dsh_weixin'
  const extra = Object.entries(options.labels ?? {}).map(([k, v]) => `${escapeLabel(k)}="${escapeValue(v)}"`)
  const lines = []

  function sample(name, value, labelValue) {
    const parts = [...extra]
    if (labelValue !== undefined) parts.push(`label="${escapeValue(labelValue)}"`)
    lines.push(`${prefix}_${name}${parts.length > 0 ? `{${parts.join(',')}}` : ''} ${value}`)
  }

  const counters = Object.entries(snapshot?.counters ?? {})
  if (counters.length > 0) {
    lines.push(`# HELP ${prefix}_events Events counted since this process started.`)
    lines.push(`# TYPE ${prefix}_events counter`)
    for (const [key, value] of counters) {
      const parsed = splitKey(key)
      // One sample per key. Emitting an unlabelled twin next to a labelled one
      // makes Prometheus reject the family for inconsistent label cardinality.
      sample(parsed.name.replace(/[^A-Za-z0-9_]/g, '_'), value, parsed.label)
    }
  }

  const gauges = Object.entries(snapshot?.gauges ?? {})
  if (gauges.length > 0) {
    lines.push(`# HELP ${prefix}_gauge A value the plugin measured, not counted.`)
    lines.push(`# TYPE ${prefix}_gauge gauge`)
    for (const [key, value] of gauges) {
      const parsed = splitKey(key)
      sample(parsed.name.replace(/[^A-Za-z0-9_]/g, '_'), value, parsed.label)
    }
  }

  lines.push(`# HELP ${prefix}_uptime_seconds How long this process has been up.`)
  lines.push(`# TYPE ${prefix}_uptime_seconds gauge`)
  lines.push(`${prefix}_uptime_seconds ${Math.max(0, Number(snapshot?.uptimeMs ?? 0)) / 1000}`)
  return `${lines.join('\n')}\n`
}

function splitKey(key) {
  const match = /^(.+)\[(.+)\]$/.exec(String(key))
  return match === null ? { name: String(key) } : { name: match[1], label: match[2] }
}

function escapeValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function escapeLabel(value) {
  return String(value).replace(/[^A-Za-z0-9_]/g, '_')
}

/**
 * The one place a snapshot reaches the disk. Two files, same numbers: `.json` for
 * the card and for a human, `.prom` for whatever scrapes next to the app. Both are
 * written atomically so a scraper never reads half a file.
 *
 * @param {string} stateRoot
 * @param {object} snapshot
 * @param {{ atomics?: { atomicWriteJson?: Function }, fs?: object, promises?: boolean }} [io]
 */
export async function writeMetricsSnapshot(stateRoot, snapshot, io = {}) {
  const { promises: fsp } = await import('node:fs')
  const path = await import('node:path')
  const dir = path.join(stateRoot)
  const json = `${JSON.stringify({ ...snapshot, writtenAt: Date.now() }, null, 2)}\n`
  const prom = prometheusText(snapshot)
  await fsp.mkdir(dir, { recursive: true }).catch(() => {})
  const write = async (file, body) => {
    const target = path.join(dir, file)
    const temp = `${target}.tmp`
    try {
      await fsp.writeFile(temp, body, { mode: 0o600 })
      await fsp.rename(temp, target)
      return true
    } catch {
      await fsp.rm(temp, { force: true }).catch(() => {})
      return false
    }
  }
  const [jsonOk, promOk] = await Promise.all([write('metrics.json', json), write('metrics.prom', prom)])
  return { json: jsonOk, prom: promOk }
}
