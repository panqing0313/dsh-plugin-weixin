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
  const agents = {
    get: () => undefined,
    async resume({ resumeSessionId }) {
      sessionsOpened.push(resumeSessionId)
      if (resumeSessionId.startsWith('wx-')) return { agent: sideAgent(resumeSessionId), dispose: trackedDispose(resumeSessionId) }
      return { agent: { session: { id: resumeSessionId }, inbox: { clear() {} } }, dispose: trackedDispose(resumeSessionId) }
    },
    async create({ sessionId }) {
      sessionsOpened.push(sessionId)
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
    plugin.apply(ctx, plugin.Config({ allowedSenders: [ALLOWED], typingIndicator: false }))
    seedAccount(root, { baseUrl: fake.baseUrl })
    await waitFor(() => fake.seen.getupdates > 0, 'the inbound loop to start')
    await body({ root, lines, fake, sessionsOpened, servers, agents, disposedSessions, get deliverCalls() { return deliverCalls } })
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
    assert.match(fake.outbound[0].text, /没有安排：看不懂这个时间/)

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
    assert.match(fake.outbound[2].text, /默认、女友、男友、朋友、海龟汤、成语接龙、文字冒险/)
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

test('/status and /memory show the affinity line when a bond exists', async () => {
  await withPlugin(async ({ fake, root }) => {
    // Seed the bond the settle point would have written (the settle-point
    // write itself is covered by the e2e summarizer test; this harness's fake
    // agents do not complete real turns). The conversation here is the peer id
    // itself: group_id is empty for direct messages.
    const { bumpTurnAndBond } = await import('../src/memory.js')
    bumpTurnAndBond(root, ACCOUNT_ID, ALLOWED)

    fake.deliver('/status', 'm1')
    await waitFor(() => fake.outbound.length > 0, 'the status reply')
    assert.match(fake.outbound[0].text, /我们认识第 1 天 · 聊过 1 条消息/, fake.outbound[0].text)

    fake.deliver('/memory', 'm2')
    await waitFor(() => fake.outbound.length > 1, 'the memory reply')
    assert.match(fake.outbound[1].text, /我们认识第 1 天/, fake.outbound[1].text)
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

test('/summary summarizes the conversation on demand and never writes the conv file', async () => {
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
