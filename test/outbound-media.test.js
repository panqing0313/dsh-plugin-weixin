/**
 * Tests for outbound media: which local files an agent reply may send back to
 * Weixin, how they are routed, and what happens when the upload fails.
 *
 * The interesting cases are the two that would be silent bugs in production:
 *  - a reply that names a path outside the allowed directories must not be
 *    uploaded anywhere, and must say so in the text;
 *  - a failed upload must still deliver the answer.
 *
 * The last test is a real end-to-end pass over the vendored pipeline — real AES
 * encryption, real CDN POST, real iLink send — against local fake servers.
 * @module dsh-weixin/test/outbound-media
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const CONVERSATION = 'wxid_abc'

/**
 * Import the module under test with the state directory pointed somewhere
 * throwaway, so `allowedMediaDirs`'s default cannot touch the real ~/.dsh.
 */
async function loadOutbound() {
  return await import(path.join(PROJECT_ROOT, 'src', 'media', 'outbound.js'))
}

/** A temp directory that is removed when the test ends. */
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-weixin-${prefix}-`))
}

/** A local fake iLink + CDN server pair; see {@link startFakeWeixin}. */
async function startFakeWeixin() {
  /** Every body the fake CDN received, in order. */
  const uploads = []
  /** Every JSON body posted to sendmessage, in order. */
  const sent = []
  /** The getuploadurl request that preceded the current upload. */
  let lastUploadUrlRequest
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url, 'http://x')
      if (url.pathname === '/upload') {
        uploads.push({ query: url.searchParams, body, seenUploadUrlRequest: lastUploadUrlRequest })
        res.setHeader('x-encrypted-param', 'download-param-1')
        return res.end('')
      }
      res.setHeader('content-type', 'application/json')
      if (url.pathname === '/ilink/bot/getuploadurl') {
        lastUploadUrlRequest = JSON.parse(body.toString('utf8'))
        // No upload_full_url: forces the client to build the CDN URL from
        // upload_param + filekey, which is the path that has to be right.
        return res.end(JSON.stringify({ ret: 0, upload_param: 'param-abc' }))
      }
      if (url.pathname === '/ilink/bot/sendmessage') {
        sent.push(JSON.parse(body.toString('utf8')))
        return res.end(JSON.stringify({ ret: 0, message_id: 555 }))
      }
      res.end(JSON.stringify({ ret: 0 }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { server, origin, cdnBaseUrl: origin, uploads, sent }
}

test('mediaKindForMime routes video, image and everything else', async () => {
  const { mediaKindForMime } = await loadOutbound()
  assert.equal(mediaKindForMime('video/mp4'), 'video')
  assert.equal(mediaKindForMime('video/quicktime'), 'video')
  assert.equal(mediaKindForMime('image/png'), 'image')
  assert.equal(mediaKindForMime('image/jpeg'), 'image')
  assert.equal(mediaKindForMime('application/pdf'), 'file')
  // The unknown-extension default, straight from the vendored MIME table.
  assert.equal(mediaKindForMime('application/octet-stream'), 'file')
  assert.equal(mediaKindForMime(''), 'file')
})

test('isInside accepts the root itself and its descendants, rejects siblings', async () => {
  const { isInside } = await loadOutbound()
  assert.equal(isInside('/wi', '/wi'), true)
  assert.equal(isInside('/wi', '/wi/a/b.png'), true)
  // The prefix trap: /wi-evil is not inside /wi even though the string starts
  // with it.
  assert.equal(isInside('/wi', '/wi-evil/a.png'), false)
  assert.equal(isInside('/wi', '/etc/passwd'), false)
  assert.equal(isInside('/wi', '/'), false)
})

test('resolveAllowedPath refuses traversal, absolute escapes and empty paths', async () => {
  const root = tempDir('allow')
  const { resolveAllowedPath } = await loadOutbound()
  const roots = [root]
  try {
    const good = path.join(root, 'out', 'a.png')
    fs.mkdirSync(path.dirname(good), { recursive: true })
    fs.writeFileSync(good, 'x')
    // The resolved path is the *real* one: on macOS a temp root is spelled
    // /var/... but lives at /private/var/..., and we return the physical path.
    assert.deepEqual(await resolveAllowedPath(good, roots), { ok: true, path: fs.realpathSync(good), existed: true })

    // `..` out of the allowed root. Every entry is a *relative* escape, because
    // `path.join(root, escape)` silently re-roots an absolute `escape` inside
    // the root (`path.join('/r', '/etc/passwd')` is `/r/etc/passwd`) and the
    // assertion would then be vacuous. Root-relative spellings are built with
    // `root + '/..'` inside the string, not passed as an absolute path.
    for (const escape of [
      '../secrets.png',
      'sub/../../secrets.png',
      '../../secrets.png',
      '..\\secrets.png',
    ]) {
      const result = await resolveAllowedPath(path.join(root, escape), roots)
      assert.equal(result.ok, false, `expected ${escape} to be refused`)
    }
    // A bare absolute path outside every root is refused on its own terms.
    for (const absoluteEscape of ['/etc/passwd', '/tmp', root + '-sibling/secrets.png']) {
      assert.equal(
        (await resolveAllowedPath(absoluteEscape, roots)).ok,
        false,
        `expected ${absoluteEscape} to be refused`,
      )
    }
    // A path that resolves to the root's parent by name is not inside it.
    assert.equal((await resolveAllowedPath(path.dirname(root), roots)).ok, false)
    assert.equal((await resolveAllowedPath('', roots)).ok, false)
    assert.equal((await resolveAllowedPath('   ', roots)).ok, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolveAllowedPath refuses a symlink that escapes the allowed root', async () => {
  const root = tempDir('symlink')
  const outside = tempDir('outside')
  const { resolveAllowedPath } = await loadOutbound()
  try {
    fs.writeFileSync(path.join(outside, 'secret.png'), 'private')
    const link = path.join(root, 'link.png')
    try {
      fs.symlinkSync(path.join(outside, 'secret.png'), link)
    } catch {
      return // No symlink permission on this platform; the lexical test covers it.
    }
    // Lexically inside the root, physically outside it: the check must follow
    // the link, otherwise the cwd could be used to exfiltrate any file.
    assert.equal((await resolveAllowedPath(link, [root])).ok, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('resolveAllowedPath names a `..` escape differently from a plain outside path', async () => {
  const root = tempDir('reason')
  const { resolveAllowedPath } = await loadOutbound()
  try {
    // The distinction is user-facing: "you wrote a bad relative path" and "that
    // absolute path is not somewhere I may read" call for different fixes.
    //
    // Built by string concatenation, not `path.join`: `path.join` collapses
    // `..` itself, so a joined sample would reach the function already
    // normalized and the `..` branch would never be exercised.
    const climbed = await resolveAllowedPath(`${root}/inside/../../etc/passwd`, [root])
    assert.equal(climbed.ok, false)
    assert.match(climbed.reason, /\.\./)

    const relative = await resolveAllowedPath('sub/../../secrets.png', [root])
    assert.equal(relative.ok, false)
    assert.match(relative.reason, /\.\./)

    const absolute = await resolveAllowedPath('/etc/passwd', [root])
    assert.equal(absolute.ok, false)
    assert.doesNotMatch(absolute.reason, /\.\./)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolveAllowedPath ignores a root that is a regular file, not a directory', async () => {
  const root = tempDir('fileroot')
  const { resolveAllowedPath } = await loadOutbound()
  try {
    const file = path.join(root, 'a.png')
    fs.writeFileSync(file, 'x')
    // A file can never contain anything, so it must not confer containment on
    // paths spelled beneath it.
    assert.equal((await resolveAllowedPath(file + '/anything', [file])).ok, false)
    // Dropping the bad root must not invalidate the good one.
    assert.equal((await resolveAllowedPath(file, [file, root])).ok, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolveOutboundMedia classifies a real file and rejects non-files and oversize', async () => {
  const root = tempDir('resolve')
  const { resolveOutboundMedia } = await loadOutbound()
  try {
    const image = path.join(root, 'chart.png')
    fs.writeFileSync(image, Buffer.alloc(40, 7))
    const resolved = await resolveOutboundMedia({ filePath: image, allowedDirs: [root] })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.kind, 'image')
    assert.equal(resolved.mime, 'image/png')
    assert.equal(resolved.size, 40)
    assert.equal(resolved.name, 'chart.png')

    const video = path.join(root, 'clip.mp4')
    fs.writeFileSync(video, 'v')
    assert.equal((await resolveOutboundMedia({ filePath: video, allowedDirs: [root] })).kind, 'video')

    const doc = path.join(root, 'report.pdf')
    fs.writeFileSync(doc, 'p')
    assert.equal((await resolveOutboundMedia({ filePath: doc, allowedDirs: [root] })).kind, 'file')

    // A directory, an empty file, a missing file and an oversize file each get
    // an actionable reason instead of an upload.
    fs.mkdirSync(path.join(root, 'adir'))
    assert.match((await resolveOutboundMedia({ filePath: path.join(root, 'adir'), allowedDirs: [root] })).status, /not a regular file/)
    fs.writeFileSync(path.join(root, 'empty.png'), '')
    assert.match((await resolveOutboundMedia({ filePath: path.join(root, 'empty.png'), allowedDirs: [root] })).status, /empty/)
    assert.match((await resolveOutboundMedia({ filePath: path.join(root, 'nope.png'), allowedDirs: [root] })).status, /does not exist/)
    fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(2048))
    assert.match(
      (await resolveOutboundMedia({ filePath: path.join(root, 'big.bin'), allowedDirs: [root], maxBytes: 1024 })).status,
      /upload limit/,
    )
    // Out-of-bounds paths never even reach the file checks.
    assert.match((await resolveOutboundMedia({ filePath: '/etc/passwd', allowedDirs: [root] })).status, /outside the allowed directories/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('detectMediaReferences finds markdown images and path-only lines', async () => {
  const { detectMediaReferences, splitOutboundMedia } = await loadOutbound()
  const text = [
    '这里是结果：',
    '![柱状图](/tmp/out/chart.png)',
    '明细在',
    '/tmp/out/report.pdf',
    '以及 `![not a ref](/etc/passwd)`',
    '看图 [链接](https://example.com/a.png) 不算',
  ].join('\n')
  const found = detectMediaReferences(text)
  assert.deepEqual(
    found.map((r) => r.path),
    ['/tmp/out/chart.png', '/tmp/out/report.pdf'],
  )
  assert.equal(found[0].alt, '柱状图')

  const split = splitOutboundMedia(text)
  assert.equal(split.media.length, 2)
  // The references themselves are gone; the prose survives.
  assert.ok(!split.text.includes('/tmp/out/chart.png'))
  assert.ok(!split.text.includes('/tmp/out/report.pdf'))
  assert.match(split.text, /这里是结果：/)

  // Deduplication and the per-reply cap keep one reply from becoming a flood.
  const many = Array.from({ length: 8 }, (_, i) => `![x](/tmp/out/f${i}.png)`).join('\n')
  assert.equal(detectMediaReferences(many).length, 5)
  assert.equal(detectMediaReferences('![x](/a.png)\n![y](/a.png)').length, 1)
  assert.deepEqual(detectMediaReferences('no files here'), [])
  assert.deepEqual(detectMediaReferences(undefined), [])
})

test('a URL in an image reference is not treated as a local file', async () => {
  // A reply that embeds a remote image is not asking us to upload anything.
  // Detected anyway, the URL reaches the resolver, fails to `stat`, and the
  // user gets "附件发送失败 … the file does not exist" stapled onto a good reply.
  const { detectMediaReferences, splitOutboundMedia } = await loadOutbound()
  for (const url of [
    'https://example.com/a.png',
    'http://example.com/a.png',
    'HTTPS://EXAMPLE.COM/A.PNG',
    'ftp://example.com/a.png',
    'data:image/png;base64,AAAA',
  ]) {
    assert.deepEqual(detectMediaReferences(`![x](${url})`), [], `expected ${url} to be ignored`)
    assert.equal(splitOutboundMedia(`before ![x](${url}) after`).media.length, 0)
  }

  // `file:` IS a local path, and a Windows drive letter is not a scheme — the
  // naive "anything with a colon is a URL" rule silently dropped `C:\x\y.png`.
  assert.equal(detectMediaReferences('![x](file:///tmp/x.png)').length, 1)
  assert.equal(detectMediaReferences(String.raw`![x](C:\Users\me\x.png)`).length, 1)
  assert.equal(detectMediaReferences('![x](C:/Users/me/x.png)').length, 1)

  // A remote URL must leave the reply text untouched, not be cut out of it.
  const split = splitOutboundMedia('看图：![x](https://example.com/a.png) 就这样')
  assert.equal(split.text, '看图：![x](https://example.com/a.png) 就这样')
})

test('deliverOutboundMedia sends only allowed files and strips them from the text', async () => {
  const root = tempDir('deliver')
  const outside = tempDir('deliver-outside')
  const { deliverOutboundMedia, allowedMediaDirs } = await loadOutbound()
  const sentTo = []
  try {
    const image = path.join(root, 'chart.png')
    fs.writeFileSync(image, 'png-bytes')
    const secret = path.join(outside, 'secret.pdf')
    fs.writeFileSync(secret, 'confidential')

    const result = await deliverOutboundMedia({
      text: `结果如下\n![图](${image})\n另外这里\n${secret}`,
      to: CONVERSATION,
      contextToken: 'ct1',
      allowedDirs: allowedMediaDirs({ cwd: root, stateDir: path.join(root, 'state') }),
      cdnBaseUrl: 'http://cdn.invalid',
      opts: { baseUrl: 'http://ilink.invalid', token: 't' },
      // Fake sender: the point under test is the gate and the text, not the wire.
      send: async (params) => sentTo.push(params.filePath),
    })

    assert.deepEqual(sentTo, [fs.realpathSync(image)])
    assert.deepEqual(result.sent, [fs.realpathSync(image)])
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].path, secret)
    // The sent file is removed from the text; the refused one stays visible so
    // the user does not lose a file they were told about.
    assert.ok(!result.text.includes(path.basename(image)))
    assert.ok(result.text.includes(secret))
    assert.match(result.text, /附件发送失败/)
    assert.match(result.text, /outside the allowed directories/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('deliverOutboundMedia keeps the text when the upload fails', async () => {
  const root = tempDir('fail')
  const { deliverOutboundMedia } = await loadOutbound()
  const warnings = []
  try {
    const image = path.join(root, 'chart.png')
    fs.writeFileSync(image, 'png-bytes')
    const result = await deliverOutboundMedia({
      text: `这是答案正文\n![图](${image})`,
      to: CONVERSATION,
      contextToken: 'ct1',
      allowedDirs: [root],
      cdnBaseUrl: 'http://cdn.invalid',
      opts: { baseUrl: 'http://ilink.invalid', token: 't' },
      send: async () => { throw new Error('CDN upload server error: 502') },
      warn: (line) => warnings.push(line),
    })

    // The answer survives, the failure is reported, and the reference is not
    // claimed as delivered.
    assert.match(result.text, /这是答案正文/)
    assert.match(result.text, /附件发送失败/)
    assert.match(result.text, /502/)
    assert.deepEqual(result.sent, [])
    assert.equal(result.failed.length, 1)
    assert.ok(warnings.some((w) => w.includes('502')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a reply with no references is returned untouched', async () => {
  const { deliverOutboundMedia } = await loadOutbound()
  let called = false
  const result = await deliverOutboundMedia({
    text: 'just prose, no files',
    to: CONVERSATION,
    allowedDirs: [],
    cdnBaseUrl: 'http://cdn.invalid',
    opts: {},
    send: async () => { called = true },
  })
  assert.equal(result.text, 'just prose, no files')
  assert.deepEqual(result.sent, [])
  assert.deepEqual(result.failed, [])
  assert.equal(called, false)
})

test('end to end: a referenced image uploads encrypted and is sent as an IMAGE item', async () => {
  const { server, origin, cdnBaseUrl, uploads, sent } = await startFakeWeixin()
  const root = tempDir('e2e')
  const { sendOutboundMedia, resolveOutboundMedia } = await loadOutbound()
  const { aesEcbPaddedSize } = await import(path.join(PROJECT_ROOT, 'vendor', 'openclaw-weixin', 'cdn', 'aes-ecb.js'))
  try {
    const plaintext = crypto.randomBytes(5000)
    const image = path.join(root, 'photo.png')
    fs.writeFileSync(image, plaintext)

    const resolved = await resolveOutboundMedia({ filePath: image, allowedDirs: [root] })
    assert.equal(resolved.kind, 'image')

    const result = await sendOutboundMedia({
      filePath: resolved.path,
      to: CONVERSATION,
      contextToken: 'ct1',
      cdnBaseUrl,
      opts: { baseUrl: origin, token: 'tok' },
    })
    assert.equal(result.kind, 'image')

    // 1. The CDN saw exactly one upload, of exactly the padded ciphertext size.
    assert.equal(uploads.length, 1)
    const expectedSize = aesEcbPaddedSize(plaintext.length)
    assert.equal(uploads[0].body.length, expectedSize)
    assert.equal(expectedSize % 16, 0)
    assert.notDeepEqual(uploads[0].body.subarray(0, plaintext.length), plaintext)
    assert.equal(uploads[0].query.get('filekey')?.length, 32)
    assert.equal(uploads[0].query.get('encrypted_query_param'), 'param-abc')

    // 2. The upload really was AES-128-ECB under the key the client handed to
    // getuploadurl: decrypting the received bytes with that key reproduces the
    // file byte for byte. This is the assertion that would catch a key/size
    // mismatch that the length check alone cannot see.
    const aesKey = Buffer.from(uploads[0].seenUploadUrlRequest.aeskey, 'hex')
    assert.equal(aesKey.length, 16)
    const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, null)
    const decrypted = Buffer.concat([decipher.update(uploads[0].body), decipher.final()])
    assert.deepEqual(decrypted, plaintext)

    // 3. The iLink send carried one IMAGE item pointing at the CDN response.
    assert.equal(sent.length, 1)
    const msg = sent[0].msg
    assert.equal(msg.to_user_id, CONVERSATION)
    assert.equal(msg.context_token, 'ct1')
    assert.equal(msg.item_list.length, 1)
    assert.equal(msg.item_list[0].type, 2)
    assert.equal(msg.item_list[0].image_item.media.encrypt_query_param, 'download-param-1')
    assert.equal(msg.item_list[0].image_item.media.encrypt_type, 1)
    // aes_key: what the receiving client needs to decrypt what the CDN stored.
    //
    // Upstream encodes this as base64 of the *hex text* of the key, not base64
    // of the 16 raw key bytes (cdn/upload.js returns `aeskey` already
    // hex-stringified, and messaging/send.js does Buffer.from(that) — which is
    // UTF-8, so 32 ASCII bytes land in the base64). That is upstream's wire
    // format, and we vendor it unchanged, so we pin the actual behaviour here
    // and prove the key still matches the one the upload was encrypted under.
    const aesKeyField = msg.item_list[0].image_item.media.aes_key
    const decoded = Buffer.from(aesKeyField, 'base64')
    assert.equal(decoded.length, 32, 'upstream sends base64 of the 32-char hex key')
    assert.equal(decoded.toString('utf8'), uploads[0].seenUploadUrlRequest.aeskey)
    // …and that hex text is genuinely the key the ciphertext was made with.
    assert.deepEqual(Buffer.from(decoded.toString('utf8'), 'hex'), aesKey)
    assert.equal(msg.item_list[0].image_item.mid_size, expectedSize)
    assert.equal(uploads[0].seenUploadUrlRequest.media_type, 1)
    assert.equal(uploads[0].seenUploadUrlRequest.rawsize, plaintext.length)
    assert.equal(uploads[0].seenUploadUrlRequest.filesize, expectedSize)
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/**
 * `detectMediaReferences` must not treat a path the agent is *showing* as code
 * as a file to upload. These four cases are the CommonMark delimiter boundaries
 * that an independent verification pass found broken (both caused a genuinely
 * uploaded file from inside a code block).
 */
test('detectMediaReferences ignores image syntax inside code, at every fence boundary', async () => {
  const root = tempDir('mask')
  const { detectMediaReferences } = await loadOutbound()
  try {
    const secret = path.join(root, 'secret.png')
    fs.writeFileSync(secret, 'private')

    // 1. A four-backtick fence exists to contain ``` inside it. Closing on the
    //    first inner ``` exposed the block's contents as a real reference.
    const nested = ['````', '```', `![x](${secret})`, '```', '````'].join('\n')
    assert.deepEqual(detectMediaReferences(nested).map((r) => r.path), [])

    // 2. A code span is closed only by a run of EXACTLY equal length. Letting a
    //    longer run displace the opener mis-pairs every later backtick, which
    //    reopened the text inside the span.
    const longerRunInside = '用 ``` 包住它，比如 `![x](' + secret + ')` 这样'
    assert.deepEqual(detectMediaReferences(longerRunInside).map((r) => r.path), [])

    // 3. An unclosed fence still swallows the rest of the reply.
    const unclosed = '```\n![x](' + secret + ')'
    assert.deepEqual(detectMediaReferences(unclosed).map((r) => r.path), [])

    // 4. …but a properly closed span must NOT mask, or real attachments vanish.
    const real = '看图 ![x](' + secret + ') 结束'
    assert.deepEqual(detectMediaReferences(real).map((r) => r.path), [secret])

    // 5. Equal-length runs still close, so the reference after them is live.
    const equalRuns = '``a`` 然后 ![x](' + secret + ')'
    assert.deepEqual(detectMediaReferences(equalRuns).map((r) => r.path), [secret])

    // 6. A line whose info string contains a backtick is not a fence — but it does
    //    not shield the lines under it either. The ``` below it is a REAL fence
    //    opener, so the image under that is code. Gating the unclosed-fence mask on
    //    "did we reject any opener?" instead of "is a fence still open?" let a
    //    single rejected opener switch masking off for the whole reply, and the
    //    image below was uploaded.
    for (const body of [
      '```\n```js`\n',
      '```\n```js` ',
      '````js`\n```\n',
      '````js`\n~~~\n',
    ]) {
      assert.deepEqual(
        detectMediaReferences(body + `![x](${secret})`).map((r) => r.path),
        [],
        `leaked an upload from an unclosed fence: ${JSON.stringify(body)}`,
      )
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/**
 * The complement of the test above: masking must not be SO eager that it eats a
 * real attachment. Every case here is a reply where the image is genuinely
 * outside code, so the file must still be sent.
 *
 * All of these were broken at some point during development, and the failure
 * mode is silent — the user simply never receives the file.
 */
test('detectMediaReferences still finds an image that only looks like code', async () => {
  const root = tempDir('unmask')
  const { detectMediaReferences } = await loadOutbound()
  try {
    const real = path.join(root, 'chart.png')
    fs.writeFileSync(real, 'data')
    const img = `![x](${real})`

    // A line that begins with ``` but whose info string contains a backtick is
    // NOT a fence. The two single backticks pair into a span, so the image is
    // real. Treating the opening run as an unclosable span blanked the rest of
    // the reply and dropped the attachment.
    assert.deepEqual(detectMediaReferences('``` run `code` end ' + img).map((r) => r.path), [real])

    // A ``` run that is not at the start of a line never opens a fence, and it
    // has no same-length partner, so it is literal text.
    assert.deepEqual(detectMediaReferences('inline ``` then `c` end ' + img).map((r) => r.path), [real])

    // A fence that closes properly leaves what follows outside code.
    assert.deepEqual(detectMediaReferences('```\nx\n```\n' + img).map((r) => r.path), [real])

    // A tilde fence must not be closed by a backtick fence, and vice versa: the
    // block stays open, so its contents are code.
    assert.deepEqual(detectMediaReferences('~~~\n' + img + '\n```').map((r) => r.path), [])

    // …and the same content after a properly closed tilde fence is real.
    assert.deepEqual(detectMediaReferences('~~~\nx\n~~~\n' + img).map((r) => r.path), [real])

    // A closing fence may carry a further run of fence MARKERS after its own run.
    // These lines really do close the fence above them, so the image below is a
    // real attachment; requiring an empty tail left the fence open and dropped it.
    for (const [opener, closer] of [
      ['```', '```~~~'],
      ['```', '````~~~'],
      ['~~~', '~~~`'],
      ['~~~', '~~~~`'],
    ]) {
      assert.deepEqual(
        detectMediaReferences(`${opener}\n${closer}\n${img}`).map((r) => r.path),
        [real],
        `dropped a real attachment: ${JSON.stringify(opener + '\n' + closer)}`,
      )
    }

    // A blank line between them changes nothing: the fence above is still open,
    // and a closing fence needs no blank-line rule, so the image is still real.
    for (const [opener, closer] of [
      ['```', '```~~~'],
      ['~~~', '~~~`'],
    ]) {
      assert.deepEqual(
        detectMediaReferences(`${opener}\n\n${closer}\n${img}`).map((r) => r.path),
        [real],
        `dropped a real attachment across a blank line: ${JSON.stringify(opener + '\n\n' + closer)}`,
      )
    }

    // Ordinary text after the run — or a tab anywhere in the tail — disqualifies
    // the line as a closer, so the fence above stays open and the image is code.
    for (const closer of ['```x~~~', '```-~~~', '```\t~~~', '``` ~']) {
      assert.deepEqual(
        detectMediaReferences(`\`\`\`\n${closer}\n${img}`).map((r) => r.path),
        [],
        `leaked an upload past a non-closer line: ${JSON.stringify(closer)}`,
      )
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a relative reference resolves against the allowed directories, not the host cwd', async () => {
  // The real bug: an agent writing `![shot](desktop.png)` means the file in ITS
  // working directory — which is one of the allowed dirs — but a `path.resolve`
  // against `process.cwd()` looks in the host's own directory, lands outside
  // every allowed root, and every relative reference is refused. The user sees
  // an attachment that never arrives and no error anywhere.
  const root = tempDir('relative')
  const { resolveAllowedPath, deliverOutboundMedia, allowedMediaDirs } = await loadOutbound()
  try {
    const cwd = path.join(root, 'sessions')
    const state = path.join(root, 'state')
    fs.mkdirSync(cwd, { recursive: true })
    fs.mkdirSync(state, { recursive: true })
    const image = path.join(cwd, 'desktop.png')
    fs.writeFileSync(image, 'x')

    const roots = allowedMediaDirs({ cwd, stateDir: state })
    assert.deepEqual(await resolveAllowedPath('desktop.png', roots), {
      ok: true,
      path: fs.realpathSync(image),
      existed: true,
    })

    // In a subdirectory of an allowed root, too.
    const nested = path.join(cwd, 'crops')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'a.png'), 'x')
    assert.equal((await resolveAllowedPath('crops/a.png', roots)).ok, true)

    // Delivered end to end: the reply the agent actually writes.
    const sent = []
    const result = await deliverOutboundMedia({
      text: '成功了\n\n![桌面截图](desktop.png)\n\n内容如下',
      to: CONVERSATION,
      contextToken: 'ct',
      allowedDirs: roots,
      cdnBaseUrl: 'http://cdn.invalid',
      opts: { baseUrl: 'http://ilink.invalid', token: 't' },
      send: async (params) => sent.push(params.filePath),
    })
    assert.deepEqual(sent, [fs.realpathSync(image)])
    assert.deepEqual(result.sent, [fs.realpathSync(image)])
    assert.deepEqual(result.failed, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a relative reference cannot escape the allowed directories', async () => {
  // Resolving against the allowed roots must not become a way out of them.
  const root = tempDir('relative-escape')
  const { resolveAllowedPath, allowedMediaDirs } = await loadOutbound()
  try {
    const cwd = path.join(root, 'sessions')
    fs.mkdirSync(cwd, { recursive: true })
    fs.writeFileSync(path.join(root, 'secret.png'), 'private')
    const roots = allowedMediaDirs({ cwd, stateDir: path.join(root, 'state') })

    // `..` climbs out of the allowed root and is refused — and the refusal still
    // names the climb, which the joined spelling would have hidden.
    for (const escape of ['../secret.png', 'sub/../../secret.png', '..\\secret.png']) {
      const result = await resolveAllowedPath(escape, roots)
      assert.equal(result.ok, false, `expected ${escape} to be refused`)
      assert.match(result.reason, /\.\./, `expected ${escape} to be named a ".." escape`)
    }
    // A relative reference to something that simply is not there is NOT a
    // traversal: containment holds (the path it would occupy is inside an
    // allowed root), so the resolver reports it allowed-but-absent and the
    // later `stat` refuses it with the accurate reason. Naming it "outside the
    // allowed directories" would point at the wrong mistake.
    const missing = await resolveAllowedPath('nope.png', roots)
    assert.equal(missing.ok, true)
    assert.equal(missing.existed, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a relative reference resolves inside whichever allowed root holds it', async () => {
  // Several allowed directories is a supported deployment; the reference must
  // find the right one rather than being pinned to the first.
  const root = tempDir('relative-multi')
  const { resolveAllowedPath, allowedMediaDirs } = await loadOutbound()
  try {
    const cwd = path.join(root, 'sessions')
    const state = path.join(root, 'state')
    fs.mkdirSync(cwd, { recursive: true })
    fs.mkdirSync(state, { recursive: true })
    fs.writeFileSync(path.join(state, 'only-here.png'), 'x')
    fs.writeFileSync(path.join(cwd, 'only-here.png'), 'y')

    const roots = allowedMediaDirs({ cwd, stateDir: state })
    // Present in both: the first root wins, deterministically.
    assert.equal((await resolveAllowedPath('only-here.png', roots)).path, fs.realpathSync(path.join(cwd, 'only-here.png')))

    fs.rmSync(path.join(cwd, 'only-here.png'))
    // Present in only the second: still found.
    assert.equal((await resolveAllowedPath('only-here.png', roots)).path, fs.realpathSync(path.join(state, 'only-here.png')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
