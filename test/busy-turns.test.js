/**
 * Behavioural guards for busy-turn handling in the Weixin channel.
 *
 * Before this suite existed, a message that arrived while the agent was still
 * running a turn was bounced with "上一条消息还在处理中" — the user had to
 * guess when to retry. The channel now offers the two dispositions dsh-im
 * proved out across nine IM platforms:
 *
 *  - **queue** (default): the message waits in a FIFO tail and is delivered
 *    automatically when the current turn settles, with a receipt telling the
 *    user it was queued.
 *  - **steer**: the message is injected into the *running* turn at the next
 *    step boundary through `agent.steer()`, which the DSH agent API exposes
 *    natively (`Agent.steer(message)` in dsh-agent-preset-registry's Agent
 *    interface; it sends with inbox target "next-step" and wakeup=true).
 *
 * `/steer <instruction>` is always a steer, regardless of the configured mode.
 *
 * The fake agent here mimics exactly the surface {@link AgentBridge} touches:
 * `inbox.clear()`, `session.id`, `session.snapshotEvents()`, `followup()`,
 * `steer()`. The reply comes from `readAssistantReply`, which scans events for
 * an assistant message after `before`, so the fake emits one on demand.
 * @module dsh-weixin/test/busy-turns
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')

// The vendored logger resolves its directory when it is first imported, so it
// must be redirected before src/agent-bridge.js (via src/index.js) loads.
const LOG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-busy-logs-'))
const previousLogDir = process.env.DSH_WEIXIN_LOG_DIR
process.env.DSH_WEIXIN_LOG_DIR = LOG_ROOT

test.after?.(() => {
  if (previousLogDir === undefined) delete process.env.DSH_WEIXIN_LOG_DIR
  else process.env.DSH_WEIXIN_LOG_DIR = previousLogDir
  fs.rmSync(LOG_ROOT, { recursive: true, force: true })
})

/**
 * A fake agent whose turn resolves when the test releases it.
 *
 * `followup` records the call and starts a turn that stays open until
 * `release(text)` emits an assistant message into the event log. `steer`
 * records its payload so a test can assert exactly what was injected.
 */
function fakeAgent() {
  const calls = { followup: [], steer: [] }
  let seq = 0
  const events = []
  const waiters = []
  const agent = {
    inbox: { clear() {} },
    session: {
      id: 'weixin-room-1',
      snapshotEvents: () => events,
    },
    followup(message) {
      calls.followup.push(message)
      // The turn starts; it produces no assistant event until released.
    },
    steer(message) {
      calls.steer.push(message)
    },
  }
  return {
    agent,
    calls,
    /** Emit an assistant message, settling whatever turn is pending. */
    release(text = 'done') {
      seq += 1
      events.push({ seq, type: 'assistant/message', data: { step: seq, turn: seq, message: { content: [{ type: 'text', text }] } } })
      for (const resolve of waiters.splice(0)) resolve()
    },
    /** Resolve when at least one more assistant event exists. */
    wait(ms = 2000) {
      const before = events.length
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms)
        waiters.push(() => {
          clearTimeout(timer)
          resolve(events.length > before)
        })
      })
    },
  }
}

/**
 * An AgentBridge over a fake `agents` service whose `create` returns `fake`.
 * @param {object} fake  from {@link fakeAgent}
 */
async function bridgeWith(fake, overrides = {}) {
  const { AgentBridge } = await import('../src/agent-bridge.js')
  const agents = {
    get: () => undefined,
    async create() { return { agent: fake.agent, dispose: async () => {} } },
  }
  const ctx = { get: (n) => (n === 'agents' ? agents : undefined) }
  // An explicit, in-memory line index: the default one is backed by
  // ~/.dsh/weixin/sessions.json, and these tests must not touch the
  // operator's real state.
  const { SessionLines } = await import('../src/sessions.js')
  const bridge = new AgentBridge({
    ctx,
    cwd: '/tmp/busy-test',
    pollMs: 20,
    maxWaitMs: 3000,
    lines: new SessionLines({ warn: () => {} }),
    ...overrides,
  })
  return bridge
}

test('a message arriving during a turn is queued (default) and delivered after it settles', async () => {
  const fake = fakeAgent()
  const bridge = await bridgeWith(fake)

  const first = bridge.deliver({ conversationId: 'room-1', text: 'first' })
  // Settle the first turn on a timer; the reply event must reach the polling
  // loop of the first delivery (release must not depend on its resolution).
  setTimeout(() => fake.release('answer-1'), 300)

  const second = bridge.deliver({ conversationId: 'room-1', text: 'second' })
  // The queue must NOT call followup while the turn is busy: the queued
  // message is delivered only after the first reply settles.
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(fake.calls.followup.length, 1, 'a queued message must not start a second turn while one is running')

  // The queued turn runs after the first settles; its reply must arrive —
  // release answer-2 as soon as the drain starts its followup. The interval
  // is registered before any await: once deliver #1's finally begins the
  // drain, `await first` does not resume until the drain finishes, so a
  // late-registered release would always lose the race.
  const releaseSecond = setInterval(() => {
    if (fake.calls.followup.length >= 2) {
      clearInterval(releaseSecond)
      setTimeout(() => fake.release('answer-2'), 50)
    }
  }, 25)
  const firstResult = await first
  assert.equal(firstResult.text, 'answer-1')
  const secondResult = await second
  assert.equal(fake.calls.followup.length, 2, 'the queued message must be delivered after the first settles')
  assert.equal(secondResult.text, 'answer-2')
})

test('steer mode injects into the running turn via agent.steer', async () => {
  const fake = fakeAgent()
  const bridge = await bridgeWith(fake)

  const first = bridge.deliver({ conversationId: 'room-1', text: 'first' })
  setTimeout(() => fake.release('steered-answer'), 300)

  const second = bridge.deliver({ conversationId: 'room-1', text: 'correction', busyMessageMode: 'steer' })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(fake.calls.steer.length, 1, 'steer mode must call agent.steer while the turn runs')
  assert.equal(fake.calls.followup.length, 1, 'steer mode must not start a second turn')

  const firstResult = await first
  const secondResult = await second
  assert.equal(firstResult.text, 'steered-answer')
})

test('a steer arriving when the agent is idle degrades to a normal turn', async () => {
  const fake = fakeAgent()
  const bridge = await bridgeWith(fake)

  const delivery = bridge.deliver({ conversationId: 'room-1', text: 'only', busyMessageMode: 'steer' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  fake.release('answer')
  const result = await delivery

  assert.equal(fake.calls.followup.length, 1)
  assert.equal(fake.calls.steer.length, 0, 'an idle agent must be driven by followup, not steer')
  assert.equal(result.text, 'answer')
})

test('/steer <instruction> steers the running turn regardless of the configured mode', async () => {
  const fake = fakeAgent()
  const bridge = await bridgeWith(fake)

  const first = bridge.deliver({ conversationId: 'room-1', text: 'start work' })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const second = bridge.deliver({ conversationId: 'room-1', text: '/steer focus on the tests' })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(fake.calls.steer.length, 1, '/steer must reach agent.steer')
  const steered = fake.calls.steer[0]
  const text = steered?.content?.[0]?.text ?? ''
  assert.match(text, /focus on the tests/, 'the steer payload must carry the instruction')

  fake.release('done')
  await Promise.all([first, second])
})

test('a queued message resolves with its own reply; the receipt goes through onProgress', async () => {
  const fake = fakeAgent()
  const bridge = await bridgeWith(fake)
  const notes = []

  const first = bridge.deliver({ conversationId: 'room-1', text: 'first' })
  setTimeout(() => fake.release('answer-1'), 300)
  // When the drain starts the queued turn (followup #2), settle it too.
  const releaseSecond = setInterval(() => {
    if (fake.calls.followup.length >= 2) { clearInterval(releaseSecond); fake.release('answer-2') }
  }, 25)

  const second = bridge.deliver({
    conversationId: 'room-1',
    text: 'second',
    onProgress: (note) => { notes.push(note) },
  })
  const secondResult = await second

  // The receipt reached the send channel, and the resolved value is the real
  // answer of the queued turn — the caller sends it through the normal path.
  assert.ok(notes.some((n) => String(n).includes('已排队')), 'the queue receipt must go through onProgress')
  assert.equal(secondResult.text, 'answer-2')
})

test('a turn that outlives the wait still delivers its answer through onLateReply', async () => {
  const fake = fakeAgent()
  // Shrink both waits so the timeout path and the late window run quickly.
  const bridge = await bridgeWith(fake, { maxWaitMs: 150, lateReplyMaxWaitMs: 2000 })
  const late = []

  const delivery = bridge.deliver({
    conversationId: 'room-1',
    text: 'long-running question',
    onLateReply: (event) => { late.push(event) },
  })
  // The turn settles long after the wait gave up; release before awaiting so
  // the late listener is already running when the answer lands.
  setTimeout(() => fake.release('the late answer'), 300)
  const first = await delivery
  // With a late-reply channel the answer travels out of band: the deliver
  // promise resolves only after the late path finishes, flagged so the
  // caller skips its normal send.
  assert.equal(first.text, '')
  assert.equal(first.late, true, 'the caller must know the answer went out of band')

  await new Promise((resolve) => setTimeout(resolve, 800))

  assert.deepEqual(late.map((e) => e.kind), ['timeout-notice', 'reply'], 'notice first, then the late answer')
  assert.equal(late[1].text, 'the late answer')
})

test('without onLateReply the timeout path is unchanged', async () => {
  const fake = fakeAgent()
  const bridge = await bridgeWith(fake, { maxWaitMs: 120 })
  const reply = await bridge.deliver({ conversationId: 'room-1', text: 'q' })
  assert.equal(reply.text, '（处理超时，请稍后查看会话）')
})

test('a failed model turn is answered immediately instead of blocking the queue', async () => {
  // The field report: one model call fails (e.g. 429 RATE_LIMIT), and every
  // message after it sits queued. Mechanism (measured in a real session
  // transcript): the failed turn emits assistant/attempt events holding ONLY
  // usage/finish chunks — never a text-delta — and then turn/end with
  // reason.kind='error'. The reader saw no settled text, so the wait spun for
  // the whole budget with record.busy held; the user's next message queued
  // behind a turn that could never answer.
  const fake = fakeAgent()
  const bridge = await bridgeWith(fake, { maxWaitMs: 60_000 })

  const delivery = bridge.deliver({ conversationId: 'room-1', text: 'q' })
  // The turn fails almost immediately — the error is durable, no reply comes.
  // Push ONLY after followup is recorded: deliver() captures the `before` seq
  // BEFORE calling followup, so once followup is in, events 900/901 are
  // guaranteed to be after the cursor. (A fixed 50ms timer raced the first
  // attach and pushed before the cursor was captured — the reader then skipped
  // the error event and the wait spun out the full budget.)
  await new Promise((resolve) => {
    const wait = setInterval(() => {
      if (fake.calls.followup.length >= 1) { clearInterval(wait); resolve() }
    }, 5)
  })
  fake.agent.session.snapshotEvents().push(
    { seq: 900, type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } }] } },
    { seq: 901, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: '429: 余额不足或无可用资源包', code: 'RATE_LIMIT' } } } },
  )

  const startedAt = Date.now()
  const reply = await delivery
  const elapsed = Date.now() - startedAt

  // The failure becomes an answer, promptly — not a 60-second spin.
  assert.match(reply.text, /模型调用失败/)
  assert.match(reply.text, /429/)
  assert.ok(elapsed < 5000, `a failed turn must return promptly, took ${elapsed}ms`)

  // And the conversation is free: the next message runs its own turn right
  // away instead of queueing behind the dead one.
  const second = bridge.deliver({ conversationId: 'room-1', text: 'still there?' })
  const releaseNext = setInterval(() => {
    if (fake.calls.followup.length >= 2) {
      clearInterval(releaseNext)
      // Not fake.release: its event counter starts at 1, which is BELOW the
      // 900/901 this test pushed, so the reader would skip the reply as
      // already-consumed. Emit with a seq above everything on the log.
      const events2 = fake.agent.session.snapshotEvents()
      events2.push({ seq: 950, type: 'assistant/message', data: { step: 2, turn: 2, message: { content: [{ type: 'text', text: 'done' }] } } })
    }
  }, 25)
  const next = await second
  assert.equal(next.text, 'done', 'the next message must run normally after a failure')
})

test('the first message mirrors its fresh line title into the host sessionTitle', async () => {
  // The GUI sidebar renders the HOST's title, not the store's, so a fresh
  // `label: message` title must be mirrored through sessionTitle.rename —
  // the same call the host's own rename dialog makes. The store title stays
  // the source of truth: a mirror failure is logged, never fatal.
  fs.rmSync(path.join(process.env.DSH_WEIXIN_STATE_DIR ?? '', 'sessions.json'), { force: true })
  const fake = fakeAgent()
  const renames = []
  const agents = {
    get: () => undefined,
    async create() { return { agent: fake.agent, dispose: async () => {} } },
  }
  const ctx = {
    get: (n) => {
      if (n === 'agents') return agents
      if (n === 'sessionTitle') return { rename: (session, title) => { renames.push({ id: session.id, title }) } }
      return undefined
    },
  }
  const { AgentBridge } = await import('../src/agent-bridge.js')
  const { SessionLines } = await import('../src/sessions.js')
  const bridge = new AgentBridge({
    ctx,
    cwd: '/tmp/busy-test',
    pollMs: 20,
    maxWaitMs: 3000,
    lines: new SessionLines({ warn: () => {} }),
  })

  const first = bridge.deliver({ conversationId: 'mirror-room', text: 'first' })
  setTimeout(() => fake.release('done'), 300)
  const receipt = await first
  assert.equal(receipt.text, 'done')

  // Exactly one mirror, carrying the store's prefixed title to the same
  // session the message ran in.
  assert.equal(renames.length, 1, 'only the first message mirrors a title')
  // The mirror forwards the LIVE agent's session (the fakeAgent fixture id),
  // not a recomputed base id — the same session the message runs in.
  assert.equal(renames[0].id, 'weixin-room-1')
  assert.equal(renames[0].title, 'first', 'no label is set, so the bare-key line has no prefix')

  // A second message must NOT rename again — the store already named the
  // line, and the host title must stay pinned to the first message.
  const second = bridge.deliver({ conversationId: 'mirror-room', text: 'second' })
  setTimeout(() => fake.release('done 2'), 300)
  await second
  assert.equal(renames.length, 1, 'a later message never renames')

  // A mirror failure (host service absent) must not break the turn.
  fs.rmSync(path.join(process.env.DSH_WEIXIN_STATE_DIR ?? '', 'sessions.json'), { force: true })
  const fake2 = fakeAgent()
  const agents2 = {
    get: () => undefined,
    async create() { return { agent: fake2.agent, dispose: async () => {} } },
  }
  const ctx2 = { get: (n) => (n === 'agents' ? agents2 : undefined) }
  const bridge2 = new AgentBridge({
    ctx: ctx2,
    cwd: '/tmp/busy-test',
    pollMs: 20,
    maxWaitMs: 3000,
    lines: new SessionLines({ warn: () => {} }),
  })
  const only = bridge2.deliver({ conversationId: 'mirror-room-2', text: 'only' })
  setTimeout(() => fake2.release('done'), 300)
  const receipt2 = await only
  assert.equal(receipt2.text, 'done', 'a missing sessionTitle service must not fail delivery')
})

test('the store title carries the account prefix the host mirror receives', async () => {
  // Scoped lines are titled `label: message`; the mirror must forward THAT
  // text, so the sidebar shows the same attribution /list does.
  fs.rmSync(path.join(process.env.DSH_WEIXIN_STATE_DIR ?? '', 'sessions.json'), { force: true })
  const fake = fakeAgent()
  const renames = []
  const agents = {
    get: () => undefined,
    async create() { return { agent: fake.agent, dispose: async () => {} } },
  }
  const ctx = {
    get: (n) => {
      if (n === 'agents') return agents
      if (n === 'sessionTitle') return { rename: (session, title) => { renames.push(title) } }
      return undefined
    },
  }
  const { AgentBridge } = await import('../src/agent-bridge.js')
  const { SessionLines } = await import('../src/sessions.js')
  const bridge = new AgentBridge({
    ctx,
    cwd: '/tmp/busy-test',
    pollMs: 20,
    maxWaitMs: 3000,
    lines: new SessionLines({ warn: () => {} }),
  })
  const account = 'c0ffee000000@im.bot'

  const turn = bridge.deliver({ conversationId: 'mirror-cn', text: '你好', accountId: account })
  setTimeout(() => fake.release('done'), 300)
  await turn
  assert.deepEqual(renames, ['c0ffee000000: 你好'])
})
