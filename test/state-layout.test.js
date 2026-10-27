import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { STATE_LAYOUT, SWEEPABLE, isInsideStateRoot, keyedStatePath, statePath, statePaths } from '../src/state-layout.js'

test('every declared entry resolves inside the state root, with unique relative paths', () => {
  const root = '/tmp/dsh-state-layout-test'
  const resolved = statePaths(root)
  const seen = new Set()
  for (const [key, entry] of Object.entries(resolved)) {
    assert.ok(entry.absolute.startsWith(root + path.sep), `${key} escaped the root`)
    assert.ok(isInsideStateRoot(root, entry.absolute), `${key} is not inside the root`)
    assert.ok(seen.has(entry.relative) === false, `duplicate relative path: ${entry.relative}`)
    seen.add(entry.relative)
    assert.ok(entry.kind === 'dir' || entry.kind === 'file', `${key} has no kind`)
  }
  assert.equal(statePath(root, 'reminders'), path.join(root, 'reminders.json'))
  assert.throws(() => statePath(root, 'nope'), /unknown state entry/)
})

test('a key that contains a slash or parent reference cannot escape the directory', () => {
  const root = '/tmp/dsh-state-layout-test'
  const good = keyedStatePath(root, 'memoryDir', 'global-bot1.json')
  assert.equal(good, path.join(root, 'memory', 'global-bot1.json'))
  const escaped = keyedStatePath(root, 'memoryDir', '../../etc/passwd')
  assert.ok(escaped.startsWith(path.join(root, 'memory') + path.sep), 'traversal must be neutralised')
  assert.ok(isInsideStateRoot(root, escaped))
})

test('the sweepable directories are all declared, and each has a retention key', () => {
  for (const [key, retentionKey] of Object.entries(SWEEPABLE)) {
    assert.ok(STATE_LAYOUT[key] !== undefined, `${key} is not in the layout`)
    assert.equal(STATE_LAYOUT[key].kind, 'dir', `${key} must be a directory`)
    assert.match(retentionKey, /Days$/)
  }
  assert.equal(Object.keys(SWEEPABLE).length, 5)
})
