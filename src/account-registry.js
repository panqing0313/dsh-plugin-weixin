// Account registry — the card's view of every saved account, beyond credentials.
//
// The credential files (`accounts/<id>.json`, vendored layout) hold only what
// the server needs: token, baseUrl, userId. Everything an operator needs to
// *manage* an account — which one is which (label), whether messages are still
// flowing (lastSeenAt), whether the operator paused it — used to live nowhere,
// so the card could show "已绑定" for an account that had been silent for days.
//
// This module keeps that extra state in `<state>/accounts-registry.json`, keyed
// by the same accountId the credential files use. It is a side table: deleting
// a credential must leave the registry entry harmless (paused/label of an
// account that no longer exists is simply not shown), and re-binding an account
// keeps its label and paused flag — an operator should not have to re-describe
// an account after every re-login.
//
// Writes go through tmp+rename (the convention from src/sessions.js), and every
// read tolerates a missing or malformed file: the registry is metadata, and
// losing it must never block messaging.
// @module dsh-weixin/account-registry
import fs from 'node:fs'
import path from 'node:path'
import { stateDir } from './state.js'

/** Absolute path of the registry file. */
export function registryFile() {
  return path.join(stateDir(), 'accounts-registry.json')
}

/** Read the whole registry, tolerating absence and corruption. */
export function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    process.emitWarning(`dsh-weixin: ignoring ${registryFile()}: expected a JSON object`)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      process.emitWarning(`dsh-weixin: ignoring malformed ${registryFile()}: ${String(error?.message ?? error)}`)
    }
  }
  return {}
}

/** Write the whole registry atomically; failure warns but never throws. */
export function writeRegistry(registry, warn = () => {}) {
  const file = registryFile()
  const temp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
    fs.renameSync(temp, file)
  } catch (error) {
    warn(`dsh-weixin: could not persist ${file}: ${String(error?.message ?? error)}`)
  }
}

/**
 * One account's registry entry, creating it on first touch.
 *
 * `createdAt` is when the account was first seen by this module; `lastSeenAt`
 * is the last time inbound traffic was accepted for it. Neither is rewritten
 * on later touches.
 */
export function ensureAccountEntry(registry, accountId) {
  let entry = registry[accountId]
  if (entry === undefined || entry === null || typeof entry !== 'object') {
    entry = {}
    registry[accountId] = entry
  }
  if (typeof entry.createdAt !== 'string') entry.createdAt = new Date().toISOString()
  return entry
}

/** Record that the account just received or sent a message. */
export function touchAccount(accountId, warn = () => {}) {
  if (typeof accountId !== 'string' || accountId === '') return
  const registry = readRegistry()
  const entry = ensureAccountEntry(registry, accountId)
  entry.lastSeenAt = new Date().toISOString()
  writeRegistry(registry, warn)
}

/**
 * Pause or resume an account's inbound loop.
 *
 * A paused account keeps its credentials and its session history; the host
 * simply stops polling it, the way "退出登录" would — but without deleting the
 * login, so resuming is instant and needs no re-scan.
 */
export function setAccountPaused(accountId, paused, warn = () => {}) {
  const registry = readRegistry()
  const entry = ensureAccountEntry(registry, accountId)
  entry.paused = paused === true
  entry.pausedAt = entry.paused ? new Date().toISOString() : undefined
  writeRegistry(registry, warn)
}

/** Whether an account is paused. Missing entry means "not paused". */
export function isAccountPaused(accountId) {
  if (typeof accountId !== 'string' || accountId === '') return false
  return readRegistry()[accountId]?.paused === true
}

/**
 * Set a human-facing label ("妈妈的微信" etc.) for an account.
 * The card shows the label next to the raw id, which is otherwise meaningless.
 */
export function setAccountLabel(accountId, label, warn = () => {}) {
  const registry = readRegistry()
  const entry = ensureAccountEntry(registry, accountId)
  const trimmed = typeof label === 'string' ? label.trim() : ''
  if (trimmed === '') delete entry.label
  else entry.label = trimmed
  writeRegistry(registry, warn)
}
