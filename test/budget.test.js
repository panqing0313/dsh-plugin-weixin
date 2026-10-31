import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { backgroundBudget, budgetDay, readBudget, recordBackgroundCall } from '../src/budget.js'
import { AgentBridge } from '../src/agent-bridge.js'

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-budget-'))
}

test('0 means unlimited, and the counter is still readable', () => {
  const root = tempRoot()
  assert.deepEqual(backgroundBudget(root, { limit: 0 }), { allowed: true, used: 0, limit: 0 })
  recordBackgroundCall(root)
  assert.equal(backgroundBudget(root, { limit: 0 }).used, 1)
})

test('the limit blocks the call after it is reached', () => {
  const root = tempRoot()
  const at = new Date(2026, 9, 31, 10, 0, 0)
  assert.equal(backgroundBudget(root, { limit: 2, now: at }).allowed, true)
  recordBackgroundCall(root, { now: at })
  assert.equal(backgroundBudget(root, { limit: 2, now: at }).allowed, true)
  recordBackgroundCall(root, { now: at })
  const blocked = backgroundBudget(root, { limit: 2, now: at })
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.used, 2)
  assert.match(blocked.reason, /2\/2/)
})

test('a new day starts from zero without deleting the file', () => {
  const root = tempRoot()
  const today = new Date(2026, 9, 31, 23, 0, 0)
  const tomorrow = new Date(2026, 10, 1, 0, 5, 0)
  recordBackgroundCall(root, { now: today })
  recordBackgroundCall(root, { now: today })
  assert.equal(readBudget(root, { now: today }).used, 2)
  assert.deepEqual(readBudget(root, { now: tomorrow }), { day: budgetDay(tomorrow), used: 0 })
  assert.equal(backgroundBudget(root, { limit: 1, now: tomorrow }).allowed, true)
})

test('a corrupt or missing file reads as zero, with a warning', () => {
  const root = tempRoot()
  const warnings = []
  fs.writeFileSync(path.join(root, 'budget.json'), '{not json')
  assert.deepEqual(readBudget(root, { warn: (line) => warnings.push(line) }), { day: budgetDay(), used: 0 })
  assert.ok(warnings.length > 0)
  assert.deepEqual(readBudget(path.join(root, 'missing'), {}), { day: budgetDay(), used: 0 })
})

test('the bridge asks before a background call and stops on a refusal', async () => {
  let asked = 0
  let counted = 0
  const bridge = new AgentBridge({
    ctx: {},
    cwd: '/tmp',
    log: () => {},
    allowBackground: () => {
      asked += 1
      return { allowed: false, reason: 'background budget 3/3 used today' }
    },
    onBackgroundCall: () => {
      counted += 1
    },
  })
  const result = await bridge.summarize({ conversationId: 'c1', accountId: 'a1', prompt: 'fold this' })
  assert.equal(result, undefined)
  assert.equal(asked, 1)
  assert.equal(counted, 0, 'a refused call is not counted as a call')
})
