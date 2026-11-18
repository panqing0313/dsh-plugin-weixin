import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * Issue #3: one rejected poll must not take the DSH host down.
 *
 * `#loop` used to wrap getUpdates in try/finally only. A rejection (a DNS
 * failure that escapes the vendor's own catcher, a socket reset, a JSON parse
 * error) escaped the loop, so `loopPromise` rejected; `stop()` awaited that
 * rejected promise and the unhandled rejection killed the process. The fix has
 * two halves: the poll is caught and treated as one failed round, and the loop
 * promise itself is caught so a future escape degrades to a log line.
 *
 * Both halves are pinned here: the fake poll throws on its first call and then
 * delivers a message, so passing means "survived the throw AND kept polling".
 */

const ACCOUNT_ID = 'bot1'
const PEER = 'wxid_abc'

/** Smallest inbound message the normalizer accepts. */
function inboundMessage(text, id) {
  return {
    message_id: id,
    from_user_id: PEER,
    group_id: '',
    message_type: 1,
    message_state: 2,
    context_token: `ct-${id}`,
    create_time_ms: 1,
    item_list: [{ type: 1, text_item: { text } }],
  }
}

test('a rejected poll is one failed round, not the end of the loop', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-loop-resilience-'))
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = stateRoot
  try {
    const { ILinkTransport } = await import('../src/transport/ilink.js')

    const lines = []
    const delivered = []
    let calls = 0
    const transport = new ILinkTransport({
      accountId: ACCOUNT_ID,
      baseUrl: 'http://127.0.0.1:1',
      token: 'tok',
      longPollTimeoutMs: 50,
      log() {},
      errLog: (line) => lines.push(String(line)),
      // Round 1 rejects the way a real network error arrives; every round
      // after it behaves.
      getUpdates: async () => {
        calls += 1
        if (calls === 1) throw new TypeError('fetch failed')
        if (calls === 2) return { ret: 0, msgs: [inboundMessage('survived', 9001)] }
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { ret: 0, msgs: [] }
      },
    })

    await transport.start(async (message) => {
      delivered.push(message.text)
    })

    const deadline = Date.now() + 5_000
    while (delivered.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await transport.stop()

    assert.deepEqual(delivered, ['survived'], 'the loop kept polling after the rejection and delivered the next message')
    assert.ok(
      lines.some((line) => /getUpdates threw/.test(line)),
      `the failed round has to be reported: ${lines.join(' | ')}`,
    )
    assert.ok(calls >= 3, `the loop must still be polling after the throw (calls: ${calls})`)
    assert.equal(transport.running, false)
  } finally {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('a loop that dies anyway leaves a log line, never an unhandled rejection', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-loop-escape-'))
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = stateRoot
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const { ILinkTransport } = await import('../src/transport/ilink.js')
    const lines = []
    const transport = new ILinkTransport({
      accountId: ACCOUNT_ID,
      baseUrl: 'http://127.0.0.1:1',
      token: 'tok',
      longPollTimeoutMs: 50,
      log() {},
      errLog: (line) => lines.push(String(line)),
      // Something outside the loop's own handling — the escape hatch the
      // second half of the fix exists for.
      getUpdates: async () => {
        throw new RangeError('something unexpected')
      },
    })

    await transport.start(async () => {})
    await new Promise((resolve) => setTimeout(resolve, 100))
    await transport.stop()
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.deepEqual(unhandled, [], 'the loop promise must be caught')
    assert.ok(
      lines.some((line) => /getUpdates threw|inbound loop stopped unexpectedly/.test(line)),
      lines.join(' | '),
    )
  } finally {
    process.off('unhandledRejection', onUnhandled)
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

/**
 * Issue #14: "the plugin stopped receiving, and nothing said why."
 *
 * The loop already retried, but nothing an operator could see recorded that:
 * `lastPollFailure` is that record. A network-shaped failure must surface the
 * classified kind (the number the user pasted — `type=unknown` — lives in the
 * vendor's log line, this one says the loop knows), the description, and a
 * consecutive count; a later good poll is not the same as never having failed,
 * but the count must not keep climbing once rounds succeed.
 */
test('the last poll failure is readable, and counts consecutive rounds', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-last-failure-'))
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = stateRoot
  try {
    const { ILinkTransport } = await import('../src/transport/ilink.js')
    const transport = new ILinkTransport({
      accountId: ACCOUNT_ID,
      baseUrl: 'http://127.0.0.1:1',
      token: 'tok',
      longPollTimeoutMs: 50,
      log() {},
      errLog() {},
      getUpdates: async () => {
        throw new TypeError('fetch failed')
      },
    })
    assert.equal(transport.lastPollFailure, null, 'a transport that has not polled has nothing to report')

    await transport.start(async () => {})
    const deadline = Date.now() + 5_000
    while ((transport.lastPollFailure?.failures ?? 0) < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const failure = transport.lastPollFailure
    await transport.stop()

    assert.ok(failure !== null, 'after a failed round there has to be a record')
    assert.equal(failure.kind, 'unknown', 'a bare TypeError: fetch failed classifies as unknown, like the report')
    assert.match(failure.description, /network request failed/)
    assert.ok(failure.failures >= 2, `consecutive failures are counted (got ${failure.failures})`)
    assert.equal(typeof failure.at, 'number')
    // The copy handed out must not be the live object: mutating it cannot
    // confuse the next reader.
    failure.failures = -1
    assert.notEqual(transport.lastPollFailure?.failures, -1)
  } finally {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

/**
 * The server saying "no" (`ret !== 0`) is a different failure from the network
 * dying, and #14's report was explicitly a network failure — the two must not
 * be filed under the same kind, or the log tells the operator to check their
 * wifi when iLink itself refused.
 */
test('a refused poll is reported as refused, not as a network fault', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-refused-'))
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = stateRoot
  try {
    const { ILinkTransport } = await import('../src/transport/ilink.js')
    const lines = []
    let calls = 0
    const transport = new ILinkTransport({
      accountId: ACCOUNT_ID,
      baseUrl: 'http://127.0.0.1:1',
      token: 'tok',
      longPollTimeoutMs: 50,
      log() {},
      errLog: (line) => lines.push(String(line)),
      getUpdates: async () => {
        calls += 1
        if (calls === 1) return { ret: 5, errmsg: 'internal error' }
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { ret: 0, msgs: [] }
      },
    })
    await transport.start(async () => {})
    // Round 1 refuses, round 2 is good: waiting for the count to reach 2
    // proves the loop carried on past the refusal. (Stopping as soon as the
    // record appears would race the second poll and pass or fail at random.)
    const deadline = Date.now() + 5_000
    while (calls < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
    const failure = transport.lastPollFailure
    await transport.stop()

    assert.equal(failure?.kind, 'refused', `ret=5 is a refused poll: ${lines.join(' | ')}`)
    assert.match(failure?.description ?? '', /ret=5/)
    assert.ok(calls >= 2, 'the loop keeps polling after a refusal')
  } finally {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})
