/**
 * Outbound voice: audio files become Weixin SILK voice messages.
 *
 * What these tests protect:
 *  - the transcode layer (wav parsed in-process, silk passthrough, ffmpeg for
 *    compressed audio) and the exact wire `voice_item` shape;
 *  - that a transport `sendMedia` on an audio file takes the voice path, and
 *    that a REJECTED voice send degrades to the file path instead of dropping
 *    the audio (the shape is the newest item kind here; its worst case must be
 *    "arrives as a file", never "the reply loses its attachment").
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const {
  parseWavPcm,
  transcodeToSilk,
  buildVoiceItem,
  isVoiceCandidate,
  VOICE_ENCODE_TYPE_SILK,
} = await import('../src/media/voice-encode.js')
const { sendOutboundVoice, OutboundMediaError } = await import('../src/media/outbound.js')

/** A minimal valid PCM16 WAV buffer (sine at 440 Hz). */
function wavBuffer({ seconds = 0.3, rate = 24_000, channels = 1 } = {}) {
  const frames = Math.round(seconds * rate)
  const data = Buffer.alloc(frames * channels * 2)
  for (let i = 0; i < frames * channels; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 9000)
    data.writeInt16LE(v, i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test('a mono wav transcodes to SILK with the original rate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'))
  const file = path.join(dir, 'tone.wav')
  fs.writeFileSync(file, wavBuffer({ seconds: 0.3, rate: 24_000 }))
  const { silk, durationMs, sampleRate } = await transcodeToSilk(file)
  assert.ok(silk.length > 100, 'SILK payload must be non-trivial')
  assert.equal(sampleRate, 24_000)
  assert.ok(durationMs >= 250 && durationMs <= 400, `duration ~300ms, got ${durationMs}`)
})

test('a stereo wav is downmixed and a non-SILK rate is resampled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'))
  const file = path.join(dir, 'stereo.wav')
  fs.writeFileSync(file, wavBuffer({ seconds: 0.3, rate: 22_050, channels: 2 }))
  const { silk, sampleRate, durationMs } = await transcodeToSilk(file)
  assert.equal(sampleRate, 24_000, '22050 is not a SILK rate, so it must be resampled')
  assert.ok(durationMs >= 250 && durationMs <= 400, `resampling must keep the duration, got ${durationMs}`)
  assert.ok(silk.length > 100)
})

test('parseWavPcm rejects a non-WAV payload (the ffmpeg branch takes over)', () => {
  assert.throws(() => parseWavPcm(Buffer.from('this is not a wav file at all, not even close')), /not a RIFF\/WAVE/)
})

test('.silk passes through untouched and non-audio extensions are not candidates', async () => {
  assert.equal(isVoiceCandidate('/tmp/a.mp3'), true)
  assert.equal(isVoiceCandidate('/tmp/a.WAV'), true)
  assert.equal(isVoiceCandidate('/tmp/a.silk'), true)
  assert.equal(isVoiceCandidate('/tmp/a.png'), false)
  assert.equal(isVoiceCandidate('/tmp/a.pdf'), false)

  // A real SILK buffer, produced from a wav, then written as .silk: the
  // passthrough must return the very same bytes without any ffmpeg call.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'))
  const wav = path.join(dir, 'a.wav')
  const silkFile = path.join(dir, 'a.silk')
  fs.writeFileSync(wav, wavBuffer({ seconds: 0.3 }))
  const { silk } = await transcodeToSilk(wav)
  fs.writeFileSync(silkFile, silk)
  const out = await transcodeToSilk(silkFile)
  assert.deepEqual(Buffer.from(out.silk), Buffer.from(silk), '.silk must not be re-encoded')
})

test('ffmpeg decodes compressed audio into the same voice path', { skip: hasFfmpeg ? false : 'ffmpeg not on PATH' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'))
  const wav = path.join(dir, 'a.wav')
  const mp3 = path.join(dir, 'a.mp3')
  fs.writeFileSync(wav, wavBuffer({ seconds: 0.3 }))
  execFileSync('ffmpeg', ['-v', 'error', '-i', wav, mp3])
  const { silk, durationMs, sampleRate } = await transcodeToSilk(mp3)
  assert.equal(sampleRate, 24_000)
  assert.ok(durationMs >= 250 && durationMs <= 600, `decoded duration ~300ms, got ${durationMs}`)
  assert.ok(silk.length > 100)
})

test('buildVoiceItem emits the VoiceItem wire shape (encode_type 5, seconds playtime)', () => {
  const uploaded = {
    downloadEncryptedQueryParam: 'DPARAM',
    aeskey: 'aabbccdd00112233aabbccdd00112233',
  }
  const item = buildVoiceItem({ uploaded, durationMs: 2_200, sampleRate: 24_000 })
  assert.equal(item.type, 3, 'MessageItemType.VOICE')
  assert.equal(item.voice_item.media.encrypt_query_param, 'DPARAM')
  assert.equal(
    item.voice_item.media.aes_key,
    Buffer.from('aabbccdd00112233aabbccdd00112233', 'ascii').toString('base64'),
    'aes_key uses the vendor wire form: base64 of the ASCII hex key',
  )
  assert.equal(item.voice_item.media.encrypt_type, 1)
  assert.equal(item.voice_item.encode_type, VOICE_ENCODE_TYPE_SILK)
  assert.equal(item.voice_item.bits_per_sample, 16)
  assert.equal(item.voice_item.sample_rate, 24_000)
  assert.equal(item.voice_item.playtime, 2, 'playtime is whole seconds')
  assert.equal(buildVoiceItem({ uploaded, durationMs: 250, sampleRate: 24_000 }).voice_item.playtime, 1, 'never zero — WeChat renders 0 s as unplayable')
})

test('sendOutboundVoice sends text first, then the voice item, echoing the token', async () => {
  const sent = []
  const result = await sendOutboundVoice({
    filePath: '/tmp/a.wav',
    to: 'peer@im.wechat',
    contextToken: 'CTX',
    text: '这是说明',
    opts: { baseUrl: 'http://127.0.0.1:1', token: 'tok' },
    transcode: async () => ({ silk: new Uint8Array([1, 2, 3]), durationMs: 3_000, sampleRate: 24_000 }),
    upload: async ({ silk, to, opts }) => {
      assert.deepEqual([...silk], [1, 2, 3])
      assert.equal(to, 'peer@im.wechat')
      assert.equal(opts.baseUrl, 'http://127.0.0.1:1')
      return { downloadEncryptedQueryParam: 'DP', aeskey: 'aabbccdd00112233aabbccdd00112233' }
    },
    send: async (params) => {
      sent.push(params.body)
      return { ret: 0, server_message_id: 42 }
    },
  })
  assert.equal(result.kind, 'voice')
  assert.equal(sent.length, 2, 'caption is its own send (upstream splits text from media)')
  assert.equal(sent[0].msg.item_list[0].type, 1)
  assert.equal(sent[0].msg.item_list[0].text_item.text, '这是说明')
  assert.equal(sent[1].msg.item_list[0].type, 3)
  assert.equal(sent[1].msg.context_token, 'CTX')
  assert.equal(sent[1].msg.message_type, 2, 'BOT')
  assert.equal(sent[1].msg.message_state, 2, 'FINISH')
  assert.ok(sent[1].msg.client_id.startsWith('dsh-weixin-voice-'))
  assert.equal(sent[1].msg.item_list[0].voice_item.media.encrypt_query_param, 'DP')
})

test('a rejected voice send surfaces as OutboundMediaError', async () => {
  await assert.rejects(
    sendOutboundVoice({
      filePath: '/tmp/a.wav',
      to: 'peer@im.wechat',
      opts: { baseUrl: 'http://127.0.0.1:1', token: 'tok' },
      transcode: async () => ({ silk: new Uint8Array([1]), durationMs: 1_000, sampleRate: 24_000 }),
      upload: async () => ({ downloadEncryptedQueryParam: 'DP', aeskey: 'aa' }),
      send: async () => { throw new Error('sendMessage ret=-2 errmsg=prepare failed') },
    }),
    (error) => error instanceof OutboundMediaError && /ret=-2/.test(error.message),
  )
})

test('sendOutboundVoice throws when the transcode fails (caller decides the fallback)', async () => {
  await assert.rejects(
    sendOutboundVoice({
      filePath: '/tmp/a.wav',
      to: 'peer@im.wechat',
      opts: { baseUrl: 'http://127.0.0.1:1', token: 'tok' },
      transcode: async () => { throw new Error('not a RIFF/WAVE file') },
      upload: async () => { throw new Error('upload must not run when transcode failed') },
    }),
    /not a RIFF\/WAVE/,
  )
})

/** Fetch stub scripted per call: each entry answers one request in order. */
async function withScriptedFetch(script, body) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body })
    const step = script[calls.length - 1]
    if (!step) throw new Error(`unexpected fetch #${calls.length}: ${url}`)
    const headers = { 'content-type': 'application/json', ...(step.headers ?? {}) }
    const payload = typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {})
    return new Response(payload, { status: 200, headers })
  }
  try {
    return { result: await body(), calls }
  } finally {
    globalThis.fetch = original
  }
}

test('transport.sendMedia on a wav goes out as a voice_item through the real pipeline', async () => {
  const { ILinkTransport } = await import('../src/transport/ilink.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'))
  const file = path.join(dir, 'tone.wav')
  fs.writeFileSync(file, wavBuffer({ seconds: 0.3 }))
  const transport = new ILinkTransport({ accountId: 'acc', baseUrl: 'http://127.0.0.1:1', token: 'tok' })
  const script = [
    { body: { ret: 0, upload_param: 'UP' } },          // getuploadurl (voice)
    { body: '', headers: { 'x-encrypted-param': 'DP' } }, // CDN upload
    { body: { ret: 0 } },                              // sendmessage (voice)
  ]
  const { calls, result } = await withScriptedFetch(script, () =>
    transport.sendMedia({ filePath: file, conversationId: 'peer@im.wechat', contextToken: 'CTX' }),
  )
  assert.equal(result.kind, 'voice')
  const sendCalls = calls.filter((c) => c.url.includes('/sendmessage'))
  assert.equal(sendCalls.length, 1)
  const sent = JSON.parse(sendCalls[0].body)
  assert.equal(sent.msg.item_list[0].type, 3)
  assert.equal(sent.msg.item_list[0].voice_item.encode_type, 5)
  assert.equal(sent.msg.item_list[0].voice_item.sample_rate, 24_000)
  assert.equal(sent.msg.context_token, 'CTX')
  const uploadCalls = calls.filter((c) => c.url.includes('media_type') === false && /upload/.test(c.url))
  assert.ok(uploadCalls.length >= 1, 'the CDN upload ran')
})

test('a voice send the server rejects degrades to the file path', async () => {
  const { ILinkTransport } = await import('../src/transport/ilink.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'))
  const file = path.join(dir, 'tone.wav')
  fs.writeFileSync(file, wavBuffer({ seconds: 0.3 }))
  const transport = new ILinkTransport({ accountId: 'acc', baseUrl: 'http://127.0.0.1:1', token: 'tok' })
  const logLines = []
  transport.log = (line) => logLines.push(line)
  const script = [
    { body: { ret: 0, upload_param: 'UP1' } },             // getuploadurl (voice)
    { body: '', headers: { 'x-encrypted-param': 'DP1' } }, // CDN upload (voice)
    { body: { ret: -2, errmsg: 'prepare failed' } },       // sendmessage (voice) REJECTED
    { body: { ret: 0, upload_param: 'UP2' } },             // getuploadurl (file fallback)
    { body: '', headers: { 'x-encrypted-param': 'DP2' } }, // CDN upload (file)
    { body: { ret: 0 } },                                  // sendmessage (file)
  ]
  const { calls, result } = await withScriptedFetch(script, () =>
    transport.sendMedia({ filePath: file, conversationId: 'peer@im.wechat', contextToken: 'CTX' }),
  )
  assert.equal(result.kind, 'file', 'the fallback reports the kind that actually went out')
  assert.ok(logLines.some((l) => l.includes('voice send failed') && l.includes('as a file instead')), 'the degradation is logged, not silent')
  const sendCalls = calls.filter((c) => c.url.includes('/sendmessage'))
  assert.equal(sendCalls.length, 2)
  const fileSend = JSON.parse(sendCalls[1].body)
  assert.equal(fileSend.msg.item_list[0].type, 4, 'MessageItemType.FILE')
  assert.ok(fileSend.msg.item_list[0].file_item, 'the fallback carries a real file item')
})

test('voiceOutbound:false keeps audio on the plain file path', async () => {
  const { ILinkTransport } = await import('../src/transport/ilink.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'))
  const file = path.join(dir, 'tone.wav')
  fs.writeFileSync(file, wavBuffer({ seconds: 0.3 }))
  const transport = new ILinkTransport({ accountId: 'acc', baseUrl: 'http://127.0.0.1:1', token: 'tok', voiceOutbound: false })
  const script = [
    { body: { ret: 0, upload_param: 'UP' } },              // getuploadurl (file)
    { body: '', headers: { 'x-encrypted-param': 'DP' } },  // CDN upload (file)
    { body: { ret: 0 } },                                  // sendmessage (file)
  ]
  const { calls, result } = await withScriptedFetch(script, () =>
    transport.sendMedia({ filePath: file, conversationId: 'peer@im.wechat', contextToken: 'CTX' }),
  )
  assert.equal(result.kind, 'file')
  const sendCall = calls.find((c) => c.url.includes('/sendmessage'))
  assert.equal(JSON.parse(sendCall.body).msg.item_list[0].type, 4, 'no voice item when the feature is off')
})
