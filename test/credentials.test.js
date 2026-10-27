import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { redactSecrets, secretFiles, ensureSecretModes } from '../src/credentials.js'

test('redactSecrets masks token-shaped strings and leaves prose alone', () => {
  assert.equal(redactSecrets('sendMessage ret=-2 errmsg=prepare failed'), 'sendMessage ret=-2 errmsg=prepare failed')
  assert.equal(redactSecrets('Bearer abcdef1234567890xyz'), 'Bearer ***')
  assert.match(redactSecrets('{"token":"0123456789abcdef0123456789abcdef0123"}'), /"token":"\*\*\*"/)
  assert.match(redactSecrets('key 9f'.padEnd(40, 'a')), /\*\*\*/)
  assert.match(redactSecrets('aes_key dGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgc3RyaW5n'), /\*\*\*/)
  assert.equal(redactSecrets(''), '')
  assert.equal(redactSecrets(undefined), undefined)
})

test('ensureSecretModes tightens a world-readable account file and says so', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cred-'))
  try {
    const accounts = path.join(root, 'openclaw-weixin', 'accounts')
    fs.mkdirSync(accounts, { recursive: true })
    const account = path.join(accounts, 'bot1.json')
    fs.writeFileSync(account, JSON.stringify({ token: 'x' }))
    fs.chmodSync(account, 0o644)
    const config = path.join(root, 'config.json')
    fs.writeFileSync(config, '{}')
    fs.chmodSync(config, 0o644)

    assert.deepEqual(secretFiles(root).sort(), [account, config].sort())
    const result = ensureSecretModes(root)
    assert.equal(result.checked, 2)
    assert.equal(result.tightened.length, 2)
    assert.equal(fs.statSync(account).mode & 0o777, 0o600)
    assert.equal(fs.statSync(config).mode & 0o777, 0o600)

    const again = ensureSecretModes(root)
    assert.deepEqual(again.tightened, [], 'a second pass has nothing to do')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('secretFiles tolerates a state root that has never been used', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cred-empty-'))
  try {
    const files = secretFiles(root)
    assert.equal(files.length, 1, 'only config.json is known before first login')
    assert.deepEqual(ensureSecretModes(root), { checked: 0, tightened: [] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
