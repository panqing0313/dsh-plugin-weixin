/**
 * Guards for the account registry — the side table that lets the settings card
 * show which account is which, whether it is still alive, and whether the
 * operator paused it.
 *
 * The registry is metadata on purpose: losing it must never block messaging.
 * Every test here runs against a throwaway state root set before the import
 * (the module resolves its file lazily, but the state dir itself must be
 * private so the operator's real accounts-registry.json is never touched).
 * @module dsh-weixin/test/account-registry
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

process.env.DSH_WEIXIN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-registry-'))
after(() => fs.rmSync(process.env.DSH_WEIXIN_STATE_DIR, { recursive: true, force: true }))

const { registryFile, readRegistry, writeRegistry, ensureAccountEntry, touchAccount, setAccountPaused, isAccountPaused, setAccountLabel, setAccountAllowlist, allowlistForAccount } =
  await import('../src/account-registry.js')

const warnings = []
const warn = (line) => warnings.push(line)
test.afterEach?.(() => { warnings.length = 0 })

test('a fresh account materializes with createdAt and no fields it never earned', () => {
  const registry = {}
  const entry = ensureAccountEntry(registry, 'bot1')
  assert.equal(typeof entry.createdAt, 'string', 'first touch records when the account was first seen')
  assert.equal(entry.paused, undefined, 'a fresh entry is not paused by default')
  assert.equal(entry.label, undefined, 'a fresh entry has no label')
  assert.deepEqual(Object.keys(registry), ['bot1'])
})

test('pause and resume round-trip, and a missing entry reads as not paused', () => {
  assert.equal(isAccountPaused('never-seen'), false, 'a missing entry must not read as paused')

  setAccountPaused('bot1', true, warn)
  assert.equal(isAccountPaused('bot1'), true)
  const pausedEntry = readRegistry().bot1
  assert.equal(typeof pausedEntry.pausedAt, 'string', 'the pause moment is recorded for the card')

  setAccountPaused('bot1', false, warn)
  assert.equal(isAccountPaused('bot1'), false)
  assert.equal(readRegistry().bot1.pausedAt, undefined, 'resuming clears the pause moment')
})

test('lastSeenAt is written only by touchAccount, and never blocks on a bad state dir', async () => {
  touchAccount('bot1', warn)
  const seen = readRegistry().bot1.lastSeenAt
  assert.equal(typeof seen, 'string')
  assert.ok(!Number.isNaN(Date.parse(seen)), 'the card must be able to parse it into "silent for N days"')

  // A registry write failure is a warning, never an exception: bookkeeping
  // must not take a message down with it. The malformed-file complaint goes
  // through process.emitWarning (module-level, not caller-level), so it is
  // observed on the process channel, not via the caller's warn callback.
  const file = registryFile()
  fs.writeFileSync(file, 'not json at all', 'utf8')
  const emitted = []
  const onWarning = (w) => emitted.push(String(w?.message ?? w))
  process.on('warning', onWarning)
  try {
    assert.doesNotThrow(() => touchAccount('bot1', warn))
    // process.emitWarning delivers on nextTick, not synchronously.
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.off('warning', onWarning)
  }
  assert.ok(
    emitted.some((w) => /malformed/.test(w)),
    'the operator must be told the registry was unreadable',
  )
  // rewriteRegistry from a valid in-memory shape heals the file
  const healed = readRegistry()
  healed.bot1 = { ...healed.bot1, lastSeenAt: seen }
  writeRegistry(healed, warn)
  assert.equal(readRegistry().bot1.lastSeenAt, seen)
})

test('label set, label cleared, and re-binding an account keeps both', () => {
  setAccountLabel('bot1', '妈妈的微信', warn)
  assert.equal(readRegistry().bot1.label, '妈妈的微信')

  // whitespace-only is a clear, not a label of spaces
  setAccountLabel('bot1', '   ', warn)
  assert.equal(readRegistry().bot1.label, undefined)

  setAccountLabel('bot1', '妈妈的微信', warn)
  setAccountPaused('bot1', false, warn)
  // A re-bind re-touches the entry; it must not wipe label or paused.
  touchAccount('bot1', warn)
  const entry = readRegistry().bot1
  assert.equal(entry.label, '妈妈的微信')
  assert.equal(entry.paused, false)
})

test('allowlist override set, effective, cleared, and kept across a re-touch', () => {
  // (destructured at top-level import)

  // An override lands on the entry; an empty chats list is a non-override.
  setAccountAllowlist('bot1', ['friend-a'], undefined, warn)
  const entry = readRegistry().bot1
  assert.deepEqual(entry.allowedSenders, ['friend-a'])
  assert.equal(entry.allowedChats, undefined, 'no chats override must not become an empty list')

  // Effective value: the override wins, others fall back to the global config.
  assert.deepEqual(
    allowlistForAccount('bot1', { allowedSenders: ['global-1'] }),
    { allowedSenders: ['friend-a'], allowedChats: [] },
  )
  assert.deepEqual(
    allowlistForAccount('bot2', { allowedSenders: ['global-1'], allowedChats: ['room-9'] }),
    { allowedSenders: ['global-1'], allowedChats: ['room-9'] },
    'an account without an override reads the global config',
  )
  assert.deepEqual(allowlistForAccount('never-seen', {}), { allowedSenders: [], allowedChats: [] })

  // Empty senders is a CLEAR: the global list rules again (never deny-all).
  setAccountAllowlist('bot1', [], undefined, warn)
  assert.equal(readRegistry().bot1.allowedSenders, undefined)
  assert.deepEqual(allowlistForAccount('bot1', { allowedSenders: ['global-1'] }), { allowedSenders: ['global-1'], allowedChats: [] })

  // Re-touch (a re-bind or a seen message) must not wipe the override.
  setAccountAllowlist('bot1', ['friend-a'], ['room-1'], warn)
  touchAccount('bot1', warn)
  assert.deepEqual(readRegistry().bot1.allowedSenders, ['friend-a'])
  assert.deepEqual(readRegistry().bot1.allowedChats, ['room-1'])
})
