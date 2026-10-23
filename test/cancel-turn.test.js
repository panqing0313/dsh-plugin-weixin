/**
 * Behavioural guards for `/cancel` — interrupting the turn that is running now.
 *
 * The gap this closes: a long tool run (a build, a scan, a stuck subagent) had
 * no way out from WeChat. The only lever was `/steer`, which adds context to
 * the turn that is already too slow, and a plain message, which is queued
 * BEHIND that turn. So the user's "stop" could not be heard until the thing
 * they wanted stopped had finished.
 *
 * Three properties matter and each has a test:
 *
 *  1. `/cancel` is answered as a command, so it works while busy — that is the
 *     whole point, and a command that only worked when idle would be useless.
 *  2. The abort is reported as a cancellation, not as a model failure. The host
 *     ends the turn with an error event; without the flag the user would read
 *     "（模型调用失败：…）" for something they asked for.
 *  3. The flag is cleared when the turn settles, so the NEXT turn's reply is
 *     not silently swallowed.
 *
 * The fake agent mimics exactly the surface AgentBridge touches:
 * `inbox.clear()`, `session.id`, `session.snapshotEvents()`, `followup()`, and
 * — new here — `cancel(cause)`, which records the cause and ends the turn with
 * an error event, the way the real agent does.
 * @module dsh-weixin/test/cancel-turn
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// The vendored logger resolves its directory when it is first imported, so it
// must be redirected before src/agent-bridge.js (via src/index.js) loads.
const LOG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-cancel-logs-'))
const previousLogDir = process.env.DSH_WEIXIN_LOG_DIR
process.env.DSH_WEIXIN_LOG_DIR = LOG_ROOT

test.after?.(() => {
  if (previousLogDir === undefined) delete process.env.DSH_WEIXIN_LOG_DIR
  else process.env.DSH_WEIXIN_LOG_DIR = previousLogDir
  fs.rmSync(LOG_ROOT, { recursive: true, force: true })
})

/**
 * A fake agent whose turn stays open until the test settles it.
 *
 * `cancel(cause)` is what `/cancel` must reach: it records the cause and ends
 * the running turn with a `turn/end` error event, which is exactly the shape
 * the host produces when a turn is aborted.
 */
function fakeAgent({ withCancel = true } = {}) {
  const calls = { followup: [], steer: [], cancel: [] }
  let seq = 0
  let open = false
  const events = []
  const agent = {
    inbox: { clear() {} },
    session: {
      id: 'weixin-room-cancel',
      snapshotEvents: () => events,
    },
    followup(message) {
      calls.followup.push(message)
      open = true
    },
    steer(message) {
      calls.steer.push(message)
    },
  }
  if (withCancel) {
    agent.cancel = (cause) => {
      calls.cancel.push(cause)
      if (!open) return
      open = false
      seq += 1
      events.push({ seq, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'aborted' } } } })
    }
  }
  return {
    agent,
    calls,
    /** Emit a settled assistant message, ending the open turn normally. */
    release(text = 'done') {
      open = false
      seq += 1
      events.push({ seq, type: 'assistant/message', data: { step: seq, turn: seq, message: { content: [{ type: 'text', text }] } } })
    },
  }
}

/** An AgentBridge over a fake `agents` service whose `create` returns `fake`. */
async function bridgeWith(fake, overrides = {}) {
  const { AgentBridge } = await import('../src/agent-bridge.js')
  const agents = {
    get: () => undefined,
    async create() {
      return { agent: fake.agent, dispose: async () => {} }
    },
  }
  const ctx = { get: (n) => (n === 'agents' ? agents : undefined) }
  const { SessionLines } = await import('../src/sessions.js')
  return new AgentBridge({
    ctx,
    cwd: '/tmp/cancel-test',
    pollMs: 20,
    maxWaitMs: 3000,
    lines: new SessionLines({ warn: () => {} }),
    ...overrides,
  })
}

test('the parser accepts /cancel and its Chinese alias', async () => {
  const { parseSessionCommand } = await import('../src/sessions.js')
  assert.deepEqual(parseSessionCommand('/cancel'), { command: 'cancel' })
  assert.deepEqual(parseSessionCommand('  /CANCEL  '), { command: 'cancel' })
  assert.deepEqual(parseSessionCommand('/取消'), { command: 'cancel' })
  // It must not swallow a message that merely starts with the word.
  assert.equal(parseSessionCommand('/cancel please'), undefined)
})

test('/cancel with no running turn says so and calls nothing', async () => {
  const fake = fakeAgent()
  const bridge = await bridgeWith(fake)

  const reply = bridge.handleCommand('room-cancel', '/cancel', 'acc')

  assert.equal(reply, '当前没有正在跑的回合，不需要取消。')
  assert.deepEqual(fake.calls.cancel, [], 'nothing to cancel must not reach the host')
})

test('/cancel interrupts a running turn and reports it as cancelled, not failed', async () => {
  const fake = fakeAgent()
  const bridge = await bridgeWith(fake)

  const turn = bridge.deliver({ conversationId: 'room-cancel', accountId: 'acc', text: 'run the long thing' })
  // Let attach()/followup() happen: the turn is running and never settles on
  // its own, which is the situation /cancel exists for.
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(fake.calls.followup.length, 1, 'the turn must be running before cancelling')

  const reply = bridge.handleCommand('room-cancel', '/cancel', 'acc')
  assert.equal(reply, '已请求取消当前回合。')
  assert.deepEqual(fake.calls.cancel, [{ kind: 'user' }], 'the host abort must carry the user cause')

  const result = await turn
  assert.equal(result.text, '', 'a cancelled turn has nothing to send: /cancel already replied')
  assert.equal(result.cancelled, true)
})

test('the cancelled flag does not leak into the next turn', async () => {
  const fake = fakeAgent()
  const bridge = await bridgeWith(fake)

  const first = bridge.deliver({ conversationId: 'room-cancel', accountId: 'acc', text: 'first' })
  await new Promise((resolve) => setTimeout(resolve, 120))
  bridge.handleCommand('room-cancel', '/cancel', 'acc')
  const cancelled = await first
  assert.equal(cancelled.cancelled, true)

  // The second turn settles normally: if the flag had survived, its reply
  // would be dropped and the user would get silence after every cancel.
  const second = bridge.deliver({ conversationId: 'room-cancel', accountId: 'acc', text: 'second' })
  setTimeout(() => fake.release('answer-2'), 80)
  const result = await second
  assert.equal(result.text, 'answer-2')
  assert.notEqual(result.cancelled, true)
})

test('a host without cancel() is told it cannot interrupt, instead of a false success', async () => {
  const fake = fakeAgent({ withCancel: false })
  const bridge = await bridgeWith(fake)

  const turn = bridge.deliver({ conversationId: 'room-cancel', accountId: 'acc', text: 'long thing' })
  await new Promise((resolve) => setTimeout(resolve, 120))

  const reply = bridge.handleCommand('room-cancel', '/cancel', 'acc')
  assert.match(reply, /不支持中断回合/)

  fake.release('finished anyway')
  const result = await turn
  assert.equal(result.text, 'finished anyway', 'a refused cancel must leave the turn untouched')
})
