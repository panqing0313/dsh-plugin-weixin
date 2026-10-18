/**
 * Routing tests: a message must reach the session line the conversation is
 * currently on, and switching lines must change which agent session runs next.
 *
 * These are the tests that fail if `attach()` goes back to deriving a single
 * fixed session id per conversation. The line store's own unit tests
 * (`test/sessions.test.js`) all still pass in that state — the store is fine,
 * the routing is what breaks — so this file exists to pin the routing itself.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-routing-'))
process.env.DSH_WEIXIN_STATE_DIR = stateRoot

const { SessionLines, baseSessionIdFor } = await import('../src/sessions.js')
const { AgentBridge } = await import('../src/agent-bridge.js')

test.after(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

/**
 * A bridge over a fake `agents` service that records every session it builds.
 *
 * `resume` is wired to succeed for any `weixin-` id so the bridge takes its
 * normal resume path, and the returned agent is a stub: these tests assert
 * WHICH session is attached, not what the agent decides to say.
 */
function fakeHost() {
  const built = []
  const live = new Map()
  const agents = {
    get: (id) => live.get(id),
    async resume({ resumeSessionId }) {
      if (!String(resumeSessionId).startsWith('weixin-')) throw new Error(`no such session: ${resumeSessionId}`)
      built.push(resumeSessionId)
      const agent = { session: { id: resumeSessionId }, inbox: { clear() {} } }
      live.set(resumeSessionId, agent)
      return { agent, dispose: async () => {} }
    },
    async create({ sessionId }) {
      built.push(sessionId)
      const agent = { session: { id: sessionId }, inbox: { clear() {} } }
      live.set(sessionId, agent)
      return { agent, dispose: async () => {} }
    },
  }
  const ctx = { get: (name) => (name === 'agents' ? agents : undefined) }
  return { ctx, built, live }
}

function bridgeOver(ctx, lines) {
  return new AgentBridge({ ctx, cwd: '/tmp/routing-test', lines, pollMs: 10 })
}

test('the first message of a conversation attaches the historical session id', async () => {
  fs.rmSync(path.join(stateRoot, 'sessions.json'), { force: true })
  const lines = new SessionLines()
  const { ctx, built } = fakeHost()
  const bridge = bridgeOver(ctx, lines)

  const record = await bridge.attach('room-a')
  assert.equal(record.agent.session.id, baseSessionIdFor('room-a'))
  assert.equal(record.agent.session.id, 'weixin-room-a')
  assert.deepEqual(built, ['weixin-room-a'], 'an existing-looking id must be resumed, not created')
})

test('/new makes the NEXT attach use a different session', async () => {
  fs.rmSync(path.join(stateRoot, 'sessions.json'), { force: true })
  const lines = new SessionLines()
  const { ctx, built } = fakeHost()
  const bridge = bridgeOver(ctx, lines)
  const conversationId = 'room-b'

  const first = await bridge.attach(conversationId)
  assert.equal(bridge.handleCommand(conversationId, '/new')?.includes('第 2 条会话'), true)

  const second = await bridge.attach(conversationId)
  assert.notEqual(
    second.agent.session.id,
    first.agent.session.id,
    'after /new the next message must not run in the session it was meant to leave',
  )
  assert.equal(second.agent.session.id, lines.active(conversationId))
  assert.equal(built.length, 2, 'the new line needs its own session')
})

test('/use switches the next attach back to the earlier session', async () => {
  fs.rmSync(path.join(stateRoot, 'sessions.json'), { force: true })
  const lines = new SessionLines()
  const { ctx, built } = fakeHost()
  const bridge = bridgeOver(ctx, lines)
  const conversationId = 'room-c'

  const first = await bridge.attach(conversationId)
  bridge.handleCommand(conversationId, '/new')
  await bridge.attach(conversationId)

  assert.equal(bridge.handleCommand(conversationId, '/use 1')?.includes('第 1 条会话'), true)
  const back = await bridge.attach(conversationId)

  assert.equal(back.agent.session.id, first.agent.session.id, 'switching back must reach the original session')
  // Context is genuinely preserved, not rebuilt: the same record comes back.
  assert.equal(back, first)
  // Only two sessions were ever built — switching back resumed the existing one.
  assert.deepEqual(built, [first.agent.session.id, lines.list(conversationId)[1].sessionId])
})

test('a session line survives a plugin reload and is resumed, not recreated', async () => {
  fs.rmSync(path.join(stateRoot, 'sessions.json'), { force: true })
  const first = new SessionLines()
  const hostA = fakeHost()
  const bridgeA = bridgeOver(hostA.ctx, first)
  const conversationId = 'room-d'
  await bridgeA.attach(conversationId)
  bridgeA.handleCommand(conversationId, '/new')
  await bridgeA.attach(conversationId)
  const secondLineId = first.active(conversationId)

  // A cold start: brand-new store object over the same directory, brand-new
  // bridge, brand-new host.
  const reloaded = new SessionLines()
  const hostB = fakeHost()
  const bridgeB = bridgeOver(hostB.ctx, reloaded)
  const record = await bridgeB.attach(conversationId)
  assert.equal(record.agent.session.id, secondLineId, 'the active line must survive a restart')
})

test('a command is not a message: handleCommand returns undefined for ordinary text', async () => {
  fs.rmSync(path.join(stateRoot, 'sessions.json'), { force: true })
  const lines = new SessionLines()
  const { ctx } = fakeHost()
  const bridge = bridgeOver(ctx, lines)
  const conversationId = 'room-e'

  for (const text of ['你好', '/steer 用中文回答', '看看 /new 这个命令', '/newx', '/use abc']) {
    assert.equal(bridge.handleCommand(conversationId, text), undefined, `${JSON.stringify(text)} must reach the agent`)
  }
  // `/steer` in particular must keep flowing: hijacking it would break the
  // existing steer feature.
  assert.equal(lines.list(conversationId).length, 1, 'no line may be created by a non-command')
})

test('sessionLines exposes the line list without changing what is active', async () => {
  fs.rmSync(path.join(stateRoot, 'sessions.json'), { force: true })
  const lines = new SessionLines()
  const { ctx } = fakeHost()
  const bridge = bridgeOver(ctx, lines)
  const conversationId = 'room-f'
  bridge.handleCommand(conversationId, '/new')
  const before = lines.active(conversationId)

  const listed = bridge.sessionLines(conversationId)
  assert.equal(listed.length, 2)
  assert.equal(lines.active(conversationId), before, 'reading the list must not switch the conversation')
})

test('a session command aimed at one account never touches another account\'s lines', async () => {
  fs.rmSync(path.join(stateRoot, 'sessions.json'), { force: true })
  const lines = new SessionLines()
  const { ctx } = fakeHost()
  const bridge = bridgeOver(ctx, lines)
  const conversationId = 'room-multi'
  const accountA = 'aaaaaaaaaaaa@im.bot'
  const accountB = 'bbbbbbbbbbbb@im.bot'

  // Account A opens a fresh line; account B must still be on its first.
  const aReply = bridge.handleCommand(conversationId, '/new', accountA)
  assert.match(aReply ?? '', /已开启第 2 条/)
  assert.equal(bridge.sessionLines(conversationId, accountA).length, 2)
  assert.equal(bridge.sessionLines(conversationId, accountB).length, 1)
  assert.equal(bridge.sessionLines(conversationId).length, 1, 'the bare key is untouched by account-scoped commands')

  // B lists its own (single) line even though A has two.
  const bReply = bridge.handleCommand(conversationId, '/list', accountB)
  assert.match(bReply ?? '', /共 1 条会话/)
})
