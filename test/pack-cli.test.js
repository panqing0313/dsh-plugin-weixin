import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPersonaStore, writePersonaStore } from '../src/persona.js'
import { PACK_FORMAT } from '../src/packs.js'
import { readSubscriptions, writeSubscriptions } from '../src/message/subscriptions.js'

const ROOT = path.resolve(import.meta.dirname, '..')

function stateWithPack() {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-pack-cli-'))
  const modes = readPersonaStore(state)
  modes.push({ id: 'custom-x', name: '毒舌室友', prompt: '损友，嘴上不饶人但会记得你的事。', builtin: false })
  writePersonaStore(state, modes)
  const store = readSubscriptions(state)
  store.seq = 1
  store.items.push({ id: 's1', accountId: 'acc', conversationId: 'acc', prompt: '早安', kind: 'daily', time: '08:00', createdAt: Date.now() })
  writeSubscriptions(state, store, () => {})
  fs.mkdirSync(path.join(state, 'openclaw-weixin', 'accounts'), { recursive: true })
  return state
}

function run(args, env = {}) {
  const base = { ...process.env, DSH_WEIXIN_STATE_DIR: env.state }
  return spawnSync(process.execPath, ['bin/pack.mjs', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...base, ...env } })
}

test('the pack CLI exports a file the plugin can import', () => {
  const state = stateWithPack()
  const out = path.join(state, 'out.json')
  const exported = run(['export', '--name', '毒舌陪聊', '--account', 'acc', '-o', out], { state })
  assert.equal(exported.status, 0, exported.stderr)
  const pack = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(pack.format, PACK_FORMAT)
  assert.deepEqual(pack.persona.modes.map((mode) => mode.name), ['毒舌室友'])
  assert.deepEqual(pack.subscriptions.map((entry) => entry.when), ['每天 08:00'])
})

test('the pack CLI imports one into another state directory', () => {
  const source = stateWithPack()
  const file = path.join(source, 'pack.json')
  assert.equal(run(['export', '--account', 'acc', '-o', file], { state: source }).status, 0)

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-pack-cli-'))
  const imported = run(['import', file, '--account', 'acc2'], { state: target })
  assert.equal(imported.status, 0, imported.stderr)
  assert.match(imported.stdout, /modes added: 1/)
  assert.match(imported.stdout, /subscriptions added: 1/)
  assert.ok(readPersonaStore(target).some((mode) => mode.name === '毒舌室友'))
  assert.equal(readSubscriptions(target).items[0].accountId, 'acc2')
})

test('the pack CLI refuses a file that is not a pack, and says why', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-pack-cli-'))
  const file = path.join(state, 'bad.json')
  fs.writeFileSync(file, '{"format":"something-else"}')
  const result = run(['import', file, '--account', 'acc'], { state })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not a pack: wrong-format/)
})
