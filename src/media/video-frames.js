// Inbound video: the one attachment the agent could not actually read.
//
// A video arrives as video.mp4 and the note used to say "请用 read 工具处理（无法
// 直接读取视频帧时请说明）" — which is an honest way of saying the model gets
// nothing. The model can read images, though, and ffmpeg is already a dependency
// of the voice path, so the useful move is to hand it stills: a handful of
// frames sampled across the clip, each a PNG it can open with read_image.
//
// Everything here is best-effort. A missing ffmpeg, a codec it cannot decode or
// a zero-length clip costs one log line and the file is still delivered — an
// unreadable video is the status quo, not a regression.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** How many stills to take from one clip. */
export const DEFAULT_FRAME_COUNT = 3

/** Longest clip worth sampling; past this the first frames are enough. */
export const MAX_SAMPLE_SECONDS = 600

/**
 * Where to sample from a clip of a known length.
 *
 * The first frame of a clip is very often black or a title card, so sampling
 * starts slightly in and spreads the rest evenly to the end.
 *
 * @param {number} durationSeconds
 * @param {number} [count]
 * @returns {number[]}  Sorted, unique, inside the clip.
 */
export function planSampleTimes(durationSeconds, count = DEFAULT_FRAME_COUNT) {
  const length = Number(durationSeconds)
  if (!Number.isFinite(length) || length <= 0) return []
  const wanted = Math.max(1, Math.min(10, Math.floor(Number(count) || DEFAULT_FRAME_COUNT)))
  const span = Math.min(length, MAX_SAMPLE_SECONDS)
  const times = []
  for (let index = 0; index < wanted; index += 1) {
    // spread across 10%..90% of the sampled span
    const fraction = wanted === 1 ? 0.5 : 0.1 + (0.8 * index) / (wanted - 1)
    const at = Math.max(0, Math.min(span - 0.05, span * fraction))
    const rounded = Math.round(at * 100) / 100
    if (!times.includes(rounded)) times.push(rounded)
  }
  return times.sort((a, b) => a - b)
}

/**
 * Read a clip's duration out of ffmpeg's own banner.
 *
 * ffprobe is a separate binary that is not always installed next to ffmpeg;
 * ffmpeg always prints `Duration: 00:00:12.34` when it opens a file, so one
 * call answers both "is this readable" and "how long is it".
 *
 * @param {string} filePath
 * @param {{ ffmpegPath?: string }} [options]
 * @returns {{ durationSeconds: number } | { error: string }}
 */
export function probeDurationSeconds(filePath, options = {}) {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg'
  let stderr = ''
  try {
    // No output file: ffmpeg opens the input, prints the banner, exits 1.
    execFileSync(ffmpegPath, ['-hide_banner', '-i', filePath], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000 })
  } catch (error) {
    stderr = String(error?.stderr ?? '')
    if (stderr === '' && error?.code === 'ENOENT') return { error: 'ffmpeg unavailable' }
  }
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{2})/.exec(stderr)
  if (match === null) return { error: 'could not read the clip duration' }
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`)
  if (!Number.isFinite(seconds) || seconds <= 0) return { error: 'the clip has no readable duration' }
  return { durationSeconds: seconds }
}

/**
 * Pull stills out of a video file.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {string} [options.dir]  Where to write the PNGs (defaults to the video's own directory).
 * @param {string} [options.stem]  File stem for the PNGs.
 * @param {number} [options.count]
 * @param {string} [options.ffmpegPath]
 * @param {(line: string) => void} [options.warn]
 * @returns {{ frames: { path: string, atSeconds: number }[], durationSeconds?: number, error?: string }}
 */
export function extractVideoFrames(filePath, options = {}) {
  const warn = options.warn ?? (() => {})
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg'
  const probe = probeDurationSeconds(filePath, { ffmpegPath })
  if ('error' in probe) return { frames: [], error: probe.error }
  const times = planSampleTimes(probe.durationSeconds, options.count)
  const dir = options.dir ?? path.dirname(filePath)
  const stem = options.stem ?? path.basename(filePath, path.extname(filePath))
  const frames = []
  for (let index = 0; index < times.length; index += 1) {
    const at = times[index]
    const target = path.join(dir, `${stem}-frame-${index + 1}.png`)
    try {
      execFileSync(
        ffmpegPath,
        ['-v', 'error', '-y', '-ss', String(at), '-i', filePath, '-frames:v', '1', '-vf', 'scale=1280:-2', target],
        { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000 },
      )
      if (fs.existsSync(target) && fs.statSync(target).size > 0) frames.push({ path: target, atSeconds: at })
    } catch (error) {
      // One unreadable timestamp is not the whole clip's problem.
      warn(`could not sample a frame at ${at}s: ${String(error?.message ?? error)}`)
    }
  }
  if (frames.length === 0) return { frames, durationSeconds: probe.durationSeconds, error: 'no frame could be decoded' }
  return { frames, durationSeconds: probe.durationSeconds }
}
