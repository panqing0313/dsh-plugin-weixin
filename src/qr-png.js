/**
 * Render a login QR code to a PNG file, for environments where the terminal
 * cannot display one.
 *
 * `qrcode-terminal` draws the code as half-block characters on stdout, which is
 * useless when the command runs inside a GUI transcript, over a pipe, or in any
 * terminal that does not preserve the block glyphs. A PNG is scannable
 * everywhere, so `bin/login.js` writes one alongside the terminal render.
 *
 * The encoder is our own (`src/png.js` plus the matrix out of the
 * `qrcode-terminal` package that is already a dependency), because both
 * external routes are unavailable on a stock machine: `qrcode` is not a
 * dependency, and Windows has no `python3`/`python` on PATH. Those routes stay
 * as fallbacks for environments that do have them.
 * @module dsh-weixin/qr-png
 */
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodePng } from './png.js'

/**
 * @param {string} text  URL encoded in the QR code.
 * @param {string} outFile  Destination PNG path.
 * @returns {Promise<string | undefined>} the written path, or undefined when no
 *   encoder was available (the caller falls back to printing the URL).
 */
export async function writeQrPng(text, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })

  // 1. Our own encoder, fed by the QR matrix from `qrcode-terminal` — a real
  //    dependency, so this works on every platform with no external tool.
  if (writeWithOwnEncoder(text, outFile)) return outFile

  // 2. A real npm `qrcode` package, when one is resolvable in this environment.
  if (await writeWithNodeQrcode(text, outFile)) return outFile

  // 3. Python's `qrcode` (Pillow-backed), which is commonly present on macOS
  //    and is what the bundled DSH python runtime can install.
  if (await writeWithPythonQrcode(text, outFile)) return outFile

  return undefined
}

/**
 * Encode the QR with our own PNG writer, using the encoder vendored inside
 * `qrcode-terminal` for the module matrix.
 *
 * `qrcode-terminal` is a declared dependency and the installer already copies
 * it into the profile, so this path is the only one that is guaranteed to be
 * present. Its public API only prints half-block characters, but it ships a
 * complete `QRCode` implementation under `vendor/QRCode` whose `modules` array
 * is the matrix we need.
 *
 * Resolved through `createRequire` from the installed package entry, so the
 * vendored file is found relative to `qrcode-terminal` itself rather than to
 * this module (which lives in a different tree once deployed).
 *
 * @returns {boolean} whether a PNG was written.
 */
function writeWithOwnEncoder(text, outFile) {
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve('qrcode-terminal')
    const fromPackage = createRequire(entry)
    const QRCode = fromPackage('./../vendor/QRCode')
    const qrcode = new QRCode(-1, 1 /* error correction level L */)
    qrcode.addData(text)
    qrcode.make()
    const modules = qrcode.getModuleCount()
    const matrix = []
    for (let row = 0; row < modules; row += 1) {
      const cells = []
      for (let col = 0; col < modules; col += 1) cells.push(qrcode.modules[row][col] === true)
      matrix.push(cells)
    }
    // A quiet zone of 4 modules is part of the spec; without it scanners fail.
    fs.writeFileSync(outFile, encodePng(matrix, { scale: 12, border: 4 }))
    return fs.existsSync(outFile)
  } catch {
    return false
  }
}

async function writeWithNodeQrcode(text, outFile) {
  try {
    const mod = await import('qrcode')
    const toFile = mod.toFile ?? mod.default?.toFile
    if (typeof toFile !== 'function') return false
    await toFile(outFile, text, { width: 640, margin: 2 })
    return fs.existsSync(outFile)
  } catch {
    return false
  }
}

/**
 * Encoders are tried in order so a machine with a bundled python (DSH ships
 * one) still produces a scannable image without an npm install.
 */
function bundledPythonPath() {
  // DSH ships a python for its own runtime, so reaching for it beats requiring
  // an npm install. The layout differs per platform: bin/python on POSIX,
  // python.exe at the root on Windows. `HOME` is not set on Windows either.
  const home = os.homedir()
  if (!home) return ''
  const root = path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python')
  return process.platform === 'win32'
    ? path.join(root, 'python.exe')
    : path.join(root, 'bin', 'python')
}

const PYTHON_CANDIDATES = [
  process.env.DSH_PYTHON ?? '',
  'python3',
  'python',
  bundledPythonPath(),
].filter((p) => p !== '')

const PYTHON_SCRIPT = `
import sys
import qrcode
img = qrcode.make(sys.argv[1], box_size=12, border=3)
img.save(sys.argv[2])
`

async function writeWithPythonQrcode(text, outFile) {
  for (const python of PYTHON_CANDIDATES) {
    const ok = await new Promise((resolve) => {
      execFile(python, ['-c', PYTHON_SCRIPT, text, outFile], { timeout: 30_000 }, (error) => {
        resolve(error === null && fs.existsSync(outFile))
      })
    })
    if (ok) return true
  }
  return false
}

/**
 * Render a login QR code straight to a `data:image/png;base64,…` string, so the
 * settings UI can show a scannable image without any client-side QR encoder.
 * Falls back to `undefined` when no encoder is available (the UI then shows the
 * clickable link instead).
 * @param {string} text  URL encoded in the QR code.
 * @returns {Promise<string | undefined>} data URL, or undefined on failure.
 */
export async function qrDataUrl(text) {
  const tmp = path.join(os.tmpdir(), `dsh-weixin-qr-${process.pid}-${Date.now()}.png`)
  try {
    const out = await writeQrPng(text, tmp)
    if (!out) return undefined
    return `data:image/png;base64,${fs.readFileSync(out).toString('base64')}`
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
  }
}
