/**
 * The event-poll cadence: a reply that lands between two slow polls used to
 * wait up to a full second, on every message.
 *
 * The host never pushes session events, so the only way to see an answer is to
 * snapshot the event log. At the steady `eventPollMs` (1000ms in production)
 * a 20ms turn could still take ~1s to surface. These tests pin the adaptive
 * behaviour: tight polling while the turn is young, then the old cadence.
 *
 * @module dsh-weixin/test/event-poll
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { hostTest } from './host-packages.mjs'

const LOG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-poll-logs-'))
const previousLogDir = process.env.DSH_WEIXIN_LOG_DIR
process.env.DSH_WEIXIN_LOG_DIR = LOG_ROOT

test.after?.(() => {
  if (previousLogDir === undefined) delete process.env.DSH_WEIXIN_LOG_DIR
  else process.env.DSH_WEIXIN_LOG_DIR = previousLogDir
  fs.rmSync(LOG_ROOT, { recursive: true, force: true })
})

/**
 * A fake agent that records when its event log was read, so a test can tell
 * a tight loop from a slow one without trusting wall clock alone.
 */
function fakeAgent() {
  const events = []
  const reads = []
  let seq = 0
  const agent = {
    inbox: { clear() {} },
    session: {
      id: 'weixin-poll-1',
      snapshotEvents: () => {
        reads.push(Date.now())
        return events
      },
    },
    followup() {},
    steer() {},
  }
  return {
    agent,
    reads,
    release(text = 'done') {
      seq += 1
      events.push({ seq, type: 'assistant/message', data: { step: seq, turn: seq, message: { content: [{ type: 'text', text }] } } })
    },
  }
}

async function bridgeWith(fake, overrides = {}) {
  const { AgentBridge } = await import('../src/agent-bridge.js')
  const agents = {
    get: () => undefined,
    async create() { return { agent: fake.agent, dispose: async () => {} } },
  }
  const { SessionLines } = await import('../src/sessions.js')
  return new AgentBridge({
    ctx: { get: (name) => (name === 'agents' ? agents : undefined) },
    cwd: '/tmp/event-poll-test',
    pollMs: 1000,
    eventPollMs: 1000,
    maxWaitMs: 5000,
    lines: new SessionLines({ warn: () => {} }),
    ...overrides,
  })
}

hostTest('a reply that lands right after a poll is seen in well under the steady cadence', async () => {
  const fake = fakeAgent()
  const bridge = await bridgeWith(fake)
  // The knobs default to "tight at first, then the configured cadence".
  assert.equal(bridge.eventPollFastMs, 50)
  assert.equal(bridge.eventPollFastWindowMs, 400)

  const started = Date.now()
  const pending = bridge.deliver({ conversationId: 'room-1', text: 'hi' })
  setTimeout(() => fake.release('answer'), 20)
  const result = await pending
  const elapsed = Date.now() - started

  assert.equal(result.text, 'answer')
  // Before this change the same turn took ~1000ms: the answer sat in the log
  // until the next steady poll. 400ms is a generous ceiling for a 20ms turn.
  assert.ok(elapsed < 400, `expected the fast window to catch the reply, took ${elapsed}ms`)
})

hostTest('after the fast window the loop relaxes back to eventPollMs', async () => {
  const fake = fakeAgent()
  const bridge = await bridgeWith(fake, { maxWaitMs: 6000 })

  const pending = bridge.deliver({ conversationId: 'room-1', text: 'slow' })
  // Land the answer past the fast window: from here on the loop must tick at
  // 1000ms, not 50ms, or a long tool run would cost 20× the snapshots.
  setTimeout(() => fake.release('late answer'), 700)
  const result = await pending
  assert.equal(result.text, 'late answer')

  const now = Date.now()
  const duringRelaxed = fake.reads.filter((at) => now - at > 400 && now - at < 700).length
  assert.ok(duringRelaxed <= 3, `expected the relaxed cadence after 400ms, saw ${duringRelaxed} reads in 300ms`)
})

hostTest('the fast window can be tuned, and never outruns eventPollMs', async () => {
  const quick = fakeAgent()
  const bridge = await bridgeWith(quick, { eventPollFastMs: 10, eventPollFastWindowMs: 200 })
  assert.equal(bridge.eventPollFastMs, 10)
  const started = Date.now()
  const pending = bridge.deliver({ conversationId: 'room-1', text: 'hi' })
  setTimeout(() => quick.release('fast'), 5)
  await pending
  assert.ok(Date.now() - started < 200, 'a 10ms fast poll should catch a 5ms turn almost immediately')

  // A caller asking for a slower event poll must not be sped up by the default
  // fast value: min(50, eventPollMs).
  const slow = fakeAgent()
  const relaxed = await bridgeWith(slow, { eventPollMs: 20 })
  assert.equal(relaxed.eventPollFastMs, 20, 'the fast cadence is capped by the steady one')
})
