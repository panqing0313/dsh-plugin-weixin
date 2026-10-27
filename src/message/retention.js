/**
 * Retention: nothing in the state directory grows without a bound.
 *
 * Five things are written and never read again after a while — the message
 * journal, the tool audit, inbound media, markdown exports and the vendor's own
 * daily log. Each is one file per day (or one file per attachment), so a year of
 * ordinary use is gigabytes of history nobody asked to keep on a laptop.
 *
 * The sweep is deliberately narrow: it only removes files whose name carries a
 * date older than the configured window, and it never touches a file it does
 * not recognise. Deleting the wrong thing here means losing history, so an
 * unknown shape is left alone.
 *
 * @module dsh-weixin/message/retention
 */

import fs from 'node:fs'
import path from 'node:path'

/** Defaults, in days. 0 disables the class. */
export const DEFAULT_RETENTION = {
  journalDays: 180,
  auditDays: 90,
  mediaDays: 30,
  exportsDays: 60,
  logsDays: 30,
}

/** How often the sweep runs while the plugin is up. */
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/** @param {string} name */
function dayFromName(name) {
  const journal = /^journal-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name)
  if (journal !== null) return `${journal[1]}-${journal[2]}-${journal[3]}`
  const audit = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name)
  if (audit !== null) return `${audit[1]}-${audit[2]}-${audit[3]}`
  const log = /^openclaw-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name)
  if (log !== null) return `${log[1]}-${log[2]}-${log[3]}`
  const exported = /^chat-.*-(\d{4})(\d{2})(\d{2})-\d{6}\.md$/.exec(name)
  if (exported !== null) return `${exported[1]}-${exported[2]}-${exported[3]}`
  return undefined
}

/** @param {number} at @returns {string} local YYYY-MM-DD */
function today(now) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** @param {string} day @param {number} days @returns {boolean} */
function olderThan(day, cutoff) {
  return day < cutoff
}

/** @param {number} now @param {number} days */
function cutoffDay(now, days) {
  return today(now - days * DAY_MS)
}

/**
 * Directory layout the sweep knows about.
 *
 * @param {string} stateRoot
 */
function targets(stateRoot) {
  return {
    journal: { dir: path.join(stateRoot, 'journal'), days: 'journalDays' },
    audit: { dir: path.join(stateRoot, 'audit'), days: 'auditDays' },
    media: { dir: path.join(stateRoot, 'media', 'inbound'), days: 'mediaDays' },
    exports: { dir: path.join(stateRoot, 'exports'), days: 'exportsDays' },
    logs: { dir: path.join(stateRoot, 'logs'), days: 'logsDays' },
  }
}

/**
 * Remove files older than their window.
 *
 * @param {string} stateRoot
 * @param {{ now?: number, warn?: (message: string) => void, retention?: Partial<typeof DEFAULT_RETENTION>, dryRun?: boolean }} [options]
 * @returns {{ removed: Array<{ file: string, bytes: number }>, bytes: number, scanned: number }}
 */
export function sweepRetention(stateRoot, options = {}) {
  const now = options.now ?? Date.now()
  const warn = options.warn ?? (() => {})
  const retention = { ...DEFAULT_RETENTION, ...(options.retention ?? {}) }
  const removed = []
  let scanned = 0
  let bytes = 0
  for (const [label, target] of Object.entries(targets(stateRoot))) {
    const days = Number(retention[target.days] ?? 0)
    if (!Number.isFinite(days) || days <= 0) continue
    const cutoff = cutoffDay(now, days)
    let names
    try {
      names = fs.readdirSync(target.dir)
    } catch {
      continue
    }
    for (const name of names) {
      const day = dayFromName(name)
      // An unrecognised file is someone else's; leave it.
      if (day === undefined) continue
      scanned += 1
      if (!olderThan(day, cutoff)) continue
      const file = path.join(target.dir, name)
      let size = 0
      try {
        size = fs.statSync(file).size
      } catch {
        continue
      }
      if (options.dryRun === true) {
        removed.push({ file, bytes: size })
        bytes += size
        continue
      }
      try {
        fs.rmSync(file, { force: true })
        removed.push({ file, bytes: size })
        bytes += size
      } catch (error) {
        warn(`could not remove ${label} file ${name}: ${String(error?.message ?? error)}`)
      }
    }
  }
  return { removed, bytes, scanned }
}

/**
 * How much room the state directory is taking, per class.
 *
 * Uses file names where the class is name-addressable and stat() elsewhere, so
 * the card can show four numbers without walking every byte of every file twice.
 *
 * @param {string} stateRoot
 * @returns {{ journal: number, audit: number, media: number, exports: number, logs: number, total: number }}
 */
export function directoryUsage(stateRoot) {
  const usage = { journal: 0, audit: 0, media: 0, exports: 0, logs: 0, total: 0 }
  for (const [label, target] of Object.entries(targets(stateRoot))) {
    let names
    try {
      names = fs.readdirSync(target.dir)
    } catch {
      continue
    }
    let sum = 0
    for (const name of names) {
      try {
        sum += fs.statSync(path.join(target.dir, name)).size
      } catch {
        // A file that vanished between readdir and stat contributes nothing.
      }
    }
    usage[label] = sum
    usage.total += sum
  }
  return usage
}

/**
 * One line for the log, so a sweep that deleted something is never silent.
 *
 * @param {ReturnType<typeof sweepRetention>} result
 */
export function describeSweep(result) {
  if (result.removed.length === 0) return `retention: nothing to remove (${result.scanned} dated file(s) checked)`
  return `retention: removed ${result.removed.length} file(s), ${(result.bytes / 1024 / 1024).toFixed(1)} MB`
}
