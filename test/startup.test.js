import { test } from 'node:test'
import assert from 'node:assert/strict'

import { startAccounts } from '../src/startup.js'

test('every account is dialled before any of them finishes its handshake', async () => {
  // A gate that only opens once all three have entered proves concurrency
  // without measuring wall-clock time: a serial loop would never reach the
  // third entry, so the race below fails instead of hanging.
  let entered = 0
  let open
  const gate = new Promise((resolve) => { open = resolve })
  const running = startAccounts(
    [{ accountId: 'a' }, { accountId: 'b' }, { accountId: 'c' }],
    async () => {
      entered += 1
      if (entered === 3) open()
      await gate
    },
  )
  const result = await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error('accounts started serially')), 1000)),
  ])
  assert.equal(entered, 3)
  assert.equal(result.started, 3)
  assert.deepEqual(result.failures, [])
})

test('one bad credential is reported and skipped, never blocking the rest', async () => {
  const warns = []
  const started = []
  const result = await startAccounts(
    [{ accountId: 'good-1' }, { accountId: 'bad' }, { accountId: 'good-2' }],
    async (account) => {
      if (account.accountId === 'bad') throw new Error('ticket rejected')
      started.push(account.accountId)
    },
    (line) => warns.push(line),
  )
  assert.deepEqual(started.sort(), ['good-1', 'good-2'])
  assert.equal(result.started, 2)
  assert.deepEqual(result.failures, [{ accountId: 'bad', reason: 'ticket rejected' }])
  assert.equal(warns.length, 1)
  assert.match(warns[0], /could not start the loop for bad: ticket rejected/)
})

test('no accounts is a no-op, not an error', async () => {
  const result = await startAccounts([], async () => { throw new Error('never called') })
  assert.deepEqual(result, { started: 0, failures: [] })
})

test('a non-Error rejection still becomes a readable reason', async () => {
  const result = await startAccounts([{ accountId: 'x' }], async () => { throw 'plain string' })
  assert.deepEqual(result.failures, [{ accountId: 'x', reason: 'plain string' }])
})