import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { SCOPABLE_KEYS, readScope, readScopes, scopedConfig, writeScope } from '../src/config-scope.js'

function withRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'scope-'))
  try { return fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('a conversation override is stored, read back and layered over the account config', () => {
  withRoot((root) => {
    const base = { bubbleGapMs: 700, memoryEnabled: true, maxMessageLength: 1500 }
    assert.equal(readScope(root, 'bot1', 'room1'), undefined)
    writeScope(root, 'bot1', 'room1', { bubbleGapMs: 200, memoryEnabled: false })
    assert.deepEqual(readScope(root, 'bot1', 'room1'), { bubbleGapMs: 200, memoryEnabled: false })
    const layered = scopedConfig(base, readScope(root, 'bot1', 'room1'))
    assert.equal(layered.bubbleGapMs, 200)
    assert.equal(layered.memoryEnabled, false)
    assert.equal(layered.maxMessageLength, 1500, 'unscoped keys keep the account value')
    assert.equal(base.bubbleGapMs, 700, 'the base config is never mutated')
    // Another conversation on the same account is untouched.
    assert.equal(readScope(root, 'bot1', 'room2'), undefined)
  })
})

test('keys outside the allowlist are dropped, not stored', () => {
  withRoot((root) => {
    writeScope(root, 'bot1', 'room1', { allowedSenders: ['wxid_evil'], maxMediaBytes: 1, bubbleGapMs: 100 })
    const scope = readScope(root, 'bot1', 'room1')
    assert.deepEqual(scope, { bubbleGapMs: 100 })
    assert.ok(SCOPABLE_KEYS.includes('allowedSenders') === false, 'the allowlist must never be scopable')
  })
})

test('clearing a scope removes it, and a partial write merges', () => {
  withRoot((root) => {
    writeScope(root, 'bot1', 'room1', { bubbleGapMs: 100 })
    writeScope(root, 'bot1', 'room1', { memoryEnabled: false })
    assert.deepEqual(readScope(root, 'bot1', 'room1'), { bubbleGapMs: 100, memoryEnabled: false })
    writeScope(root, 'bot1', 'room1', {})
    assert.equal(readScope(root, 'bot1', 'room1'), undefined)
    assert.deepEqual(readScopes(root), {})
  })
})

test('a corrupt scope file reads as empty instead of throwing', () => {
  withRoot((root) => {
    const file = path.join(root, 'config-scope.json')
    writeFileSync(file, '{not json')
    assert.deepEqual(readScopes(root), {})
  })
})
