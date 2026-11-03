/**
 * Which writes pay for a crash — and which do not.
 *
 * `atomicWriteJson` fsyncs before the rename by default, which is what keeps a
 * power cut from turning reminders or memory into an empty file. That fsync
 * measured ~4ms of blocked event loop per write on macOS; running it for every
 * derived counter (today's budget, the usage ledger, the sender quota) is a
 * cost with nothing behind it.
 *
 * These tests pin the policy, not the implementation detail: the default must
 * still fsync, the derived writes must not, and both must produce a readable
 * file with no temp file left behind.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { atomicWriteJson } from '../src/atomic.js'
import { recordBackgroundCall } from '../src/budget.js'
import { createSenderDailyLimiter } from '../src/message/sender-daily.js'
import { conversationRows, recordUsage } from '../src/message/usage-ledger.js'

/** Count fsyncSync calls while `run` executes; the real one still happens. */
function countFsyncs(run) {
  const real = fs.fsyncSync
  let calls = 0
  fs.fsyncSync = (...args) => {
    calls += 1
    return real(...args)
  }
  try {
    run()
  } finally {
    fs.fsyncSync = real
  }
  return calls
}

function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('the default write still fsyncs, and durable: false skips only that', () => {
  const dir = freshDir('wx-durable-')
  const file = path.join(dir, 'state.json')

  assert.equal(countFsyncs(() => atomicWriteJson(file, { schemaVersion: 1, n: 1 })), 1, 'user-owned state pays for the fsync')
  assert.equal(countFsyncs(() => atomicWriteJson(file, { schemaVersion: 1, n: 2 }, { durable: false })), 0)

  // Atomicity against readers is unchanged: content is complete and no temp
  // file survives either path.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schemaVersion: 1, n: 2 })
  assert.deepEqual(fs.readdirSync(dir), ['state.json'], 'a non-durable write leaves no temp file behind')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('derived counters do not fsync: the ledger, the daily budget, the sender quota', () => {
  const dir = freshDir('wx-durable-derived-')

  assert.equal(countFsyncs(() => recordUsage(dir, {
    accountId: 'bot@im.bot',
    conversationId: 'wxid_a@im.wxid',
    model: 'deepseek/deepseek-chat',
    prompt: '你好呀',
    reply: '我在的',
  })), 0, 'the usage ledger is an estimate that rebuilds its view')

  assert.equal(countFsyncs(() => recordBackgroundCall(dir)), 0, "today's budget counter restarts at midnight anyway")

  const limiter = createSenderDailyLimiter({ stateRoot: dir, limit: 5 })
  assert.equal(countFsyncs(() => limiter.check('bot@im.bot', 'wxid_a')), 0, 'a quota counter for one local day')

  // ...and all three are still on disk and parse.
  const rows = conversationRows(dir, 'bot@im.bot')
  assert.equal(rows[0].turns, 1, 'the ledger still landed on disk')
  assert.ok(fs.existsSync(path.join(dir, 'budget.json')))
  assert.ok(fs.existsSync(path.join(dir, 'sender-daily.json')))
  fs.rmSync(dir, { recursive: true, force: true })
})
