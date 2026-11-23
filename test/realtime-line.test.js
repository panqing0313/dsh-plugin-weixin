/**
 * The mid-turn realtime line (issue #10): the bridge's `announce` throttle and
 * `lineForSession` reverse lookup. These drive the bridge directly with a fake
 * agent, so they pin the rules that protect the user from a chatty or
 * out-of-order bot — the tool wiring itself is covered by tool-realtime tests.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { hostTest } from './host-packages.mjs'

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-realtime-'))
process.env.DSH_WEIXIN_STATE_DIR = stateRoot
const LOG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-realtime-logs-'))
process.env.DSH_WEIXIN_LOG_DIR = LOG_ROOT

test.after(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true })
  fs.rmSync(LOG_ROOT, { recursive: true, force: true })
})

const { AgentBridge } = await import('../src/agent-bridge.js')
const { SessionLines, baseSessionIdFor } = await import('../src/sessions.js')

/** A fake agent that stays busy until the test releases its turn. */
function fakeAgent(sessionId) {
  const events = []
  const waiters = []
  let seq = 0
  const agent = {
    inbox: { clear() {} },
    session: { id: sessionId, snapshotEvents: () => events },
    followup() {},
    steer() {},
  }
  return {
    agent,
    release(text = 'done') {
      seq += 1
      events.push({ seq, type: 'assistant/message', data: { step: seq, turn: seq, message: { content: [{ type: 'text', text }] } } })
      for (const resolve of waiters.splice(0)) resolve()
    },
  }
}

async function bridgeWith(sessionId, overrides = {}) {
  const fake = fakeAgent(sessionId)
  const agents = {
    get: () => undefined,
    async create() { return { agent: fake.agent, dispose: async () => {} } },
  }
  const ctx = { get: (n) => (n === 'agents' ? agents : undefined) }
  const bridge = new AgentBridge({
    ctx,
    cwd: '/tmp/realtime-test',
    pollMs: 20,
    maxWaitMs: 3000,
    lines: new SessionLines({ warn: () => {} }),
    ...overrides,
  })
  return { bridge, fake }
}

test('no sink means the feature is off, and the verdict says so', async () => {
  const { bridge } = await bridgeWith(baseSessionIdFor('room-off'))
  const verdict = await bridge.announce({ conversationId: 'room-off', text: '在查了' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'off')
})

test('a line is delivered mid-turn, and the per-turn quota then refuses more', async () => {
  const sent = []
  const { bridge, fake } = await bridgeWith(baseSessionIdFor('room-quota'), {
    onRealtimeReady: async (entry) => { sent.push(entry.text) },
    realtimeMaxPerTurn: 2,
    realtimeMinIntervalMs: 0,
  })
  const running = bridge.deliver({ conversationId: 'room-quota', text: 'go' })
  // Let the turn start.
  await new Promise((r) => setTimeout(r, 30))

  const first = await bridge.announce({ conversationId: 'room-quota', text: '在查了' })
  assert.deepEqual(first, { ok: true, text: '在查了' })
  const second = await bridge.announce({ conversationId: 'room-quota', text: '找到两条' })
  assert.equal(second.ok, true)
  const third = await bridge.announce({ conversationId: 'room-quota', text: '再等等' })
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'limit')
  assert.deepEqual(sent, ['在查了', '找到两条'], 'only the two allowed lines reach WeChat')

  fake.release('done')
  await running
})

test('lines are spaced by the minimum interval', async () => {
  const { bridge, fake } = await bridgeWith(baseSessionIdFor('room-gap'), {
    onRealtimeReady: async () => {},
    realtimeMaxPerTurn: 5,
    realtimeMinIntervalMs: 60_000,
  })
  const running = bridge.deliver({ conversationId: 'room-gap', text: 'go' })
  await new Promise((r) => setTimeout(r, 30))
  const first = await bridge.announce({ conversationId: 'room-gap', text: '一' })
  assert.equal(first.ok, true)
  const second = await bridge.announce({ conversationId: 'room-gap', text: '二' })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'interval')
  fake.release('done')
  await running
})

test('an empty line is refused, not sent as a blank bubble', async () => {
  const sent = []
  const { bridge, fake } = await bridgeWith(baseSessionIdFor('room-empty'), {
    onRealtimeReady: async (entry) => { sent.push(entry.text) },
    realtimeMinIntervalMs: 0,
  })
  const running = bridge.deliver({ conversationId: 'room-empty', text: 'go' })
  await new Promise((r) => setTimeout(r, 30))
  const verdict = await bridge.announce({ conversationId: 'room-empty', text: '   ' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'empty')
  assert.equal(sent.length, 0)
  fake.release('done')
  await running
})

test('after the turn settles a line is refused as idle', async () => {
  const { bridge, fake } = await bridgeWith(baseSessionIdFor('room-late'), {
    onRealtimeReady: async () => {},
    realtimeMaxPerTurn: 5,
    realtimeMinIntervalMs: 0,
  })
  const running = bridge.deliver({ conversationId: 'room-late', text: 'go' })
  fake.release('done')
  await running
  const verdict = await bridge.announce({ conversationId: 'room-late', text: '补充一句' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'idle')
})

test('a failing sink costs the quota anyway, so a retry storm cannot happen', async () => {
  let calls = 0
  const { bridge, fake } = await bridgeWith(baseSessionIdFor('room-fail'), {
    onRealtimeReady: async () => { calls += 1; throw new Error('no transport') },
    realtimeMaxPerTurn: 1,
    realtimeMinIntervalMs: 0,
  })
  const running = bridge.deliver({ conversationId: 'room-fail', text: 'go' })
  await new Promise((r) => setTimeout(r, 30))
  const first = await bridge.announce({ conversationId: 'room-fail', text: '在查了' })
  assert.equal(first.ok, false)
  assert.equal(first.reason, 'failed')
  const second = await bridge.announce({ conversationId: 'room-fail', text: '再来' })
  assert.equal(second.reason, 'limit', 'the failed send still used the one-line budget')
  assert.equal(calls, 1)
  fake.release('done')
  await running
})

test('lineForSession maps a session id back to its conversation', async () => {
  const { bridge } = await bridgeWith(baseSessionIdFor('room-map'))
  const record = await bridge.attach('room-map')
  const line = bridge.lineForSession(record.agent.session.id)
  assert.deepEqual(line, { accountId: '', conversationId: 'room-map' })
  assert.equal(bridge.lineForSession('weixin-nobody'), undefined)
  assert.equal(bridge.lineForSession(undefined), undefined)
})
