// Migration-pack tests: the four remote methods the card calls.
//
// These run against a throwaway state directory (DSH_WEIXIN_STATE_DIR), so the
// host's own state is never read or written. The point of each test is the
// promise the card makes to the operator:
//   - the summary tells the truth about size, media included or not;
//   - a pack written by export can be read back by inspect and restored by
//     restore, with the same bytes;
//   - inspect never writes (a wrong passphrase writes nothing at all);
//   - restore keeps a rollback copy first.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Context } from '@deepseek-ai/cordis'

import { WeixinLoginController } from '../src/login-remote.js'

function withState(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-migrate-'))
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = root
  fs.writeFileSync(path.join(root, 'config.json'), '{"accountId":"bot@im.bot"}')
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true })
  fs.writeFileSync(path.join(root, 'memory', 'global-bot@im.bot.json'), '{"facts":[{"text":"对花生过敏"}]}')
  fs.mkdirSync(path.join(root, 'media', 'inbound'), { recursive: true })
  fs.writeFileSync(path.join(root, 'media', 'inbound', 'shot.png'), Buffer.alloc(4096, 7))
  const controller = new WeixinLoginController(new Context(), {})
  return (async () => {
    try {
      return await run({ root, controller })
    } finally {
      if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
      else process.env.DSH_WEIXIN_STATE_DIR = previous
      fs.rmSync(root, { recursive: true, force: true })
    }
  })()
}

test('the summary separates memory from media, so the size shown is honest', () =>
  withState(async ({ controller }) => {
    const summary = await controller.migrateSummary()
    assert.equal(summary.withoutMedia.files, 2, 'config.json + memory file')
    assert.equal(summary.media.files, 1)
    assert.equal(summary.media.bytes, 4096)
    assert.equal(summary.withMedia.files, 3)
    assert.equal(summary.withMedia.bytes, summary.withoutMedia.bytes + 4096)
    assert.equal(summary.stateRoot, path.resolve(process.env.DSH_WEIXIN_STATE_DIR))
  }))

test('export → inspect → restore round-trips, and inspect writes nothing', () =>
  withState(async ({ root, controller }) => {
    const exported = await controller.migrateExport({ passphrase: 'correct horse', includeMedia: false })
    assert.equal(exported.files, 2, 'media left behind on request')
    assert.ok(fs.existsSync(exported.file))

    const before = fs.readFileSync(path.join(root, 'memory', 'global-bot@im.bot.json'), 'utf8')
    // Wipe the memory file: a restore that does nothing would stay empty.
    fs.rmSync(path.join(root, 'memory', 'global-bot@im.bot.json'))
    const inspected = await controller.migrateInspect({ file: exported.file, passphrase: 'correct horse' })
    assert.equal(inspected.files, 2)
    assert.equal(inspected.hasConfig, true)
    assert.equal(inspected.replaces, 1, 'config.json is there; the memory file is not')
    assert.equal(inspected.adds, 1)
    assert.equal(fs.existsSync(path.join(root, 'memory', 'global-bot@im.bot.json')), false, 'inspect is read-only')

    const restored = await controller.migrateRestore({ file: exported.file, passphrase: 'correct horse' })
    assert.equal(restored.restored, 2)
    assert.ok(restored.safety !== '', 'a rollback copy is named in the reply')
    assert.equal(fs.readFileSync(path.join(root, 'memory', 'global-bot@im.bot.json'), 'utf8'), before)
  }))

test('a wrong passphrase says so and writes nothing', () =>
  withState(async ({ root, controller }) => {
    const exported = await controller.migrateExport({ passphrase: 'correct horse' })
    const snapshot = fs.readFileSync(path.join(root, 'config.json'), 'utf8')
    const inspected = await controller.migrateInspect({ file: exported.file, passphrase: 'wrong' })
    assert.match(inspected.error, /口令不对/)
    const restored = await controller.migrateRestore({ file: exported.file, passphrase: 'wrong' })
    assert.equal(restored.restored, undefined)
    assert.ok(restored.error !== undefined)
    assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), snapshot)
  }))

test('a short passphrase is refused with a reason, not silently accepted', () =>
  withState(async ({ controller }) => {
    const short = await controller.migrateExport({ passphrase: 'abc' })
    assert.equal(short.file, undefined)
    assert.match(short.error, /至少 8 个字符/)
    const missing = await controller.migrateInspect({ file: '/tmp/does-not-exist.enc', passphrase: 'whatever' })
    assert.match(missing.error, /找不到文件/)
  }))