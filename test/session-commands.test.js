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

import { hostTest } from './host-packages.mjs'

import { appendJournal } from '../src/message/journal.js'

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
  function deliver(text, messageId, from = ALLOWED, groupId = '') {
    seen.inboundTexts.push(text)
    queue.push({
      message_id: messageId,
      from_user_id: from,
      group_id: groupId,
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
async function withPlugin(body, overrides = {}) {
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

  // Side sessions (wx-mem-/wx-sub-/wx-sum-…) must be able to COMPLETE a turn:
  // the background summarizer, /subscribe and /summary all run through them.
  // Main sessions stay followup-less on purpose — a session command that leaks
  // to the agent would otherwise look like a working turn instead of the
  // failure this file exists to catch.
  const sideAgent = (sessionId) => {
    const events = []
    let seq = 0
    const ev = (type, data) => events.push({ type, seq: seq++, time: Date.now(), data })
    return {
      session: { id: sessionId, snapshotEvents: () => events },
      inbox: { clear() {} },
      followup(message) {
        ev('user/message', { message })
        ev('turn/start', {})
        setTimeout(() => {
          ev('assistant/message', { stream: [{ type: 'text-chunks', texts: ['（假总结）聊到了吃饭的安排。', message.content[0].text] }] })
          ev('turn/end', {})
        }, 20)
      },
    }
  }
  // C20: provider/model live in agentOptions, so recording it is how a test
  // sees which route a turn would actually run on.
  const agentOptionsSeen = []
  const agents = {
    get: () => undefined,
    async resume({ resumeSessionId, agentOptions }) {
      sessionsOpened.push(resumeSessionId)
      agentOptionsSeen.push({ sessionId: resumeSessionId, agentOptions })
      if (resumeSessionId.startsWith('wx-')) return { agent: sideAgent(resumeSessionId), dispose: trackedDispose(resumeSessionId) }
      return { agent: { session: { id: resumeSessionId }, inbox: { clear() {} } }, dispose: trackedDispose(resumeSessionId) }
    },
    async create({ sessionId, agentOptions }) {
      sessionsOpened.push(sessionId)
      agentOptionsSeen.push({ sessionId, agentOptions })
      if (sessionId.startsWith('wx-')) return { agent: sideAgent(sessionId), dispose: trackedDispose(sessionId) }
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
    plugin.apply(ctx, plugin.Config({ allowedSenders: [ALLOWED], typingIndicator: false, ...overrides }))
    seedAccount(root, { baseUrl: fake.baseUrl })
    await waitFor(() => fake.seen.getupdates > 0, 'the inbound loop to start')
    await body({ root, lines, fake, sessionsOpened, servers, agents, disposedSessions, agentOptionsSeen, get deliverCalls() { return deliverCalls } })
  } finally {
    // Debugging aid: DSH_DEBUG_LINES=1 dumps everything the plugin logged.
    if (process.env.DSH_DEBUG_LINES) console.error('LINES:\n' + lines.join('\n'))
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

test('/remind schedules a durable reminder that fires through the live transport', async () => {
  await withPlugin(async ({ fake, root, sessionsOpened }) => {
    // 1. The command is answered by the plugin at all, and costs no model turn.
    fake.deliver('/remind 3s 测试提醒内容', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the confirm reply')
    assert.match(fake.outbound[0].text, /我会提醒你（编号 /, 'the confirmation names the reminder id')
    assert.match(fake.outbound[0].text, /\/remindcancel/, 'the confirmation teaches the cancel command')
    assert.deepEqual(sessionsOpened, [], 'a remind command must cost no model turn')

    // 2. The reminder is durable: it sits in reminders.json under the state
    //    root before it fires, so a reload would re-arm it.
    const store = JSON.parse(fs.readFileSync(path.join(root, 'reminders.json'), 'utf8'))
    assert.equal(store.items.length, 1)
    assert.equal(store.items[0].text, '测试提醒内容')

    // 3. When the moment comes, the text goes out through the SAME fake iLink
    //    outbound channel — no agent turn involved.
    await waitFor(() => fake.outbound.some((line) => line.text.includes('测试提醒内容')), 'the reminder to fire', 8_000)
    assert.match(fake.outbound.find((line) => line.text.includes('测试提醒内容')).text, /（提醒：测试提醒内容）/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'reminders.json'), 'utf8')).items.length, 0, 'a fired reminder leaves the store')

    // 4. /remindlist then reports the empty truth.
    fake.deliver('/remindlist', 'm2')
    // The fired reminder is itself an outbound line, so `length > 1` is
    // already true the moment it lands: the list reply is the third one.
    await waitFor(() => fake.outbound.length > 2, 'the list reply')
    assert.match(fake.outbound[fake.outbound.length - 1].text, /没有待发的提醒/)
  })
})

test('/remind refuses a bad time, and /remindcancel removes a pending one', async () => {
  await withPlugin(async ({ fake, root }) => {
    fake.deliver('/remind 明天下午 喝水', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the refusal')
    assert.match(fake.outbound[0].text, /没有安排：还需要一个钟点/)

    fake.deliver('/remind 1h 还没发生的事', 'm2')
    await waitFor(() => fake.outbound.length > 1, 'the confirm')
    const id = /编号 (r\d+)/.exec(fake.outbound[1].text)?.[1]
    assert.ok(id, 'the confirm carries the id')

    fake.deliver(`/remindcancel ${id}`, 'm3')
    await waitFor(() => fake.outbound.length > 2, 'the cancel reply')
    assert.match(fake.outbound[2].text, new RegExp(`已取消提醒 ${id}`))
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'reminders.json'), 'utf8')).items.length, 0)

    fake.deliver(`/remindcancel ${id}`, 'm4')
    await waitFor(() => fake.outbound.length > 3, 'the second cancel reply')
    assert.match(fake.outbound[3].text, /没有找到编号/)
  })
})

test('/help lists every command with what it does', async () => {
  await withPlugin(async ({ fake, sessionsOpened }) => {
    fake.deliver('/help', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the help reply')
    const reply = fake.outbound[0].text
    assert.match(reply, /\/new 开一条新会话/)
    assert.match(reply, /\/list 查看这个微信会话下的所有会话/)
    assert.match(reply, /\/use <序号>/)
    assert.match(reply, /\/clear 清空当前会话/)
    assert.match(reply, /\/status 查看当前账号和会话的状态/)
    assert.match(reply, /\/remind <时间> <内容>/)
    assert.match(reply, /\/remindlist/)
    assert.match(reply, /\/remindcancel/)
    assert.match(reply, /\/mode \[名称\]/)
    assert.match(reply, /\/remember <内容>/)
    assert.match(reply, /\/forget \[编号或关键词\]/)
    assert.match(reply, /\/memory 查看记住的内容/)
    assert.deepEqual(sessionsOpened, [], '/help must not cost a model turn')
  })
})

test('/帮助 is an alias for /help', async () => {
  await withPlugin(async ({ fake }) => {
    fake.deliver('/帮助', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the help reply')
    assert.match(fake.outbound[0].text, /会话指令/)
  })
})

test('/mode bare lists the modes with the current one marked', async () => {
  await withPlugin(async ({ fake, sessionsOpened }) => {
    fake.deliver('/mode', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the mode list reply')
    const reply = fake.outbound[0].text
    assert.match(reply, /当前对话模式：默认助手/)
    assert.match(reply, /→默认助手（不扮演角色）/)
    assert.match(reply, /女友/)
    assert.match(reply, /男友/)
    assert.match(reply, /朋友/)
    assert.deepEqual(sessionsOpened, [], '/mode must not cost a model turn')
  })
})

test('/mode 女友 switches, pins the override, and opens a fresh session line', async () => {
  await withPlugin(async ({ root, fake, sessionsOpened }) => {
    fake.deliver('/mode 女友', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the switch reply')
    assert.match(fake.outbound[0].text, /已切换到「女友」模式，并开启了一条新会话线/)
    // The override landed in the state root as its own file.
    const overrides = JSON.parse(fs.readFileSync(path.join(root, 'persona-active.json'), 'utf8'))
    assert.equal(Object.values(overrides)[0], 'girlfriend')
    // A follow-up /mode marks 女友 as current.
    fake.deliver('/mode', 'm2')
    await waitFor(() => fake.outbound.length > 1, 'the second mode list')
    assert.match(fake.outbound[1].text, /当前对话模式：女友/)
    // Unknown names list what exists instead of guessing.
    fake.deliver('/mode 不存在的模式', 'm3')
    await waitFor(() => fake.outbound.length > 2, 'the unknown-mode reply')
    assert.match(fake.outbound[2].text, /没有叫「不存在的模式」的模式/)
    assert.match(fake.outbound[2].text, /默认、女友、男友、朋友、贾维斯、小鲸娘、御姐、知心大姐姐、暖男、可爱闺女、猫娘、傲娇、海龟汤、成语接龙、文字冒险/)
    // /mode 默认 pins default (it must NOT clear the override: the global
    // default may itself be a persona).
    fake.deliver('/mode 默认', 'm4')
    await waitFor(() => fake.outbound.length > 3, 'the back-to-default reply')
    assert.match(fake.outbound[3].text, /已切回默认助手模式，并开启了一条新会话线/)
    const after = JSON.parse(fs.readFileSync(path.join(root, 'persona-active.json'), 'utf8'))
    assert.equal(Object.values(after)[0], 'default')
    assert.deepEqual(sessionsOpened, [], 'no mode command may cost a model turn')
  })
})

test('/mode by English id also works (girlfriend)', async () => {
  await withPlugin(async ({ fake }) => {
    fake.deliver('/mode girlfriend', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the switch reply')
    assert.match(fake.outbound[0].text, /已切换到「女友」模式/)
  })
})

test('/remember stores a fact, /memory shows it, /forget removes it', async () => {
  await withPlugin(async ({ root, fake, sessionsOpened }) => {
    fake.deliver('/remember', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the usage reply')
    assert.match(fake.outbound[0].text, /用法：\/remember <要记住的内容>/)
    fake.deliver('/remember 我对花生过敏', 'm2')
    await waitFor(() => fake.outbound.length > 1, 'the stored reply')
    assert.match(fake.outbound[1].text, /已记住：我对花生过敏/)
    const store = JSON.parse(fs.readFileSync(path.join(root, 'memory', 'global-bot1.json'), 'utf8'))
    assert.deepEqual(store.facts.map((f) => f.text), ['我对花生过敏'])
    fake.deliver('/remember 我对花生过敏', 'm3')
    await waitFor(() => fake.outbound.length > 2, 'the duplicate reply')
    assert.match(fake.outbound[2].text, /这条已经记过了/)
    fake.deliver('/memory', 'm4')
    await waitFor(() => fake.outbound.length > 3, 'the memory view')
    assert.match(fake.outbound[3].text, /1\. 我对花生过敏/)
    assert.match(fake.outbound[3].text, /长期记忆：/)
    assert.match(fake.outbound[3].text, /本会话记忆：还没有摘要/)
    fake.deliver('/forget 5', 'm5')
    await waitFor(() => fake.outbound.length > 4, 'the bad index reply')
    assert.match(fake.outbound[4].text, /没有第 5 条/)
    fake.deliver('/forget 1', 'm6')
    await waitFor(() => fake.outbound.length > 5, 'the forget reply')
    assert.match(fake.outbound[5].text, /已忘掉：我对花生过敏/)
    assert.deepEqual(sessionsOpened, [], 'no memory command may cost a model turn')
  })
})

test('/forget by keyword: single hit forgets, several hits ask for the number', async () => {
  await withPlugin(async ({ root, fake }) => {
    fake.deliver('/remember 我对花生过敏', 'm1')
    fake.deliver('/remember 我住在杭州', 'm2')
    await waitFor(() => fake.outbound.length > 1, 'both facts stored')
    fake.deliver('/forget 杭州', 'm3')
    await waitFor(() => fake.outbound.length > 2, 'the single-hit reply')
    assert.match(fake.outbound[2].text, /已忘掉：我住在杭州/)
    fake.deliver('/remember 花生油也别碰', 'm4')
    await waitFor(() => fake.outbound.length > 3, 'second peanut fact stored')
    fake.deliver('/forget 花生', 'm5')
    await waitFor(() => fake.outbound.length > 4, 'the ambiguous reply')
    assert.match(fake.outbound[4].text, /用编号指明删哪条/)
    assert.match(fake.outbound[4].text, /1\. 我对花生过敏/)
    fake.deliver('/forget 没这个词', 'm6')
    await waitFor(() => fake.outbound.length > 5, 'the miss reply')
    assert.match(fake.outbound[5].text, /没有找到含「没这个词」的记忆/)
  })
})

test('a switching a mode does not disturb an ordinary queued message flow', async () => {
  await withPlugin(async ({ fake }) => {
    fake.deliver('/mode 朋友', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the switch reply')
    assert.match(fake.outbound[0].text, /已切换到「朋友」模式/)
  })
})

test('/status and /memory show the affinity line in a companion mode, never for the stock assistant', async () => {
  await withPlugin(async ({ fake, root }) => {
    // Seed the bond the settle point would have written (the settle-point
    // write itself is covered by the e2e summarizer test; this harness's fake
    // agents do not complete real turns). The conversation here is the peer id
    // itself: group_id is empty for direct messages.
    const { bumpTurnAndBond } = await import('../src/memory.js')
    bumpTurnAndBond(root, ACCOUNT_ID, ALLOWED)

    // Default assistant: facts only. An affinity line would be a lie about a
    // tool, so it is absent even though the bond exists.
    fake.deliver('/status', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the status reply')
    assert.ok(!fake.outbound[0].text.includes('我们认识第'), fake.outbound[0].text)

    // Switch to a companion: now it reports how long you two have known each
    // other. /mode opens a new session line; the bond lives on the
    // conversation, not the line, so it survives the switch.
    fake.deliver('/mode 女友', 'm2')
    await waitFor(() => fake.outbound.length > 1, 'the mode switch reply')

    fake.deliver('/status', 'm3')
    await waitFor(() => fake.outbound.length > 2, 'the companion status reply')
    assert.match(fake.outbound[2].text, /我们认识第 1 天 · 聊过 1 条消息/, fake.outbound[2].text)

    fake.deliver('/memory', 'm4')
    await waitFor(() => fake.outbound.length > 3, 'the memory reply')
    assert.match(fake.outbound[3].text, /我们认识第 1 天/, fake.outbound[3].text)
  })
})

test('/subscribe schedules, lists and cancels timed proactive messages', async () => {
  await withPlugin(async ({ fake, root, sessionsOpened }) => {
    fake.deliver('/subscribe', 'm0')
    await waitFor(() => fake.outbound.length > 0, 'the usage reply')
    assert.match(fake.outbound[0].text, /用法：\/subscribe/, fake.outbound[0].text)
    assert.match(fake.outbound[0].text, /每天 HH:mm/, 'the usage names the recurring forms')

    fake.deliver('/subscribe 每天 08:00 早安，问问我睡得怎么样', 'm1')
    await waitFor(() => fake.outbound.length > 1, 'the confirmation')
    assert.match(fake.outbound[1].text, /好的，每天 08:00 到点我会主动给你发一条（编号 s1）/, fake.outbound[1].text)
    assert.deepEqual(sessionsOpened, [], 'scheduling costs no model turn')

    const store = JSON.parse(fs.readFileSync(path.join(root, 'subscriptions.json'), 'utf8'))
    assert.equal(store.items.length, 1)
    assert.equal(store.items[0].kind, 'daily')
    assert.equal(store.items[0].time, '08:00')
    assert.equal(store.items[0].prompt, '早安，问问我睡得怎么样')
    assert.ok(store.items[0].fireAt > Date.now(), 'the first slot is in the future')

    fake.deliver('/subscribelist', 'm2')
    await waitFor(() => fake.outbound.length > 2, 'the list reply')
    assert.match(fake.outbound[2].text, /s1 · 每天 08:00 · 早安，问问我睡得怎么样/, fake.outbound[2].text)

    fake.deliver('/subscribe 每周日 21:30 聊聊这周', 'm3')
    await waitFor(() => fake.outbound.length > 3, 'the second confirmation')
    assert.match(fake.outbound[3].text, /每周日 21:30/, 'the weekly label renders')

    fake.deliver('/subscribecancel s1', 'm4')
    await waitFor(() => fake.outbound.length > 4, 'the cancel reply')
    assert.match(fake.outbound[4].text, /已取消定时消息 s1/, fake.outbound[4].text)
    const after = JSON.parse(fs.readFileSync(path.join(root, 'subscriptions.json'), 'utf8'))
    assert.deepEqual(after.items.map((item) => item.id), ['s2'])

    fake.deliver('/subscribecancel s9', 'm5')
    await waitFor(() => fake.outbound.length > 5, 'the miss reply')
    assert.match(fake.outbound[5].text, /没有找到编号 s9/, fake.outbound[5].text)
  })
})

test('/export renders the journal as markdown and spills to a file when long', async () => {
	await withPlugin(async ({ root, fake }) => {
		// A small export rides the normal reply channel.
		appendJournal(root, { dir: 'in', accountId: ACCOUNT_ID, conversationId: ALLOWED, text: '晚饭吃什么', at: Date.now() - 60_000 })
		appendJournal(root, { dir: 'out', accountId: ACCOUNT_ID, conversationId: ALLOWED, text: '去吃面', at: Date.now() })
		fake.deliver('/export 1', 'e0')
		await waitFor(() => fake.outbound.length > 0, 'the small export reply')
		assert.match(fake.outbound[0].text, /晚饭吃什么/)
		assert.match(fake.outbound[0].text, /去吃面/)

		// A long export spills to a file under <stateRoot>/exports/.
		for (let i = 0; i < 120; i += 1) {
			appendJournal(root, { dir: 'in', accountId: ACCOUNT_ID, conversationId: ALLOWED, text: `长记录第${i}条 ${'x'.repeat(90)}`, at: Date.now() + i })
		}
		fake.deliver('/export', 'e1')
		await waitFor(() => fake.outbound.length > 1, 'the spill reply')
		assert.match(fake.outbound[1].text, /已导出成文件/)
		// 长导出现在会把文件一起发出来：附件链路成功时路径会从正文里摘掉，
		// 失败时正文保留路径并在末尾附上失败原因。两种情况文件都必须存在。
		const exportsDir = path.join(root, 'exports')
		const written = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : []
		assert.ok(written.length > 0, 'the long export must be written to exports/')

		// The zh alias reaches the command, not the agent turn.
		fake.deliver('/导出', 'e2')
		await waitFor(() => fake.outbound.length > 2, 'the alias reply')
		assert.match(fake.outbound[2].text, /已导出成文件/)
	})
})

test('/recall searches the local journal and answers without an agent turn', async () => {
	await withPlugin(async ({ root, fake, sessionsOpened }) => {
		// 60 天前的旧消息，关键词只在那一条里出现。
		appendJournal(root, {
			dir: 'in',
			accountId: ACCOUNT_ID,
			conversationId: ALLOWED,
			text: '上次那个报错是 ECONNREFUSED，端口没起',
			at: Date.now() - 60 * 24 * 60 * 60 * 1000,
		})
		appendJournal(root, { dir: 'in', accountId: ACCOUNT_ID, conversationId: ALLOWED, text: '今天天气不错', at: Date.now() - 1000 })

		// 只发 /recall，没有触发 agent 回合：回复直接来自本地索引。
		fake.deliver('/recall 报错', 'r0')
		await waitFor(() => fake.outbound.length > 0, 'the recall reply')
		assert.match(fake.outbound[0].text, /找到 1 条和「报错」相关的记录/, fake.outbound[0].text)
		assert.match(fake.outbound[0].text, /ECONNREFUSED/, 'the original line comes back verbatim')
		assert.deepEqual(sessionsOpened, [], 'a local lookup must not cost a model turn')

		// 查不到就说查不到，而不是把问题丢给模型。
		fake.deliver('/recall 火龙果', 'r1')
		await waitFor(() => fake.outbound.length > 1, 'the miss reply')
		assert.match(fake.outbound[1].text, /没有找到和「火龙果」相关的消息/)

		// 裸命令给用法。
		fake.deliver('/recall', 'r2')
		await waitFor(() => fake.outbound.length > 2, 'the usage reply')
		assert.match(fake.outbound[2].text, /用法：\/recall/)
	})
})

hostTest('/summary summarizes the conversation on demand and never writes the conv file', async () => {
  await withPlugin(async ({ fake, root }) => {
    // A short history so the recent window is non-empty.
    appendJournal(root, { dir: 'in', accountId: ACCOUNT_ID, conversationId: ALLOWED, text: '我们讨论了周五去哪吃饭' })
    appendJournal(root, { dir: 'out', accountId: ACCOUNT_ID, conversationId: ALLOWED, text: '好，我来订位子' })

    fake.deliver('/summary', 's0')
    await waitFor(() => fake.outbound.length > 0, 'the summary reply')
    assert.match(fake.outbound[0].text, /假总结/, fake.outbound[0].text)

    // 「看一眼」不写盘：/summary 与后台摘要分离。
    assert.equal(fs.existsSync(path.join(root, 'memory', `conv-${ACCOUNT_ID}-${ALLOWED}.json`)), false, 'no conv file written')

    // The side-session prompt carried the transcript and the summary instruction.
    // (The fake echoes the prompt after the canned reply; both arrive in text.)
    assert.match(fake.outbound[0].text, /我们讨论了周五去哪吃饭/, 'the transcript reached the side session')

    fake.deliver('/总结', 's1')
    await waitFor(() => fake.outbound.length > 1, 'the zh alias reply')
    assert.match(fake.outbound[1].text, /假总结/, fake.outbound[1].text)

    // /help names the new command.
    fake.deliver('/help', 's2')
    await waitFor(() => fake.outbound.length > 2, 'the help reply')
    assert.match(fake.outbound[2].text, /\/summary 总结这段会话/, fake.outbound[2].text)
  })
})

test('the command table is the single source for /help, parsing and dispatch', async () => {
  const { commandIds, parseSessionCommand, SESSION_COMMANDS_HELP } = await import('../src/sessions.js')
  // Every id in the table appears exactly once in the help text (subscribe is
  // the one command with two parse rules and one help line).
  const ids = commandIds()
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ['new', 'list', 'use', 'clear', 'cancel', 'status', 'help', 'remind', 'remindlist', 'remindcancel', 'subscribe', 'subscribelist', 'subscribecancel', 'mode', 'remember', 'forget', 'memory', 'recall', 'summary', 'export']) {
    assert.ok(ids.includes(id), `the table is missing ${id}`)
    if (id === 'help') continue
    assert.match(SESSION_COMMANDS_HELP, new RegExp(`/${id} `), `the help text does not mention /${id}`)
  }
  // Ordering: the help lists lines in the order a person would look for them,
  // not in parse order.
  const modeAt = SESSION_COMMANDS_HELP.indexOf('/mode [名称]')
  const remindAt = SESSION_COMMANDS_HELP.indexOf('/remind <时间>')
  assert.ok(modeAt > 0 && remindAt > modeAt, 'mode comes before remind in the help')
  // Parsing agrees with the table for both the english and the chinese alias.
  assert.deepEqual(parseSessionCommand('/new'), { command: 'new' })
  assert.deepEqual(parseSessionCommand('/订阅列表'), { command: 'subscribelist' })
  assert.equal(parseSessionCommand('/nonsense'), undefined)
})

test('a group chat is silent by default, and answers only when addressed once enabled', async () => {
  // C14. Both failure modes are silent: the bot answering every group message
  // (spam), and a group message slipping past the allowlist into a model turn.
  const ROOM = 'room@chatroom'
  await withPlugin(async ({ fake, sessionsOpened }) => {
    fake.deliver('今天吃什么', 'g1', ALLOWED, ROOM)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual(sessionsOpened, [], 'groups are off by default, so nothing reaches the agent')
    assert.deepEqual(fake.outbound, [], 'and nothing is said back into the group')
  })

  await withPlugin(async ({ fake, sessionsOpened }) => {
    fake.deliver('今天吃什么', 'g2', ALLOWED, ROOM)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual(sessionsOpened, [], 'a group message that does not address the bot is ignored')
  }, { groupChatEnabled: true })

  await withPlugin(async ({ fake, sessionsOpened }) => {
    fake.deliver('@bot1 今天吃什么', 'g3', ALLOWED, ROOM)
    await waitFor(() => sessionsOpened.length > 0, 'an addressed group message reaches the agent')
  }, { groupChatEnabled: true })
})

test('a correction replaces the fact it names, and /memory shows what changed', async () => {
  await withPlugin(async ({ fake }) => {
    fake.deliver('/remember 我住在北京', 'm1')
    await waitFor(() => fake.outbound.length >= 1, 'first /remember answered')
    fake.deliver('/remember 我住在北京 → 我搬到杭州了', 'm2')
    await waitFor(() => fake.outbound.length >= 2, 'correction answered')
    fake.deliver('/memory', 'm3')
    await waitFor(() => fake.outbound.length >= 3, '/memory answered')
    const last = fake.outbound.at(-1).text
    assert.match(last, /我搬到杭州了/)
    assert.ok(!last.includes('1. 我住在北京'), 'the old fact is gone from the numbered list')
    assert.match(last, /改过的说法/)
    assert.match(last, /我住在北京 → 我搬到杭州了/)
  })
})

hostTest('a side session runs on the background route; the conversation keeps its own', async () => {
  // C20. Provider/model reach the host as agentOptions, so this is the real
  // assertion that the routing knob does what the settings card promises.
  await withPlugin(async ({ fake, agentOptionsSeen }) => {
    fake.deliver('/summary', 'm1')
    await waitFor(() => fake.outbound.length >= 1, '/summary answered')
    const side = agentOptionsSeen.find((entry) => entry.sessionId.startsWith('wx-sum-'))
    assert.ok(side, `expected a /summary side session among ${JSON.stringify(agentOptionsSeen.map((e) => e.sessionId))}`)
    assert.deepEqual(side.agentOptions, { provider: 'cheap', model: 'cheap-1' })
  }, { sideProvider: 'cheap', sideModel: 'cheap-1', chatProvider: 'good', chatModel: 'good-1' })
})

test('the conversation itself runs on the chat route', async () => {
  await withPlugin(async ({ fake, agentOptionsSeen }) => {
    fake.deliver('普通的一句话', 'm1')
    await waitFor(
      () => agentOptionsSeen.some((entry) => entry.sessionId.startsWith('wx-') === false),
      'the main session to be created',
    )
    const chat = agentOptionsSeen.find((entry) => entry.sessionId.startsWith('wx-') === false)
    assert.deepEqual(chat.agentOptions, { provider: 'good', model: 'good-1' })
    for (const entry of agentOptionsSeen.filter((one) => one.sessionId.startsWith('wx-'))) {
      assert.notDeepEqual(entry.agentOptions, chat.agentOptions, 'server-side sessions must not inherit the chat route')
    }
  }, { chatProvider: 'good', chatModel: 'good-1' })
})

test('locale: en makes the bot speak English where it has a translation', async () => {
  await withPlugin(async ({ fake }) => {
    fake.deliver('/help', 'm1')
    await waitFor(() => fake.outbound.length >= 1, '/help answered')
    const help = fake.outbound[0].text
    assert.match(help, /Session commands/)
    assert.match(help, /\/recall <keyword>/)
    assert.ok(!help.includes('会话指令'))
  }, { locale: 'en' })
})
