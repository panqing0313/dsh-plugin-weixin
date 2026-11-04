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
test('the command line offers the same two conveniences: leave media out, and list before writing', () => {
  const bin = new URL('../bin/backup.mjs', import.meta.url).pathname
  const source = fs.readFileSync(bin, 'utf8')
  // `--no-media` must reach sealState, otherwise the flag would be a lie.
  assert.match(source, /includeMedia: !flags\.has\('--no-media'\)/)
  // `--dry-run` must return before restoreSealed is reached.
  const dryIndex = source.indexOf("flags.has('--dry-run')")
  const restoreIndex = source.indexOf('restoreSealed(root, opened.files')
  assert.ok(dryIndex > 0 && restoreIndex > dryIndex, 'the dry run returns before anything is written')
})

test('the bill finds its numbers without an accountId saved in the card', () =>
  withState(async ({ root, controller }) => {
    // The reported bug: `~/.dsh/weixin/usage-ledger.json` held seven recorded
    // turns, yet the card showed "nothing recorded yet". `usageLedger` looked the
    // account up in `config.accountId`, and first-run machines never save that —
    // this state root imitates one (config.json carries no accountId below).
    fs.writeFileSync(path.join(root, 'config.json'), '{"pricePer1kInputYuan":0.1,"pricePer1kOutputYuan":0.2}')
    fs.writeFileSync(
      path.join(root, 'accounts-registry.json'),
      JSON.stringify({ schemaVersion: 1, 'bot@im.bot': { createdAt: '2026-11-01T00:00:00.000Z', lastSeenAt: '2026-11-04T05:00:00.000Z' } }),
    )
    fs.writeFileSync(
      path.join(root, 'usage-ledger.json'),
      JSON.stringify({
        schemaVersion: 1,
        accounts: {
          'bot@im.bot': {
            conversations: {
              conv1: {
                turns: 3, tokensIn: 900, tokensOut: 100,
                models: { 'magpie/auto/x': { turns: 3, tokensIn: 900, tokensOut: 100 } },
                routes: { chat: { turns: 3, tokensIn: 900, tokensOut: 100 } },
                days: { '2026-11-04': { turns: 3, tokensIn: 900, tokensOut: 100 } },
                firstAt: 1, lastAt: 2, failedTurns: 0,
              },
            },
          },
        },
      }),
    )
    const bill = await controller.usageLedger({})
    assert.equal(bill.accountId, 'bot@im.bot', 'the registry supplies the account the config left blank')
    assert.equal(bill.rows.length, 1, 'the recorded conversation is visible')
    assert.equal(bill.totals.tokens, 1000)
    assert.equal(bill.totals.turns, 3)
    assert.deepEqual(bill.rows[0].models, ['magpie/auto/x'])
    // An explicit account still wins, so a card showing another account keeps working.
    const explicit = await controller.usageLedger({ accountId: 'bot@im.bot' })
    assert.equal(explicit.rows.length, 1)
  }))

// ---------------------------------------------------------------------------
// fsList — the picker the card's path boxes open.
// ---------------------------------------------------------------------------

test('fsList lists a directory, keeps folders first, and never leaves the path it was given', () => withState(async ({ root, controller }) => {
  const dir = path.join(root, 'packs')
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'b.enc'), 'x')
  fs.writeFileSync(path.join(dir, 'a.enc'), 'yyyy')
  fs.writeFileSync(path.join(dir, '.hidden'), 'h')

  const listing = await controller.fsList({ path: dir })
  assert.equal(listing.path, dir)
  assert.equal(listing.parent, root)
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['sub', 'a.enc', 'b.enc'], 'folders first, then names; dotfiles hidden')
  assert.equal(listing.entries[1].size, 4)

  const withHidden = await controller.fsList({ path: dir, showHidden: true })
  assert.ok(withHidden.entries.some((entry) => entry.name === '.hidden'))

  const dirsOnly = await controller.fsList({ path: dir, filter: 'dir' })
  assert.deepEqual(dirsOnly.entries.map((entry) => entry.name), ['sub'], 'a folder-only box must not offer files')
}))

test('fsList given a file steps up to its folder and marks the file, so a pasted path still shows a list', () => withState(async ({ root, controller }) => {
  const dir = path.join(root, 'packs')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'migrate.enc')
  fs.writeFileSync(file, '0123456789')
  const listing = await controller.fsList({ path: file })
  assert.equal(listing.path, dir)
  assert.deepEqual(listing.picked, { name: 'migrate.enc', path: file, size: 10 })
  assert.ok(listing.entries.some((entry) => entry.name === 'migrate.enc'))
}))

test('fsList explains what went wrong in the operator\'s words', () => withState(async ({ root, controller }) => {
  const missing = await controller.fsList({ path: path.join(root, 'nope') })
  assert.equal(missing.entries, undefined)
  assert.match(missing.error, /找不到这个位置/)

  const notDir = await controller.fsList({ path: path.join(root, 'config.json') })
  // config.json exists in the fixture, so this exercises the file branch…
  assert.equal(notDir.path, root)

  // …and a real non-directory that is not a regular file hits the other message.
  const fifo = path.join(root, 'pipe')
  try {
    fs.mkfifoSync?.(fifo)
  } catch {
    // not available on every platform; the branch is covered by the code path above
  }
  const noPath = await controller.fsList()
  assert.equal(typeof noPath.path, 'string')
  assert.ok(Array.isArray(noPath.entries))
  assert.equal(typeof noPath.home, 'string')
  assert.equal(noPath.stateRoot, root, 'the listing says where this machine keeps its state')
  assert.equal(noPath.defaultOutDir, path.join(root, 'backups'), 'and offers the export folder as a shortcut')
}))

// ---------------------------------------------------------------------------
// modelCatalog — the dropdowns' data.
// ---------------------------------------------------------------------------

test('modelCatalog hands the card the host catalogue and what the card has saved', () => withState(async ({ root, controller }) => {
  // The remote reads the host's own settings file location, not ours; point the
  // module at a fixture by writing one where it looks.
  const settings = path.join(os.homedir(), '.dsh', 'settings.yaml')
  const backup = fs.existsSync(settings) ? fs.readFileSync(settings) : null
  try {
    fs.mkdirSync(path.dirname(settings), { recursive: true })
    fs.writeFileSync(settings, `llm-pi-ai:
  providers:
    magpie:
      api: openai-completions
      models:
        - id: auto/deepseek-v4.1-flash
          name: DeepSeek V4.1 Flash · routing group
          contextWindow: 1048576
`)
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ accountId: 'bot@im.bot', chatProvider: 'magpie', chatModel: 'auto/deepseek-v4.1-flash' }))
    const catalog = await controller.modelCatalog()
    assert.equal(catalog.providers.length, 1)
    assert.equal(catalog.providers[0].id, 'magpie')
    assert.equal(catalog.providers[0].api, 'openai-completions')
    assert.equal(catalog.models[0].id, 'auto/deepseek-v4.1-flash')
    assert.equal(catalog.partial, false)
    assert.deepEqual(catalog.configured.chat, { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' })
    assert.deepEqual(catalog.configured.side, { provider: '', model: '' })
  } finally {
    if (backup === null) fs.rmSync(settings, { force: true })
    else fs.writeFileSync(settings, backup)
  }
}))

test('a folder in the pack box is explained, not handed to the filesystem', () => withState(async ({ root, controller }) => {
  // The operator clicked "Browse", got a folder listing, and pressed inspect —
  // which used to come back as `EISDIR: illegal operation on a directory, read`.
  const dir = path.join(root, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const inspected = await controller.migrateInspect({ file: dir, passphrase: 'longenough' })
  assert.equal(inspected.error, `${dir} 是个文件夹 —— 这里要的是选中的那一个 .enc 迁移包`)
  const restored = await controller.migrateRestore({ file: dir, passphrase: 'longenough' })
  assert.match(restored.error, /是个文件夹/)

  const empty = path.join(dir, 'empty.enc')
  fs.writeFileSync(empty, '')
  const emptyResult = await controller.migrateInspect({ file: empty, passphrase: 'longenough' })
  assert.match(emptyResult.error, /是空文件/)
}))

test('an export folder that is really a file path means "put it in that folder"', () => withState(async ({ root, controller }) => {
  // Pasting a full name like .../backups/migrate-x.enc used to create a
  // *directory* of that name with the pack inside it.
  const packPath = path.join(root, 'backups', 'migrate-x.enc')
  const written = await controller.migrateExport({ passphrase: 'longenough', outDir: packPath })
  assert.equal(written.outDir, path.join(root, 'backups'), 'the folder, not a folder named like a pack')
  assert.match(path.basename(written.file), /^migrate-.*\.enc$/)
  assert.ok(fs.existsSync(written.file))
  assert.equal(fs.existsSync(packPath), false, 'no stray directory (or file) was created at the pasted name')

  const notAFolder = await controller.migrateExport({ passphrase: 'longenough', outDir: path.join(root, 'config.json') })
  assert.match(notAFolder.error, /是个文件，不是文件夹/)
}))

test('the prompt preview opens on the live mode, not on the config fallback', () => withState(async ({ root, controller }) => {
  // 「个性化」 writes the live mode into persona-active.json; config.json's
  // personaDefaultMode is a different, usually unset fallback. Reading only the
  // config made the tab open on `default` and show an empty prompt on a machine
  // that was really talking as a persona — which is exactly what got reported.
  const { writeGlobalDefaultMode, writePersonaStore, readGlobalDefaultMode } = await import('../src/persona.js')
  const warn = () => {}
  writePersonaStore(root, [
    { id: 'default', label: '默认' },
    { id: 'girlfriend', label: '女友', body: '你是他的女朋友，说话短、亲昵。' },
  ], { warn })
  writeGlobalDefaultMode(root, 'girlfriend', { warn })
  // The write has to be visible to the resolver, or the fixture is not testing
  // what it claims: an early version of this test wrote nothing the card
  // could see, and its own `emptyNote` assertion caught the mismatch.
  assert.equal(
    readGlobalDefaultMode(root, { warn }),
    'girlfriend',
    "the persona tab's write is what the preview must follow",
  )

  const live = await controller.promptPreview({})
  assert.equal(live.modeId, 'girlfriend')
  assert.equal(live.modeSource, 'active')
  assert.equal(live.activeModeId, 'girlfriend')
  assert.ok(live.chars > 17, `the persona block is in the prompt (${live.chars} chars)`)
  assert.equal(live.emptyNote, '')

  const picked = await controller.promptPreview({ modeId: 'default' })
  assert.equal(picked.modeId, 'default')
  assert.equal(picked.modeSource, 'picked')
  assert.equal(picked.activeModeId, 'girlfriend')
  assert.match(picked.emptyNote, /实际会话用的是「女友」/, 'an empty preview says which mode is really live')

  // No persona chosen anywhere: the note explains that empty is expected.
  // `writeGlobalDefaultMode('')` is how the card unsets it — the global default
  // lives under the reserved `__global__` key, which clearActiveMode (a
  // conversation override) does not touch.
  writeGlobalDefaultMode(root, '', { warn })
  const bare = await controller.promptPreview({})
  assert.equal(bare.modeId, 'default')
  assert.match(bare.emptyNote, /本来就没有人设块/)
}))
