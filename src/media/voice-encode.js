/**
 * Outbound voice: turn an audio file into a Weixin `voice_item`.
 *
 * WeChat voice messages are SILK at 24 kHz (the same codec inbound voice uses;
 * see `vendor/openclaw-weixin/media/silk-transcode.js` for the decode
 * direction). The upload side of this plugin never spoke SILK, which is why a
 * bot could RECEIVE voice but not send it. This module is the missing half:
 *
 *  - `.wav` → parsed here (RIFF/PCM, downmix to mono, resample when the rate is
 *    not one SILK accepts), encoded with silk-wasm.
 *  - `.silk` → passed through untouched.
 *  - everything else (mp3/m4a/ogg/...) → decoded by ffmpeg into raw PCM on
 *    stdout, then encoded. ffmpeg is optional: when it is missing the caller
 *    falls back to sending the audio as a plain file attachment.
 *
 * The wire shape follows the `VoiceItem` type in the vendored Tencent layer
 * (`types.ts`: `media`, `encode_type`, `bits_per_sample`, `sample_rate`,
 * `playtime`, optional `text`) plus the SILK `encode_type` upstream's own send
 * path uses.
 * @module dsh-weixin/media/voice-encode
 */
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'

/** silk-wasm is CommonJS; resolve it through createRequire like the vendor layer does. */
async function silkWasm() {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('silk-wasm')
}

/** Sample rates SILK actually supports (the codec's own set: 8/12/16/24 kHz). silk-wasm *encodes* 32/44.1/48 kHz without complaint, but those streams are outside the codec's spec and WeChat's player expects the 24 kHz family — resample them instead of trusting the passthrough. */
const SILK_RATES = new Set([8_000, 12_000, 16_000, 24_000])

/** What an unplayable rate gets resampled to. 24 kHz is what WeChat records at. */
const FALLBACK_RATE = 24_000

/** VoiceItem.encode_type for SILK (upstream's send path uses 5). */
export const VOICE_ENCODE_TYPE_SILK = 5
/** VoiceItem.bits_per_sample — SILK decodes to 16-bit PCM. */
export const VOICE_BITS_PER_SAMPLE = 16

/** Extensions that can become voice. `.silk` needs no transcode at all. */
const VOICE_EXTENSIONS = new Set([
  'wav', 'silk', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aif', 'aiff',
])

/**
 * Would this file be sent as a voice message (before ffmpeg availability)?
 * Checked by extension only — content sniffing WAV headers happens in
 * {@link transcodeToSilk}, which still throws cleanly for a mislabeled file.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isVoiceCandidate(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return VOICE_EXTENSIONS.has(ext)
}

/**
 * Extract 16-bit mono PCM from a RIFF/WAVE buffer.
 *
 * Accepts PCM (format 1) and extensible PCM (0xfffe) at 16 bits; downmixes
 * every channel count by averaging. Anything else (float WAV, ADPCM, 8/24-bit)
 * is left to the ffmpeg branch by throwing.
 *
 * @param {Buffer} buffer
 * @returns {{ pcm: Uint8Array, sampleRate: number }}
 */
export function parseWavPcm(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bitsPerSample: buffer.readUInt16LE(offset + 22),
      }
    } else if (id === 'data') {
      data = buffer.subarray(offset + 8, Math.min(offset + 8 + size, buffer.length))
    }
    // Chunks are word-aligned; a malformed size cannot loop forever because
    // offset still advances.
    offset += 8 + size + (size % 2)
  }
  if (!fmt || !data || data.length === 0) throw new Error('WAV is missing fmt or data chunk')
  const pcm16 = fmt.format === 1 || fmt.format === 0xfffe ? fmt.bitsPerSample === 16 : false
  if (!pcm16) throw new Error(`unsupported WAV format ${fmt.format} @ ${fmt.bitsPerSample}-bit; needs ffmpeg`)
  if (fmt.sampleRate <= 0) throw new Error(`WAV declares sample rate ${fmt.sampleRate}`)
  const bytesPerFrame = 2 * fmt.channels
  const frames = Math.floor(data.length / bytesPerFrame)
  const mono = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE(i * bytesPerFrame + c * 2)
    mono.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / fmt.channels))), i * 2)
  }
  return { pcm: mono, sampleRate: fmt.sampleRate }
}

/** Linear-interpolation resample of mono 16-bit PCM (voice quality is enough). */
function resamplePcm(pcm, fromRate, toRate) {
  // Callers may hand back a plain Uint8Array (typed loosely for silk-wasm);
  // view it as a Buffer without copying so the typed reads below work.
  const view = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const inFrames = view.length / 2
  if (fromRate === toRate || inFrames === 0) return pcm
  const outFrames = Math.max(1, Math.round((inFrames * toRate) / fromRate))
  const out = Buffer.alloc(outFrames * 2)
  for (let i = 0; i < outFrames; i++) {
    const src = (i * fromRate) / toRate
    const i0 = Math.min(inFrames - 1, Math.floor(src))
    const i1 = Math.min(inFrames - 1, i0 + 1)
    const frac = src - i0
    const sample = Math.round(view.readInt16LE(i0 * 2) * (1 - frac) + view.readInt16LE(i1 * 2) * frac)
    out.writeInt16LE(sample, i * 2)
  }
  return out
}

/**
 * Decode any ffmpeg-readable audio into 24 kHz mono PCM on stdout.
 *
 * Resolves `{ pcm, sampleRate: 24000 }`; rejects when ffmpeg is missing or the
 * file cannot be decoded, which the caller treats as "send it as a file
 * instead" rather than a dropped attachment.
 *
 * @param {string} filePath
 * @param {string} [ffmpegPath]
 * @returns {Promise<{ pcm: Uint8Array, sampleRate: number }>}
 */
export function ffmpegToPcm(filePath, ffmpegPath = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ['-v', 'error', '-i', filePath, '-ac', '1', '-ar', String(FALLBACK_RATE), '-f', 's16le', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const chunks = []
    let stderr = ''
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-500) })
    child.on('error', (error) => reject(new Error(`ffmpeg unavailable: ${error.message}`)))
    child.on('close', (code) => {
      const pcm = Buffer.concat(chunks)
      if (code !== 0 || pcm.length === 0) {
        reject(new Error(`ffmpeg exited ${code} with ${pcm.length} PCM bytes${stderr ? `: ${stderr.trim()}` : ''}`))
        return
      }
      resolve({ pcm, sampleRate: FALLBACK_RATE })
    })
  })
}

/**
 * Turn an audio file into SILK bytes.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {string} [options.ffmpegPath]  ffmpeg binary for non-WAV inputs.
 * @returns {Promise<{ silk: Uint8Array, durationMs: number, sampleRate: number }>}
 * @throws when the file cannot be read, parsed or encoded — the caller decides
 *   the fallback (this module never degrades silently).
 */
export async function transcodeToSilk(filePath, { ffmpegPath } = {}) {
  const silk = await silkWasm()
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  let pcm
  let sampleRate
  if (ext === 'silk') {
    // Already the target codec: pass through, no ffmpeg, no re-encode.
    const raw = await fs.readFile(filePath)
    if (!silk.isSilk(raw)) throw new Error('.silk file does not carry a SILK stream')
    return { silk: raw, durationMs: silk.getDuration(raw), sampleRate: FALLBACK_RATE }
  }
  if (ext === 'wav') {
    const parsed = parseWavPcm(await fs.readFile(filePath))
    pcm = parsed.pcm
    sampleRate = SILK_RATES.has(parsed.sampleRate) ? parsed.sampleRate : FALLBACK_RATE
    if (sampleRate !== parsed.sampleRate) pcm = resamplePcm(parsed.pcm, parsed.sampleRate, sampleRate)
  } else {
    const decoded = await ffmpegToPcm(filePath, ffmpegPath)
    pcm = decoded.pcm
    sampleRate = decoded.sampleRate
  }
  if (pcm.length === 0) throw new Error('audio decoded to zero PCM bytes')
  const encoded = await silk.encode(pcm, sampleRate)
  return { silk: encoded.data, durationMs: encoded.duration, sampleRate }
}

/**
 * Build the wire `voice_item` for an uploaded SILK payload.
 *
 * Field set per the vendored `VoiceItem` type; `media.aes_key` uses the vendor
 * wire form (base64 of the ASCII hex key — the same form every image/file send
 * in this plugin already uses), `playtime` is whole seconds and never zero
 * because WeChat renders 0 s as an unplayable bubble.
 *
 * @param {object} params
 * @param {{ downloadEncryptedQueryParam: string, aeskey: string }} params.uploaded
 *   Vendor upload result (hex-string aeskey, as `uploadMediaToCdn` returns).
 * @param {number} params.durationMs
 * @param {number} params.sampleRate
 * @param {number} [params.itemType]  MessageItemType.VOICE (3) by default.
 * @returns {{ type: number, voice_item: object }}
 */
export function buildVoiceItem({ uploaded, durationMs, sampleRate, itemType = 3 }) {
  const playtime = Math.max(1, Math.round(durationMs / 1000))
  return {
    type: itemType,
    voice_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey, 'ascii').toString('base64'),
        encrypt_type: 1,
      },
      encode_type: VOICE_ENCODE_TYPE_SILK,
      bits_per_sample: VOICE_BITS_PER_SAMPLE,
      sample_rate: sampleRate,
      playtime,
    },
  }
}
