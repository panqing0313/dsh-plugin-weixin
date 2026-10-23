/**
 * The poll loop must not sit inside a turn.
 *
 * Measured defect (2026-10-23, real account): the loop awaited each message's
 * handler, and the handler awaits the whole agent turn. While a 180 s `sleep`
 * ran, four `/cancel` messages went unread; they were answered seconds after
 * the turn finished, every one with "当前没有正在跑的回合" — the command whose
 * only job is to interrupt a running turn could never reach it. The scheduler
 * below is the fix: the loop hands off and moves on, per-conversation order is
 * kept by a promise chain, and `/cancel` bypasses that chain.
 *
 * These tests pin the scheduler's contract, not its call sites.
 * @module dsh-weixin/test/turn-dispatch
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { ILinkTransport, createInboundScheduler } from '../src/transport/ilink.js'
import { isInterruptCommand, parseSessionCommand } from '../src/sessions.js'

/** A handler whose runs are released by hand, so ordering is observable. */
function controlledHandler() {
  const starts = []
  const releases = new Map()
  const onMessage = (message) => {
    starts.push(message.id)
    return new Promise((resolve) => releases.set(message.id, resolve))
  }
  return {
    starts,
    onMessage,
    release: (id) => {
      const resolve = releases.get(id)
      assert.notEqual(resolve, undefined, `nothing is waiting on ${id}`)
      resolve()
    },
  }
}

const message = (id, conversationId = 'conv-1') => ({ id, conversationId, type: 'text', text: id })

/** Give pending microtasks (and the scheduler's `.finally` bookkeeping) a turn. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('messages in one conversation run one at a time, in order', async () => {
  const handler = controlledHandler()
  const scheduler = createInboundScheduler({ onMessage: handler.onMessage, errLog: () => {} })

  scheduler.dispatch(message('a'))
  scheduler.dispatch(message('b'))
  scheduler.dispatch(message('c'))
  await settle()

  // Only the first one has been handed to the handler: b and c wait for it,
  // which is what keeps a single conversation's turns from interleaving.
  assert.deepEqual(handler.starts, ['a'])
  assert.equal(scheduler.pending, 3)

  handler.release('a')
  await settle()
  assert.deepEqual(handler.starts, ['a', 'b'])

  handler.release('b')
  await settle()
  assert.deepEqual(handler.starts, ['a', 'b', 'c'])

  handler.release('c')
  await scheduler.drain()
  assert.equal(scheduler.pending, 0)
})

test('different conversations do not block each other', async () => {
  const handler = controlledHandler()
  const scheduler = createInboundScheduler({ onMessage: handler.onMessage, errLog: () => {} })

  scheduler.dispatch(message('a', 'conv-1'))
  scheduler.dispatch(message('b', 'conv-2'))
  await settle()

  // The whole point of dropping the loop's await: a message from another chat
  // (or the same chat, see the next test) is handled while a turn is running.
  assert.deepEqual(handler.starts, ['a', 'b'])

  handler.release('a')
  handler.release('b')
  await scheduler.drain()
})

test('/cancel runs immediately, ahead of a turn still running in its conversation', async () => {
  const handler = controlledHandler()
  const scheduler = createInboundScheduler({
    onMessage: handler.onMessage,
    errLog: () => {},
    bypass: (msg) => isInterruptCommand(msg.text),
  })

  scheduler.dispatch(message('long turn', 'conv-1'))
  await settle()
  // Realistically the turn is already running when the cancel arrives (it came
  // from an earlier poll), so the interesting question is what happens next.
  assert.deepEqual(handler.starts, ['long turn'])

  scheduler.dispatch(message('/cancel', 'conv-1'))
  await settle()

  // The cancel is answered while the turn it targets is still in flight. Before
  // this change the cancel was not even read until that turn finished.
  assert.deepEqual(handler.starts, ['long turn', '/cancel'])

  handler.release('/cancel')
  handler.release('long turn')
  await scheduler.drain()
})

test('a failing handler does not poison the chain for later messages', async () => {
  const errors = []
  const started = []
  const scheduler = createInboundScheduler({
    onMessage: async (msg) => {
      started.push(msg.id)
      if (msg.id === 'boom') throw new Error('turn exploded')
    },
    errLog: (line) => errors.push(line),
  })

  scheduler.dispatch(message('boom'))
  scheduler.dispatch(message('after'))
  await scheduler.drain()

  assert.deepEqual(started, ['boom', 'after'])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /message boom failed: Error: turn exploded/)
})

test('the cancel predicate matches exactly the two spellings the parser accepts', () => {
  for (const text of ['/cancel', '  /CANCEL  ', '/取消']) {
    assert.equal(isInterruptCommand(text), true, text)
    assert.deepEqual(parseSessionCommand(text), { command: 'cancel' })
  }
  for (const text of ['/cancel please', 'cancel', '/cancelled', '', ' /cancel\nmore']) {
    assert.equal(isInterruptCommand(text), false, JSON.stringify(text))
  }
  assert.equal(isInterruptCommand(undefined), false)
})

/** One inbound text message, shaped like the server sends it. */
function rawText(id, text, { from = 'wxid_abc', group = '' } = {}) {
  return {
    message_id: id,
    from_user_id: from,
    group_id: group,
    message_type: 1,
    message_state: 2,
    context_token: `ctx-${id}`,
    create_time_ms: 1,
    item_list: [{ type: 1, text_item: { text } }],
  }
}

/**
 * A fake iLink host that hands out the given polls in order, then empty ones.
 *
 * This is where the defect actually lived: the scheduler can be perfectly
 * correct and still never see a `/cancel` if the loop is parked inside the
 * handler. So the regression has to be pinned through `ILinkTransport.start()`
 * against a real socket, not only against the scheduler.
 */
async function startFakePoll(polls) {
  let index = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      res.setHeader('content-type', 'application/json')
      if (url.pathname === '/ilink/bot/getconfig') return res.end(JSON.stringify({ ret: 0, typing_ticket: 'TT' }))
      if (url.pathname === '/ilink/bot/getupdates') {
        const msgs = polls[index] ?? []
        index += 1
        return res.end(JSON.stringify({ ret: 0, get_updates_buf: 'buf', longpolling_timeout_ms: 20, msgs }))
      }
      return res.end(JSON.stringify({ ret: 0 }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }),
  }
}

test('the poll loop reads /cancel while a turn is still running', async () => {
  const server = await startFakePoll([[rawText(1, 'long task'), rawText(2, '/cancel')]])
  const started = []
  let releaseTurn
  const turnDone = new Promise((resolve) => { releaseTurn = resolve })
  const transport = new ILinkTransport({
    accountId: 'bot1',
    baseUrl: server.baseUrl,
    token: 'tok-1',
    userId: 'me@im.wechat',
    bypassQueue: (message) => message?.type === 'text' && isInterruptCommand(message.text),
    pollPauseMs: 1,
  })
  try {
    transport.start(async (message) => {
      started.push(message.text)
      if (message.text === 'long task') await turnDone
    })

    // Before the fix the loop awaited the handler, so `/cancel` was not even
    // read until the turn it targets had finished — the whole point of the
    // command, dead. Here the loop must have handed the cancel to the handler
    // while the first one is still blocked.
    const deadline = Date.now() + 3_000
    while (!started.includes('/cancel') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(started, ['long task', '/cancel'])
  } finally {
    releaseTurn()
    await transport.stop()
    await server.close()
  }
})
