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

/** File holding the operator's settings for this plugin. */
export function configFile() {
  return path.join(stateDir(), 'config.json')
}

/**
 * Read the operator's saved settings.
 *
 * This is a plain JSON file under the plugin's own state root, deliberately NOT
 * a profile YAML patch. A profile patch row would have to be *inserted* through
 * `cordis.patch.yml`, and this package is also installed as a bundle — whose own
 * patch layer already inserts the same row. Two insertions of one `id` produce
 * two loader entries, both of which mount, so the account gets two long-poll
 * loops. DSH's own `dsh-better-sidebar` documentation states the rule: a profile
 * still carrying the manual mount line must drop it before switching to the
 * bundle channel. Keeping the settings beside the credentials (which already
 * live under this state root) sidesteps the composition entirely.
 *
 * A missing file, unreadable file, or malformed JSON all resolve to `{}`: this
 * is a settings overlay, and a corrupt overlay must cost the user their
 * preferences, never the plugin's ability to load and reply.
 *
 * @returns {Record<string, unknown>} saved settings, possibly empty
 */
export function readSavedConfig() {
  const file = configFile()
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    process.emitWarning(`dsh-weixin: ignoring malformed ${file}: ${String(error?.message ?? error)}`)
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.emitWarning(`dsh-weixin: ignoring ${file}: expected a JSON object`)
    return {}
  }
  return parsed
}

/**
 * Merge the operator's saved settings over the composition's own config.
 *
 * Precedence: the saved file written by the settings card is the newer
 * statement. A saved value wins unless it is the schema's empty form
 * (`undefined`, `''`, `[]`, `{}`); `false` and `0` are real values. `asr`
 * merges one level deeper, and an explicit non-empty composition
 * `allowedSenders` stays authoritative.
 *
 * The reason is the one that forced the `asr` rule: the loader validates the
 * composition through schemastery before `apply` sees it, so every field
 * arrives with its schema default already filled in. `{ ...saved, ...config }`
 * therefore let a default outrank the card — `proactiveEnabled: true` in
 * config.json reached `planProactive` as `false` and no proactive message was
 * ever planned (2026-10-28); `quietHoursEnabled: true` was read as false, and
 * `memoryEnabled: false` could not switch memory off.
 *
 * @param {Record<string, unknown>} config config as the loader passed it
 * @returns {Record<string, unknown>} config with the saved settings applied
 */
export function withSavedConfig(config) {
  const saved = readSavedConfig()
  const merged = { ...saved, ...config }
  // `allowedSenders` needs its own rule. The schemastery schema instantiates
  // every field, so a composition that never mentions the array still arrives
  // as `allowedSenders: []` — and spread-merge would let that default win over
  // the operator's saved allowlist, refusing every sender while the file on
  // disk looks perfectly configured (observed 2026-10-15: the refusal log said
  // `allowedSenders=[]` while config.json listed exactly one id). An empty
  // array from the composition cannot be distinguished from an explicit
  // deny-all, but the deny-all is already the behavior of an EMPTY SAVED FILE,
  // so a non-empty saved list always wins over an empty composition value.
  if (
    Array.isArray(merged.allowedSenders) &&
    merged.allowedSenders.length === 0 &&
    Array.isArray(saved.allowedSenders) &&
    saved.allowedSenders.length > 0
  ) {
    merged.allowedSenders = saved.allowedSenders
  }
  // `asr` needs the same protection, one level deeper. Its schema defaults are
  // `command: ''`, `args: []`, `env: {}`, `model: ''` — so a host that passes
  // the schema-instantiated config (which is every host: the loader validates
  // the composition through schemastery before `apply` sees it) arrives with an
  // `asr` object whose `command` is the empty string. Spread-merging that over
  // the saved section erased the operator's real command and left the bridge
  // undefined while `config.json` still showed it — the "voice notes arrive but
  // say `no ASR bridge is configured`" symptom (observed 2026-10-16).
  //
  // The rule is per field and deliberately conservative: a saved value always
  // outranks the composition UNLESS the saved value is itself the empty form.
  // `withSavedConfig` cannot tell a schema default from a value the operator
  // wrote in the YAML — both arrive as plain values on `config` — so the only
  // safe reading is "the settings page is the newer, more specific statement".
  // That is also how the top-level merge already behaves for every key the
  // composition omits. `false` and `0` are real values and are never treated as
  // empty, so an operator who switched transcription off keeps it off.
  const savedAsr = saved.asr
  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  const isEmptyDefault = (value) =>
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (isPlainObject(value) && Object.keys(value).length === 0)

  if (isPlainObject(savedAsr) && isPlainObject(config?.asr)) {
    const asr = { ...config.asr }
    for (const [key, savedValue] of Object.entries(savedAsr)) {
      if (!isEmptyDefault(savedValue)) asr[key] = savedValue
    }
    merged.asr = asr
  }
  // The same rule now applies to the top level: a saved value beats the
  // schema-instantiated default the loader passed. `asr` and `allowedSenders`
  // keep the rules above; `null` counts as "not set here", while `false` and
  // `0` are real values.
  for (const [key, savedValue] of Object.entries(saved)) {
    if (key === 'asr' || key === 'allowedSenders') continue
    if (savedValue === null || isEmptyDefault(savedValue)) continue
    merged[key] = savedValue
  }
  return merged
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
