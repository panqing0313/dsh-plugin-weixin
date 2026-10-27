/**
 * A shareable template: the personality, the rhythm, and the schedule as one file.
 *
 * What a pack contains — and deliberately what it does not — is the whole design:
 *
 * - persona modes the operator wrote (not the built-ins: those ship with the plugin
 *   and would make every pack stale the moment a new role is added);
 * - the behaviour knobs that make a bot feel like a particular bot (companion
 *   pacing, stickers, life state, proactive window, digest times, quiet hours,
 *   locale);
 * - subscriptions, as the words plus their clock, so a friend can import
 *   "每天 08:00 早安" without inheriting anyone's account;
 * - and NOT: memory, credentials, allowlists, journal, sessions. A pack is a
 *   starting point, not a copy of somebody's life. Importing one cannot overwrite
 *   what the importer already remembers.
 */
import fs from 'node:fs'
import path from 'node:path'
import { MAX_CUSTOM_MODES, readPersonaStore, writePersonaStore } from './persona.js'
import { readSubscriptions, parseSubscriptionWhen } from './message/subscriptions.js'
import { stateDir } from './state.js'

export const PACK_FORMAT = 'dsh-weixin-pack'
export const PACK_VERSION = 1
/** Subscriptions a pack may carry; the per-account live cap is the same number. */
export const PACK_MAX_SUBSCRIPTIONS = 20

/**
 * The settings a pack may carry. Anything absent here — `allowedSenders`,
 * `maxMediaBytes`, tokens, model routes — is either a security decision or tied to
 * the machine it runs on, so it never travels in a template.
 */
export const PACK_CONFIG_KEYS = Object.freeze([
  'personaDefaultMode',
  'humanPacing', 'replyDelayMaxMs', 'bubbleSplitMax', 'bubbleGapMs', 'lifeState',
  'stickerEnabled',
  'proactiveEnabled', 'proactiveMinGapMinutes', 'proactiveMaxPerDay', 'proactiveWindowStart', 'proactiveWindowEnd',
  'digestEnabled', 'digestWhen', 'memoryReviewEnabled', 'memoryReviewWhen',
  'memoryEnabled', 'memoryRecentTurns', 'memoryRecall', 'memoryRecallDays', 'memoryRecallHits',
  'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd',
  'locale',
])

const CONFIG_KEY_SET = new Set(PACK_CONFIG_KEYS)

/** The clock of a subscription, in the same vocabulary `/subscribe` accepts. */
export function describeSubscriptionClock(item) {
  if (item?.kind === 'daily' && typeof item.time === 'string') return `每天 ${item.time}`
  if (item?.kind === 'weekly' && typeof item.time === 'string') {
    const names = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' }
    return `每周${names[item.weekday] ?? '一'} ${item.time}`
  }
  return undefined
}

/** Build a pack from what is on disk right now. */
export function exportPack(stateRoot, accountId, { config = {}, name = '', now = Date.now() } = {}) {
  const modes = (readPersonaStore(stateRoot) ?? [])
    .filter((mode) => mode.builtin !== true && mode.game !== true)
    .map((mode) => ({ name: mode.name, prompt: mode.prompt }))
  const subscriptions = readSubscriptions(stateRoot).items
    .filter((item) => item.accountId === accountId)
    .map((item) => ({ prompt: item.prompt, when: describeSubscriptionClock(item) }))
    .filter((item) => typeof item.when === 'string')
    .slice(0, PACK_MAX_SUBSCRIPTIONS)
  const settings = {}
  for (const key of PACK_CONFIG_KEYS) {
    if (config[key] !== undefined) settings[key] = config[key]
  }
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    name: name === '' ? `微信陪聊模板 ${new Date(now).toISOString().slice(0, 10)}` : name,
    createdAt: new Date(now).toISOString(),
    config: settings,
    persona: { modes },
    subscriptions,
  }
}

function asPack(raw) {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { error: 'not-json' }
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: 'not-a-pack' }
  if (value.format !== PACK_FORMAT) return { error: 'wrong-format' }
  if (Number(value.version) > PACK_VERSION) return { error: 'newer-version' }
  return { pack: value }
}

/**
 * Apply a pack. Every part is optional and every part is additive: modes are
 * added (never overwritten), subscriptions are added (never replaced), settings are
 * merged. Importing the same pack twice adds nothing the second time.
 *
 * @returns {{ ok: boolean, error?: string, modes: {added: string[], skipped: Array<{name: string, reason: string}>}, subscriptions: {added: string[], skipped: Array<{prompt: string, reason: string}>}, config: string[] }}
 */
export function importPack(stateRoot, accountId, raw, { now = Date.now(), scheduleSubscription, conversationId: packConversationId } = {}) {
  const parsed = asPack(raw)
  if (parsed.error !== undefined) {
    return { ok: false, error: parsed.error, modes: { added: [], skipped: [] }, subscriptions: { added: [], skipped: [] }, config: [] }
  }
  const pack = parsed.pack

  const modes = readPersonaStore(stateRoot) ?? []
  const addedModes = []
  const skippedModes = []
  const existingNames = new Set(modes.map((mode) => String(mode.name ?? '').toLowerCase()))
  let customCount = modes.filter((mode) => mode.builtin !== true && mode.game !== true).length
  for (const entry of Array.isArray(pack.persona?.modes) ? pack.persona.modes : []) {
    const name = String(entry?.name ?? '').trim()
    const prompt = String(entry?.prompt ?? '').trim()
    if (name === '' || prompt === '') { skippedModes.push({ name, reason: 'empty-name-or-prompt' }); continue }
    if (existingNames.has(name.toLowerCase())) { skippedModes.push({ name, reason: 'duplicate-name' }); continue }
    if (customCount >= MAX_CUSTOM_MODES) { skippedModes.push({ name, reason: 'cap' }); continue }
    const id = `custom-${now.toString(36)}-${addedModes.length}`
    modes.push({ id, name, prompt, builtin: false })
    existingNames.add(name.toLowerCase())
    customCount += 1
    addedModes.push(name)
  }
  if (addedModes.length > 0) writePersonaStore(stateRoot, modes)

  const addedSubscriptions = []
  const skippedSubscriptions = []
  for (const entry of Array.isArray(pack.subscriptions) ? pack.subscriptions : []) {
    const prompt = String(entry?.prompt ?? '').trim()
    const when = String(entry?.when ?? '').trim()
    if (prompt === '' || when === '') { skippedSubscriptions.push({ prompt, reason: 'empty-prompt-or-when' }); continue }
    if (typeof scheduleSubscription !== 'function') { skippedSubscriptions.push({ prompt, reason: 'not-wired' }); continue }
    // The scheduler takes a parsed clock, not the words: parsing here keeps a pack
    // from importing a schedule that would immediately be rejected.
    const parsedClock = parseSubscriptionWhen(when, new Date(now))
    if (parsedClock?.ok !== true) { skippedSubscriptions.push({ prompt, reason: 'bad-clock' }); continue }
    const result = scheduleSubscription({ prompt, when: parsedClock, accountId, conversationId: packConversationId })
    if (result?.ok === true) addedSubscriptions.push(prompt)
    else skippedSubscriptions.push({ prompt, reason: result?.reason ?? 'refused' })
  }

  const config = Object.keys(pack.config ?? {}).filter((key) => CONFIG_KEY_SET.has(key))
  return { ok: true, modes: { added: addedModes, skipped: skippedModes }, subscriptions: { added: addedSubscriptions, skipped: skippedSubscriptions }, config }
}

/** Where an exported pack would be written, so the card and the CLI agree. */
export function packFile(stateRoot, name, now = Date.now()) {
  const safe = String(name).replace(/[^\w\u4e00-\u9fff-]+/g, '-').slice(0, 60) || 'pack'
  return path.join(stateRoot, 'exports', `${safe}-${new Date(now).toISOString().slice(0, 10)}.json`)
}

/** Write a pack next to the chat exports. Returns the absolute path. */
export function writePack(stateRoot, pack) {
  const target = packFile(stateRoot === undefined ? stateDir() : stateRoot, pack.name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(pack, null, 2)}\n`, { mode: 0o600 })
  return target
}
