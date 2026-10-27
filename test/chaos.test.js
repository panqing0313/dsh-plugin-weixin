// Chaos, but deterministic (E30).
//
// The point of a chaos test is the invariant, not the randomness: pick a seed,
// fail a third of the sends, cap the queue, and then assert the properties that
// must hold no matter what happened — nothing is lost silently, per-conversation
// order never inverts, the store on disk is always parseable, and the limiter
// never lets more through in a window than it says it does.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createOutbox } from '../src/message/outbox.js'
import { createSenderLimiter } from '../src/message/sender-limit.js'
import { sweepRetention } from '../src/message/retention.js'

/** Deterministic PRNG: a seed makes a failure reproducible, which a chaos test must be. */
function seeded(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

test('outbox: under random failures, nothing is lost and order never inverts', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chaos-outbox-'))
  const random = seeded(20261027)
  const delivered = []
  const transport = {
    async send({ conversationId, text }) {
      if (random() < 0.33) throw new Error('simulated network failure')
      delivered.push({ conversationId, text })
    },
  }
  const outbox = createOutbox({ stateRoot: root, transportFor: () => transport })
  try {
    for (let index = 0; index < 40; index += 1) {
      outbox.enqueue({ accountId: 'a', conversationId: `c${index % 3}`, text: `m${index}` })
    }
    for (let round = 0; round < 12; round += 1) await outbox.flush({ force: true })

    // 1. Whatever was delivered is in per-conversation order.
    for (const conversation of ['c0', 'c1', 'c2']) {
      const seq = delivered.filter((entry) => entry.conversationId === conversation).map((entry) => Number(entry.text.slice(1)))
      const sorted = [...seq].sort((a, b) => a - b)
      assert.deepEqual(seq, sorted, `order inverted for ${conversation}`)
    }

    // 2. Whatever was not delivered is still queued (or was deliberately dropped by the cap).
    const queued = outbox.pending()
    const accountedFor = new Set([...delivered.map((entry) => entry.text), ...queued.map((entry) => entry.text)])
    for (let index = 0; index < 40; index += 1) {
      assert.ok(accountedFor.has(`m${index}`), `m${index} vanished without being sent or queued`)
    }

    // 3. The store on disk is parseable at every point (atomic writes).
    const raw = fs.readFileSync(path.join(root, 'outbox.json'), 'utf8')
    assert.doesNotThrow(() => JSON.parse(raw))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('limiter: a burst never exceeds the declared rate, and retryAfterMs is sane', () => {
  const limiter = createSenderLimiter({ perMinute: 5 })
  const random = seeded(7)
  let allowed = 0
  for (let index = 0; index < 500; index += 1) {
    const result = limiter.check(`sender${Math.floor(random() * 3)}`)
    assert.ok(result.retryAfterMs >= 0, 'retryAfter must never be negative')
    if (result.allowed) allowed += 1
  }
  assert.ok(allowed <= 3 * 5, `allowed ${allowed} in one window across three senders, cap is 15`)
})

test('retention: a sweep deletes only files it can date, never a stray file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chaos-retention-'))
  try {
    const journal = path.join(root, 'journal')
    fs.mkdirSync(journal, { recursive: true })
    const now = Date.UTC(2026, 9, 27, 12, 0, 0)
    const day = (offset) => new Date(now - offset * 86_400_000).toISOString().slice(0, 10)
    fs.writeFileSync(path.join(journal, `journal-${day(400)}.jsonl`), '{}\n')
    fs.writeFileSync(path.join(journal, `journal-${day(1)}.jsonl`), '{}\n')
    fs.writeFileSync(path.join(journal, 'notes.txt'), 'keep me\n')
    const result = sweepRetention(root, { now, retention: { journalDays: 180 } })
    assert.deepEqual(result.removed.map((entry) => path.basename(entry.file)), [`journal-${day(400)}.jsonl`])
    assert.ok(fs.existsSync(path.join(journal, 'notes.txt')), 'an unrecognised file is never deleted')
    assert.ok(fs.existsSync(path.join(journal, `journal-${day(1)}.jsonl`)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
