import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CONTEXT_TOKEN_TTL_MS, createOutbox, tokenExpired } from '../src/message/outbox.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-outbox-ttl-'))
}

test('a token is good until the ttl, then considered expired', () => {
  const born = 1_000_000
  assert.equal(tokenExpired({ contextToken: 'tok', createdAt: born }, born + 60_000), false)
  assert.equal(tokenExpired({ contextToken: 'tok', createdAt: born }, born + CONTEXT_TOKEN_TTL_MS - 1), false)
  assert.equal(tokenExpired({ contextToken: 'tok', createdAt: born }, born + CONTEXT_TOKEN_TTL_MS), true)
})

test('an item without a token, or without a birth time, is never expired by this rule', () => {
  const now = 9_000_000_000
  assert.equal(tokenExpired({ createdAt: 1 }, now), false, 'no token to expire')
  assert.equal(tokenExpired({ contextToken: '', createdAt: 1 }, now), false)
  assert.equal(tokenExpired({ contextToken: 'tok' }, now), false, 'unknown age is not guessed as expired')
  assert.equal(tokenExpired(undefined, now), false)
})

test('a reply whose token aged out is parked, not retried, and says why', async () => {
  const stateRoot = tmpRoot()
  try {
    let clock = 1_000_000
    const sent = []
    const outbox = createOutbox({
      stateRoot,
      now: () => clock,
      warn: () => {},
      transportFor: () => ({ send: async (params) => sent.push(params) }),
    })
    const id = outbox.enqueue({ accountId: 'a', conversationId: 'c', text: '迟到的回复', contextToken: 'tok' })
    // Eleven minutes pass before the retry — past the ten-minute window in #9.
    clock += 11 * 60_000
    const result = await outbox.flush()
    assert.equal(result.sent, 0, 'an expired token cannot deliver')
    assert.deepEqual(sent, [], 'the transport must not be called with a dead token')
    assert.equal(result.remaining, 1, 'the item is parked, not dropped')
    const [parked] = outbox.pending()
    assert.equal(parked.id, id)
    assert.match(parked.lastError, /context token expired/)
    // Parked means no longer retried by the timer either: another flush must not
    // call the transport, and must not keep bumping attempts past the cap.
    const again = await outbox.flush()
    assert.equal(again.sent, 0)
    assert.equal(outbox.pending().length, 1)
    assert.equal(outbox.pending()[0].attempts, parked.attempts)
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('a fresh token still sends normally', async () => {
  const stateRoot = tmpRoot()
  try {
    let clock = 1_000_000
    const sent = []
    const outbox = createOutbox({
      stateRoot,
      now: () => clock,
      warn: () => {},
      transportFor: () => ({ send: async (params) => sent.push(params) }),
    })
    outbox.enqueue({ accountId: 'a', conversationId: 'c', text: '及时回复', contextToken: 'tok' })
    clock += 30_000
    const result = await outbox.flush()
    assert.equal(result.sent, 1)
    assert.equal(sent[0].contextToken, 'tok')
    assert.equal(outbox.pending().length, 0)
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})
