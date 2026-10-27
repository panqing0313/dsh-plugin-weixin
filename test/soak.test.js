import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

test('a short soak run holds every invariant', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-soak-test-'))
  // The isolated-run wrapper points the journal and the logs at a throwaway dir;
  // the soak asserts against the state it was handed, so drop those overrides.
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('DSH_WEIXIN_')) delete env[key]
  const run = spawnSync(process.execPath, ['bin/soak.mjs', '--minutes', '0.04', '--rate', '40', '--state', state], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env,
  })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /all invariants held/)
  assert.match(run.stdout, /journal \d+ entries/)
  // The state it leaves behind is real: a journal, an outbox and a backup.
  assert.ok(fs.existsSync(path.join(state, 'journal')))
  assert.ok(fs.existsSync(path.join(state, 'outbox.json')))
  assert.ok(fs.readdirSync(path.join(state, 'backups')).length >= 1)
})
