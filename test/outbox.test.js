import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const {
  BASE_RETRY_MS,
  MAX_ATTEMPTS,
  MAX_ITEMS,
  MAX_RETRY_MS,
  createOutbox,
  formatOutbox,
  outboxFile,
  readOutbox,
  retryDelayMs,
} = await import('../src/message/outbox.js')

/**
 * The outbox keeps a reply that was written but not delivered.
 *
 * The experience: the laptop slept mid-turn, or the phone was offline for a
 * minute. Without this the reply — and every reminder — is gone with no trace.
 * The rules that matter are ordering (a later message must not overtake an
 * earlier one), bounded retries, and a store that survives a restart.
 */

function fixture(transports = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-outbox-'))
  const sent = []
  const logs = []
  const box = createOutbox({
    stateRoot: root,
    transportFor: (accountId) => transports[accountId],
    warn: () => {},
    log: (line) => logs.push(line),
    now: () => Date.now(),
  })
  return { root, box, sent, logs, transports }
}

/** A transport that records sends and can be told to fail. */
function flaky() {
  const sent = []
  const state = { fail: false }
  return {
    sent,
    setFail(value) {
      state.fail = value
    },
    transport: {
      async send(message) {
        if (state.fail) throw new Error('socket hang up')
        sent.push(message)
      },
    },
  }
}

test('a queued message survives a restart of the plugin, and delivers on the next attempt', async () => {
  const fake = flaky()
  fake.setFail(true)
  const first = fixture({ acc: fake.transport })
  try {
    first.box.enqueue({ accountId: 'acc', conversationId: 'conv', text: '开会提醒：15:00' })
    // A restart: a brand-new outbox over the same directory sees the item.
    const reopened = createOutbox({ stateRoot: first.root, transportFor: () => fake.transport, warn() {}, log() {}, now: () => Date.now() })
    assert.equal(reopened.pending().length, 1)
    // Still failing: the item stays, with an attempt counted and a backoff set.
    const failed = await reopened.flush()
    assert.deepEqual(failed, { sent: 0, failed: 1, remaining: 1 })
    const parked = reopened.pending()[0]
    assert.equal(parked.attempts, 1)
    assert.ok(parked.notBefore > Date.now() - 1)
    assert.match(parked.lastError, /socket hang up/)

    fake.setFail(false)
    const forced = await reopened.flush({ force: true })
    assert.deepEqual(forced, { sent: 1, failed: 0, remaining: 0 })
    assert.deepEqual(fake.sent.map((m) => m.text), ['开会提醒：15:00'])
    assert.deepEqual(readOutbox(first.root, { warn() {} }).items, [])
  } finally {
    fs.rmSync(first.root, { recursive: true, force: true })
  }
})

test('a stuck message blocks its own conversation but not another one', async () => {
  const stuck = flaky()
  stuck.setFail(true)
  const fine = flaky()
  const { root, box } = fixture({ a: stuck.transport, b: fine.transport })
  try {
    box.enqueue({ accountId: 'a', conversationId: 'x', text: '第一' })
    box.enqueue({ accountId: 'a', conversationId: 'x', text: '第二' })
    box.enqueue({ accountId: 'b', conversationId: 'y', text: '别的会话' })
    const result = await box.flush()
    assert.equal(result.sent, 1, 'the healthy conversation still delivers')
    assert.equal(result.remaining, 2, 'both items of the blocked conversation stay queued, in order')
    assert.deepEqual(fine.sent.map((m) => m.text), ['别的会话'])
    assert.deepEqual(box.pending().map((i) => i.text), ['第一', '第二'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('no live transport keeps the item instead of dropping it', async () => {
  const { root, box } = fixture()
  try {
    box.enqueue({ accountId: 'acc', conversationId: 'conv', text: '等一下' })
    const result = await box.flush()
    assert.deepEqual(result, { sent: 0, failed: 0, remaining: 1 })
    assert.match(box.pending()[0].lastError, /no live transport/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the store is bounded, and the oldest are the ones dropped', async () => {
  const { root, box } = fixture()
  try {
    for (let i = 0; i < MAX_ITEMS + 5; i += 1) box.enqueue({ accountId: 'a', conversationId: 'c', text: `m${i}` })
    const pending = box.pending()
    assert.equal(pending.length, MAX_ITEMS)
    assert.equal(pending.at(-1).text, `m${MAX_ITEMS + 4}`)
    assert.equal(pending[0].text, 'm5', 'the five oldest were dropped')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('retries back off exponentially and stop being retried after the cap', () => {
  assert.equal(retryDelayMs(1), BASE_RETRY_MS)
  assert.equal(retryDelayMs(2), BASE_RETRY_MS * 2)
  assert.equal(retryDelayMs(3), BASE_RETRY_MS * 4)
  assert.equal(retryDelayMs(20), MAX_RETRY_MS, 'the cap is a cap')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-outbox-cap-'))
  try {
    const box = createOutbox({ stateRoot: root, transportFor: () => undefined, warn() {}, log() {}, now: () => Date.now() })
    box.enqueue({ accountId: 'a', conversationId: 'c', text: 'x' })
    const store = readOutbox(root, { warn() {} })
    store.items[0].attempts = MAX_ATTEMPTS
    store.items[0].notBefore = 0
    fs.writeFileSync(outboxFile(root), JSON.stringify({ schemaVersion: 1, ...store }))
    return box.flush({ force: true }).then((result) => {
      assert.equal(result.sent, 0, 'a parked item is not hammered forever')
      assert.equal(box.pending().length, 1, 'and it is still there for the operator')
    })
  } finally {
    // Deleted by the caller's finally below; kept here for the sync path.
    setTimeout(() => fs.rmSync(root, { recursive: true, force: true }), 0)
  }
})

test('one item can be dropped by id', () => {
  const { root, box } = fixture()
  try {
    const id = box.enqueue({ accountId: 'a', conversationId: 'c', text: 'x' })
    assert.equal(box.drop('nope'), false)
    assert.equal(box.drop(id), true)
    assert.deepEqual(box.pending(), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the /outbox view says what is waiting, how old, and why it failed', () => {
  const now = Date.UTC(2026, 9, 31, 3, 0, 0)
  assert.equal(formatOutbox([], { now }), '重发队列是空的。')

  const text = formatOutbox([
    {
      id: 'abc123',
      createdAt: now - 5 * 60_000,
      attempts: 2,
      lastError: 'fetch failed: timeout',
      text: 'x'.repeat(80),
    },
  ], { now })
  assert.match(text, /待重发 1 条/)
  assert.match(text, /abc123 · 5 分钟前 · 尝试 2 次 · 上次失败：fetch failed: timeout/)
  assert.match(text, /xxxx…/)
  assert.match(text, /\/outbox retry/)
})

test('the view shows five and counts the rest', () => {
  const now = Date.UTC(2026, 9, 31, 3, 0, 0)
  const items = Array.from({ length: 7 }, (_, i) => ({ id: `id${i}`, createdAt: now, attempts: 0, text: `t${i}` }))
  const text = formatOutbox(items, { now })
  assert.match(text, /待重发 7 条/)
  assert.match(text, /id4/)
  assert.doesNotMatch(text, /id5/)
  assert.match(text, /还有 2 条/)
})
