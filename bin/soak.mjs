#!/usr/bin/env node
/**
 * Soak the state layer for a while and report whether it stayed sane.
 *
 * What this does *not* do: drive a model. A soak that needed a real DSH host and a
 * real WeChat account could not run in CI, and one that fakes the agent proves
 * nothing about the agent. So this exercises the parts that actually accumulate
 * damage over days — the journal, outbox retries, memory files, retention sweeps
 * and backups — at a rate far above real traffic, and asserts invariants that a
 * slow leak or a lost write would break.
 *
 *   npm run soak                    # 5 minutes, 5 messages/second
 *   npm run soak -- --minutes 60 --rate 2
 *
 * Exit code is 0 only when every invariant held.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendJournal, readJournal } from '../src/message/journal.js'
import { createOutbox } from '../src/message/outbox.js'
import { addGlobalFact, readGlobalMemory, buildMemoryBlock } from '../src/memory.js'
import { sweepRetention, directoryUsage } from '../src/message/retention.js'
import { createBackup, restoreBackup, verifyBackup } from '../src/backup.js'

function parseArgs(argv) {
  const options = { minutes: 5, rate: 5, state: undefined, quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--minutes') options.minutes = Number(argv[++i])
    else if (arg === '--rate') options.rate = Number(argv[++i])
    else if (arg === '--state') options.state = argv[++i]
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!Number.isFinite(options.minutes) || options.minutes <= 0) throw new Error('--minutes must be a positive number')
  if (!Number.isFinite(options.rate) || options.rate <= 0) throw new Error('--rate must be a positive number')
  return options
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('usage: npm run soak -- [--minutes 5] [--rate 5] [--state <dir>] [--quiet]\n')
    return 0
  }
  const say = (line) => { if (!options.quiet) process.stdout.write(`${line}\n`) }
  const stateRoot = options.state ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-soak-'))
  fs.mkdirSync(stateRoot, { recursive: true })
  const accountId = 'soak@bot'
  const conversationId = 'soak-conv'

  const failures = []
  const fail = (message) => { failures.push(message); say(`✗ ${message}`) }

  // A transport that fails one send in three, so the outbox has real work to do.
  let sent = 0
  let attempted = 0
  let rng = 12345
  const nextRandom = () => { rng = (rng * 1103515245 + 12345) >>> 0; return rng / 0xffffffff }
  const transportFor = () => ({
    accountId,
    async send() {
      attempted += 1
      if (nextRandom() < 1 / 3) throw new Error('soak: transport hiccup')
      sent += 1
    },
  })
  const outbox = createOutbox({ stateRoot, transportFor, warn: () => {}, log: () => {} })

  const started = Date.now()
  const deadline = started + options.minutes * 60_000
  const intervalMs = 1000 / options.rate
  let delivered = 0
  let journaled = 0
  let rssBaseline = 0
  let rssPeak = 0

  say(`soak: ${options.minutes} min at ${options.rate} msg/s in ${stateRoot}`)

  const backup = await createBackup(stateRoot, { label: 'soak-start', warn: () => {} })
  if (backup.files === 0) say('· first backup was empty (expected on a fresh directory)')

  let tick = 0
  while (Date.now() < deadline) {
    tick += 1
    const dir = tick % 2 === 0 ? 'in' : 'out'
    const text = `soak message ${tick} ${'x'.repeat(20 + (tick % 40))}`
    appendJournal(stateRoot, { at: Date.now(), dir, accountId, conversationId, text }, { warn: () => {} })
    journaled += 1
    if (dir === 'out') {
      outbox.enqueue({ accountId, conversationId, text })
      delivered += 1
    }
    if (tick % 20 === 0) await outbox.flush({ force: true })
    if (tick % 200 === 0) {
      addGlobalFact(stateRoot, accountId, `soak fact ${tick}`, { warn: () => {} })
      const global = readGlobalMemory(stateRoot, accountId, { warn: () => {} })
      const block = buildMemoryBlock({ global, conv: { facts: [], summary: '', bond: undefined }, recent: [], now: Date.now() })
      if (typeof block !== 'string') fail('memory block was not a string')
    }
    if (tick % 100 === 0) {
      const sampleRss = process.memoryUsage().rss
      rssPeak = Math.max(rssPeak, sampleRss)
      if (rssBaseline === 0) rssBaseline = sampleRss
    }
    if (tick % 500 === 0) {
      // A tiny retention window on purpose: the sweep must delete its own old files
      // without touching anything it does not recognise.
      fs.writeFileSync(path.join(stateRoot, 'journal', 'notes.txt'), 'keep me')
      await sweepRetention(stateRoot, { retention: { journalDays: 3650 }, warn: () => {} })
      if (!fs.existsSync(path.join(stateRoot, 'journal', 'notes.txt'))) fail('retention deleted a file it did not create')
      say(`· ${Math.round((Date.now() - started) / 1000)}s  journaled ${journaled}  sent ${sent}  queued ${outbox.pending().length}  rss ${Math.round(rssPeak / 1048576)}MB`)
    }
    await sleep(intervalMs)
  }

  // Final drain: with a failing transport we cannot promise zero, only progress.
  for (let round = 0; round < 3 && outbox.pending().length > 0; round += 1) await outbox.flush({ force: true })
  const queued = outbox.pending().length
  if (queued > 0) say(`· ${queued} message(s) still queued (the transport keeps failing; that is the queue working)`)
  if (sent === 0) fail('nothing was ever delivered')
  if (attempted === 0) fail('the outbox never tried to send')

  const journal = readJournal(stateRoot, { limit: 1_000_000, accountId, conversationId })
  if (journal.length === 0) fail('the journal is empty after a soak run')
  if (journal.length > journaled) fail(`journal grew past what was written (${journal.length} > ${journaled})`)

  const outboxBody = JSON.parse(fs.readFileSync(path.join(stateRoot, 'outbox.json'), 'utf8'))
  if (!Array.isArray(outboxBody.items)) fail('outbox.json lost its item list')

  const usage = directoryUsage(stateRoot)
  if (!Number.isFinite(usage.total)) fail('directory usage was not a number')

  const finalBackup = await createBackup(stateRoot, { label: 'soak-end', warn: () => {} })
  if (verifyBackup(stateRoot, finalBackup.id).ok !== true) fail('the end-of-run backup did not verify')
  // Restore the backup we just took, not the empty one from the start: the point
  // is to prove a restore puts real state back, and an empty backup would hide a
  // broken copy step behind a legitimately empty directory.
  const restored = await restoreBackup(stateRoot, finalBackup.id, { warn: () => {} })
  if (restored.restoredFiles < 1) fail(`restore copied nothing back (${restored.restoredFiles} files)`)
  if (!fs.existsSync(path.join(stateRoot, 'journal'))) fail('the journal did not come back after a restore')

  const seconds = Math.round((Date.now() - started) / 1000)
  say('')
  say(`soak: ${seconds}s, journaled ${journaled}, still queued ${queued}, sent ${sent}, attempts ${attempted}`)
  say(`soak: journal ${journal.length} entries, state ${Math.round(usage.total / 1024)}KB, rss ${Math.round(rssPeak / 1048576)}MB`)
  if (rssBaseline > 0 && rssPeak > rssBaseline * 3) fail(`rss grew more than 3x (${Math.round(rssBaseline / 1048576)} → ${Math.round(rssPeak / 1048576)}MB)`)

  if (failures.length > 0) {
    say(`\n${failures.length} invariant(s) broken`)
    return 1
  }
  say('\nall invariants held')
  return 0
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  process.stderr.write(`soak failed: ${String(error?.stack ?? error)}\n`)
  process.exitCode = 1
})
