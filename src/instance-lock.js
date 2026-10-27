/**
 * One writer per state directory.
 *
 * Two DSH windows with the same profile both load this plugin, both poll the
 * same Weixin account (whoever polls first steals the messages) and both write
 * the same JSON files. The writes are atomic now, so nothing is torn — but
 * last-writer-wins still means one window's reminders silently disappear when
 * the other saves its in-memory copy.
 *
 * This is a courtesy lock, not a mutex with guarantees: the holder refreshes the
 * file's mtime as a heartbeat, and a lock whose holder is gone (dead pid, or a
 * heartbeat older than the stale window) is taken over. The point is to make the
 * second instance SAY it is second, not to make it impossible to run two.
 *
 * @module dsh-weixin/instance-lock
 */

import fs from 'node:fs'
import path from 'node:path'

/** How often the holder refreshes the lock file. */
export const HEARTBEAT_MS = 30_000
/** A lock file untouched for this long belongs to a dead process. */
export const STALE_MS = 3 * HEARTBEAT_MS

/** @param {string} stateRoot */
export function lockFile(stateRoot) {
  return path.join(stateRoot, 'instance.lock')
}

/** @param {number} pid */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists and belongs to someone else.
    return error?.code === 'EPERM'
  }
}

/**
 * Read the current holder without touching the lock.
 *
 * @param {string} stateRoot
 * @returns {{ pid: number, startedAt: number, at: number } | undefined}
 */
export function readHolder(stateRoot) {
  const file = lockFile(stateRoot)
  try {
    const stat = fs.statSync(file)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof parsed?.pid !== 'number') return undefined
    return { pid: parsed.pid, startedAt: Number(parsed.startedAt ?? 0), at: stat.mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * Take the lock, or report the live holder that has it.
 *
 * @param {string} stateRoot
 * @param {{ now?: number, warn?: (message: string) => void }} [options]
 * @returns {{ acquired: true } | { acquired: false, holder: { pid: number, startedAt: number } }}
 */
export function acquireInstanceLock(stateRoot, options = {}) {
  const now = options.now ?? Date.now()
  const warn = options.warn ?? (() => {})
  const file = lockFile(stateRoot)
  const holder = readHolder(stateRoot)
  if (holder !== undefined) {
    const live = alive(holder.pid) && now - holder.at < STALE_MS
    if (live && holder.pid !== process.pid) {
      return { acquired: false, holder: { pid: holder.pid, startedAt: holder.startedAt } }
    }
    // A dead pid or a stale heartbeat: the previous instance is gone.
  }
  try {
    fs.mkdirSync(stateRoot, { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify({ pid: process.pid, startedAt: now })}\n`, { mode: 0o600 })
    fs.renameSync(temp, file)
    return { acquired: true }
  } catch (error) {
    warn(`could not take the instance lock: ${String(error?.message ?? error)}`)
    // Failing to write a courtesy lock is not a reason to refuse to run.
    return { acquired: true }
  }
}

/**
 * Refresh the heartbeat. Called on a timer by the plugin; a no-op when the lock
 * is gone (another instance took over after ours went stale).
 *
 * @param {string} stateRoot
 */
export function heartbeatInstanceLock(stateRoot) {
  const file = lockFile(stateRoot)
  try {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (holder?.pid !== process.pid) return false
    const now = new Date()
    fs.utimesSync(file, now, now)
    return true
  } catch {
    return false
  }
}

/** Remove the lock, but only if this process holds it. */
export function releaseInstanceLock(stateRoot) {
  const file = lockFile(stateRoot)
  try {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (holder?.pid !== process.pid) return false
    fs.rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}
