import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  BASE_STICKERS,
  CUTE_STICKERS,
  MAX_STICKERS_PER_REPLY,
  MODE_STICKERS,
  SHARED_STICKERS,
  STICKERS,
  clearUserStickerCache,
  listUserStickerFiles,
  looksLikeImage,
  resolveSticker,
  stickerFilesReady,
  stickerHint,
  stickerPath,
  stickersForMode,
  takeStickers,
} from '../src/message/stickers.js'
import { BUILTIN_MODES } from '../src/persona.js'

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// The default root is `~/.dsh/weixin`; point it at a scratch directory so the
// assertions about the exact id list never depend on what the machine running
// the tests happens to have dropped in.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-stickers-scratch-'))
process.env.DSH_WEIXIN_STATE_DIR = SCRATCH

/** A real (1x1) PNG, so the magic-byte sniff has something to agree with. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function userState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-stickers-'))
  process.env.DSH_WEIXIN_STATE_DIR = root
  clearUserStickerCache()
  return root
}

test('every sticker in the catalog is a real PNG on disk', () => {
  assert.equal(stickerFilesReady(), true)
  for (const sticker of STICKERS) {
    const file = stickerPath(sticker.id)
    assert.equal(fs.existsSync(file), true, `missing ${file}`)
    const head = fs.readFileSync(file).subarray(0, 8)
    assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${sticker.id} is not a PNG`)
  }
})

test('the catalog ids and captions are unique', () => {
  assert.equal(new Set(STICKERS.map((s) => s.id)).size, STICKERS.length)
  assert.equal(new Set(STICKERS.map((s) => s.caption)).size, STICKERS.length)
})

test('a marker is removed from the text and its id comes back', () => {
  const plan = takeStickers('好呀，那明天见\n[表情:开心]')
  assert.equal(plan.text, '好呀，那明天见')
  assert.deepEqual(plan.stickers, ['happy'])
  assert.deepEqual(plan.dropped, [])
})

test('several markers keep their order and the cap is enforced', () => {
  const plan = takeStickers('[表情:开心]\n说到这个我就想笑\n[表情:哈哈]')
  assert.equal(plan.text, '说到这个我就想笑')
  assert.deepEqual(plan.stickers, ['happy', 'laugh'])

  const flooded = takeStickers('[表情:开心][表情:哈哈][表情:呜呜]')
  assert.equal(flooded.stickers.length, MAX_STICKERS_PER_REPLY)
  assert.equal(flooded.text, '')
  assert.deepEqual(flooded.dropped, ['呜呜'], 'the ones over the cap are reported, not silently lost')
})

test('the same sticker twice in one reply is sent once', () => {
  const plan = takeStickers('哈哈哈[表情:哈哈]真的假的[表情:哈哈]')
  assert.deepEqual(plan.stickers, ['laugh'])
  assert.equal(plan.text, '哈哈哈真的假的')
})

test('an unknown name is dropped from the text and reported', () => {
  const plan = takeStickers('行\n[表情:不存在的表情]')
  assert.equal(plan.text, '行')
  assert.deepEqual(plan.stickers, [])
  assert.deepEqual(plan.dropped, ['不存在的表情'])
})

test('aliases and the stray particles a model adds still resolve', () => {
  assert.equal(resolveSticker('笑哭'), 'laugh')
  assert.equal(resolveSticker('委屈巴巴'), null, 'not an alias — falls through rather than guessing')
  assert.equal(resolveSticker('开心啊'), 'happy')
  assert.equal(resolveSticker('晚安~'), 'goodnight')
  assert.equal(resolveSticker('  '), null)
})

test('full-width colon and trailing whitespace inside the marker work', () => {
  const plan = takeStickers('晚安[表情：困了 ]')
  assert.deepEqual(plan.stickers, ['sleepy'])
  assert.equal(plan.text, '晚安')
})

test('text without markers is untouched apart from trimming', () => {
  const plan = takeStickers('  今天天气不错  \n\n')
  assert.equal(plan.text, '今天天气不错')
  assert.deepEqual(plan.stickers, [])
})

test('removing a marker cannot leave three blank lines or a whitespace bubble', () => {
  const plan = takeStickers('先说一句\n\n[表情:开心]\n\n后说一句')
  assert.equal(plan.text, '先说一句\n\n后说一句')
  assert.deepEqual(takeStickers('[表情:开心]').text, '')
})

test('the prompt hint lists every caption exactly once', () => {
  const hint = stickerHint()
  for (const sticker of stickersForMode()) {
    assert.equal(hint.split(sticker.caption).length - 1, 1, `${sticker.caption} must appear once`)
  }
  assert.match(hint, /\[表情:名字\]/)
})

test('the catalog is eleven character packs on top of two shared ones', () => {
  assert.equal(BASE_STICKERS.length, 12)
  assert.equal(CUTE_STICKERS.length, 12)
  assert.equal(SHARED_STICKERS.length, 24)
  assert.equal(MODE_STICKERS.length, 11)
  for (const pack of MODE_STICKERS) assert.equal(pack.stickers.length, 4, `${pack.modes[0]} needs four`)
  const modes = MODE_STICKERS.flatMap((pack) => pack.modes)
  assert.equal(new Set(modes).size, modes.length, 'no mode may have two packs')
  assert.equal(STICKERS.length, 12 + 12 + 44)
})

test('a character pack follows its mode and only its mode', () => {
  const shared = SHARED_STICKERS.map((sticker) => sticker.id)
  assert.deepEqual(stickersForMode().map((sticker) => sticker.id), shared)
  assert.deepEqual(stickersForMode('neko').map((sticker) => sticker.id), [...shared, 'meow', 'paw', 'fluff', 'nuzzle'])
  assert.deepEqual(stickersForMode('whale-girl').slice(shared.length).map((s) => s.id), ['burble', 'spout', 'tail', 'peek'])
  assert.deepEqual(stickersForMode('daughter').slice(shared.length).map((s) => s.id), ['actcute', 'headpat', 'proud', 'weepy'])
  assert.deepEqual(stickersForMode('girlfriend').slice(shared.length).map((s) => s.id), ['gf_embrace', 'gf_kiss', 'gf_pout', 'gf_wait'])
  assert.deepEqual(stickersForMode('jarvis').slice(shared.length).map((s) => s.id), ['jv_scan', 'jv_report', 'jv_hologram', 'jv_alert'])
  assert.deepEqual(stickersForMode('tsundere').slice(shared.length).map((s) => s.id), ['ts_hmph', 'ts_blush', 'ts_gift', 'ts_wait'])
})

test('every mode pack names a builtin mode', () => {
  const ids = BUILTIN_MODES.map((mode) => mode.id)
  for (const pack of MODE_STICKERS) {
    for (const id of pack.modes) assert.equal(ids.includes(id), true, `${id} is not a builtin mode any more`)
  }
})

test('a cat sticker is unresolvable outside the cat mode, so the wrong character never sends it', () => {
  assert.equal(resolveSticker('喵'), null)
  assert.equal(resolveSticker('喵', 'neko'), 'meow')
  assert.equal(resolveSticker('摸摸头', 'daughter'), 'headpat')
  assert.equal(resolveSticker('摸摸头', 'neko'), null)
  assert.equal(resolveSticker('亲一下', null), null)
  assert.equal(resolveSticker('亲一下', 'girlfriend'), 'gf_kiss')
  assert.equal(resolveSticker('亲一下', 'boyfriend'), null, 'the girlfriend pack stays out of the boyfriend mode')

  const plan = takeStickers('在的呀\n[表情:喵]', { modeId: 'girlfriend' })
  assert.equal(plan.text, '在的呀')
  assert.deepEqual(plan.stickers, [])
  assert.deepEqual(plan.dropped, ['喵'])

  const catty = takeStickers('在的呀\n[表情:喵]', { modeId: 'neko' })
  assert.deepEqual(catty.stickers, ['meow'])
})

test('the hint offers exactly the pack a mode may send', () => {
  const shared = stickerHint()
  assert.equal(shared.includes('喵'), false)
  assert.equal(shared.includes('开心'), true)
  const catHint = stickerHint('neko')
  for (const caption of ['喵', '舔爪', '炸毛', '蹭蹭']) assert.equal(catHint.includes(caption), true)
  assert.equal(catHint.includes('咕噜噜'), false, 'another character\'s pack stays out')
  const girlfriendHint = stickerHint('girlfriend')
  assert.equal(girlfriendHint.includes('亲一下'), true)
  assert.equal(girlfriendHint.includes('喵'), false)
})

test('a picture dropped into the state folder becomes a usable sticker', () => {
  const root = userState()
  try {
    fs.mkdirSync(path.join(root, 'stickers', 'all'), { recursive: true })
    fs.writeFileSync(path.join(root, 'stickers', 'all', '老板.png'), PNG_1PX)
    fs.writeFileSync(path.join(root, 'stickers', 'all', 'aliases.json'), JSON.stringify({ 发红包: '老板.png' }))
    fs.mkdirSync(path.join(root, 'stickers', 'girlfriend'), { recursive: true })
    fs.writeFileSync(path.join(root, 'stickers', 'girlfriend', '亲亲.jpg'), PNG_1PX)
    // Not an image: no magic bytes, so it must be ignored rather than offered.
    fs.writeFileSync(path.join(root, 'stickers', 'all', 'fake.png'), 'not an image')

    assert.equal(resolveSticker('老板', undefined, { stateRoot: root }), 'user:all:老板.png')
    assert.equal(resolveSticker('发红包', undefined, { stateRoot: root }), 'user:all:老板.png', 'aliases.json works')
    assert.equal(resolveSticker('老板', 'neko', { stateRoot: root }), 'user:all:老板.png', 'all means every mode')
    assert.equal(resolveSticker('亲亲', 'neko', { stateRoot: root }), null, 'a mode folder stays in its mode')
    assert.equal(resolveSticker('亲亲', 'girlfriend', { stateRoot: root }), 'user:girlfriend:亲亲.jpg')
    assert.equal(resolveSticker('fake', undefined, { stateRoot: root }), null)

    const file = stickerPath('user:all:老板.png', root)
    assert.equal(fs.existsSync(file), true)
    assert.equal(path.basename(file), '老板.png')
    assert.match(stickerHint(undefined, { stateRoot: root }), /老板/)
    assert.match(stickerHint('girlfriend', { stateRoot: root }), /亲亲/)

    const plan = takeStickers('好\n[表情:老板]', { stateRoot: root })
    assert.equal(plan.text, '好')
    assert.deepEqual(plan.stickers, ['user:all:老板.png'])

    // With pictures of your own in the folder the built-in cast steps aside:
    // a marker for one of its names is dropped rather than sending art the
    // user replaced. `keepBuiltins` puts both lists back together.
    assert.equal(resolveSticker('开心', undefined, { stateRoot: root }), null)
    assert.equal(stickerHint(undefined, { stateRoot: root }).includes('开心'), false, 'built-ins leave the list')
    assert.equal(resolveSticker('开心', undefined, { stateRoot: root, keepBuiltins: true }), 'happy')
    assert.equal(stickerFilesReady(root), true)

    const listed = listUserStickerFiles(root)
    assert.equal(listed.length, 2)
    assert.equal(listed.some((line) => line.includes('老板')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    process.env.DSH_WEIXIN_STATE_DIR = SCRATCH
    clearUserStickerCache()
  }
})

test('your own set replaces the built-in cast, and the switch brings it back', () => {
  const root = userState()
  try {
    const before = stickersForMode('girlfriend', { stateRoot: root })
    assert.ok(before.length >= SHARED_STICKERS.length, 'built-ins until you install something')

    fs.mkdirSync(path.join(root, 'stickers', 'all'), { recursive: true })
    // Same caption as a built-in on purpose: yours must win the name.
    fs.writeFileSync(path.join(root, 'stickers', 'all', '开心.png'), PNG_1PX)
    clearUserStickerCache()

    const after = stickersForMode('girlfriend', { stateRoot: root })
    assert.deepEqual(after.map((sticker) => sticker.id), ['user:all:开心.png'], 'only yours is offered')
    assert.equal(resolveSticker('开心', 'girlfriend', { stateRoot: root }), 'user:all:开心.png')
    assert.equal(resolveSticker('点头', 'girlfriend', { stateRoot: root }), null, 'built-ins stop resolving')

    const hint = stickerHint('girlfriend', { stateRoot: root })
    assert.match(hint, /开心/)
    assert.equal(hint.includes('点头'), false, 'the built-in names are gone from the prompt')

    const both = stickersForMode('girlfriend', { stateRoot: root, keepBuiltins: true })
    assert.equal(both.length, after.length + before.length)
    assert.equal(both[0].id, 'user:all:开心.png', 'yours still comes first')
    assert.equal(resolveSticker('点头', 'girlfriend', { stateRoot: root, keepBuiltins: true }), 'nod')

    // A built-in marker is dropped from the text, not quietly sent.
    const plan = takeStickers('好\n[表情:点头]', { modeId: 'girlfriend', stateRoot: root })
    assert.equal(plan.text, '好')
    assert.deepEqual(plan.stickers, [])
    assert.deepEqual(plan.dropped, ['点头'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    process.env.DSH_WEIXIN_STATE_DIR = SCRATCH
    clearUserStickerCache()
  }
})

test('the new file shows up without restarting: the cache follows the folder', () => {
  const root = userState()
  try {
    assert.equal(resolveSticker('后来', undefined, { stateRoot: root }), null)
    fs.mkdirSync(path.join(root, 'stickers', 'all'), { recursive: true })
    fs.writeFileSync(path.join(root, 'stickers', 'all', '后来.png'), PNG_1PX)
    assert.equal(resolveSticker('后来', undefined, { stateRoot: root }), 'user:all:后来.png')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    process.env.DSH_WEIXIN_STATE_DIR = SCRATCH
    clearUserStickerCache()
  }
})

test('looksLikeImage accepts what WeChat shows and rejects what it cannot', () => {
  const root = userState()
  try {
    const png = path.join(root, 'a.png')
    fs.writeFileSync(png, PNG_1PX)
    assert.equal(looksLikeImage(png), true)
    const jpeg = path.join(root, 'b.jpg')
    fs.writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))
    assert.equal(looksLikeImage(jpeg), true, 'a photo from your phone is an image too')
    const text = path.join(root, 'c.png')
    fs.writeFileSync(text, 'nope')
    assert.equal(looksLikeImage(text), false)
    assert.equal(looksLikeImage(path.join(root, 'missing.png')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    process.env.DSH_WEIXIN_STATE_DIR = SCRATCH
    clearUserStickerCache()
  }
})

test('the CLI adds a file, lists it, and checks the built-in set', () => {
  const root = userState()
  try {
    const source = path.join(root, '来源.png')
    fs.writeFileSync(source, PNG_1PX)
    const env = { ...process.env, DSH_WEIXIN_STATE_DIR: root }

    const added = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'bin', 'stickers.mjs'), 'add', source, '--mode', 'neko', '--as', '喵喵'], { env, encoding: 'utf8' })
    assert.equal(added.status, 0, added.stderr)
    assert.match(added.stdout, /\[表情:喵喵\]/)
    const stored = path.join(root, 'stickers', 'neko', '喵喵.png')
    assert.equal(fs.existsSync(stored), true)

    const listed = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'bin', 'stickers.mjs'), 'list', '--mode', 'neko'], { env, encoding: 'utf8' })
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /喵喵/)

    const checked = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'bin', 'stickers.mjs'), 'check'], { env, encoding: 'utf8' })
    assert.equal(checked.status, 0, checked.stderr)
    assert.match(checked.stdout, /缺 0、尺寸不对 0/)

    const bad = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'bin', 'stickers.mjs'), 'add', source, '--mode', '没这个模式'], { env, encoding: 'utf8' })
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /未知模式/)

    const notImage = path.join(root, '文本.txt')
    fs.writeFileSync(notImage, 'hello')
    const refused = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'bin', 'stickers.mjs'), 'add', notImage], { env, encoding: 'utf8' })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /不像图片/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    process.env.DSH_WEIXIN_STATE_DIR = SCRATCH
    clearUserStickerCache()
  }
})