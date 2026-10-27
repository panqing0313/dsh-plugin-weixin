// Secrets do not belong in a log line, and they should not be world-readable on
// disk.
//
// The audit (D25) was about both halves. The account file under
// ~/.dsh/weixin/openclaw-weixin/accounts carries the bot token in plain JSON; it
// is written by the vendored login flow, so its permissions are whatever the
// process umask allowed. And every error path in the plugin funnels a string
// through `warn`, which lands in both the host logger and the file the operator
// reads — one thrown error that happens to include the token and the secret is
// on disk and in the support bundle.
//
// Two small defences, both cheap enough to keep on always: mask token-shaped
// substrings before anything is logged, and force the secret files to 0600 at
// startup.
import fs from 'node:fs'
import path from 'node:path'

/** Token shapes worth masking. Deliberately conservative: long, high-entropy runs. */
const SECRET_PATTERNS = [
  // Bearer/Bot prefixes: keep the scheme, mask the value.
  [/\b(Bearer|Bot|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 ***'],
  // A JSON field whose name says token/secret/password.
  [/("?(?:token|secret|password|aeskey|aes_key|authorization)"?\s*[:=]\s*")([^"]{12,})(")/gi, '$1***$3'],
  // Bare long hex (tokens and keys in this protocol are hexish).
  [/\b[0-9a-f]{32,}\b/gi, '***'],
  // Bare long base64 (the aes_key wire form is base64 of a hex string).
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '***'],
]

/**
 * Mask anything that looks like a credential. Safe on ordinary text: the
 * patterns require length and an alphabet that prose does not use by accident.
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Paths that hold credentials for this plugin. */
export function secretFiles(stateRoot) {
  const accounts = path.join(stateRoot, 'openclaw-weixin', 'accounts')
  const files = [path.join(stateRoot, 'config.json')]
  try {
    for (const entry of fs.readdirSync(accounts)) {
      if (entry.endsWith('.json') && entry.endsWith('.sync.json') === false) files.push(path.join(accounts, entry))
    }
  } catch {
    // No accounts directory yet: nothing to protect, which is fine.
  }
  return files
}

/**
 * Force the secret files to 0600. Returns `{checked, tightened}` so the caller can
 * say what it did — a fix that happens silently is a fix nobody trusts.
 */
export function ensureSecretModes(stateRoot, { warn } = {}) {
  let checked = 0
  const tightened = []
  for (const file of secretFiles(stateRoot)) {
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    checked += 1
    const mode = stat.mode & 0o777
    if ((mode & 0o077) === 0) continue
    try {
      fs.chmodSync(file, 0o600)
      tightened.push(file)
    } catch (error) {
      warn?.(`could not tighten permissions on ${file}: ${String(error)}`)
    }
  }
  return { checked, tightened }
}
