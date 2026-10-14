/**
 * Tests for the installer's settings handling.
 *
 * The row this package mounts carries one value the operator must fill in by
 * hand: `allowedSenders`. The allowlist is deny-by-default, so losing it does
 * not fail loudly — the bot simply stops replying to anything, which is
 * indistinguishable from "the plugin is broken". An upgrade must therefore
 * carry that value across, in whichever YAML shape the operator wrote it.
 *
 * It must ALSO not mount the plugin twice. This package is installed as a
 * bundle, and a bundle's own patch layer already inserts the plugin row. An
 * installer that additionally inserts a row into the profile's
 * `cordis.patch.yml` produces two loader entries for one package — an insert
 * with no top-level `id` appends, it does not override — and each entry starts
 * its own long-poll loop against the same WeChat account. Historical versions
 * of this installer did exactly that, so the tests below assert the row is
 * removed and the settings move to a file the loader never composes.
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
function fakeHome({ patch } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-install-'))
  const profile = path.join(home, 'profiles', 'testprofile')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'test-profile', dsh: { profile: { bundles: [] } } }, null, 2),
  )
  if (patch !== undefined) fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), patch)
  return {
    home,
    patchPath: path.join(profile, 'cordis.patch.yml'),
    settingsPath: path.join(home, 'weixin', 'config.json'),
  }
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

function readSettings(settingsPath) {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
}

/** A minimal mounted row, the shape historical installers wrote. */
function legacyRow({ allowlist }) {
  return [
    '# dsh-plugin-weixin bundle patch layer.',
    '- insert:',
    '    - id: dsh-weixin',
    "      name: 'dsh-plugin-weixin'",
    '      config:',
    '        enabled: true',
    allowlist,
    '        maxMessageLength: 1500',
    '        typingIndicator: true',
    '        asr:',
    '          hfProxy: http://127.0.0.1:7897',
    "      disabled: !!js \"[...ctx.loader.entries()].some((e) => e.options.name === 'dsh-plugin-weixin' && e.options.id !== 'dsh-weixin' && !e.disabled)\"",
    '',
  ].join('\n')
}

test('a block-sequence allowlist migrates into the settings file', () => {
  const { home, settingsPath } = fakeHome({
    patch: legacyRow({ allowlist: '        allowedSenders:\n          - wxid_operator' }),
  })
  runInstall(home)

  assert.deepEqual(
    readSettings(settingsPath).allowedSenders,
    ['wxid_operator'],
    'the allowlist was dropped: deny-by-default silently turns the bot into a no-op',
  )
  fs.rmSync(home, { recursive: true, force: true })
})

test('an inline allowlist migrates into the settings file too', () => {
  const { home, settingsPath } = fakeHome({
    patch: legacyRow({ allowlist: '        allowedSenders: [wxid_inline, wxid_two]' }),
  })
  runInstall(home)

  const settings = readSettings(settingsPath)
  assert.deepEqual(settings.allowedSenders, ['wxid_inline', 'wxid_two'])
  // Other operator-owned scalars must come across as real JSON types, not text.
  assert.equal(settings.enabled, true)
  assert.equal(settings.maxMessageLength, 1500)
  fs.rmSync(home, { recursive: true, force: true })
})

test('the duplicate mount row is removed, leaving the bundle as the only mount', () => {
  const { home, patchPath } = fakeHome({
    patch: legacyRow({ allowlist: '        allowedSenders: [wxid_operator]' }),
  })
  runInstall(home)

  const text = fs.readFileSync(patchPath, 'utf8')
  assert.equal(
    [...text.matchAll(/^\s*-\s*id:\s*dsh-weixin\s*$/gm)].length,
    0,
    'the row survived, which double-mounts the plugin and starts two long-poll loops',
  )
  assert.doesNotMatch(text, /- insert:/, 'the insert block itself must go, not just the id line')
  fs.rmSync(home, { recursive: true, force: true })
})

test('another bundle\'s rows in the profile patch are left untouched', () => {
  const other = ['- id: ui-settings', '  name: "@deepseek-ai/dsh-client-ui-settings"', '  config:', '    enabled: false', ''].join('\n')
  const { home, patchPath } = fakeHome({ patch: `${other}${legacyRow({ allowlist: '        allowedSenders: []' })}` })
  runInstall(home)

  const text = fs.readFileSync(patchPath, 'utf8')
  assert.match(text, /- id: ui-settings/, 'a neighbouring override was deleted along with our row')
  assert.match(text, /enabled: false/, 'the neighbouring override lost its config')
  assert.equal([...text.matchAll(/^\s*-\s*id:\s*dsh-weixin\s*$/gm)].length, 0)
  fs.rmSync(home, { recursive: true, force: true })
})

test('a re-run never resets settings the operator already saved', () => {
  const { home, patchPath, settingsPath } = fakeHome({
    patch: legacyRow({ allowlist: '        allowedSenders: [wxid_from_patch]' }),
  })
  runInstall(home)
  // The operator edits the settings file, as the settings card would.
  const edited = readSettings(settingsPath)
  edited.allowedSenders = ['wxid_hand_edited']
  fs.writeFileSync(settingsPath, JSON.stringify(edited, null, 2))

  runInstall(home)
  runInstall(home)

  assert.deepEqual(
    readSettings(settingsPath).allowedSenders,
    ['wxid_hand_edited'],
    'a reinstall overwrote the live settings with stale patch values',
  )
  fs.rmSync(home, { recursive: true, force: true })
})

test('a nested block the operator set survives the migration', () => {
  // `asr.hfProxy` is the network fix. Losing it silently un-does it and the
  // operator sees a working config, so the nested block must come across.
  const { home, settingsPath } = fakeHome({
    patch: legacyRow({ allowlist: '        allowedSenders: []' }),
  })
  runInstall(home)

  const settings = readSettings(settingsPath)
  assert.equal(
    settings.asr?.hfProxy,
    'http://127.0.0.1:7897',
    'the nested asr block was dropped, silently un-fixing the download',
  )
  fs.rmSync(home, { recursive: true, force: true })
})

test('installing into a profile with no patch file still writes settings', () => {
  const { home, patchPath, settingsPath } = fakeHome()
  runInstall(home)

  assert.ok(fs.existsSync(settingsPath), 'the settings file must exist even with no legacy row')
  assert.deepEqual(readSettings(settingsPath), {})
  // The installer must not create a patch file just to hold a mount row.
  assert.ok(!fs.existsSync(patchPath) || !/- insert:/.test(fs.readFileSync(patchPath, 'utf8')))
  fs.rmSync(home, { recursive: true, force: true })
})
