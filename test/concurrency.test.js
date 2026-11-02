import assert from 'node:assert/strict'
import test from 'node:test'

import { concurrencyWidth, mapWithConcurrency } from '../src/concurrency.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('results keep the input order even when later items finish first', async () => {
  const items = [30, 10, 20]
  const out = await mapWithConcurrency(items, 3, async (ms, index) => {
    await sleep(ms)
    return `${index}:${ms}`
  })
  assert.deepEqual(out, ['0:30', '1:10', '2:20'])
})

test('no more than `limit` tasks are ever in flight', async () => {
  let inFlight = 0
  let peak = 0
  const items = Array.from({ length: 9 }, (_, i) => i)
  await mapWithConcurrency(items, 3, async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await sleep(5)
    inFlight -= 1
  })
  assert.equal(peak, 3, 'the limit is a ceiling, not a suggestion')
})

test('three slow attachments take about one item of wall time, not three', async () => {
  const started = Date.now()
  await mapWithConcurrency([1, 2, 3], 3, async () => {
    await sleep(60)
  })
  const elapsed = Date.now() - started
  // Serial would be >= 180ms; give the timer plenty of slack on a loaded CI box.
  assert.ok(elapsed < 150, `expected concurrent execution, took ${elapsed}ms`)
})

test('a single item still works, and an empty list resolves to []', async () => {
  assert.deepEqual(await mapWithConcurrency([], 3, async () => 'x'), [])
  assert.deepEqual(await mapWithConcurrency(['a'], 3, async (item) => item.toUpperCase()), ['A'])
})

test('a limit below one is treated as one rather than deadlocking', async () => {
  let inFlight = 0
  let peak = 0
  await mapWithConcurrency([1, 2, 3], 0, async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await sleep(2)
    inFlight -= 1
  })
  assert.equal(peak, 1)
  assert.equal(concurrencyWidth(0), 1)
  assert.equal(concurrencyWidth(Number.NaN), 1)
  assert.equal(concurrencyWidth(4), 4)
})

test('a failing task stops new work from being scheduled, and the first error wins', async () => {
  const started = []
  await assert.rejects(
    mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
      started.push(item)
      if (item === 2) throw new Error('boom-2')
      await sleep(5)
      return item
    }),
    /boom-2/,
  )
  // Two workers: the failure lands early, so at most the in-flight pair plus a
  // little scheduling noise should have run — never all six.
  assert.ok(started.length < 6, `should have stopped scheduling, started ${started.length}`)
})
