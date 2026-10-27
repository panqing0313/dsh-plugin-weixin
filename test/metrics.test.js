import test from 'node:test'
import assert from 'node:assert/strict'
import { createMetrics } from '../src/metrics.js'
import { createHooks, HOOK_POINTS } from '../src/hooks.js'

test('counters start at zero, add up, and can be read back', () => {
  const metrics = createMetrics({ now: () => 1_000 })
  assert.equal(metrics.get('inbound.accepted'), 0, 'a counter nobody touched reads as zero')
  metrics.inc('inbound.accepted')
  metrics.inc('inbound.accepted', 2)
  metrics.inc('inbound.refused', 1)
  assert.equal(metrics.get('inbound.accepted'), 3)
  assert.equal(metrics.get('inbound.refused'), 1)
})

test('names with a label live beside the unlabelled counter', () => {
  const metrics = createMetrics()
  metrics.inc('outbound.settled', 1)
  metrics.inc('outbound.settled', 5, 'queued')
  assert.equal(metrics.get('outbound.settled'), 1)
  assert.equal(metrics.get('outbound.settled', 'queued'), 5)
  assert.deepEqual(Object.keys(metrics.snapshot().counters), ['outbound.settled', 'outbound.settled[queued]'])
})

test('gauges are set, not accumulated, and can be cleared', () => {
  const metrics = createMetrics()
  metrics.gauge('outbox.pending', 3)
  metrics.gauge('outbox.pending', 1)
  assert.equal(metrics.snapshot().gauges['outbox.pending'], 1)
  metrics.gauge('outbox.pending', Number.NaN)
  assert.deepEqual(metrics.snapshot().gauges, {}, 'a non-finite gauge value removes it instead of poisoning the snapshot')
})

test('the snapshot is sorted, JSON-safe and carries its own age', () => {
  let clock = 5_000
  const metrics = createMetrics({ now: () => clock })
  metrics.inc('b')
  metrics.inc('a')
  metrics.gauge('g', 2)
  clock = 8_000
  const snapshot = metrics.snapshot()
  assert.deepEqual(Object.keys(snapshot.counters), ['a', 'b'])
  assert.equal(snapshot.startedAt, 5_000)
  assert.equal(snapshot.uptimeMs, 3_000)
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
})

test('observe wires hook points into counters and can be unwired', () => {
  const hooks = createHooks({ warn: () => {} })
  const metrics = createMetrics()
  const off = metrics.observe(hooks, {
    [HOOK_POINTS.inboundAccepted]: 'inbound.accepted',
    [HOOK_POINTS.turnSettled]: 'turn.settled',
  })
  hooks.emit(HOOK_POINTS.inboundAccepted, {})
  hooks.emit(HOOK_POINTS.inboundAccepted, {})
  hooks.emit(HOOK_POINTS.turnSettled, {})
  assert.equal(metrics.get('inbound.accepted'), 2)
  assert.equal(metrics.get('turn.settled'), 1)
  off()
  hooks.emit(HOOK_POINTS.inboundAccepted, {})
  assert.equal(metrics.get('inbound.accepted'), 2, 'after unsubscribe the counter stops moving')
})

test('empty names are ignored rather than creating a phantom counter', () => {
  const metrics = createMetrics()
  metrics.inc('')
  metrics.gauge('', 1)
  assert.deepEqual(metrics.snapshot().counters, {})
})

test('the Prometheus text exposition splits labels and keeps one sample per key', async () => {
  const { prometheusText } = await import('../src/metrics.js')
  const registry = createMetrics()
  registry.inc('inbound.accepted')
  registry.inc('inbound.refused', 2)
  registry.inc('group.ignored', 3, 'not-addressed')
  registry.gauge('outbox.pending', 4)

  const text = prometheusText(registry.snapshot(), { prefix: 'wx' })
  assert.match(text, /^# TYPE wx_events counter$/m)
  assert.match(text, /^wx_inbound_accepted 1$/m)
  assert.match(text, /^wx_inbound_refused 2$/m)
  // A labelled key becomes one sample with the label, never a twin without it —
  // two shapes under one name makes Prometheus reject the whole family.
  assert.match(text, /^wx_group_ignored\{label="not-addressed"\} 3$/m)
  assert.equal((text.match(/wx_group_ignored/g) ?? []).length, 1)
  assert.match(text, /^wx_outbox_pending 4$/m)
  assert.match(text, /^wx_uptime_seconds [\d.]+$/m)
})

test('the snapshot writer leaves two parseable files and never a temp file', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { writeMetricsSnapshot } = await import('../src/metrics.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-metrics-'))
  const registry = createMetrics()
  registry.inc('outbound.settled', 7)
  const result = await writeMetricsSnapshot(dir, registry.snapshot())
  assert.deepEqual(result, { json: true, prom: true })
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json'), 'utf8'))
  assert.equal(json.counters['outbound.settled'], 7)
  assert.ok(typeof json.writtenAt === 'number')
  assert.match(fs.readFileSync(path.join(dir, 'metrics.prom'), 'utf8'), /dsh_weixin_outbound_settled 7/)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['metrics.json', 'metrics.prom'])
})
