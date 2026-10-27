import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCTOR = path.join(ROOT, 'bin', 'doctor.mjs')

function run(stateDir) {
  try {
    const stdout = execFileSync(process.execPath, [DOCTOR], {
      encoding: 'utf8',
      env: { ...process.env, DSH_WEIXIN_STATE_DIR: stateDir },
      timeout: 30_000,
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? '') }
  }
}

test('doctor calls out a fresh state directory that has no account and no allowlist', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'doctor-empty-'))
  try {
    const result = run(dir)
    assert.equal(result.code, 1, 'an unusable install must exit non-zero')
    assert.match(result.stdout, /✗ allowed senders/, 'an empty allowlist is the classic "why does it ignore me"')
    assert.match(result.stdout, /✗ weixin account/, 'no account file means never logged in')
    assert.match(result.stdout, /state directory writable/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor passes a state directory that has an account and an allowlist', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'doctor-ok-'))
  try {
    const accounts = path.join(dir, 'openclaw-weixin', 'accounts')
    mkdirSync(accounts, { recursive: true })
    writeFileSync(path.join(accounts, 'bot1.json'), JSON.stringify({ token: 't', savedAt: '2026-10-27T00:00:00.000Z' }))
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ allowedSenders: ['wxid_abc'] }))
    const result = run(dir)
    assert.equal(result.code, 0, result.stdout)
    assert.match(result.stdout, /✓ allowed senders/)
    assert.match(result.stdout, /✓ account bot1.json/)
    assert.match(result.stdout, /0 problem\(s\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
