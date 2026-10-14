/**
 * Voice transcription: the ASR bridge client, driven against **real child
 * processes**.
 *
 * No test here needs a model, a GPU or the network. The bridge is an external
 * line-oriented JSON process, so a twelve-line Node script stands in for it
 * perfectly — and unlike a stubbed function, a real child process actually
 * exercises the parts that break in production: startup latency, partial reads
 * that split a JSON line across chunks, a process that dies mid-request, a
 * process that never answers, and teardown while a request is in flight.
 *
 * The fakes are deliberately hostile where the contract demands robustness:
 * `split-writer` dribbles its response one byte per write, `hanger` never
 * answers at all, and `crasher` exits without a word.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AsrBridge, DEFAULT_ASR_TIMEOUT_MS, resolveAsrSettings, transcribeVoice } from '../src/media/asr.js'
import { describeInboundMedia } from '../src/media/inbound.js'

/** Directory holding the fake bridge scripts; written once per run. */
const FAKE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-asr-'))
process.on('exit', () => fs.rmSync(FAKE_DIR, { recursive: true, force: true }))

/**
 * Write a fake bridge and return the settings that launch it.
 *
 * @param {string} name   Script name, also used as the tag in the reply text.
 * @param {string} body   Script body; reads lines on stdin, writes JSON on stdout.
 * @param {object} [extra] Extra settings to merge (args, env, timeoutMs).
 */
function fakeBridge(name, body, extra = {}) {
  const file = path.join(FAKE_DIR, `${name}.mjs`)
  fs.writeFileSync(file, body)
  return {
    command: process.execPath,
    args: [file],
    env: {},
    timeoutMs: 5000,
    ...extra,
  }
}

/**
 * The well-behaved bridge: echo back a transcript and count requests.
 *
 * It answers every request, so it proves the happy path *and* that requests are
 * correlated correctly when several are issued in a row.
 */
const ECHO_BRIDGE = `
let count = 0
process.stdout.write('fake bridge ready\\n')
process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() === '') continue
    const request = JSON.parse(line)
    count += 1
    const wav = String(request.wav)
    if (wav.includes('missing-file')) {
      process.stdout.write(JSON.stringify({ ok: false, error: 'FileNotFoundError: no such wav: ' + wav }) + '\\n')
      continue
    }
    process.stdout.write(JSON.stringify({ ok: true, text: '你是谁 #' + count + ' ' + wav, ms: 280 }) + '\\n')
  }
})
`

/**
 * A bridge that writes its response **one byte per write**.
 *
 * This is the case a naive `data`-handler gets wrong: the JSON line arrives in
 * dozens of chunks, and a client that parses each chunk independently sees
 * garbage. The client must accumulate until the newline.
 */
const SPLIT_WRITER_BRIDGE = `
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (!chunk.includes('\\n')) return
  const payload = JSON.stringify({ ok: true, text: '分片写出的转写' }) + '\\n'
  for (const byte of Buffer.from(payload, 'utf8')) {
    process.stdout.write(Buffer.from([byte]))
  }
})
`

/** A bridge that never answers: exercises the timeout path. */
const HANGER_BRIDGE = `
process.stdin.resume()
setTimeout(() => process.exit(0), 60000)
`

/** A bridge that exits without answering: exercises the exit path. */
const CRASHER_BRIDGE = `
process.stdin.resume()
process.stdin.on('data', () => { process.exit(3) })
`

/**
 * A bridge that dies after serving two requests **within one process**, then is
 * restarted by the client.
 *
 * The kill decision keys off the per-process `seen` counter, not the cumulative
 * file counter: a replacement process must start over at 1 and be able to
 * answer, otherwise the test would only prove that a dead bridge stays dead.
 * The file counter still accumulates, because the spawn assertion below reads it
 * to prove a second process really appeared.
 */
const FLAKY_BRIDGE = `
import fs from 'node:fs'
const counter = process.env.FLAKY_COUNTER
process.stdin.setEncoding('utf8')
let buffer = ''
let seen = 0
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() === '') continue
    seen += 1
    const before = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0
    fs.writeFileSync(counter, String(before + 1))
    if (seen >= 2) process.exit(9)
    process.stdout.write(JSON.stringify({ ok: true, text: 'flaky #' + seen }) + '\\n')
  }
})
`

// ---------------------------------------------------------------------------
// Settings resolution — "is this install configured for ASR at all"
// ---------------------------------------------------------------------------

test('resolveAsrSettings treats an absent, disabled or empty bridge as "no ASR"', () => {
  assert.equal(resolveAsrSettings(undefined), undefined)
  assert.equal(resolveAsrSettings({}), undefined)
  assert.equal(resolveAsrSettings({ asr: { enabled: false, command: 'whisper' } }), undefined)
  // Whitespace is not a command: a `command: ` line in YAML must behave like an
  // absent one rather than spawning "" and failing on every voice message.
  assert.equal(resolveAsrSettings({ asr: { command: '   ' } }), undefined)
  assert.equal(resolveAsrSettings({ asr: { command: '  \t ' } }), undefined)
})

test('resolveAsrSettings trims the command and defaults the timeout', () => {
  const settings = resolveAsrSettings({ asr: { command: '  /usr/bin/python3  ' } })
  assert.equal(settings.command, '/usr/bin/python3')
  assert.deepEqual(settings.args, [])
  assert.equal(settings.timeoutMs, DEFAULT_ASR_TIMEOUT_MS)
  // Non-string args are dropped rather than passed through to spawn().
  const filtered = resolveAsrSettings({ asr: { command: 'py', args: ['-u', 7, null, 'a.py'] } })
  assert.deepEqual(filtered.args, ['-u', 'a.py'])
  // A non-positive or non-finite timeout falls back instead of disabling the
  // bound entirely.
  assert.equal(resolveAsrSettings({ asr: { command: 'py', timeoutMs: 0 } }).timeoutMs, DEFAULT_ASR_TIMEOUT_MS)
  assert.equal(resolveAsrSettings({ asr: { command: 'py', timeoutMs: -1 } }).timeoutMs, DEFAULT_ASR_TIMEOUT_MS)
  assert.equal(resolveAsrSettings({ asr: { command: 'py', timeoutMs: 2500 } }).timeoutMs, 2500)
})

test('resolveAsrSettings normalizes the bridge environment', () => {
  const settings = resolveAsrSettings({
    asr: { command: 'py', env: { HF_HOME: '  /vol/hf  ', DSH_WEIXIN_ASR_MODEL: 'm', BLANK: '   ', NOT_A_STRING: 5 } },
  })
  assert.equal(settings.env.HF_HOME, '/vol/hf')
  assert.equal(settings.env.DSH_WEIXIN_ASR_MODEL, 'm')
  // A blank value is dropped, so the child inherits the ambient value instead of
  // receiving an empty string that overrides it.
  assert.equal('BLANK' in settings.env, false)
  assert.equal(settings.env.NOT_A_STRING, 5)
})

test('a custom model directory reaches the bridge, so transcription uses it', () => {
  // The settings UI writes the directory at runtime (AsrController.setModelDir).
  // Passing it through must point HF_HOME and the explicit model at that tree,
  // otherwise a model downloaded there is never the one transcription loads.
  const settings = resolveAsrSettings({ asr: { command: 'py' } }, '/vol/custom-models')
  assert.equal(settings.env.HF_HOME, '/vol/custom-models')
  assert.equal(settings.env.DSH_WEIXIN_ASR_MODEL, '/vol/custom-models')

  // A blank runtime value falls back to the configured directory, and a blank
  // configured value simply adds nothing.
  const fromConfig = resolveAsrSettings({ asr: { command: 'py', modelDir: '/vol/from-config' } })
  assert.equal(fromConfig.env.HF_HOME, '/vol/from-config')
  const blank = resolveAsrSettings({ asr: { command: 'py', modelDir: '   ' } })
  assert.equal('HF_HOME' in blank.env, false)
  assert.equal('DSH_WEIXIN_ASR_MODEL' in blank.env, false)

  // An explicitly typed env value wins over the directory, since the user
  // named that path on purpose.
  const explicit = resolveAsrSettings({ asr: { command: 'py', env: { HF_HOME: '/vol/explicit' } } }, '/vol/custom-models')
  assert.equal(explicit.env.HF_HOME, '/vol/explicit')
})

// ---------------------------------------------------------------------------
// The bridge client, against real child processes
// ---------------------------------------------------------------------------

test('a bridge reports the transcript of each request, in order', async () => {
  const bridge = new AsrBridge(fakeBridge('echo', ECHO_BRIDGE))
  try {
    const first = await bridge.transcribe('/tmp/one.wav')
    const second = await bridge.transcribe('/tmp/two.wav')
    assert.deepEqual(first, { ok: true, text: '你是谁 #1 /tmp/one.wav' })
    assert.deepEqual(second, { ok: true, text: '你是谁 #2 /tmp/two.wav' })
  } finally {
    await bridge.dispose()
  }
})

test('concurrent requests are serialized and each gets its own answer', async () => {
  const bridge = new AsrBridge(fakeBridge('echo-concurrent', ECHO_BRIDGE))
  try {
    // Fired together on purpose: the protocol allows only one request in flight,
    // so a client that writes all three at once would read the first response as
    // the answer to every one of them.
    const results = await Promise.all([
      bridge.transcribe('/tmp/a.wav'),
      bridge.transcribe('/tmp/b.wav'),
      bridge.transcribe('/tmp/c.wav'),
    ])
    assert.deepEqual(
      results.map((r) => r.text),
      ['你是谁 #1 /tmp/a.wav', '你是谁 #2 /tmp/b.wav', '你是谁 #3 /tmp/c.wav'],
    )
  } finally {
    await bridge.dispose()
  }
})

test('a response split across many writes is reassembled, not parsed per chunk', async () => {
  const bridge = new AsrBridge(fakeBridge('split-writer', SPLIT_WRITER_BRIDGE))
  try {
    const result = await bridge.transcribe('/tmp/split.wav')
    assert.deepEqual(result, { ok: true, text: '分片写出的转写' })
  } finally {
    await bridge.dispose()
  }
})

test('a per-request error from the bridge degrades that request only, keeping the process', async () => {
  const bridge = new AsrBridge(fakeBridge('echo-error', ECHO_BRIDGE))
  try {
    const bad = await bridge.transcribe('/tmp/missing-file.wav')
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'bridge-error')
    assert.match(bad.reason, /FileNotFoundError: no such wav: \/tmp\/missing-file\.wav/)
    // The bridge is healthy, so the next request must still work — this is the
    // property that keeps one bad voice note from poisoning the whole session.
    const good = await bridge.transcribe('/tmp/after.wav')
    assert.equal(good.ok, true)
    assert.match(good.text, /你是谁/)
  } finally {
    await bridge.dispose()
  }
})

test('a response that never arrives times out and does not hang the caller', async () => {
  const bridge = new AsrBridge(fakeBridge('hanger', HANGER_BRIDGE, { timeoutMs: 300 }))
  try {
    const started = Date.now()
    const result = await bridge.transcribe('/tmp/never.wav')
    const elapsed = Date.now() - started
    assert.equal(result.ok, false)
    assert.equal(result.code, 'timeout')
    assert.match(result.reason, /did not answer within 300ms/)
    // Bounded means bounded: it must not have waited for the 60s sleep.
    assert.ok(elapsed < 5000, `timeout took ${elapsed}ms`)
    // The timed-out child is discarded, so the next request starts a fresh one
    // rather than queueing behind a process that will never answer.
    const again = await bridge.transcribe('/tmp/never2.wav')
    assert.equal(again.code, 'timeout')
  } finally {
    await bridge.dispose()
  }
})

test('a bridge that dies mid-request fails that request instead of waiting for the timeout', async () => {
  const bridge = new AsrBridge(fakeBridge('crasher', CRASHER_BRIDGE, { timeoutMs: 30_000 }))
  try {
    const started = Date.now()
    const result = await bridge.transcribe('/tmp/dies.wav')
    const elapsed = Date.now() - started
    assert.equal(result.ok, false)
    assert.equal(result.code, 'exited')
    assert.match(result.reason, /exited \(code=3/)
    // The exit is noticed immediately: waiting 30s for a process that is already
    // gone would stall the message for no reason.
    assert.ok(elapsed < 5000, `exit took ${elapsed}ms`)
  } finally {
    await bridge.dispose()
  }
})

test('a crashed bridge is restarted for the next request', async () => {
  const counter = path.join(FAKE_DIR, 'flaky-count')
  fs.writeFileSync(counter, '0')
  const bridge = new AsrBridge(
    fakeBridge('flaky', FLAKY_BRIDGE, { env: { FLAKY_COUNTER: counter }, timeoutMs: 5000 }),
  )
  try {
    const first = await bridge.transcribe('/tmp/1.wav')
    assert.deepEqual(first, { ok: true, text: 'flaky #1' })
    // This invocation has now served its budget and kills itself rather than
    // answering a second time.
    const second = await bridge.transcribe('/tmp/2.wav')
    assert.equal(second.ok, false)
    assert.equal(second.code, 'exited')
    // The fatal invocation must not be the last word: the next request spawns a
    // fresh process, which answers again. Without the restart this call would
    // fail forever with `exited`.
    const third = await bridge.transcribe('/tmp/3.wav')
    assert.deepEqual(third, { ok: true, text: 'flaky #1' })
    // #1, #2 and #3 were served by exactly two processes, so the counter holds 3
    // requests. Asserting `>= 4` would only pass if a *new* process were spawned
    // for the third request, which is precisely what must not happen: the `#2`
    // request reached a live process, so the client keeps it.
    assert.equal(Number(fs.readFileSync(counter, 'utf8')), 3, `requests served: ${fs.readFileSync(counter, 'utf8')}`)
  } finally {
    await bridge.dispose()
  }
})

test('a bridge that cannot be spawned degrades rather than throwing', async () => {
  const bridge = new AsrBridge({
    command: path.join(FAKE_DIR, 'definitely-not-a-real-binary'),
    args: [],
    env: {},
    timeoutMs: 2000,
  })
  try {
    const result = await bridge.transcribe('/tmp/x.wav')
    // Either the spawn error surfaces asynchronously (ENOENT) or the child exits
    // immediately; both are "degraded", neither is a throw.
    assert.equal(result.ok, false)
    assert.ok(['spawn-failed', 'exited', 'timeout'].includes(result.code), `unexpected code ${result.code}`)
  } finally {
    await bridge.dispose()
  }
})

test('dispose fails an in-flight request and stops the child', async () => {
  const bridge = new AsrBridge(fakeBridge('hanger-dispose', HANGER_BRIDGE, { timeoutMs: 30_000 }))
  const pending = bridge.transcribe('/tmp/inflight.wav')
  // Give the request a moment to be written before tearing the bridge down.
  await new Promise((resolve) => setTimeout(resolve, 200))
  const started = Date.now()
  await bridge.dispose()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'closed')
  assert.ok(Date.now() - started < 5000, 'dispose must not wait for the request timeout')
  // Requests after shutdown are refused without spawning anything.
  const after = await bridge.transcribe('/tmp/after-dispose.wav')
  assert.equal(after.ok, false)
  assert.equal(after.code, 'closed')
})

test('an empty transcript is reported as empty, never as invented text', async () => {
  const bridge = new AsrBridge(
    fakeBridge(
      'empty',
      `
process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  if (!buffer.includes('\\n')) return
  process.stdout.write(JSON.stringify({ ok: true, text: '   ' }) + '\\n')
})
`,
    ),
  )
  try {
    const result = await bridge.transcribe('/tmp/silence.wav')
    assert.deepEqual(result, { ok: true, text: '' })
  } finally {
    await bridge.dispose()
  }
})

test('transcribeVoice without a bridge is a degraded result, not a throw', async () => {
  const result = await transcribeVoice({ bridge: undefined, wavPath: '/tmp/x.wav' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-configured')
})

// ---------------------------------------------------------------------------
// What the agent is told
// ---------------------------------------------------------------------------

test('a transcript reaches the agent separated from the plugin\'s own commentary', () => {
  const text = describeInboundMedia(
    [
      {
        ok: true,
        kind: 'voice',
        path: '/tmp/in/voice.wav',
        name: 'voice.wav',
        bytes: 4096,
        transcoded: true,
        transcript: '你是谁',
      },
    ],
    '',
  )
  // The user's words are labelled as such, and appear verbatim: the agent must
  // be able to tell "the user said this" from "the plugin is describing a file".
  assert.match(text, /【语音转写】/)
  assert.match(text, /你是谁/)
  assert.match(text, /\/tmp\/in\/voice\.wav/)
  // Bookkeeping is still present and still distinguishable.
  assert.match(text, /\[用户发送的语音已保存到本地/)
})

test('an empty transcript is stated as empty and forbids guessing', () => {
  const text = describeInboundMedia([
    { ok: true, kind: 'voice', path: '/tmp/in/voice.wav', name: 'voice.wav', bytes: 4096, transcoded: true, transcript: '' },
  ])
  assert.match(text, /未能识别出任何内容/)
  assert.match(text, /不要臆测/)
  assert.equal(text.includes('【语音转写】\n'), false)
})

test('a failed transcription is reported with its reason and the file is still handed over', () => {
  const text = describeInboundMedia([
    {
      ok: true,
      kind: 'voice',
      path: '/tmp/in/voice.silk',
      name: 'voice.silk',
      bytes: 512,
      transcoded: false,
      transcriptError: 'the ASR bridge did not answer within 300ms',
    },
  ])
  assert.match(text, /转写失败：the ASR bridge did not answer within 300ms/)
  assert.match(text, /SILK/)
  assert.match(text, /\/tmp\/in\/voice\.silk/)
})

test('a WAV without a transcript is described as audio to read, not as SILK', () => {
  const text = describeInboundMedia([
    { ok: true, kind: 'voice', path: '/tmp/in/voice.wav', name: 'voice.wav', bytes: 4096, transcoded: true },
  ])
  assert.match(text, /已转码为 WAV/)
  assert.equal(text.includes('未安装转码模块'), false)
})
