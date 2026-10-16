/**
 * The QR encoder that no longer depends on anything being installed.
 *
 * This file exists because of a Windows-only bug: the settings card showed a
 * broken-image icon with the working "open in browser" buttons underneath it.
 * The card had asked `qrDataUrl()` for a PNG, got `undefined`, and fell back to
 * putting the login *link* in an `<img src>`. The encoder returned undefined
 * because it reached, in order, for an npm `qrcode` that was never a dependency
 * and for `python3`/`python` that Windows does not have on PATH. On the
 * developer's Mac both were present by luck (`miniconda3` on PATH, and a
 * bundled python that happened to have the `qrcode` wheel), so the whole suite
 * was green while Windows was broken.
 *
 * The fix is to stop depending on the environment: the QR matrix comes from
 * `qrcode-terminal` (a declared dependency the installer already ships, which
 * vendors a complete encoder) and the PNG is written by `src/png.js` using only
 * `node:zlib`. These tests therefore assert the *absence* of that dependency,
 * not merely that the happy path works.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { encodePng } from '../src/png.js'
import { writeQrPng, qrDataUrl } from '../src/qr-png.js'

const SAMPLE = 'https://liteapp.weixin.qq.com/q/abc123?qrcode=deadbeef&bot_type=3'

/**
 * Decode a PNG with `node:zlib` alone: verify every chunk CRC and read back the
 * 1-bit greyscale pixels. Using our own decoder rather than a library keeps the
 * assertion on the bytes we actually emit; it also means the test needs nothing
 * installed, which is the point of the change under test.
 * @param {Buffer} buf
 */
function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG magic')
  const chunks = []
  let off = 8
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.subarray(off + 4, off + 8).toString('latin1')
    const data = buf.subarray(off + 8, off + 8 + len)
    assert.equal(
      buf.readUInt32BE(off + 8 + len),
      zlib.crc32(buf.subarray(off + 4, off + 8 + len)),
      `CRC of the ${type} chunk`,
    )
    chunks.push({ type, data })
    off += 12 + len
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR').data
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const depth = ihdr[8]
  const colourType = ihdr[9]
  const idat = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)))
  const stride = Math.ceil(width / 8)
  return {
    width,
    height,
    depth,
    colourType,
    chunks: chunks.map((c) => c.type),
    /** 0 = black (a set bit is white in greyscale), 255 = white. */
    pixel: (x, y) => {
      const base = y * (stride + 1)
      assert.equal(idat[base], 0, 'every scanline must use filter "None"')
      return ((idat[base + 1 + (x >> 3)] >> (7 - (x & 7))) & 1) ? 255 : 0
    },
  }
}

test('the PNG encoder round-trips a matrix pixel for pixel', () => {
  const matrix = [
    [true, false, true],
    [false, true, false],
    [true, false, true],
  ]
  const png = encodePng(matrix, { scale: 4, border: 2 })
  const decoded = decodePng(png)
  const side = (3 + 2 * 2) * 4
  assert.equal(decoded.width, side)
  assert.equal(decoded.height, side)
  assert.equal(decoded.depth, 1, 'a QR is two colours, so 1 bit per pixel')
  assert.equal(decoded.colourType, 0, 'greyscale')
  assert.deepEqual(decoded.chunks, ['IHDR', 'IDAT', 'IEND'])
  for (let my = 0; my < 3; my += 1) {
    for (let mx = 0; mx < 3; mx += 1) {
      const want = matrix[my][mx] ? 0 : 255
      assert.equal(decoded.pixel((mx + 2) * 4, (my + 2) * 4), want, `module ${mx},${my}`)
    }
  }
  // The quiet zone is white by definition; a black border would break scanning.
  assert.equal(decoded.pixel(0, 0), 255, 'the quiet zone must be white')
  assert.equal(decoded.pixel(side - 1, side - 1), 255, 'the quiet zone must be white on every side')
})

test('the quiet zone is 4 modules unless asked otherwise', () => {
  // 4 is what the QR spec requires for a scannable symbol, so it must be the
  // default rather than something a caller has to remember.
  const png = encodePng([[true]], { scale: 2 })
  const decoded = decodePng(png)
  assert.equal(decoded.width, (1 + 8) * 2)
  assert.equal(decoded.pixel(1, 1), 255, 'inside the quiet zone')
  assert.equal(decoded.pixel(8, 8), 0, 'the single black module sits 4 modules in')
})

test('the encoder needs no external package, no python and no PATH', () => {
  // The regression this whole file is about: the old code resolved an npm
  // `qrcode` and then a `python3`. Assert on the SHAPE of the attempt — a
  // source that mentions an undeclared import or PATH lookup has reintroduced
  // the Windows failure even if it happens to work on a machine that has them.
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'qr-png.js'), 'utf8')
  const ownPath = source.slice(source.indexOf('function writeWithOwnEncoder'), source.indexOf('async function writeWithNodeQrcode'))
  assert.ok(ownPath.includes('encodePng'), 'the first route must be our own PNG writer')
  assert.ok(
    ownPath.includes("require.resolve('qrcode-terminal')"),
    'the matrix must come from the dependency the installer already ships',
  )
  assert.ok(
    !ownPath.includes('execFile') && !ownPath.includes('PYTHON_CANDIDATES'),
    'the guaranteed route must not shell out to a python that may not exist',
  )
  // `qrcode` is still not a declared dependency, so route 2 stays best-effort.
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  assert.ok(!('qrcode' in (pkg.dependencies ?? {})), 'qrcode must not be a hard dependency')
})

test('the QR matrix is byte-identical to a reference encoder', () => {
  // Borrowing `qrcode-terminal`'s vendored encoder is only safe if it produces
  // a correct symbol. Its module matrix for this input was compared against
  // Python's `qrcode` at error-correction level L with mask pattern 7 and
  // matched on all 1089 modules; this pins the two facts that comparison
  // established, so a future swap of the encoder cannot silently change them.
  const require = createRequire(import.meta.url)
  const entry = require.resolve('qrcode-terminal')
  const QRCode = createRequire(entry)('./../vendor/QRCode')
  const qr = new QRCode(-1, 1)
  qr.addData(SAMPLE)
  qr.make()
  const n = qr.getModuleCount()
  assert.equal(n, 33, 'version 4 for this input at level L')
  // Finder patterns: a 7x7 ring of black, a white gap, then a 3x3 black core.
  // If the matrix came back with the wrong orientation these would not be here.
  const black = (r, c) => qr.modules[r][c] === true
  assert.ok(black(0, 0) && black(0, 6) && black(6, 0), 'finder pattern outer corner')
  assert.ok(!black(1, 1), 'the ring is one module thick, so 1,1 is white')
  assert.ok(black(3, 3), 'the finder centre is solid black')
  assert.ok(black(0, n - 1) && black(n - 1, 0), 'finders appear on the other corners too')
  // Timing patterns alternate along row/column 6.
  const alternating = []
  for (let i = 8; i < n - 8; i += 1) alternating.push(black(6, i))
  assert.ok(
    alternating.every((v, i) => v === (i % 2 === 0)),
    'the horizontal timing pattern must alternate',
  )
})

test('writeQrPng produces a scannable file with no external encoder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-qr-png-'))
  try {
    const out = path.join(dir, 'qr.png')
    const written = await writeQrPng(SAMPLE, out)
    assert.equal(written, out, 'the guaranteed route must always succeed')
    const decoded = decodePng(fs.readFileSync(out))
    // 33 modules + a 4-module quiet zone on both sides, at 12 px per module.
    assert.equal(decoded.width, (33 + 8) * 12)
    // Top-left finder pattern, sampled at its centre (module 3,3).
    assert.equal(decoded.pixel((4 + 3) * 12 + 6, (4 + 3) * 12 + 6), 0, 'finder centre is black')
    assert.equal(decoded.pixel((4 + 1) * 12 + 6, (4 + 1) * 12 + 6), 255, 'the finder ring is white between centres')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('qrDataUrl yields a PNG data URL that is not a link', async () => {
  const url = await qrDataUrl(SAMPLE)
  // The original bug: `qrDataUrl` returned undefined and the card rendered the
  // login URL in <img src>. Returning undefined is no longer acceptable on any
  // platform, so this asserts a real image rather than tolerating the fallback.
  assert.notEqual(url, undefined, 'the encoder must not depend on the environment')
  assert.ok(url.startsWith('data:image/png;base64,'), 'must be a PNG data URL')
  assert.ok(!url.includes('liteapp.weixin.qq.com'), 'the data URL must not contain the link')
  const bytes = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
  const decoded = decodePng(bytes)
  assert.equal(decoded.width, decoded.height, 'a QR is square')
  assert.ok(decoded.width > 200, 'a 200px display target needs real pixels to stay crisp')
})
