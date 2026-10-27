import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

test('the package can be run with npx, so installing does not require a clone', () => {
  // npm publishes a `bin` shim only when package.json names one; without this
  // entry `npx dsh-plugin-weixin` fails with "could not determine executable".
  assert.equal(pkg.bin?.['dsh-plugin-weixin'], 'bin/install.mjs')
  const entry = path.join(ROOT, pkg.bin['dsh-plugin-weixin'])
  assert.ok(fs.existsSync(entry), 'the file the bin entry points at exists')
  const body = fs.readFileSync(entry, 'utf8')
  assert.match(body, /^#!\/usr\/bin\/env node/, 'a bin target needs a shebang or npm will not run it')
  // A file inside `files` must ship, otherwise npx would install a package whose
  // entry point is missing.
  assert.ok(Array.isArray(pkg.files))
  assert.ok(pkg.files.some((entryPath) => entryPath === 'bin'), 'bin/ ships with the package')
})

test('the soak and metrics scripts exist and are wired to real files', () => {
  assert.equal(pkg.scripts.metrics, 'node bin/metrics.mjs')
  assert.equal(pkg.scripts.soak, 'node bin/soak.mjs')
  for (const file of ['bin/metrics.mjs', 'bin/soak.mjs']) {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8')
    assert.match(body, /^#!\/usr\/bin\/env node/)
  }
})

test('the metrics reader explains itself instead of crashing when nothing has been written yet', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-metrics-cli-'))
  const run = spawnSync(process.execPath, ['bin/metrics.mjs', '--state', state], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /no metrics yet: .*metrics\.json/)
  assert.match(run.stderr, /every 30s while it is running/)
})
