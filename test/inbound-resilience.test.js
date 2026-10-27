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
