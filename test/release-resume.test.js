/**
 * A release runs under `script(1)` because npm only prints its one-time-password
 * link on a real pty. When that wrapper goes away the kernel hangs up on the
 * process group, and node's default SIGHUP handler exits immediately — which is
 * how three releases in a row (0.9.7, 0.9.8, 0.9.10) ended with a published
 * tarball, a pushed tag, and no profile pin. `writeOut` swallowing EPIPE was
 * only half of it: the process itself was being killed.
 *
 * These tests pin the half that lives in this repo rather than in node's
 * defaults: the signal handling, the argument shapes, and the `--finish` escape
 * hatch that finishes a release whose terminal died.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

test('the release script keeps running when its terminal hangs up', async () => {
  const before = process.listenerCount('SIGHUP')
  const { parseReleaseArgs } = await import('../bin/release.mjs')
  assert.equal(typeof parseReleaseArgs, 'function')
  assert.ok(
    process.listenerCount('SIGHUP') > before,
    'importing release.mjs must install a SIGHUP handler — otherwise a closed pty kills the release between the tag and the profile pin',
  )
})

test('--finish is parsed apart from a normal release run', async () => {
  const { parseReleaseArgs } = await import('../bin/release.mjs')

  assert.deepEqual(parseReleaseArgs(['0.9.11', '--finish']), {
    version: '0.9.11',
    dryRun: false,
    assumeYes: false,
    allowStaleLockfile: false,
    finish: true,
  })

  // A normal run must not be mistaken for a resume, and the flags stay apart.
  assert.equal(parseReleaseArgs(['0.9.11', '--yes']).finish, false)
  assert.equal(parseReleaseArgs(['--dry-run']).dryRun, true)
  assert.equal(parseReleaseArgs(['--allow-stale-lockfile']).allowStaleLockfile, true)
  assert.equal(parseReleaseArgs([]).version, undefined)
})

test('--finish without a version says what it needs, instead of half-running', () => {
  const result = spawnSync('node', ['bin/release.mjs', '--finish'], { cwd: ROOT, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.notEqual(result.status, 0, 'a --finish with no version must fail')
  assert.match(output, /--finish needs the version/)
  assert.match(output, /node bin\/release\.mjs --finish \d+\.\d+\.\d+/)
})
