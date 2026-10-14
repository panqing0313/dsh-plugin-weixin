/**
 * Render a login QR code to a PNG file, for environments where the terminal
 * cannot display one.
 *
 * `qrcode-terminal` draws the code as half-block characters on stdout, which is
 * useless when the command runs inside a GUI transcript, over a pipe, or in any
 * terminal that does not preserve the block glyphs. A PNG is scannable
 * everywhere, so `bin/login.js` writes one alongside the terminal render.
 *
 * There is no dependency-free QR encoder here on purpose: this is a one-shot
 * interactive command, so any available encoder is used and a failure is
 * reported as a non-fatal note (the printed URL remains a usable fallback).
 * @module dsh-weixin/qr-png
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * @param {string} text  URL encoded in the QR code.
 * @param {string} outFile  Destination PNG path.
 * @returns {Promise<string | undefined>} the written path, or undefined when no
 *   encoder was available (the caller falls back to printing the URL).
 */
export async function writeQrPng(text, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })

  // 1. A real npm `qrcode` package, when one is resolvable in this environment.
  if (await writeWithNodeQrcode(text, outFile)) return outFile

  // 2. Python's `qrcode` (Pillow-backed), which is commonly present on macOS
  //    and is what the bundled DSH python runtime can install.
  if (await writeWithPythonQrcode(text, outFile)) return outFile

  return undefined
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
const PYTHON_CANDIDATES = [
  process.env.DSH_PYTHON ?? '',
  'python3',
  'python',
  `${process.env.HOME ?? ''}/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python`,
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
