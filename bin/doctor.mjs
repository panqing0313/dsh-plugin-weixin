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
// is a note, not a failure). It is read-only: nothing is created except the
// state directory itself, which the plugin would create anyway.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyAuditChain } from '../src/message/audit.js'

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

function main() {
  const root = stateRoot()
  checkNode()
  checkPackage()
  checkStateDir(root)
  const config = checkConfig(root)
  checkAccounts(root)
  checkLock(root)
  checkOutbox(root)
  checkAuditChain(root)
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
  process.exitCode = failures > 0 ? 1 : 0
}

main()
