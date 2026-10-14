/**
 * Weixin/iLink state location for the DSH plugin.
 *
 * The vendored Tencent transport reads `OPENCLAW_STATE_DIR` (else `CLAWDBOT_STATE_DIR`,
 * else `~/.openclaw`) and lays out files under
 * `<stateDir>/openclaw-weixin/accounts/{accountId}.json` plus an index
 * `accounts.json`, and a long-poll cursor `<stateDir>/openclaw-weixin/accounts/{accountId}.sync.json`.
 *
 * dsh-weixin keeps the same layout (so the vendored code needs no patching) but
 * points the root at a DSH-owned directory, so credentials never land in a
 * directory some other OpenClaw install also writes. This module must therefore
 * set the environment variable BEFORE the vendored modules are imported — the
 * transport captures `process.env.OPENCLAW_STATE_DIR` per call
 * (`resolveStateDir()` re-reads env each time), so setting it once at apply time
 * is enough and is what {@link configureWeixinStateDir} does.
 * @module dsh-weixin/state
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Override for tests and non-default profiles. */
const ENV_OVERRIDE = 'DSH_WEIXIN_STATE_DIR'

/**
 * Absolute path of the directory that acts as the OpenClaw state root.
 * Layout below it: `openclaw-weixin/accounts/<accountId>.json`,
 * `openclaw-weixin/accounts.json`, `openclaw-weixin/accounts/<accountId>.sync.json`.
 */
export function stateDir() {
  const override = process.env[ENV_OVERRIDE]?.trim()
  if (override) return path.resolve(override)
  return path.join(os.homedir(), '.dsh', 'weixin')
}

/**
 * Directory holding per-account credential files.
 */
export function accountsDir() {
  return path.join(stateDir(), 'openclaw-weixin', 'accounts')
}

/**
 * Working directory Weixin conversations run in.
 *
 * DSH groups a session by its working directory, so running these agents in the
 * deployment's own cwd would scatter them through the profile's session group,
 * indistinguishable from conversations the user started here. Giving Weixin its
 * own directory collects every Weixin conversation under one group.
 *
 * The directory is created by {@link ensureSessionsDir} at apply time because a
 * session cannot be created in a path that does not exist.
 */
export function sessionsDir() {
  return path.join(stateDir(), 'sessions')
}

/**
 * Create {@link sessionsDir} if needed and return it.
 * @throws when the directory cannot be created, since an agent cannot run
 *   without a working directory.
 */
export function ensureSessionsDir() {
  const dir = sessionsDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Where inbound Weixin media (images, files, voice, video) is saved.
 *
 * Under the plugin's own state tree rather than a temp directory, for two
 * reasons: a decrypted attachment is the user's content and should not be swept
 * away by the OS mid-turn, and {@link sessionsDir}'s agents must be able to
 * `read` it, which the outbound media allowlist already admits
 * (`src/media/outbound.js` allows the whole state root).
 *
 * The directory is NOT created here — {@link ensureInboxDir} does that — because
 * this accessor is also used for a path comparison, and a comparison must not
 * have the side effect of creating a directory.
 */
export function inboxDir() {
  return path.join(stateDir(), 'media', 'inbound')
}

/**
 * Create {@link inboxDir} if needed and return it.
 * @throws when the directory cannot be created; an inbound attachment that
 *   cannot be stored is reported to the user as a download failure.
 */
export function ensureInboxDir() {
  const dir = inboxDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Point the vendored transport at the DSH state directory.
 *
 * Must run before any call that resolves a credential or sync-buffer path. The
 * vendored `resolveStateDir()` prefers `OPENCLAW_STATE_DIR`, so exporting it is
 * the whole integration; `CLAWDBOT_STATE_DIR` is cleared so a stray value from
 * the environment cannot win.
 */
export function configureWeixinStateDir() {
  const dir = stateDir()
  process.env.OPENCLAW_STATE_DIR = dir
  delete process.env.CLAWDBOT_STATE_DIR
  return dir
}
