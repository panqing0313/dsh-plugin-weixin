import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { DEFAULT_OCR_CHARS, DEFAULT_OCR_TIMEOUT_MS, extractImageText, resolveOcrSettings } from '../src/media/ocr.js'

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.killed = []
  }

  kill(signal) {
    this.killed.push(signal)
  }
}

function fakeSpawn(child, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options })
    return child
  }
}

test('OCR is off unless enabled and a command is set', () => {
  assert.equal(resolveOcrSettings({}), undefined)
  assert.equal(resolveOcrSettings({ ocrEnabled: false, ocrCommand: '/bin/ocr' }), undefined)
  assert.equal(resolveOcrSettings({ ocrEnabled: true }), undefined)
  assert.equal(resolveOcrSettings({ ocrEnabled: true, ocrCommand: '   ' }), undefined)
  assert.deepEqual(resolveOcrSettings({ ocrEnabled: true, ocrCommand: ' /bin/ocr ' }), {
    command: '/bin/ocr',
    timeoutMs: DEFAULT_OCR_TIMEOUT_MS,
    maxChars: DEFAULT_OCR_CHARS,
  })
  assert.deepEqual(resolveOcrSettings({ ocrEnabled: true, ocrCommand: '/bin/ocr', ocrTimeoutMs: 500, ocrMaxChars: 10 }), {
    command: '/bin/ocr',
    timeoutMs: 500,
    maxChars: 10,
  })
})

test('the image path is the only argument, and stdout is the text', async () => {
  const calls = []
  const child = new FakeChild()
  const pending = extractImageText('/tmp/a.png', { command: '/bin/ocr', timeoutMs: 1000 }, { spawnImpl: fakeSpawn(child, calls) })
  child.stdout.emit('data', Buffer.from(' 第一行\n第二行 \n'))
  child.emit('close', 0, null)
  assert.deepEqual(await pending, { ok: true, text: '第一行\n第二行', truncated: false })
  assert.deepEqual(calls[0].args, ['/tmp/a.png'])
  assert.equal(calls[0].command, '/bin/ocr')
})

test('long text is clipped to the configured cap', async () => {
  const child = new FakeChild()
  const pending = extractImageText('/tmp/a.png', { command: '/bin/ocr', maxChars: 5 }, { spawnImpl: fakeSpawn(child, []) })
  child.stdout.emit('data', Buffer.from('1234567890'))
  child.emit('close', 0, null)
  assert.deepEqual(await pending, { ok: true, text: '12345', truncated: true })
})

test('a non-zero exit reports stderr and does not throw', async () => {
  const child = new FakeChild()
  const pending = extractImageText('/tmp/a.png', { command: '/bin/ocr' }, { spawnImpl: fakeSpawn(child, []) })
  child.stderr.emit('data', Buffer.from('tesseract: not found\n'))
  child.emit('close', 2, null)
  assert.deepEqual(await pending, { ok: false, reason: 'tesseract: not found', code: 'exit' })
})

test('no text is a miss, not an empty block', async () => {
  const child = new FakeChild()
  const pending = extractImageText('/tmp/a.png', { command: '/bin/ocr' }, { spawnImpl: fakeSpawn(child, []) })
  child.stdout.emit('data', Buffer.from('   \n'))
  child.emit('close', 0, null)
  assert.equal((await pending).code, 'empty')
})

test('a hung command is killed and reported as a timeout', async () => {
  const child = new FakeChild()
  const pending = extractImageText('/tmp/a.png', { command: '/bin/ocr', timeoutMs: 5 }, { spawnImpl: fakeSpawn(child, []) })
  const result = await pending
  assert.equal(result.code, 'timeout')
  assert.deepEqual(child.killed, ['SIGKILL'])
})

test('a spawn failure is caught, not thrown', async () => {
  const result = await extractImageText('/tmp/a.png', { command: '/nope' }, {
    spawnImpl: () => {
      throw new Error('ENOENT')
    },
  })
  assert.deepEqual(result, { ok: false, reason: 'ENOENT', code: 'spawn-failed' })
})
