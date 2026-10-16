/**
 * Inbound media: fetch → decrypt → save, against a real HTTP server standing in
 * for the Weixin CDN.
 *
 * The point of the fake server is that nothing here mocks the crypto or the
 * download path: the test encrypts with `encryptAesEcb`, serves those exact
 * bytes over a real socket, and asserts on the bytes that land on disk. A key
 * or encoding mistake shows up as a corrupt file, not as a missing call.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { decryptAesEcb, encryptAesEcb } from '../vendor/openclaw-weixin/cdn/aes-ecb.js'
import {
  DEFAULT_CDN_BASE_URL,
  DEFAULT_MAX_INBOUND_MEDIA_BYTES,
  InboundMediaError,
  describeInboundMedia,
  describeMediaFailures,
  downloadInboundMedia,
  downloadInboundVoice,
  fetchInboundBytes,
  inboundFileName,
  kindLabel,
  parseAesKey,
  resolveAesKey,
  safeBaseName,
  saveInboundBuffer,
} from '../src/media/inbound.js'

/** A temp inbox directory, removed by the callback's caller. */
function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-weixin-inbound-${tag}-`))
}

/**
 * Serve `body` (or a status/headers override) once, and report the URL.
 *
 * @param {object} options
 * @param {Buffer|string} [options.body]
 * @param {number} [options.status]
 * @param {Record<string,string>} [options.headers]
 * @param {(req: http.IncomingMessage) => void} [options.onRequest]
 */
async function serveOnce({ body = Buffer.alloc(0), status = 200, headers = {}, onRequest } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    if (onRequest) onRequest(req)
    res.writeHead(status, headers)
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// ---------------------------------------------------------------------------
// Key parsing — both encodings the protocol uses
// ---------------------------------------------------------------------------

test('parseAesKey accepts a base64 of 16 raw bytes (images)', () => {
  const raw = crypto.randomBytes(16)
  assert.deepEqual(parseAesKey(raw.toString('base64')), raw)
})

test('parseAesKey accepts a base64 of the 32-character hex string (file/voice/video)', () => {
  const raw = crypto.randomBytes(16)
  const hex = raw.toString('hex')
  assert.equal(hex.length, 32)
  assert.deepEqual(parseAesKey(Buffer.from(hex, 'utf8').toString('base64')), raw)
})

test('parseAesKey rejects any other length instead of guessing', () => {
  assert.throws(() => parseAesKey(Buffer.alloc(8).toString('base64')), InboundMediaError)
  assert.throws(() => parseAesKey('not base64 at all!!'), InboundMediaError)
})

test('resolveAesKey prefers the hex aeskey an image carries beside its media block', () => {
  const raw = crypto.randomBytes(16)
  const resolved = resolveAesKey({ aesKeyHex: raw.toString('hex'), aesKey: 'ignored' })
  assert.deepEqual(Buffer.from(resolved, 'base64'), raw)
  // A file/voice descriptor has no hex field, so the base64 key is used as-is.
  assert.equal(resolveAesKey({ aesKey: 'Zg==' }), 'Zg==')
  assert.equal(resolveAesKey({}), undefined)
})

// ---------------------------------------------------------------------------
// Path-traversal defence
// ---------------------------------------------------------------------------

test('safeBaseName strips directories, dot segments and separators', () => {
  assert.equal(safeBaseName('../../etc/passwd'), 'passwd')
  assert.equal(safeBaseName('/etc/passwd'), 'passwd')
  // Backslash is a separator on the Windows hosts this plugin also runs on,
  // so basename() alone is not enough.
  assert.equal(safeBaseName('..\\..\\windows\\system32\\evil.exe'), 'evil.exe')
  assert.equal(safeBaseName('a/b/c/../../d.txt'), 'd.txt')
  assert.equal(safeBaseName('..'), 'file')
  assert.equal(safeBaseName('.'), 'file')
  assert.equal(safeBaseName('....//....//x'), 'x')
  assert.equal(safeBaseName(''), 'file')
  assert.equal(safeBaseName(undefined), 'file')
  // A NUL byte would truncate the path inside libc and must not survive.
  assert.equal(safeBaseName('a\u0000b.txt'), 'a_b.txt')
})

test('inboundFileName never yields a path and always carries a random prefix', () => {
  const cases = [
    '../../etc/passwd',
    '/etc/shadow',
    '..\\..\\evil.bat',
    'C:\\Windows\\System32\\cmd.exe',
    '....//....//etc/x',
    '..',
    '',
  ]
  for (const peer of cases) {
    const name = inboundFileName(peer, () => 'TOKEN')
    assert.equal(path.basename(name), name, `"${peer}" produced a path`)
    assert.equal(name.includes('/'), false, `"${peer}" kept a separator`)
    assert.equal(name.includes('\\'), false, `"${peer}" kept a backslash`)
    assert.equal(name.includes('..'), false, `"${peer}" kept a dot segment`)
    assert.ok(name.startsWith('TOKEN-'), `"${peer}" lost the random prefix`)
  }
})

test('saveInboundBuffer cannot be steered outside the inbox directory', async () => {
  const root = tempDir('escape')
  const inbox = path.join(root, 'inbound')
  fs.mkdirSync(inbox)
  try {
    // A distinct token per write: the exclusive-write guard would otherwise
    // reject the second file and hide whether containment actually held.
    let n = 0
    for (const peer of ['../../../../../../tmp/pwned.txt', '..\\..\\pwned.txt', '/tmp/pwned.txt']) {
      const saved = await saveInboundBuffer(Buffer.from('x'), peer, {
        dir: inbox,
        token: () => `T${n++}`,
      })
      assert.equal(path.dirname(saved.path), inbox)
      // The resolved path stays inside the inbox even after symlink resolution.
      assert.equal(fs.realpathSync(saved.path).startsWith(fs.realpathSync(inbox)), true)
    }
    assert.equal(fs.existsSync('/tmp/pwned.txt'), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('saveInboundBuffer is exclusive, so a generated name never clobbers a file', async () => {
  const root = tempDir('exclusive')
  try {
    await saveInboundBuffer(Buffer.from('first'), 'a.txt', { dir: root, token: () => 'FIXED' })
    await assert.rejects(
      () => saveInboundBuffer(Buffer.from('second'), 'a.txt', { dir: root, token: () => 'FIXED' }),
      (error) => error instanceof InboundMediaError && error.code === 'write-failed',
    )
    assert.equal(fs.readFileSync(path.join(root, 'FIXED-a.txt'), 'utf8'), 'first')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The real pass-through: HTTP → decrypt → disk
// ---------------------------------------------------------------------------

test('an image downloads, decrypts with a base64-of-16-bytes key, and lands on disk', async () => {
  const plaintext = Buffer.from('\x89PNG\r\n\x1a\n' + 'real image bytes'.repeat(20), 'binary')
  const key = crypto.randomBytes(16)
  const server = await serveOnce({ body: encryptAesEcb(plaintext, key) })
  const root = tempDir('image')
  try {
    const result = await downloadInboundMedia({
      media: {
        kind: 'image',
        encryptQueryParam: 'param-abc',
        aesKey: key.toString('base64'),
        fileName: 'photo.png',
      },
      cdnBaseUrl: server.baseUrl,
      maxBytes: DEFAULT_MAX_INBOUND_MEDIA_BYTES,
      dir: root,
      token: () => 'IMG',
    })
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.bytes, plaintext.length)
    assert.equal(result.name, 'IMG-photo.png')
    assert.deepEqual(fs.readFileSync(result.path), plaintext)
    // The descriptor's query param is what reaches the CDN, encoded.
    assert.equal(server.requests.length, 1)
    assert.equal(server.requests[0].url, '/download?encrypted_query_param=param-abc')
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a file downloads and decrypts with a base64-of-hex key', async () => {
  const plaintext = Buffer.from('PDF-1.7\n' + 'x'.repeat(500))
  const key = crypto.randomBytes(16)
  // The other encoding the protocol uses: base64 of the 32-char hex string.
  const aesKey = Buffer.from(key.toString('hex'), 'utf8').toString('base64')
  const server = await serveOnce({ body: encryptAesEcb(plaintext, key) })
  const root = tempDir('file')
  try {
    const result = await downloadInboundMedia({
      media: { kind: 'file', encryptQueryParam: 'file-param', aesKey, fileName: '报告 v2.pdf' },
      cdnBaseUrl: server.baseUrl,
      maxBytes: DEFAULT_MAX_INBOUND_MEDIA_BYTES,
      dir: root,
      token: () => 'DOC',
    })
    assert.equal(result.ok, true, result.reason)
    assert.deepEqual(fs.readFileSync(result.path), plaintext)
    // A non-ASCII name is kept for the user but is still a bare file name.
    assert.equal(result.name, 'DOC-报告 v2.pdf')
    assert.equal(path.dirname(result.path), root)
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an image key given hex-encoded in aeskey is converted and decrypts', async () => {
  const plaintext = Buffer.from('hex-keyed image')
  const key = crypto.randomBytes(16)
  const server = await serveOnce({ body: encryptAesEcb(plaintext, key) })
  const root = tempDir('hexkey')
  try {
    const result = await downloadInboundMedia({
      media: { kind: 'image', encryptQueryParam: 'p', aesKeyHex: key.toString('hex'), fileName: 'a.jpg' },
      cdnBaseUrl: server.baseUrl,
      maxBytes: DEFAULT_MAX_INBOUND_MEDIA_BYTES,
      dir: root,
      token: () => 'HEX',
    })
    assert.equal(result.ok, true, result.reason)
    assert.deepEqual(fs.readFileSync(result.path), plaintext)
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a full_url on the descriptor is used verbatim instead of building a CDN URL', async () => {
  const plaintext = Buffer.from('via full url')
  const key = crypto.randomBytes(16)
  const server = await serveOnce({ body: encryptAesEcb(plaintext, key) })
  const root = tempDir('fullurl')
  try {
    const result = await downloadInboundMedia({
      media: {
        kind: 'image',
        fullUrl: `${server.baseUrl}/direct/path?x=1`,
        aesKey: key.toString('base64'),
        fileName: 'a.jpg',
      },
      cdnBaseUrl: 'http://127.0.0.1:1/unused',
      maxBytes: DEFAULT_MAX_INBOUND_MEDIA_BYTES,
      dir: root,
      token: () => 'URL',
    })
    assert.equal(result.ok, true, result.reason)
    assert.equal(server.requests[0].url, '/direct/path?x=1')
    assert.deepEqual(fs.readFileSync(result.path), plaintext)
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Size cap and failures are reported, never thrown
// ---------------------------------------------------------------------------

test('an attachment larger than maxBytes is refused, and nothing is written', async () => {
  const server = await serveOnce({ body: Buffer.alloc(4096, 7) })
  const root = tempDir('toobig')
  try {
    const result = await downloadInboundMedia({
      media: { kind: 'file', encryptQueryParam: 'p', fileName: 'big.bin' },
      cdnBaseUrl: server.baseUrl,
      maxBytes: 1024,
      dir: root,
      token: () => 'BIG',
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'too-large')
    assert.match(result.reason, /larger than the/)
    assert.deepEqual(fs.readdirSync(root), [])
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an oversize download is refused from Content-Length before the body is read', async () => {
  // The body is small, but the header claims a huge size: the header check must
  // fire, which is what stops a hostile CDN from ever filling memory.
  const server = await serveOnce({
    body: Buffer.from('tiny'),
    headers: { 'content-length': String(50 * 1024 * 1024) },
  })
  try {
    await assert.rejects(
      () =>
        fetchInboundBytes(
          { kind: 'file', encryptQueryParam: 'p' },
          { cdnBaseUrl: server.baseUrl, maxBytes: 1024 },
        ),
      (error) => error instanceof InboundMediaError && error.code === 'too-large',
    )
  } finally {
    await server.close()
  }
})

test('a body longer than the declared Content-Length cannot smuggle an oversize payload', async () => {
  // A lying header must not license an unbounded buffer. Two independent things
  // stop it: the runtime truncates the body to the declared length, and the
  // post-read check bounds whatever actually arrived. Either way an oversize
  // payload is refused here.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': '4' })
    res.end(Buffer.alloc(64 * 1024, 1))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const url = `http://127.0.0.1:${port}/x`
    // 1. Under the cap: only the declared 4 bytes are delivered, never 64KB.
    const small = await fetchInboundBytes({ kind: 'file', fullUrl: url }, { cdnBaseUrl: '', maxBytes: 1024 })
    assert.equal(small.length, 4)
    // 2. The cap still holds: a declared length under the cap does not let the
    //    cap be exceeded, and a declared length over it is refused outright.
    await assert.rejects(
      () => fetchInboundBytes({ kind: 'file', fullUrl: url }, { cdnBaseUrl: '', maxBytes: 1 }),
      (error) => error instanceof InboundMediaError && error.code === 'too-large',
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a chunked response with no Content-Length is bounded by the post-read check', async () => {
  // No header to pre-check: the bytes themselves must be measured.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'transfer-encoding': 'chunked' })
    res.end(Buffer.alloc(64 * 1024, 1))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await assert.rejects(
      () =>
        fetchInboundBytes(
          { kind: 'file', fullUrl: `http://127.0.0.1:${port}/x` },
          { cdnBaseUrl: '', maxBytes: 1024 },
        ),
      (error) => error instanceof InboundMediaError && error.code === 'too-large',
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a CDN error status is reported with the status and the body', async () => {
  const server = await serveOnce({ status: 403, body: 'denied by CDN' })
  try {
    const result = await downloadInboundMedia({
      media: { kind: 'file', encryptQueryParam: 'p', fileName: 'a.bin' },
      cdnBaseUrl: server.baseUrl,
      maxBytes: 1024,
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'cdn-status')
    assert.match(result.reason, /403/)
    assert.match(result.reason, /denied by CDN/)
  } finally {
    await server.close()
  }
})

test('an unreachable CDN is reported as a fetch failure, not a crash', async () => {
  const result = await downloadInboundMedia({
    // Port 1 on loopback refuses immediately.
    media: { kind: 'file', fullUrl: 'http://127.0.0.1:1/nope' },
    cdnBaseUrl: '',
    maxBytes: 1024,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'fetch-failed')
})

test('a descriptor with no CDN reference is refused with a clear reason', async () => {
  const result = await downloadInboundMedia({
    media: { kind: 'image' },
    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    maxBytes: 1024,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no-cdn-reference')
})

test('a wrong key is reported as a decryption failure rather than saving garbage', async () => {
  // The wrong key must be one that PROVABLY fails. AES-ECB has no
  // authentication, so a wrong key usually throws only because the PKCS#7
  // padding happens not to validate -- and that is a random ~1-in-667 event.
  // Picking `randomBytes(16)` therefore made this test flaky: it passed almost
  // always and failed rarely, with no change to the code under test. Search for
  // a key that fails against this exact ciphertext instead, so the assertion
  // tests the error path rather than the odds.
  const rightKey = crypto.randomBytes(16)
  const body = encryptAesEcb(Buffer.alloc(64, 3), rightKey)
  /** @type {Buffer} */
  let wrongKey
  for (;;) {
    const candidate = crypto.randomBytes(16)
    try {
      decryptAesEcb(body, candidate)
    } catch {
      wrongKey = candidate
      break
    }
  }
  const server = await serveOnce({ body })
  const root = tempDir('badkey')
  try {
    const result = await downloadInboundMedia({
      media: {
        kind: 'file',
        encryptQueryParam: 'p',
        aesKey: wrongKey.toString('base64'),
        fileName: 'a.bin',
      },
      cdnBaseUrl: server.baseUrl,
      maxBytes: DEFAULT_MAX_INBOUND_MEDIA_BYTES,
      dir: root,
      token: () => 'BAD',
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'decrypt-failed')
    assert.deepEqual(fs.readdirSync(root), [])
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the configured CDN base builds the documented upstream download URL', async () => {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    res.writeHead(200, { 'content-length': '0' })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fetchInboundBytes(
      { kind: 'image', encryptQueryParam: 'abc+/=' },
      { cdnBaseUrl: `http://127.0.0.1:${port}/c2c/`, maxBytes: 1024 },
    )
    // A trailing slash on the configured base must not double up, and the
    // query param must be percent-encoded (it is base64ish and can contain +/=).
    assert.equal(requests[0], '/c2c/download?encrypted_query_param=abc%2B%2F%3D')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the default CDN base is the upstream c2c root', () => {
  assert.equal(DEFAULT_CDN_BASE_URL, 'https://novac2c.cdn.weixin.qq.com/c2c')
  assert.equal(DEFAULT_MAX_INBOUND_MEDIA_BYTES, 20 * 1024 * 1024)
})

// ---------------------------------------------------------------------------
// Voice: SILK in, and the documented degradation when silk-wasm is absent
// ---------------------------------------------------------------------------

test('voice saves the SILK payload and degrades to it when no transcoder is installed', async () => {
  // silk-wasm is an OPTIONAL runtime dependency (the vendored silk-transcode.js
  // dynamic-imports it), so this asserts the shipped fallback: the .silk file is
  // saved and the caller is told it was not transcoded, rather than the download
  // being reported as a failure. If a host does install silk-wasm, the same code
  // path returns transcoded: true and a .wav — hence the either/or.
  const silk = Buffer.from('\x02#!SILK_V3' + 'payload'.repeat(10))
  const key = crypto.randomBytes(16)
  const server = await serveOnce({ body: encryptAesEcb(silk, key) })
  const root = tempDir('voice')
  try {
    const result = await downloadInboundVoice({
      media: {
        kind: 'voice',
        encryptQueryParam: 'voice-param',
        aesKey: Buffer.from(key.toString('hex'), 'utf8').toString('base64'),
        fileName: 'voice.silk',
      },
      cdnBaseUrl: server.baseUrl,
      maxBytes: DEFAULT_MAX_INBOUND_MEDIA_BYTES,
      dir: root,
      token: () => 'V',
    })
    assert.equal(result.ok, true, result.reason)
    const names = fs.readdirSync(root).sort()
    if (result.transcoded === true) {
      assert.equal(result.mime, 'audio/wav')
      assert.deepEqual(names, ['V-V-voice.silk.wav', 'V-voice.silk'])
      assert.deepEqual(fs.readFileSync(result.silkPath), silk)
    } else {
      // No transcoder: the SILK bytes are intact on disk and the path handed
      // back is the .silk file.
      assert.deepEqual(names, ['V-voice.silk'])
      assert.deepEqual(fs.readFileSync(result.path), silk)
    }
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('describeInboundMedia tells the agent which tool to use, per kind', () => {
  const saved = [
    { ok: true, kind: 'image', path: '/tmp/in/a.jpg', name: 'a.jpg', bytes: 2048 },
    { ok: true, kind: 'file', path: '/tmp/in/b.pdf', name: 'b.pdf', bytes: 1024 },
    { ok: true, kind: 'voice', path: '/tmp/in/c.silk', name: 'c.silk', bytes: 512, transcoded: false },
    { ok: true, kind: 'voice', path: '/tmp/in/d.wav', name: 'd.wav', bytes: 4096, transcoded: true },
  ]
  const text = describeInboundMedia(saved, '看看这个')
  // Every saved path is named, so the agent can open it.
  for (const item of saved) assert.match(text, new RegExp(item.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(text, /read_image/)
  // An untranscodable voice note is described as SILK, not silently dropped.
  assert.match(text, /SILK/)
  // The caption rides along at the end, so the question is still the question.
  assert.ok(text.endsWith('看看这个'))
})

test('describeMediaFailures reports the reason, never a blanket "unsupported"', () => {
  const text = describeMediaFailures([
    { kind: 'image', reason: 'CDN returned 403 Forbidden', code: 'cdn-status' },
    { kind: 'file', reason: 'the attachment is 30.0MB, larger than the 20.0MB limit', code: 'too-large' },
  ])
  assert.match(text, /图片下载失败：CDN returned 403 Forbidden/)
  assert.match(text, /文件下载失败：.*20\.0MB/)
  assert.equal(text.includes('暂不支持'), false)
})

test('kindLabel names the four media kinds for the user', () => {
  assert.equal(kindLabel('image'), '图片')
  assert.equal(kindLabel('voice'), '语音')
  assert.equal(kindLabel('video'), '视频')
  assert.equal(kindLabel('file'), '文件')
})
