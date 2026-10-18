/**
 * A session-control command must be answered by the plugin and must never
 * reach the agent.
 *
 * This is a separate file from `inbound-loop-start.test.js` because it needs a
 * fake iLink that actually DELIVERS an inbound message (that file's server
 * always returns `msgs: []`), and a fake `agents` service that records what it
 * was asked to run.
 *
 * The property that matters is the second half: `/new` must not run inside the
 * very session it is meant to leave. If the command were forwarded to the
 * agent, `/new` would cost a model turn and answer from the old context, and
 * `/list` would burn context printing a list the plugin already knows.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const ACCOUNT_ID = 'bot1'
const ALLOWED = 'wxid_abc'

const LOG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-cmd-logs-'))
const previousLogDir = process.env.DSH_WEIXIN_LOG_DIR
process.env.DSH_WEIXIN_LOG_DIR = LOG_ROOT

const roots = []

after(() => {
  if (previousLogDir === undefined) delete process.env.DSH_WEIXIN_LOG_DIR
  else process.env.DSH_WEIXIN_LOG_DIR = previousLogDir
  fs.rmSync(LOG_ROOT, { recursive: true, force: true })
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function withStateRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-cmd-state-'))
  roots.push(root)
  return root
}

/**
 * A fake iLink that delivers ONE queued inbound text message.
 *
 * `sendmessage` bodies are recorded so a test can assert what the plugin
 * replied. `getupdates` answers with the queued message once and then an empty
 * poll, the same shape a real long-poll produces after a delivery.
 */
async function startFakeILink() {
  /** @type {Array<{text: string}>} */
  const outbound = []
  const seen = { getupdates: 0, delivered: 0, inboundTexts: [] }
  /** @type {Array<object>} */
  const queue = []

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      res.setHeader('content-type', 'application/json')
      if (url.pathname === '/ilink/bot/getconfig') {
        const parsed = body ? JSON.parse(body) : {}
        if (!parsed.ilink_user_id) return res.end(JSON.stringify({ ret: -2, errmsg: 'ilink_user_id required' }))
        return res.end(JSON.stringify({ ret: 0, typing_ticket: 'TT' }))
      }
      if (url.pathname === '/ilink/bot/sendmessage') {
        const parsed = body ? JSON.parse(body) : {}
        const items = parsed?.msg?.item_list ?? []
        const text = items.map((item) => item?.text_item?.text ?? '').join('')
        outbound.push({ text })
        return res.end(JSON.stringify({ ret: 0 }))
      }
      if (url.pathname === '/ilink/bot/getupdates') {
        seen.getupdates += 1
        const next = queue.shift()
        if (next !== undefined) seen.delivered += 1
        return res.end(JSON.stringify({
          ret: 0,
          get_updates_buf: 'buf',
          longpolling_ms: 50,
          msgs: next === undefined ? [] : [next],
        }))
      }
      res.end(JSON.stringify({ ret: 0 }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  /** Queue one inbound text message; `from` defaults to the allowed operator. */
  function deliver(text, messageId, from = ALLOWED) {
    seen.inboundTexts.push(text)
    queue.push({
      message_id: messageId,
      from_user_id: from,
      message_type: 1,
      message_state: 2,
      context_token: 'CT',
      create_time_ms: Date.now(),
      item_list: [{ type: 1, text_item: { text } }],
    })
  }
  return { server, baseUrl, seen, outbound, deliver }
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  })
}

async function waitFor(check, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

function seedAccount(root, { baseUrl, token = 'tok-1' }) {
  fs.mkdirSync(path.join(root, 'openclaw-weixin', 'accounts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'openclaw-weixin', 'accounts', `${ACCOUNT_ID}.json`), JSON.stringify({
    accountId: ACCOUNT_ID,
    token,
    baseUrl,
    userId: 'me@im.wechat',
    savedAt: new Date().toISOString(),
  }))
  fs.writeFileSync(path.join(root, 'openclaw-weixin', 'accounts.json'), JSON.stringify([ACCOUNT_ID]))
}

/**
 * Apply the plugin against a fake host that records every agent session it is
 * asked to open, run `body`, then dispose exactly as the host would.
 */
async function withPlugin(body) {
  const root = withStateRoot()
  const previousStateDir = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = root
  const fake = await startFakeILink()
  const servers = [fake.server]

  const lines = []
  const disposers = []
  /** @type {string[]} */
  const sessionsOpened = []
  /** Session handles the bridge explicitly tore down (e.g. via /clear). */
  const disposedSessions = []
  const trackedDispose = (sessionId) => async () => { disposedSessions.push(sessionId) }
  let deliverCalls = 0

  const agents = {
    get: () => undefined,
    async resume({ resumeSessionId }) {
      sessionsOpened.push(resumeSessionId)
      return { agent: { session: { id: resumeSessionId }, inbox: { clear() {} } }, dispose: trackedDispose(resumeSessionId) }
    },
    async create({ sessionId }) {
      sessionsOpened.push(sessionId)
      return { agent: { session: { id: sessionId }, inbox: { clear() {} } }, dispose: trackedDispose(sessionId) }
    },
  }

  const ctx = {
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    effect(fn) {
      disposers.push(fn())
      return { dispose() {} }
    },
    reflect: { provide: () => () => {} },
    plugin(instance) {
      if (typeof instance !== 'function' && typeof instance?.apply !== 'function') {
        throw new Error(`invalid plugin, expect function or object with an "apply" method, received ${typeof instance}`)
      }
      return instance
    },
    get: (name) => (name === 'agents' ? agents : undefined),
  }

  const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
  try {
    plugin.apply(ctx, plugin.Config({ allowedSenders: [ALLOWED], typingIndicator: false }))
    seedAccount(root, { baseUrl: fake.baseUrl })
    await waitFor(() => fake.seen.getupdates > 0, 'the inbound loop to start')
    await body({ root, lines, fake, sessionsOpened, servers, agents, disposedSessions, get deliverCalls() { return deliverCalls } })
  } finally {
    for (const disposer of disposers) await (await disposer)?.()
    for (const target of servers.reverse()) await closeServer(target)
    if (previousStateDir === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previousStateDir
  }
}

test('/new is answered by the plugin and never reaches the agent', async () => {
  await withPlugin(async ({ fake, sessionsOpened }) => {
    fake.deliver('/new', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the command reply')
    const reply = fake.outbound[0].text
    assert.match(reply, /已开启第 2 条会话/)
    assert.equal(fake.seen.delivered, 1, 'the message must have been delivered to the plugin')
    // The decisive assertion: no agent session was ever opened for a command.
    assert.deepEqual(sessionsOpened, [], 'a command must not cost a model turn')
  })
})

test('/list is answered without opening an agent session', async () => {
  await withPlugin(async ({ fake, sessionsOpened }) => {
    fake.deliver('/list', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the list reply')
    assert.match(fake.outbound[0].text, /共 1 条会话，当前使用第 1 条/)
    assert.deepEqual(sessionsOpened, [], '/list must be answered from the index, not by the model')
  })
})

test('an ordinary message still goes to the agent', async () => {
  await withPlugin(async ({ fake, sessionsOpened }) => {
    fake.deliver('你好，帮我看下构建', 'm1')
    await waitFor(() => sessionsOpened.length > 0, 'the agent session to open for a real message')
    assert.equal(sessionsOpened.length, 1)
    // The first line: the historical id, so an existing conversation keeps its
    // context across the upgrade that introduced session lines.
    assert.equal(sessionsOpened[0], 'weixin-wxid-abc')
  })
})

test('a refused sender cannot steer the conversation, even with a valid command', async () => {
  await withPlugin(async ({ fake, sessionsOpened, lines }) => {
    // The allowlist gate runs first. The FIRST stranger is the first-contact
    // enrolment (whoever scans owns the account), so their command is
    // ANSWERED — /new replies and never opens an agent session (that is the
    // contract asserted by the /new test above), so the reply is the proof.
    fake.deliver('/new', 'm1', 'wxid_stranger')
    await waitFor(() => fake.outbound.length > 0, 'the enrolled first contact to get the command reply')
    assert.match(fake.outbound[0].text, /已开启第 2 条会话/)
    assert.deepEqual(sessionsOpened, [], 'a command must not cost a model turn, even for the enrolled contact')
    // A SECOND stranger arrives after the enrolment: refused, before any
    // session command, silently to the sender.
    fake.deliver('/list', 'm2', 'wxid_second_stranger')
    await waitFor(
      () => lines.some((line) => /refused message from wxid_second_stranger/.test(line)),
      'the refusal to be logged',
    )
    assert.deepEqual(sessionsOpened, [], 'a refused sender must not open or switch a session')
    assert.equal(fake.outbound.length, 1, 'a refusal must be silent to the sender')
  })
})

test('a command does not start the typing indicator or an agent turn', async () => {
  await withPlugin(async ({ fake }) => {
    fake.deliver('/list', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the reply')
    // Exactly one outbound message: the reply itself. A typing indicator or a
    // second bubble would mean the command leaked into the normal path.
    assert.equal(fake.outbound.length, 1)
    assert.match(fake.outbound[0].text, /共 1 条会话/)
  })
})

test('/clear clears the context and the next message opens a fresh session', async () => {
  await withPlugin(async ({ fake, sessionsOpened, disposedSessions }) => {
    // Turn 1 lands in the historical base session and gives it context.
    fake.deliver('记一下：项目代号是蓝鲸', 'm1')
    await waitFor(() => sessionsOpened.length > 0, 'the first session to open')
    const oldId = sessionsOpened[0]
    await waitFor(() => fake.outbound.length > 0, 'the first reply')
    fake.outbound.length = 0

    fake.deliver('/clear', 'm2')
    await waitFor(() => fake.outbound.length > 0, 'the clear reply')
    assert.match(fake.outbound[0].text, /已清空当前会话/)
    assert.equal(fake.seen.delivered, 2, 'a command must not cost a model turn')

    // The orphaned record must be torn down: a stale agent that keeps
    // answering would let queued messages reach a session the user believes
    // is gone.
    await waitFor(() => disposedSessions.includes(oldId), 'the old session handle to be disposed')

    // The next message must NOT go back to the cleared session id.
    fake.deliver('蓝鲸是什么？', 'm3')
    await waitFor(() => sessionsOpened.length > 1, 'the fresh session to open')
    const freshId = sessionsOpened[sessionsOpened.length - 1]
    assert.notEqual(freshId, oldId, 'the next message must open a different session')
    assert.match(freshId, /--/, 'the fresh session must be a stamped new line')
    await waitFor(() => fake.outbound.length > 0, 'the fresh reply')
  })
})

test('/status answers with account facts and no agent turn', async () => {
  await withPlugin(async ({ fake, sessionsOpened }) => {
    fake.deliver('/status', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the status reply')
    const reply = fake.outbound[0].text
    // The inbound handler assembles the context from the registry: the seeded
    // account has no label and no override, so the status names the raw id and
    // the global list (which this harness seeds with ALLOWED).
    assert.match(reply, /发信人白名单：1 人（全局名单）/)
    assert.match(reply, /1 条会话线/)
    assert.deepEqual(sessionsOpened, [], '/status must cost no model turn, like every session command')
  })
})
