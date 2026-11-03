#!/usr/bin/env node
// Doctor: answer "why is it not working?" without reading the logs first.
//
// The audit asked for a diagnose entry point (D24). Everything a support answer
// needs today is spread across: the config file, the account registry, the log
// directory, the instance lock, the outbox and the npm versions — and the plugin
// only surfaces failures one at a time, in prose, when they happen.
//
// This prints one line per check, in the order a human would ask, and exits
// non-zero only for things that are actually broken (a missing optional feature
// is a note, not a failure). The diagnosis itself is read-only: nothing is
// created except the state directory itself, which the plugin would create
// anyway. `--fix` then repairs the problems that have one right answer (missing
// plugin directories, too-permissive state files, temp files a dead process left
// behind, a state file that is not JSON at all) and reports each change;
// `--dry-run` lists the same repairs without making them.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyAuditChain } from '../src/message/audit.js'
import { backupsDir, listBackups, stampFor } from '../src/backup.js'
import { describeHost, detectHostVersion, hostStatus } from '../src/host-compat.js'
import { statePath } from '../src/state-layout.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const results = []

function record(level, name, detail) {
  results.push({ level, name, detail })
}

function ok(name, detail = '') { record('ok', name, detail) }
function note(name, detail = '') { record('note', name, detail) }
function bad(name, detail = '') { record('bad', name, detail) }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { return { __error: String(error) } }
}

function pkgJson() {
  return readJson(path.join(ROOT, 'package.json'))
}

function stateRoot() {
  const env = process.env.DSH_WEIXIN_STATE_DIR
  if (typeof env === 'string' && env !== '') return env
  return path.join(os.homedir(), '.dsh', 'weixin')
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 20) ok(`node ${process.versions.node}`)
  else bad(`node ${process.versions.node}`, 'the plugin needs Node 20 or newer')
}

function checkPackage() {
  const pkg = pkgJson()
  if (pkg.__error !== undefined) return bad('package.json', pkg.__error)
  ok(`installed version ${pkg.version}`)
  const deps = Object.keys(pkg.dependencies ?? {})
  if (deps.length <= 2) ok(`dependencies: ${deps.join(', ') || 'none'}`)
  else note(`dependencies: ${deps.join(', ')}`, 'this plugin is meant to stay near-zero-dependency')
}

function checkStateDir(root) {
  try {
    fs.mkdirSync(root, { recursive: true })
  } catch (error) {
    return bad('state directory', `${root} cannot be created: ${String(error)}`)
  }
  const probe = path.join(root, '.doctor-write-probe')
  try {
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    ok('state directory writable', root)
  } catch (error) {
    bad('state directory writable', `${root}: ${String(error)}`)
  }
}

function checkConfig(root) {
  const file = path.join(root, 'config.json')
  if (fs.existsSync(file) !== true) {
    note('config', 'not written yet — defaults are in use until the settings card saves')
    // No config means no allowlist, and an empty allowlist means the bot
    // answers nobody. Saying that here is the whole point of the check.
    bad('allowed senders', 'empty — the bot will answer nobody. Open the card, add your wxid and save.')
    return undefined
  }
  const config = readJson(file)
  if (config.__error !== undefined) return bad('config', `${file}: ${config.__error}`)
  const allowed = Array.isArray(config.allowedSenders) ? config.allowedSenders : []
  if (allowed.length === 0) {
    bad('allowed senders', 'empty — the bot will answer nobody. Add your wxid in the settings card.')
  } else {
    ok('allowed senders', `${allowed.length} sender(s)`)
  }
  if (config.asrEnabled === true) {
    const modelDir = typeof config.asrModelDir === 'string' ? config.asrModelDir : ''
    if (modelDir === '' || fs.existsSync(modelDir) !== true) {
      note('voice transcription', `enabled but the model directory is missing (${modelDir || 'unset'})`)
    } else {
      ok('voice transcription', modelDir)
    }
  }
  return config
}

function checkAccounts(root) {
  const dir = path.join(root, 'openclaw-weixin', 'accounts')
  if (fs.existsSync(dir) !== true) return bad('weixin account', 'never logged in — open the card and scan the QR code')
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json') && name.endsWith('.sync.json') === false)
  if (files.length === 0) return bad('weixin account', `${dir} has no account file — log in again`)
  for (const name of files) {
    const file = path.join(dir, name)
    const account = readJson(file)
    if (account.__error !== undefined) { bad(`account ${name}`, account.__error); continue }
    const token = typeof account.token === 'string' ? account.token : ''
    if (token === '') bad(`account ${name}`, 'no token in the file — log in again')
    else ok(`account ${name}`, `token present, saved ${account.savedAt ?? 'unknown'}`)
  }
}

function checkLock(root) {
  const file = path.join(root, 'instance.lock')
  if (fs.existsSync(file) !== true) return ok('instance lock', 'no other window is writing this state')
  const lock = readJson(file)
  const pid = Number(lock.pid)
  if (!Number.isFinite(pid)) return note('instance lock', 'unreadable; the plugin will take it over')
  let alive = false
  try { process.kill(pid, 0); alive = true } catch { alive = false }
  if (alive && fs.statSync(file).mtimeMs > Date.now() - 90_000) {
    note('instance lock', `held by pid ${pid} (a second DSH window) — both will poll the same account`)
  } else {
    ok('instance lock', 'stale; will be taken over')
  }
}

function checkOutbox(root) {
  const file = path.join(root, 'outbox.json')
  if (fs.existsSync(file) !== true) return ok('outbox', 'empty')
  const store = readJson(file)
  const items = Array.isArray(store.items) ? store.items : []
  if (items.length === 0) return ok('outbox', 'empty')
  const oldest = items[0]
  note('outbox', `${items.length} message(s) waiting, oldest from ${new Date(oldest.createdAt ?? Date.now()).toISOString()}`)
}

function checkRecentErrors(root) {
  const dir = path.join(root, 'logs')
  if (fs.existsSync(dir) !== true) return ok('logs', 'none yet')
  const files = fs.readdirSync(dir).filter((name) => name.startsWith('openclaw-') && name.endsWith('.log')).sort()
  const latest = files.at(-1)
  if (latest === undefined) return ok('logs', 'none yet')
  const text = fs.readFileSync(path.join(dir, latest), 'utf8')
  const lines = text.split('\n')
  const errors = lines.filter((line) => /error|failed|refused|threw/i.test(line)).slice(-3)
  if (errors.length === 0) ok('recent log', `${latest}: no errors`)
  else note('recent log', `${latest}: ${errors.join(' | ').slice(0, 400)}`)
}

function checkAuditChain(root) {
  const result = verifyAuditChain(root)
  if (result.files === 0) return ok('audit chain', 'no audit lines yet')
  if (result.broken !== null) {
    return bad('audit chain', `${result.broken.file}:${result.broken.line} does not match its hash — the file was edited after it was written`)
  }
  ok('audit chain', `${result.chained} line(s) chained${result.unchained > 0 ? `, ${result.unchained} legacy` : ''}`)
}

/**
 * Is there a recent backup? Retention deletes old files on purpose and nothing
 * else keeps a copy, so "no backups" is the state you discover you were in when
 * you needed one.
 */
function checkBackups(root) {
  const backups = listBackups(root).filter((entry) => entry.complete && !entry.id.startsWith('pre-restore-'))
  if (backups.length === 0) {
    return note('backups', `none yet — run \`npm run backup create\` (daily backups start 5 minutes after the plugin loads)`)
  }
  const newest = backups[0]
  const ageMs = Date.now() - Date.parse(newest.createdAt)
  const ageDays = ageMs / (24 * 60 * 60 * 1000)
  if (!Number.isFinite(ageDays)) return ok('backups', `${backups.length} copy(ies), newest ${newest.id}`)
  if (ageDays > 7) {
    return bad('backups', `newest is ${Math.floor(ageDays)} days old (${newest.id}) — daily backups are not running; check backupEnabled`)
  }
  ok('backups', `${backups.length} copy(ies), newest ${ageDays < 1 ? 'today' : `${Math.floor(ageDays)} day(s) ago`} (${newest.files} files)`)
}

/**
 * Which host app is this running inside?
 *
 * The plugin imports the app's own packages and registers into the app's own slots,
 * so a host upgrade is the single most likely cause of "it worked yesterday". This
 * check cannot fix anything — it just makes the version visible before someone
 * spends an evening on the wrong theory.
 */
function checkHost() {
  const version = detectHostVersion()
  const status = hostStatus(version)
  if (status.status === 'unknown') return note('host app', describeHost(version))
  if (status.status === 'tested') return ok('host app', describeHost(version))
  note('host app', describeHost(version))
}

function checkRegistryVersion() {
  const pkg = pkgJson()
  if (pkg.__error !== undefined) return
  try {
    const remote = execFileSync('npm', ['view', pkg.name, 'version'], { encoding: 'utf8', timeout: 8_000 }).trim()
    if (remote === pkg.version) ok('published version', `up to date (${remote})`)
    else note('published version', `installed ${pkg.version}, published ${remote} — a newer release exists`)
  } catch {
    note('published version', 'could not reach npm')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// --fix: the repairs a diagnostic can safely make on its own
// ─────────────────────────────────────────────────────────────────────────────
//
// A doctor that only reports leaves the operator to do the easy parts by hand:
// the plugin's own directories, a state file the umask left at 0644, a temp file
// a killed process never renamed away. Those have one right answer, so `--fix`
// does them and says what it changed. What it deliberately will not do:
//
//   * delete anything a human wrote. Memory, journal lines, media and exports are
//     never removed; a state file that is not JSON at all is renamed aside as
//     `<name>.broken-<stamp>`, so its bytes survive for whoever wants to look;
//   * clean up `instance.lock`. The plugin already takes a stale lock over, and
//     removing a live one is exactly how two pollers end up on one account;
//   * follow a symlink. A link planted in the state root must not be able to aim
//     this at `~/.ssh`, so links are skipped and every path is checked to be
//     inside the state root before it is acted on;
//   * walk `asr-models/`. Those are hundreds of MB of third-party model files the
//     plugin did not write, and a permission pass over them buys nothing.

/** A `.tmp` file older than this was left by a dead process, not a live one. */
const STALE_TMP_MS = 24 * 60 * 60 * 1000
/** Upper bound on the mode walk, so a huge state root cannot hang the doctor. */
const WALK_LIMIT = 20_000
/** Top-level directories the walk does not descend into. */
const WALK_SKIP = new Set(['asr-models'])

function parseArgs(argv) {
  const args = argv.slice(2)
  const dryRun = args.includes('--dry-run')
  return { repairing: args.includes('--fix') || dryRun, dryRun }
}

/** A `.broken-<stamp>` name no existing file is using, so a rename never overwrites. */
function brokenSibling(file) {
  const stamp = stampFor(Date.now())
  let target = `${file}.broken-${stamp}`
  for (let n = 2; fs.existsSync(target); n += 1) target = `${file}.broken-${stamp}-${n}`
  return target
}

/**
 * The plugin's own state files: the single-file stores at the root and the
 * account credentials. Only these are inspected for malformed JSON — memory,
 * journal and media files further down are the user's content, and the plugin
 * already reads a broken one as empty.
 */
function stateJsonFiles(root) {
  const files = []
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) files.push(path.join(root, entry.name))
    }
  } catch {
    // An unreadable root is already reported by the state-directory check.
  }
  const index = path.join(root, 'openclaw-weixin', 'accounts.json')
  if (fs.existsSync(index)) files.push(index)
  const accounts = path.join(root, 'openclaw-weixin', 'accounts')
  try {
    for (const name of fs.readdirSync(accounts)) {
      if (name.endsWith('.json')) files.push(path.join(accounts, name))
    }
  } catch {
    // No accounts directory means there is nothing to inspect here.
  }
  return files
}

/**
 * Apply (or, with `dryRun`, only list) the safe repairs.
 *
 * @returns {{ changes: string[], failed: string[] }}
 */
function applyFixes(root, { dryRun }) {
  const changes = []
  const failed = []
  const rootPath = path.resolve(root)
  const rel = (full) => path.relative(rootPath, full) || root
  const insideRoot = (candidate) => {
    const full = path.resolve(candidate)
    return full === rootPath || full.startsWith(`${rootPath}${path.sep}`)
  }
  const act = (description, run) => {
    if (dryRun) {
      changes.push(description)
      return
    }
    try {
      run()
      changes.push(description)
    } catch (error) {
      failed.push(`${description} — ${String(error?.message ?? error)}`)
    }
  }

  // 1. Directories the plugin owns. Created 0700: the state root holds live
  //    account tokens and nothing the plugin writes needs group access.
  const ownedDirs = [
    [root, 'state root'],
    [statePath(root, 'memoryDir'), 'memory/'],
    [statePath(root, 'mediaInboundDir'), 'media/inbound/'],
    // knowledgeDir() lives in src/message/knowledge.js as <root>/knowledge/<account>.
    [path.join(root, 'knowledge'), 'knowledge/'],
    [backupsDir(root), 'backups/'],
  ]
  for (const [dir, label] of ownedDirs) {
    if (!insideRoot(dir)) {
      failed.push(`${label} resolves outside the state root: ${dir}`)
      continue
    }
    if (fs.existsSync(dir)) continue
    act(`created ${label}`, () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }))
  }

  // 2/3. One walk for both: the modes of what is there, and the temp files that
  //      were never renamed into place.
  const staleTemps = []
  let seen = 0
  let truncated = false
  const queue = [root]
  while (queue.length > 0 && truncated === false) {
    const dir = queue.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      failed.push(`could not read ${rel(dir)}: ${String(error?.message ?? error)}`)
      continue
    }
    for (const entry of entries) {
      seen += 1
      if (seen > WALK_LIMIT) {
        truncated = true
        break
      }
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (dir === root && WALK_SKIP.has(entry.name)) continue
        queue.push(full)
        let dirMode
        try {
          dirMode = fs.statSync(full).mode & 0o777
        } catch {
          continue
        }
        // A directory the owner cannot enter hides everything under it.
        if ((dirMode & 0o500) !== 0o500) {
          act(`chmod ${(dirMode | 0o700).toString(8)} ${rel(full)}/ (owner could not enter it)`, () =>
            fs.chmodSync(full, dirMode | 0o700))
        }
        continue
      }
      if (entry.isFile() !== true) continue
      let stat
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (entry.name.endsWith('.tmp')) {
        if (Date.now() - stat.mtimeMs > STALE_TMP_MS) staleTemps.push(full)
        continue
      }
      const mode = stat.mode & 0o777
      const top = rel(full).split(path.sep)[0]
      // `atomicWriteJson` writes state files 0600, and a backup copy is 0600 for
      // the same reason (it carries live tokens). A `.json`, or anything under
      // those two trees, is therefore either a token store or a copy of one.
      const sensitive = entry.name.endsWith('.json') || top === 'openclaw-weixin' || top === 'backups'
      if (sensitive) {
        if (mode !== 0o600) {
          act(`chmod 0600 ${rel(full)} (was ${mode.toString(8).padStart(4, '0')})`, () => fs.chmodSync(full, 0o600))
        }
      } else if ((mode & 0o400) !== 0o400) {
        // Anything else the owner cannot read is unusable, whatever it holds.
        act(`chmod ${(mode | 0o400).toString(8).padStart(4, '0')} ${rel(full)} (owner could not read it)`, () =>
          fs.chmodSync(full, mode | 0o400))
      }
    }
  }
  if (truncated) failed.push(`mode/temp pass stopped after ${WALK_LIMIT} entries — run it again to continue`)

  if (staleTemps.length > 0) {
    // Reported as one line with a count, because "how many" is the question.
    act(
      `removed ${staleTemps.length} temp file(s) older than 24h: ${staleTemps.map(rel).join(', ')}`,
      () => {
        for (const file of staleTemps) fs.rmSync(file, { force: true })
      },
    )
  }

  // 4. A state file that is not JSON at all: move it aside, never delete it.
  for (const file of stateJsonFiles(root)) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') failed.push(`could not read ${rel(file)}: ${String(error?.message ?? error)}`)
      continue
    }
    try {
      JSON.parse(text)
      continue
    } catch {
      // Malformed — renamed below so the bytes are kept.
    }
    const target = brokenSibling(file)
    act(`moved ${rel(file)} → ${path.basename(target)} (not valid JSON; kept aside)`, () => fs.renameSync(file, target))
  }

  return { changes, failed }
}

function printFixes({ changes, failed }, dryRun) {
  const label = dryRun ? 'would fix' : 'fixed'
  if (changes.length === 0 && failed.length === 0) {
    process.stdout.write(`\n${label}: nothing to repair.\n`)
    return
  }
  process.stdout.write(`\n${dryRun ? 'would fix (dry run):' : 'fixed:'}\n`)
  for (const line of changes) process.stdout.write(`  + ${line}\n`)
  for (const line of failed) process.stdout.write(`  ✗ ${line}\n`)
}

function main() {
  const { repairing, dryRun } = parseArgs(process.argv)
  const root = stateRoot()
  checkNode()
  checkPackage()
  checkStateDir(root)
  const config = checkConfig(root)
  checkAccounts(root)
  checkLock(root)
  checkOutbox(root)
  checkAuditChain(root)
  checkBackups(root)
  checkHost()
  checkRecentErrors(root)
  checkRegistryVersion()
  if (config !== undefined && config.voiceOutbound === true) {
    note('voice outbound', 'enabled — measured: the server accepts a bot voice item and does not deliver it')
  }

  const icon = { ok: '✓', note: '·', bad: '✗' }
  const width = Math.max(...results.map((entry) => entry.name.length))
  for (const entry of results) {
    process.stdout.write(`${icon[entry.level]} ${entry.name.padEnd(width)}  ${entry.detail}\n`)
  }
  const failures = results.filter((entry) => entry.level === 'bad').length
  process.stdout.write(`\n${results.length} checks, ${failures} problem(s). state: ${root}\n`)
  if (repairing) printFixes(applyFixes(root, { dryRun }), dryRun)
  process.exitCode = failures > 0 ? 1 : 0
}

main()
