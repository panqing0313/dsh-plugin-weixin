/**
 * Who is who, in a chat where more than two people talk.
 *
 * The plugin's memory is per account and per conversation, which is right for a
 * 1:1 chat and wrong for a group: five people share one conversation, so one
 * person's allergy becomes everybody's shared fact. A contact profile is the small
 * fix — the same shape as the owner's profile (call, schedule, likes, dislikes,
 * dates), stored per sender, injected only in group chats and only for the person
 * actually talking.
 *
 * It is intentionally not a second memory system: no facts list, no digest, no
 * summariser. Those exist for the owner. A contact gets what a name card would
 * hold, and the model is told whose name card it is looking at.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'
import { sanitizeProfile, formatProfile } from '../memory.js'

export const CONTACTS_SCHEMA_VERSION = 1
export const CONTACT_MAX_CALL_CHARS = 40

function safeName(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9@._-]/g, '_').slice(0, 120) || 'unknown'
}

export function contactsDir(stateRoot) {
  return path.join(stateRoot, 'contacts')
}

export function contactFile(stateRoot, accountId, contactId) {
  return path.join(contactsDir(stateRoot), `${safeName(accountId)}-${safeName(contactId)}.json`)
}

/** All known contacts of one account, newest first by last seen. */
export function listContacts(stateRoot, accountId, { warn } = {}) {
  const dir = contactsDir(stateRoot)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const prefix = `${safeName(accountId)}-`
  const contacts = []
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
    const parsed = readJsonFile(path.join(dir, name), { version: CONTACTS_SCHEMA_VERSION, fallback: () => undefined, warn })
    if (parsed === undefined || typeof parsed !== 'object') continue
    contacts.push(parsed)
  }
  contacts.sort((a, b) => Number(b.lastSeenAt ?? 0) - Number(a.lastSeenAt ?? 0))
  return contacts
}

export function readContact(stateRoot, accountId, contactId, { warn } = {}) {
  const parsed = readJsonFile(contactFile(stateRoot, accountId, contactId), {
    version: CONTACTS_SCHEMA_VERSION,
    fallback: () => undefined,
    warn,
  })
  if (parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return { ...parsed, profile: sanitizeProfile(parsed.profile) }
}

/**
 * Create or update one. `patch.profile` merges field by field (a list replaces the
 * list it names), `call` is a shortcut for the one thing people actually set.
 */
export function saveContact(stateRoot, accountId, contactId, patch = {}, { now = Date.now(), warn } = {}) {
  if (typeof contactId !== 'string' || contactId === '') return { ok: false, reason: 'empty-contact' }
  const existing = readContact(stateRoot, accountId, contactId, { warn })
  const profile = { ...(existing?.profile ?? {}) }
  if (typeof patch.call === 'string') {
    profile.call = patch.call.trim().slice(0, CONTACT_MAX_CALL_CHARS)
  }
  if (patch.profile !== undefined && typeof patch.profile === 'object') {
    const sanitized = sanitizeProfile({ ...profile, ...patch.profile })
    Object.assign(profile, sanitized)
  }
  const record = {
    schemaVersion: CONTACTS_SCHEMA_VERSION,
    accountId: String(accountId),
    contactId: String(contactId),
    profile: sanitizeProfile(profile),
    firstSeenAt: Number(existing?.firstSeenAt ?? now),
    lastSeenAt: Number(patch.touch === false ? existing?.lastSeenAt ?? now : now),
  }
  fs.mkdirSync(contactsDir(stateRoot), { recursive: true })
  const written = atomicWriteJson(contactFile(stateRoot, accountId, contactId), record, { warn })
  return written ? { ok: true, contact: record } : { ok: false, reason: 'write-failed' }
}

/** Note that this person spoke, without changing their profile. */
export function touchContact(stateRoot, accountId, contactId, { now = Date.now(), warn } = {}) {
  const existing = readContact(stateRoot, accountId, contactId, { warn })
  return saveContact(stateRoot, accountId, contactId, { touch: true, profile: existing?.profile, now }, { now, warn })
}

/**
 * The block a group message gets: whose message it is, and what the bot knows about
 * them. Empty when there is nothing to say (a stranger in a group gets no block,
 * and the model is not told to guess).
 */
export function buildContactBlock(contact, { senderId } = {}) {
  // formatProfile already renders the call name and skips empty fields, so the card
  // and this block cannot disagree about what is known.
  const lines = formatProfile(contact?.profile)
  if (lines.length === 0) return ''
  return [
    `<weixin_contact id="${String(senderId ?? contact?.contactId ?? '')}">`,
    '这条消息来自群里的这个人。下面是你给他记的名字和已知的事，只用于理解他的话，不要主动念出来：',
    ...lines,
    '</weixin_contact>',
  ].join('\n')
}
