import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  BASE_STICKERS,
  CUTE_STICKERS,
  MAX_STICKERS_PER_REPLY,
  MODE_STICKERS,
  STICKERS,
  resolveSticker,
  stickerFilesReady,
  stickerHint,
  stickerPath,
  stickersForMode,
  takeStickers,
} from '../src/message/stickers.js'
import { BUILTIN_MODES } from '../src/persona.js'

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

test('the catalog is three packs: twelve shared, twelve cute, four per character', () => {
  assert.equal(BASE_STICKERS.length, 12)
  assert.equal(CUTE_STICKERS.length, 12)
  assert.deepEqual(MODE_STICKERS.map((pack) => pack.modes), [['neko'], ['whale-girl'], ['daughter']])
  for (const pack of MODE_STICKERS) assert.equal(pack.stickers.length, 4)
  assert.equal(STICKERS.length, 12 + 12 + 12)
})

test('a character pack follows its mode and only its mode', () => {
  const shared = [...BASE_STICKERS, ...CUTE_STICKERS].map((sticker) => sticker.id)
  assert.deepEqual(stickersForMode().map((sticker) => sticker.id), shared)
  assert.deepEqual(stickersForMode('girlfriend').map((sticker) => sticker.id), shared)
  assert.deepEqual(stickersForMode('neko').map((sticker) => sticker.id), [...shared, 'meow', 'paw', 'fluff', 'nuzzle'])
  assert.deepEqual(stickersForMode('whale-girl').slice(shared.length).map((s) => s.id), ['burble', 'spout', 'tail', 'peek'])
  assert.deepEqual(stickersForMode('daughter').slice(shared.length).map((s) => s.id), ['actcute', 'headpat', 'proud', 'weepy'])
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
})
