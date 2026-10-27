/**
 * Small shared helpers for the pack CLI.
 *
 * Kept in `bin/lib` so `bin/pack.mjs` stays about the command and this file about
 * "where is the state, and whose account is the default one".
 */
import { readSavedConfig, stateDir } from '../../src/state.js'
import { readRegistry } from '../../src/account-registry.js'

export function stateRoot() {
  return stateDir()
}

/**
 * The account a CLI operation applies to: the saved one, else the only bound
 * account, else `''` (which callers turn into a refusal rather than a guess).
 */
export function activeAccountId() {
  const saved = readSavedConfig()
  if (typeof saved.accountId === 'string' && saved.accountId !== '') return saved.accountId
  const ids = Object.keys(readRegistry())
  return ids.length === 1 ? ids[0] : ''
}
