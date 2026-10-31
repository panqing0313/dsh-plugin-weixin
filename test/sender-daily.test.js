import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createSenderDailyLimiter, dailyKey, SENDER_DAILY_SCHEMA_VERSION } from '../src/message/sender-daily.js'

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-daily-'))
}

test('a zero limit means no counting at all', () => {
  const root = tmpState()
  const limiter = createSenderDailyLimiter({ stateRoot: root, limit: 0 })
  for (let i = 0; i < 50; i += 1) assert.equal(limiter.check('a1', 'wxid_a').allowed, true)
  assert.equal(fs.existsSync(path.join(root, 'sender-daily.json')), false, '0 never writes a file')
})

test('the limit counts per account and per sender, and stops that one person', () => {
  const root = tmpState()
  const limiter = createSenderDailyLimiter({ stateRoot: root, limit: 3 })
  assert.equal(limiter.check('a1', 'wxid_a').allowed, true)
  assert.equal(limiter.check('a1', 'wxid_a').allowed, true)
  assert.equal(limiter.check('a1', 'wxid_a').allowed, true)
  const refused = limiter.check('a1', 'wxid_a')
  assert.equal(refused.allowed, false)
  assert.equal(refused.used, 3)
  assert.equal(refused.limit, 3)
  // A different person in the same account is untouched.
  assert.equal(limiter.check('a1', 'wxid_b').allowed, true)
  // The same person in a different account has their own budget.
  assert.equal(limiter.check('a2', 'wxid_a').allowed, true)
})

test('a refusal only warns once per cooldown window', () => {
  const root = tmpState()
  let at = 1_000_000
  const limiter = createSenderDailyLimiter({ stateRoot: root, limit: 1, now: () => at })
  assert.equal(limiter.check('a1', 'wxid_a').allowed, true)
  const first = limiter.check('a1', 'wxid_a')
  assert.equal(first.shouldWarn, true)
  assert.equal(limiter.check('a1', 'wxid_a').shouldWarn, false, 'silent inside the cooldown')
  at += 5 * 60_000
  assert.equal(limiter.check('a1', 'wxid_a').shouldWarn, true, 'warns again after the cooldown')
})

test('the next day starts from zero, and the counter survives a reload', () => {
  const root = tmpState()
  let at = new Date(2026, 9, 31, 23, 0).getTime()
  const first = createSenderDailyLimiter({ stateRoot: root, limit: 1, now: () => at })
  assert.equal(first.check('a1', 'wxid_a').allowed, true)
  assert.equal(first.check('a1', 'wxid_a').allowed, false)

  // A new instance reads the same file (the count is durable, not in memory).
  const again = createSenderDailyLimiter({ stateRoot: root, limit: 1, now: () => at })
  assert.equal(again.used('a1', 'wxid_a'), 1)
  assert.equal(again.check('a1', 'wxid_a').allowed, false)

  at = new Date(2026, 10, 1, 0, 5).getTime()
  const tomorrow = createSenderDailyLimiter({ stateRoot: root, limit: 1, now: () => at })
  assert.equal(tomorrow.used('a1', 'wxid_a'), 0, 'a new day is a fresh budget')
  assert.equal(tomorrow.check('a1', 'wxid_a').allowed, true)
})

test('a corrupt state file degrades to zero used, never to a crash', () => {
  const root = tmpState()
  fs.writeFileSync(path.join(root, 'sender-daily.json'), '{not json')
  const warnings = []
  const limiter = createSenderDailyLimiter({ stateRoot: root, limit: 1, warn: (line) => warnings.push(line) })
  assert.equal(limiter.check('a1', 'wxid_a').allowed, true)
  assert.equal(warnings.length > 0, true)
})

test('the day key is the local date and the schema version is written', () => {
  assert.equal(dailyKey(new Date(2026, 9, 31, 0, 5)), '2026-10-31')
  const root = tmpState()
  createSenderDailyLimiter({ stateRoot: root, limit: 2 }).check('a1', 'wxid_a')
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'sender-daily.json'), 'utf8'))
  assert.equal(stored.schemaVersion, SENDER_DAILY_SCHEMA_VERSION)
  assert.equal(stored.accounts.a1.senders.wxid_a, 1)
})
