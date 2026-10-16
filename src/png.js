/**
 * Encode a PNG by hand, so the QR image needs no encoder, no python and no
 * native module on any platform.
 *
 * The previous implementation reached for an npm `qrcode`, then for a python
 * that might have `qrcode` installed. Neither is guaranteed: `qrcode` was never
 * a dependency, and Windows ships no `python3`/`python` on PATH at all, so the
 * settings card there showed a broken image while the login link below it still
 * worked. Writing the few hundred bytes of PNG ourselves removes the whole
 * class of failure — it only needs `node:zlib`, which is part of the runtime.
 *
 * The encoder is deliberately minimal, because its only caller is the login QR:
 *
 *   - 1-bit greyscale (colour type 0, bit depth 1), where 0 is black. A QR code
 *     is two colours, so a truecolour image would be four times the bytes for
 *     an identical result.
 *   - Every scanline is filtered with "None" (filter type 0). PNG filters exist
 *     to help DEFLATE; a QR is high-entropy noise where a filter predicts
 *     nothing, so the simplest filter also gives the smallest output.
 *   - `zlib.deflateSync` for the single IDAT, with `zlib.crc32` for the chunk
 *     CRCs (Node >= 20.15, and this package requires >= 22.13).
 * @module dsh-weixin/qr-png
 */

import zlib from 'node:zlib'

/** @type {Buffer} */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * One PNG chunk: length, type, payload, CRC over type+payload.
 * @param {string} type  4 ASCII characters.
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function chunk(type, payload) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const typeAndPayload = Buffer.concat([Buffer.from(type, 'latin1'), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(typeAndPayload), 0)
  return Buffer.concat([length, typeAndPayload, crc])
}

/**
 * Build a 1-bit greyscale PNG from a square matrix of booleans.
 *
 * @param {boolean[][]} matrix  `matrix[row][col]`, true meaning a black module.
 * @param {object} [options]
 * @param {number} [options.scale]  Pixels per module (the QR's module size).
 * @param {number} [options.border] Quiet zone, in modules. The QR spec requires
 *   4; scanners rely on it, so it is not cosmetic.
 * @returns {Buffer} a complete PNG file.
 */
export function encodePng(matrix, options = {}) {
  const scale = options.scale ?? 12
  const border = options.border ?? 4
  const modules = matrix.length
  if (modules === 0) throw new Error('cannot encode an empty QR matrix')

  const side = (modules + border * 2) * scale
  // One bit per pixel, rows padded to whole bytes.
  const stride = Math.ceil(side / 8)
  const raw = Buffer.alloc((stride + 1) * side) // +1 filter byte per scanline

  for (let y = 0; y < side; y += 1) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0 // filter type "None"
    const moduleY = Math.floor(y / scale) - border
    for (let x = 0; x < side; x += 1) {
      const moduleX = Math.floor(x / scale) - border
      const black =
        moduleY >= 0 && moduleY < modules && moduleX >= 0 && moduleX < modules
          ? matrix[moduleY][moduleX] === true
          : false // the quiet zone is white
      if (black) {
        // A set bit is white in greyscale, so a black module is a CLEARED bit
        // — and the buffer is already zero. Nothing to do.
      } else {
        raw[rowStart + 1 + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(side, 0)
  ihdr.writeUInt32BE(side, 4)
  ihdr.writeUInt8(1, 8) // bit depth
  ihdr.writeUInt8(0, 9) // colour type 0: greyscale
  ihdr.writeUInt8(0, 10) // compression: deflate
  ihdr.writeUInt8(0, 11) // filter method: adaptive
  ihdr.writeUInt8(0, 12) // interlace: none

  return Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
