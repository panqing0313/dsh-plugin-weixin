// `--fix` repairs the problems a diagnostic can fix without a human: the
// directories the plugin owns, a state file the umask left world-readable, a
// temp file a dead process never renamed away, a state file that is not JSON.
//
// Every test runs the script as a child process against a temporary state root
// via DSH_WEIXIN_STATE_DIR, so neither the DSH host nor the operator's real
// credentials are involved.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCTOR = path.join(ROOT, 'bin', 'doctor.mjs')

function run(stateDir, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [DOCTOR, ...args], {
      encoding: 'utf8',
      env: { ...process.env, DSH_WEIXIN_STATE_DIR: stateDir },
      timeout: 30_000,
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

function fixture(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

function modeOf(file) {
  return fs.statSync(file).mode & 0o777
}

/** A state root that passes every check: one account and one allowlisted sender. */
function completeFixture(prefix) {
  const dir = fixture(prefix)
  const accounts = path.join(dir, 'openclaw-weixin', 'accounts')
  fs.mkdirSync(accounts, { recursive: true })
  const account = path.join(accounts, 'bot1.json')
  fs.writeFileSync(account, JSON.stringify({ token: 't', savedAt: '2026-10-27T00:00:00.000Z' }))
  fs.chmodSync(account, 0o644)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ allowedSenders: ['wxid_abc'] }))
  return dir
}

function brokenFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes('.broken-'))
}

test('--fix creates the directories the plugin owns', () => {
  const dir = fixture('doctor-fix-dirs-')
  try {
    const result = run(dir, ['--fix'])
    for (const sub of ['memory', path.join('media', 'inbound'), 'knowledge', 'backups']) {
      assert.equal(fs.existsSync(path.join(dir, sub)), true, `${sub} must exist after --fix`)
    }
    assert.match(result.stdout, /fixed:/)
    assert.match(result.stdout, /created memory\//)
    assert.match(result.stdout, /created media\/inbound\//)
    assert.match(result.stdout, /created knowledge\//)
    assert.match(result.stdout, /created backups\//)
  } finally {
    cleanup(dir)
  }
})

test('--fix tightens a 0644 token file to 0600 and restores owner read elsewhere', () => {
  const dir = completeFixture('doctor-fix-mode-')
  const account = path.join(dir, 'openclaw-weixin', 'accounts', 'bot1.json')
  const journal = path.join(dir, 'journal')
  const entry = path.join(journal, '2026-01-01.jsonl')
  try {
    fs.mkdirSync(journal, { recursive: true })
    fs.writeFileSync(entry, '{}\n')
    fs.chmodSync(entry, 0o200) // write-only: the owner can no longer read its own journal
    assert.equal(modeOf(account), 0o644)
    assert.equal(modeOf(entry), 0o200)

    const result = run(dir, ['--fix'])

    assert.equal(modeOf(account), 0o600, 'a file holding a token must not be group/other readable')
    assert.equal(modeOf(entry) & 0o400, 0o400, 'the owner must be able to read a journal file again')
    assert.match(result.stdout, /chmod 0600 openclaw-weixin\//)
    assert.match(result.stdout, /owner could not read it/)
  } finally {
    cleanup(dir)
  }
})

test('--fix moves a malformed state file aside instead of deleting it', () => {
  const dir = fixture('doctor-fix-broken-')
  const reminders = path.join(dir, 'reminders.json')
  try {
    fs.writeFileSync(reminders, '{ this is not json')

    const result = run(dir, ['--fix'])

    assert.equal(fs.existsSync(reminders), false, 'the malformed file must not stay in place')
    const aside = brokenFiles(dir)
    assert.equal(aside.length, 1, `expected exactly one .broken- file, got ${aside.join(', ') || '(none)'}`)
    assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{ this is not json')
    assert.match(result.stdout, /moved reminders\.json → reminders\.json\.broken-/)
  } finally {
    cleanup(dir)
  }
})

test('--fix removes a stale temp file but keeps a fresh one', () => {
  const dir = fixture('doctor-fix-tmp-')
  const stale = path.join(dir, 'outbox.json.4242.abc.tmp')
  const fresh = path.join(dir, 'outbox.json.4242.def.tmp')
  try {
    fs.writeFileSync(stale, '{}')
    fs.writeFileSync(fresh, '{}')
    const twoDaysAgo = (Date.now() - 48 * 60 * 60 * 1000) / 1000
    fs.utimesSync(stale, twoDaysAgo, twoDaysAgo)

    const result = run(dir, ['--fix'])

    assert.equal(fs.existsSync(stale), false, 'a temp file older than 24h is a leftover')
    assert.equal(fs.existsSync(fresh), true, 'a fresh temp file may belong to a write still in flight')
    assert.match(result.stdout, /removed 1 temp file\(s\) older than 24h/)
    assert.match(result.stdout, /outbox\.json\.4242\.abc\.tmp/)
  } finally {
    cleanup(dir)
  }
})

test('--dry-run lists the repairs and changes nothing', () => {
  const dir = completeFixture('doctor-fix-dry-')
  const account = path.join(dir, 'openclaw-weixin', 'accounts', 'bot1.json')
  const reminders = path.join(dir, 'reminders.json')
  try {
    fs.writeFileSync(reminders, 'not json')
    const before = fs.readdirSync(dir).sort()

    const result = run(dir, ['--fix', '--dry-run'])

    assert.match(result.stdout, /would fix \(dry run\):/)
    assert.match(result.stdout, /created memory\//)
    assert.equal(fs.existsSync(path.join(dir, 'memory')), false, 'dry run must not create directories')
    assert.equal(fs.existsSync(path.join(dir, 'backups')), false)
    assert.equal(fs.existsSync(reminders), true, 'dry run must not move the malformed file')
    assert.equal(modeOf(account), 0o644, 'dry run must not chmod')
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'dry run must not leave a .broken- file behind')
  } finally {
    cleanup(dir)
  }
})

test('--dry-run on its own also only lists', () => {
  const dir = fixture('doctor-fix-dryonly-')
  try {
    const result = run(dir, ['--dry-run'])
    assert.match(result.stdout, /would fix/)
    assert.equal(fs.existsSync(path.join(dir, 'memory')), false)
    assert.equal(fs.existsSync(path.join(dir, 'backups')), false)
  } finally {
    cleanup(dir)
  }
})

test('without --fix nothing is created, moved or chmod-ed', () => {
  const dir = completeFixture('doctor-fix-nofix-')
  const account = path.join(dir, 'openclaw-weixin', 'accounts', 'bot1.json')
  const reminders = path.join(dir, 'reminders.json')
  try {
    fs.writeFileSync(reminders, 'not json')

    const result = run(dir)

    assert.equal(result.code, 0, result.stdout)
    assert.doesNotMatch(result.stdout, /fixed:|would fix/)
    assert.equal(fs.existsSync(path.join(dir, 'memory')), false)
    assert.equal(fs.existsSync(path.join(dir, 'media')), false)
    assert.equal(fs.existsSync(path.join(dir, 'knowledge')), false)
    assert.equal(fs.existsSync(path.join(dir, 'backups')), false)
    assert.equal(fs.existsSync(reminders), true, 'a read-only diagnosis must not move it')
    assert.equal(brokenFiles(dir).length, 0)
    assert.equal(modeOf(account), 0o644)
  } finally {
    cleanup(dir)
  }
})

test('--fix leaves the check section it prints unchanged', () => {
  const plain = completeFixture('doctor-fix-plain-')
  const repaired = completeFixture('doctor-fix-repair-')
  try {
    // Everything before the "fixed:" section, with the state path and the one
    // networked line normalised away, must be byte-identical to the plain run.
    const checkSection = (stdout, dir) => {
      const cut = stdout.indexOf('\nfixed:')
      const text = cut === -1 ? stdout : stdout.slice(0, cut)
      return text
        .split('\n')
        .filter((line) => line.includes('published version') === false)
        .join('\n')
        .replaceAll(dir, '<state>')
    }

    const a = run(plain)
    const b = run(repaired, ['--fix'])

    assert.equal(b.code, a.code)
    assert.equal(checkSection(b.stdout, repaired), checkSection(a.stdout, plain))
  } finally {
    cleanup(plain)
    cleanup(repaired)
  }
})