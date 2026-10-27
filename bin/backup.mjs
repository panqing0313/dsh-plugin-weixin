#!/usr/bin/env node
/**
 * Back up, list, verify and restore this machine's Weixin state directory.
 *
 *   node bin/backup.mjs create [--label before-upgrade]
 *   node bin/backup.mjs list
 *   node bin/backup.mjs verify <id>
 *   node bin/backup.mjs restore <id> [--yes]
 *
 * Written as a CLI rather than a remote method because the interesting moments
 * (upgrading, moving to another machine, "I think I deleted the wrong thing")
 * happen when the plugin is not running — or when running it is exactly what you
 * do not want to do.
 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createBackup, listBackups, pruneBackups, restoreBackup, verifyBackup, backupsDir } from '../src/backup.js'
import { stateDir } from '../src/state.js'

const argv = process.argv.slice(2)
const command = argv.find((a) => !a.startsWith('--')) ?? 'help'
const rest = argv.filter((a) => !a.startsWith('--')).slice(1)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const yes = flags.has('--yes')

const root = stateDir()

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function warn(line) {
  process.stderr.write(`! ${line}\n`)
}

switch (command) {
  case 'create': {
    const labelIndex = argv.indexOf('--label')
    const label = labelIndex === -1 ? '' : (argv[labelIndex + 1] ?? '')
    const result = createBackup(root, { label, warn, includeMedia: flags.has('--with-media') })
    console.log(`✓ backup ${result.id}`)
    console.log(`  ${result.files} file(s), ${human(result.bytes)}`)
    console.log(`  ${result.path}`)
    if (result.skipped.length > 0) console.log(`  not present: ${result.skipped.join(', ')}`)
    console.log(`\n  this copy contains config.json and the account tokens — keep it on this machine`)
    break
  }

  case 'list': {
    const backups = listBackups(root)
    if (backups.length === 0) {
      console.log(`no backups in ${backupsDir(root)}`)
      break
    }
    for (const entry of backups) {
      const state = entry.complete ? `${entry.files} file(s), ${human(entry.bytes)}` : 'incomplete (no manifest)'
      console.log(`${entry.id}  ${entry.createdAt}  ${state}`)
    }
    break
  }

  case 'verify': {
    const [id] = rest
    if (id === undefined) {
      console.error('usage: node bin/backup.mjs verify <id>')
      process.exitCode = 1
      break
    }
    const result = verifyBackup(root, id)
    if (result.ok) console.log(`✓ ${id}: ${result.files} file(s) present (manifest said ${result.expected})`)
    else console.log(`✗ ${id}: ${result.reason ?? `${result.files} of ${result.expected} file(s) present`}`)
    break
  }

  case 'restore': {
    const [id] = rest
    if (id === undefined) {
      console.error('usage: node bin/backup.mjs restore <id> [--yes]')
      process.exitCode = 1
      break
    }
    const verified = verifyBackup(root, id)
    if (!verified.ok) {
      console.error(`✗ ${id} does not look intact (${verified.reason ?? 'missing files'}) — refusing to restore`)
      process.exitCode = 1
      break
    }
    // Restoring under a live instance is the one thing that silently undoes
    // itself: the running plugin rewrites its in-memory state over the files.
    const running = spawnSync('pgrep', ['-f', 'dsh-plugin-weixin'], { encoding: 'utf8' })
    if (running.status === 0 && !yes) {
      console.error('✗ DSH looks like it is running. Quit it first, or pass --yes if you know better.')
      process.exitCode = 1
      break
    }
    const result = restoreBackup(root, id, { warn })
    console.log(`✓ restored ${result.restoredFiles} file(s) from ${id}`)
    console.log(`  previous state moved to ${path.relative(root, result.aside)} (delete it once you are happy)`)
    console.log(`  restart DSH to load the restored state`)
    break
  }

  default: {
    console.log(`usage:
  node bin/backup.mjs create [--label <name>] [--with-media]   take a backup (keeps the newest few)
  node bin/backup.mjs list                      what backups exist
  node bin/backup.mjs verify <id>               is this one intact
  node bin/backup.mjs restore <id> [--yes]      copy it back over the live state

state: ${root}
backups: ${backupsDir(root)}`)
  }
}
