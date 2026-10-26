import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  MAX_STICKERS_PER_REPLY,
  STICKERS,
  resolveSticker,
  stickerFilesReady,
  stickerHint,
  stickerPath,
  takeStickers,
} from '../src/message/stickers.js'

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
  for (const sticker of STICKERS) {
    assert.equal(hint.split(sticker.caption).length - 1, 1, `${sticker.caption} must appear once`)
  }
  assert.match(hint, /\[表情:名字\]/)
})
