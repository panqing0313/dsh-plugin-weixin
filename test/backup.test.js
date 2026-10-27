import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBackup, listBackups, pruneBackups, restoreBackup, verifyBackup, backupsDir } from '../src/backup.js'

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-backup-'))
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true })
  fs.writeFileSync(path.join(root, 'memory', 'global-bot1.json'), '{"facts":[{"text":"likes tea"}]}')
  fs.mkdirSync(path.join(root, 'journal'), { recursive: true })
  fs.writeFileSync(path.join(root, 'journal', 'journal-2026-10-27.jsonl'), '{"text":"hi"}\n')
  fs.writeFileSync(path.join(root, 'config.json'), '{"allowedSenders":["wxid"]}')
  return root
}

test('a backup copies the state and a manifest, and lists itself', () => {
  const root = sandbox()
  const created = createBackup(root, { now: Date.UTC(2026, 9, 28, 2, 0, 0) })
  assert.match(created.id, /^2026-10-28T02-00-00/)
  assert.equal(created.files, 3)
  assert.ok(fs.existsSync(path.join(created.path, 'memory', 'global-bot1.json')))
  assert.ok(fs.existsSync(path.join(created.path, 'MANIFEST.json')))
  // Missing directories are reported, not fatal.
  assert.ok(created.skipped.includes('openclaw-weixin'))

  const [first] = listBackups(root)
  assert.equal(first.id, created.id)
  assert.equal(first.complete, true)
  assert.equal(first.files, 3)
})

test('verify notices a backup that lost files', () => {
  const root = sandbox()
  const created = createBackup(root, { now: Date.UTC(2026, 9, 28, 2, 0, 0) })
  assert.equal(verifyBackup(root, created.id).ok, true)

  fs.rmSync(path.join(created.path, 'journal', 'journal-2026-10-27.jsonl'))
  const broken = verifyBackup(root, created.id)
  assert.equal(broken.ok, false)
  assert.equal(broken.files, 2)
  assert.equal(broken.expected, 3)
})

test('only the newest few backups survive a prune, and pre-restore copies are kept', () => {
  const root = sandbox()
  for (let day = 1; day <= 4; day += 1) {
    createBackup(root, { now: Date.UTC(2026, 9, day, 3, 0, 0), keep: 10 })
  }
  const stale = path.join(backupsDir(root), 'pre-restore-2026-10-01T00-00-00')
  fs.mkdirSync(path.join(stale, 'memory'), { recursive: true })
  fs.writeFileSync(path.join(stale, 'MANIFEST.json'), '{"files":0}')

  assert.equal(listBackups(root).length, 5)
  const removed = pruneBackups(root, { keep: 2 })
  assert.equal(removed.length, 2)
  const left = listBackups(root).map((entry) => entry.id)
  assert.equal(left.length, 3)
  assert.ok(left.some((id) => id.startsWith('pre-restore-')), 'a pre-restore copy must never be pruned')
})

test('restore puts the old files back and keeps what it replaced', () => {
  const root = sandbox()
  const created = createBackup(root, { now: Date.UTC(2026, 9, 28, 2, 0, 0) })

  // Someone wiped a memory file and renamed the config after the backup.
  fs.writeFileSync(path.join(root, 'memory', 'global-bot1.json'), '{"facts":[]}')
  fs.writeFileSync(path.join(root, 'config.json'), '{"allowedSenders":[]}')

  const result = restoreBackup(root, created.id, { now: Date.UTC(2026, 9, 28, 5, 0, 0) })
  assert.equal(result.restoredFiles, 3)
  assert.ok(result.movedAside.includes('memory'))
  assert.match(fs.readFileSync(path.join(root, 'memory', 'global-bot1.json'), 'utf8'), /likes tea/)
  assert.match(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), /wxid/)

  // The replaced state is still on disk, under pre-restore-*.
  const aside = fs.readdirSync(result.aside)
  assert.ok(aside.includes('memory'))
  assert.match(fs.readFileSync(path.join(result.aside, 'config.json'), 'utf8'), /allowedSenders/)
})

test('restoring something that is not a backup throws instead of half-copying', () => {
  const root = sandbox()
  assert.throws(() => restoreBackup(root, 'nope'), /no backup named nope/)
  fs.mkdirSync(path.join(backupsDir(root), 'empty'), { recursive: true })
  assert.throws(() => restoreBackup(root, 'empty'), /no backup named empty/)
})
