import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const { HEARTBEAT_MS, STALE_MS, acquireInstanceLock, heartbeatInstanceLock, lockFile, readHolder, releaseInstanceLock } =
  await import('../src/instance-lock.js')

/**
 * Two DSH windows, one state directory.
 *
 * The lock is a courtesy: the second instance keeps running but says so. What
 * matters is that it reports a LIVE holder, takes over from a dead one, and
 * never mistakes its own heartbeat for somebody else's.
 */

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-lock-'))
}

test('a live holder blocks a second instance, a dead pid does not', () => {
  const dir = root()
  try {
    const first = acquireInstanceLock(dir)
    assert.equal(first.acquired, true)
    const holder = readHolder(dir)
    assert.equal(holder.pid, process.pid)

    // Same process asking again is a restart of the same instance, not a
    // conflict — the pid is ours.
    assert.deepEqual(acquireInstanceLock(dir), { acquired: true })

    // Another live process: report it. pid 1 is always alive on this platform.
    fs.writeFileSync(lockFile(dir), `${JSON.stringify({ pid: 1, startedAt: 1 })}\n`)
    const blocked = acquireInstanceLock(dir, { now: Date.now() })
    assert.equal(blocked.acquired, false)
    assert.equal(blocked.holder.pid, 1)

    // A dead pid (999999 is above every default pid_max on macOS/Linux) is
    // taken over.
    fs.writeFileSync(lockFile(dir), `${JSON.stringify({ pid: 999999, startedAt: 1 })}\n`)
    assert.equal(acquireInstanceLock(dir).acquired, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a heartbeat older than the stale window is taken over', () => {
  const dir = root()
  try {
    fs.writeFileSync(lockFile(dir), `${JSON.stringify({ pid: 1, startedAt: 1 })}\n`)
    const old = new Date(Date.now() - STALE_MS - HEARTBEAT_MS)
    fs.utimesSync(lockFile(dir), old, old)
    // pid 1 is alive, but it has not refreshed the file: that instance is wedged
    // (or the file is a leftover), and waiting for it would mean never starting.
    assert.equal(acquireInstanceLock(dir).acquired, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the heartbeat only refreshes its own lock, and release only removes its own', () => {
  const dir = root()
  try {
    assert.equal(heartbeatInstanceLock(dir), false, 'no lock, nothing to refresh')
    acquireInstanceLock(dir)
    const before = fs.statSync(lockFile(dir)).mtimeMs
    assert.equal(heartbeatInstanceLock(dir), true)
    // The exact millisecond depends on the filesystem's timestamp granularity;
    // what the takeover rule reads is "recent", so that is what is asserted.
    assert.ok(Math.abs(fs.statSync(lockFile(dir)).mtimeMs - Date.now()) < 5_000, `heartbeat mtime ${before} vs now`)

    // Another process's lock must not be refreshed or removed by us.
    fs.writeFileSync(lockFile(dir), `${JSON.stringify({ pid: 1, startedAt: 1 })}\n`)
    assert.equal(heartbeatInstanceLock(dir), false)
    assert.equal(releaseInstanceLock(dir), false)
    assert.equal(fs.existsSync(lockFile(dir)), true)

    // Take it back the only way a courtesy lock allows: the old holder must be
    // gone (or stale), otherwise a live instance would lose its voice.
    const old = new Date(Date.now() - STALE_MS - HEARTBEAT_MS)
    fs.utimesSync(lockFile(dir), old, old)
    const mine = acquireInstanceLock(dir)
    assert.equal(mine.acquired, true)
    assert.equal(releaseInstanceLock(dir), true)
    assert.equal(fs.existsSync(lockFile(dir)), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
