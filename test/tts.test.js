import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  TTS_MAX_CHARS,
  TTS_WAV_RATE,
  aiffToWav,
  cleanSpeechText,
  synthesizeAiff,
  synthesizeVoiceFile,
  ttsPlatformSupported,
} from '../src/media/tts.js'

/** 假装 `say`：把 `-o <file>` 指的文件写出来，并记下调用参数。 */
function fakeSay({ write = true } = {}) {
  const calls = []
  const run = async (command, args) => {
    calls.push({ command, args })
    if (command === 'say') {
      const at = args.indexOf('-o')
      if (write && at >= 0) fs.writeFileSync(args[at + 1], Buffer.from('fake aiff'))
      return
    }
    if (command === 'afconvert') {
      const out = args[args.length - 1]
      if (write) fs.writeFileSync(out, Buffer.from('fake wav'))
      return
    }
    throw new Error(`unexpected command ${command}`)
  }
  return { calls, run }
}

test('the text read aloud drops markers, links and decoration', () => {
  const { text, truncated } = cleanSpeechText('**好呀** [表情:开心] 看这里 https://example.com/x ！')
  assert.equal(text, '好呀 看这里 ！')
  assert.equal(truncated, false)
})

test('a long line is cut to the limit and marked as cut', () => {
  const { text, chars, truncated } = cleanSpeechText('啊'.repeat(200))
  assert.equal(truncated, true)
  assert.equal(chars, TTS_MAX_CHARS)
  assert.ok(text.length <= TTS_MAX_CHARS + 1, `kept ${text.length}`)
})

test('only macOS has a local voice to synthesise with', () => {
  assert.equal(ttsPlatformSupported({ platform: 'darwin' }), true)
  assert.equal(ttsPlatformSupported({ platform: 'linux' }), false)
})

test('say is called with the voice when one is configured, and without it otherwise', async () => {
  const withVoice = fakeSay()
  const first = await synthesizeAiff('你好', { voice: 'Tingting', run: withVoice.run })
  assert.equal(first.ok, true)
  assert.deepEqual(withVoice.calls[0].args.slice(0, 2), ['-v', 'Tingting'])
  fs.rmSync(first.file, { force: true })

  const plain = fakeSay()
  const second = await synthesizeAiff('你好', { run: plain.run })
  assert.equal(second.ok, true)
  assert.equal(plain.calls[0].args[0], '-o', 'no voice flag when none is configured')
  fs.rmSync(second.file, { force: true })
})

test('an empty line is refused before any process is started', async () => {
  let called = 0
  const run = async () => {
    called += 1
  }
  const result = await synthesizeAiff('   [表情:开心]  ', { run })
  assert.equal(result.ok, false)
  assert.equal(called, 0, 'nothing to say means nothing to run')
})

test('a failing say is reported as a reason, not thrown', async () => {
  const result = await synthesizeAiff('你好', {
    run: async () => {
      throw new Error('say exited 1: voice not found')
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /本机语音合成失败.*voice not found/)
})

test('a say that reports success without writing a file is still a failure', async () => {
  const { run } = fakeSay({ write: false })
  const result = await synthesizeAiff('你好', { run })
  assert.equal(result.ok, false)
  assert.match(result.reason, /没有产出音频文件/)
})

test('the AIFF is converted to 24 kHz 16-bit mono WAV', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-tts-'))
  const aiff = path.join(dir, 'in.aiff')
  fs.writeFileSync(aiff, Buffer.from('aiff'))
  const { calls, run } = fakeSay()
  const result = await aiffToWav(aiff, { run })
  assert.equal(result.ok, true)
  assert.equal(calls[0].command, 'afconvert')
  assert.deepEqual(calls[0].args.slice(0, 3), ['-f', 'WAVE', '-d'])
  assert.equal(calls[0].args[3], `LEI16@${TTS_WAV_RATE}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('one call turns a sentence into a WAV and cleans up the AIFF', async () => {
  const { calls, run } = fakeSay()
  const result = await synthesizeVoiceFile('晚安，早点睡', { run })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map((call) => call.command), ['say', 'afconvert'])
  assert.equal(path.extname(result.file), '.wav')
  const aiff = calls[0].args[calls[0].args.indexOf('-o') + 1]
  assert.equal(fs.existsSync(aiff), false, 'the intermediate AIFF is gone')
  fs.rmSync(result.file, { force: true })
})

test('a failed conversion still removes the intermediate AIFF', async () => {
  let aiff = ''
  const run = async (command, args) => {
    if (command === 'say') {
      aiff = args[args.indexOf('-o') + 1]
      fs.writeFileSync(aiff, Buffer.from('aiff'))
      return
    }
    throw new Error('afconvert exited 1')
  }
  const result = await synthesizeVoiceFile('晚安', { run })
  assert.equal(result.ok, false)
  assert.match(result.reason, /音频转 WAV 失败/)
  assert.notEqual(aiff, '')
  assert.equal(fs.existsSync(aiff), false, 'the intermediate AIFF is gone even when the conversion fails')
})