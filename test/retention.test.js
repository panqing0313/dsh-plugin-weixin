import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const { DEFAULT_RETENTION, describeSweep, directoryUsage, enforceMediaCap, sweepRetention } = await import('../src/message/retention.js')

/**
 * Retention: the state directory stops growing.
 *
 * Every test writes files with the names the producers really use (journal /
 * audit / vendor log / export / inbound media) and a date far enough back to be
 * inside or outside the window. The sweep may only delete what it can date, and
 * only what is older than the configured window — a bug here destroys history
 * rather than breaking a reply, so the unknown-file case matters as much as the
 * removal case.
 */

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-retention-'))
  for (const dir of ['journal', 'audit', 'media/inbound', 'exports', 'logs']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  const write = (relative, body = 'x') => fs.writeFileSync(path.join(root, relative), body)
  write('journal/journal-2025-01-01.jsonl', 'old\n')
  write('journal/journal-2025-12-31.jsonl', 'fresh\n')
  write('journal/notes.txt', 'not ours\n')
  write('audit/audit-2025-01-02.jsonl', 'old\n')
  write('audit/audit-2025-12-30.jsonl', 'fresh\n')
  write('logs/openclaw-2025-01-03.log', 'old\n')
  write('logs/openclaw-2025-12-29.log', 'fresh\n')
  write('exports/chat-bot1-peer-20250103-101010.md', 'old\n')
  write('exports/chat-bot1-peer-20251229-101010.md', 'fresh\n')
  write('media/inbound/photo.jpg', 'bytes')
  return root
}

// 2026-01-05: everything from December 2025 is well inside a 30-day window.
const NOW = new Date(2026, 0, 5, 12, 0, 0).getTime()

test('dated files older than their window are removed, everything else is untouched', () => {
  const root = fixture()
  try {
    const result = sweepRetention(root, { now: NOW, retention: { journalDays: 30, auditDays: 30, logsDays: 30, exportsDays: 30, mediaDays: 0 } })
    const removed = result.removed.map((entry) => path.relative(root, entry.file)).sort()
    assert.deepEqual(removed, [
      'audit/audit-2025-01-02.jsonl',
      'exports/chat-bot1-peer-20250103-101010.md',
      'journal/journal-2025-01-01.jsonl',
      'logs/openclaw-2025-01-03.log',
    ])
    assert.ok(result.bytes > 0)
    // The day files inside the window survive, and so does a file the sweep
    // cannot date (its owner is someone else).
    assert.equal(fs.existsSync(path.join(root, 'journal/journal-2025-12-31.jsonl')), true)
    assert.equal(fs.existsSync(path.join(root, 'journal/notes.txt')), true)
    assert.equal(fs.existsSync(path.join(root, 'media/inbound/photo.jpg')), true, 'mediaDays: 0 disables that class')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a dry run reports what it would remove and removes nothing', () => {
  const root = fixture()
  try {
    const zero = { journalDays: 30, auditDays: 0, mediaDays: 0, exportsDays: 0, logsDays: 0 }
    const result = sweepRetention(root, { now: NOW, retention: zero, dryRun: true })
    assert.equal(result.removed.length, 1)
    assert.ok(fs.existsSync(path.join(root, 'journal/journal-2025-01-01.jsonl')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the usage report adds up per class and in total', () => {
  const root = fixture()
  try {
    const usage = directoryUsage(root)
    // Every file in the class counts, including one the sweep would refuse to
    // touch: "what is this costing me" is a size question, not a policy one.
    assert.equal(usage.journal, 'old\n'.length + 'fresh\n'.length + 'not ours\n'.length)
    assert.equal(usage.audit, 'old\n'.length + 'fresh\n'.length)
    assert.equal(usage.logs, 'old\n'.length + 'fresh\n'.length)
    assert.equal(usage.exports, 'old\n'.length + 'fresh\n'.length)
    assert.equal(usage.media, 'bytes'.length)
    assert.equal(usage.total, usage.journal + usage.audit + usage.media + usage.exports + usage.logs)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the sweep line says what happened, and defaults are all positive', () => {
  for (const days of Object.values(DEFAULT_RETENTION)) assert.ok(days > 0, 'a default of 0 would keep everything forever')
  assert.match(describeSweep({ removed: [], bytes: 0, scanned: 3 }), /nothing to remove/)
  assert.match(describeSweep({ removed: [{ file: 'a', bytes: 2 * 1024 * 1024 }], bytes: 2 * 1024 * 1024, scanned: 3 }), /removed 1 file\(s\), 2\.0 MB/)
})

test('an unwritable directory is skipped, not fatal', () => {
  const root = fixture()
  try {
    fs.chmodSync(path.join(root, 'journal'), 0o500)
    try {
      const result = sweepRetention(root, { now: NOW, retention: { journalDays: 30, auditDays: 0, mediaDays: 0, exportsDays: 0, logsDays: 0 } })
      assert.equal(result.removed.length, 0, 'the sweep reports nothing when the class cannot be read or written')
      assert.ok(fs.existsSync(path.join(root, 'journal/journal-2025-01-01.jsonl')))
    } finally {
      fs.chmodSync(path.join(root, 'journal'), 0o700)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('enforceMediaCap removes oldest files until the directory fits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-cap-'))
  const at = (day) => new Date(2026, 9, day, 9, 0)
  for (const [name, day] of [['a.png', 1], ['b.png', 2], ['c.png', 3]]) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(1000))
    fs.utimesSync(path.join(dir, name), at(day), at(day))
  }
  const result = enforceMediaCap(dir, { maxBytes: 2500 })
  assert.equal(result.removed.length, 1)
  assert.equal(result.removed[0].file.endsWith('a.png'), true)
  assert.equal(result.total, 2000)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['b.png', 'c.png'])
  // Under the cap: nothing happens, and 0 means "no cap at all".
  assert.equal(enforceMediaCap(dir, { maxBytes: 5000 }).removed.length, 0)
  assert.equal(enforceMediaCap(dir, { maxBytes: 0 }).removed.length, 0)
  // A missing directory is not an error.
  assert.deepEqual(enforceMediaCap(path.join(dir, 'nope'), { maxBytes: 10 }).removed, [])
})
