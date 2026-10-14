/**
 * Tests for the installer's cordis.patch.yml handling.
 *
 * The row this package mounts carries one value the operator must fill in by
 * hand: `allowedSenders`. The allowlist is deny-by-default, so losing it does
 * not fail loudly — the bot simply stops replying to anything, which is
 * indistinguishable from "the plugin is broken". An upgrade must therefore
 * carry that value across, in whichever YAML shape the operator wrote it.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL = path.join(ROOT, 'bin', 'install.mjs')

/** Build a throwaway DSH home with one profile, and return the paths we use. */
function fakeHome({ patch }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-install-'))
  const profile = path.join(home, 'profiles', 'testprofile')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'test-profile', dsh: { profile: { bundles: [] } } }, null, 2),
  )
  if (patch !== undefined) fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), patch)
  return { home, patchPath: path.join(profile, 'cordis.patch.yml') }
}

function runInstall(home) {
  const result = spawnSync(process.execPath, [INSTALL, '--profile', 'testprofile'], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'testprofile' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `installer failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

/** Pull the mounted row's config out of the patch file, without a YAML dep. */
function readRowConfig(text) {
  const lines = text.split('\n')
  const idAt = lines.findIndex((line) => /^\s*-\s*id:\s*dsh-weixin\s*$/.test(line))
  assert.notEqual(idAt, -1, `no dsh-weixin row in:\n${text}`)
  const configAt = lines.findIndex((line, index) => index > idAt && /^\s*config:\s*$/.test(line))
  assert.notEqual(configAt, -1, 'the mounted row has no config block')
  const baseIndent = lines[configAt].match(/^[ \t]*/)[0].length
  const config = {}
  let key = null
  for (let at = configAt + 1; at < lines.length; at += 1) {
    const line = lines[at]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.match(/^[ \t]*/)[0].length
    if (indent <= baseIndent) break
    const item = line.match(/^\s*-\s*(.+)$/)
    if (item !== null && key !== null) {
      config[key].push(item[1].trim())
      continue
    }
    const entry = line.match(/^\s*([A-Za-z_][\w]*):[ \t]*(.*)$/)
    if (entry === null) continue
    key = entry[1]
    const inline = entry[2].trim()
    if (inline === '') {
      // Block sequence (or empty); items are collected on the following lines.
      config[key] = []
    } else if (inline.startsWith('[') && inline.endsWith(']')) {
      // Flow sequence: split on commas, treating `[]` as empty.
      const body = inline.slice(1, -1).trim()
      config[key] = body === '' ? [] : body.split(',').map((item) => item.trim())
    } else {
      config[key] = [inline]
    }
  }
  return config
}

test('a block-sequence allowlist survives an upgrade', () => {
  const { home, patchPath } = fakeHome({
    patch:
      '[]\n',
  })
  runInstall(home)
  // Write the allowlist the way an operator would: as a block sequence.
  const installed = fs.readFileSync(patchPath, 'utf8')
  fs.writeFileSync(
    patchPath,
    installed.replace(/^(\s*)allowedSenders:\s*\[\s*\]\s*$/m, '$1allowedSenders:\n$1  - wxid_operator'),
  )
  assert.deepEqual(readRowConfig(fs.readFileSync(patchPath, 'utf8')).allowedSenders, ['wxid_operator'])

  // A second install stands in for the next upgrade.
  runInstall(home)
  const after = readRowConfig(fs.readFileSync(patchPath, 'utf8'))
  assert.deepEqual(
    after.allowedSenders,
    ['wxid_operator'],
    'the allowlist was dropped: deny-by-default silently turns the bot into a no-op',
  )
  fs.rmSync(home, { recursive: true, force: true })
})

test('an inline allowlist survives an upgrade too', () => {
  const { home, patchPath } = fakeHome({ patch: '[]\n' })
  runInstall(home)
  const installed = fs.readFileSync(patchPath, 'utf8')
  fs.writeFileSync(
    patchPath,
    installed.replace(/^(\s*)allowedSenders:\s*\[\s*\]\s*$/m, '$1allowedSenders: [wxid_inline, wxid_two]'),
  )
  runInstall(home)
  const after = readRowConfig(fs.readFileSync(patchPath, 'utf8'))
  assert.deepEqual(after.allowedSenders, ['wxid_inline', 'wxid_two'])
  // The other operator-owned scalars must come across as well.
  assert.deepEqual(after.enabled, ['true'])
  fs.rmSync(home, { recursive: true, force: true })
})

test('an upgrade keeps the row singular and does not duplicate the header', () => {
  const { home, patchPath } = fakeHome({ patch: '[]\n' })
  runInstall(home)
  runInstall(home)
  runInstall(home)
  const text = fs.readFileSync(patchPath, 'utf8')
  const rows = [...text.matchAll(/^\s*-\s*id:\s*dsh-weixin\s*$/gm)]
  assert.equal(rows.length, 1, 'the row was duplicated, which would start two long-poll loops')
  assert.equal(
    [...text.matchAll(/dsh-weixin — a DSH channel plugin/g)].length,
    0,
    'the installed patch must not accumulate the package README header',
  )
  fs.rmSync(home, { recursive: true, force: true })
})
