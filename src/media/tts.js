/**
 * 本地语音合成：把一句话变成可以发出去的音频文件。
 *
 * 只用**本机自带的**语音合成 —— macOS 的 `say`，再把它吐出的 AIFF 转成 WAV
 * （`afconvert`，同样是系统自带），因为 WAV 进得去插件自己的 SILK 编码器，
 * 不需要 ffmpeg、不联网、不花钱。
 *
 * 两条要说清楚的事：
 *
 * 1. **不是「她本人的声音」**。这是系统音色（婷婷、Samantha 之类），想克隆某个
 *    人的声音得接外部 TTS 服务，那要 API key 和费用，本项目默认不走那条路。
 * 2. **语音气泡这条路，服务端目前会吞**。插件的 `voiceOutbound` 早就实现了
 *    SILK `voice_item` 发送，但实测两次（2026-06、2026-10-26）iLink 服务端
 *    收下（ret=0）却不投递机器人的语音。所以 `/say` 默认把音频**当文件发**
 *    （文件一定送得到），只有用户自己打开 `voiceOutbound` 才会试语音气泡。
 *
 * 合成是注入式的（`run`），这样测试可以假装 `say` 成功了，而不用真发声。
 *
 * @module dsh-weixin/media/tts
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 太长的话先说这么多：语音条不是播客。 */
export const TTS_MAX_CHARS = 120
/** 语音条目标采样率；WeChat 自己录的就是 24k。 */
export const TTS_WAV_RATE = 24_000
const DEFAULT_TIMEOUT_MS = 20_000

/** 这台机器能不能本地合成语音（只有 macOS 有 `say`）。 */
export function ttsPlatformSupported({ platform = process.platform } = {}) {
  return platform === 'darwin'
}

/**
 * 把一段文本洗成适合朗读的样子：去掉表情标记、Markdown 装饰、URL 与多余空白。
 *
 * @param {string} text
 * @param {{ max?: number }} [options]
 * @returns {{ text: string, chars: number, truncated: boolean }}
 */
export function cleanSpeechText(text, { max = TTS_MAX_CHARS } = {}) {
  const stripped = String(text ?? '')
    .replace(/\[表情[:：][^\]]*\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const limit = Number.isFinite(max) && max > 0 ? max : TTS_MAX_CHARS
  if (stripped.length <= limit) return { text: stripped, chars: stripped.length, truncated: false }
  return { text: `${stripped.slice(0, limit)}…`, chars: limit, truncated: true }
}

/** 跑一个命令，非零退出或超时都算失败（错误里带一点 stderr 方便排查）。 */
function runCommand(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${command} exited ${code}${stderr.trim() === '' ? '' : `: ${stderr.trim().slice(0, 200)}`}`))
    })
  })
}

function tempPath(prefix, extension, now) {
  return path.join(os.tmpdir(), `${prefix}-${now}-${Math.random().toString(36).slice(2, 8)}.${extension}`)
}

/**
 * `say` 一段话，得到 AIFF。
 *
 * @param {string} text
 * @param {{ voice?: string, run?: Function, now?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, file?: string, reason?: string }>}
 */
export async function synthesizeAiff(text, { voice = '', run = runCommand, now = Date.now(), timeoutMs } = {}) {
  const speech = cleanSpeechText(text)
  if (speech.text === '') return { ok: false, reason: '没有可读的文字' }
  const file = tempPath('weixin-tts', 'aiff', now)
  const args = []
  if (String(voice ?? '').trim() !== '') args.push('-v', String(voice).trim())
  args.push('-o', file, speech.text.replace(/…$/, ''))
  try {
    await run('say', args, { timeoutMs })
  } catch (error) {
    return { ok: false, reason: `本机语音合成失败：${String(error?.message ?? error)}` }
  }
  if (!fs.existsSync(file)) return { ok: false, reason: '本机语音合成没有产出音频文件' }
  return { ok: true, file }
}

/**
 * AIFF → 24 kHz 单声道 16 位 WAV（`afconvert`，系统自带；WAV 才能进 SILK 编码器）。
 *
 * @returns {Promise<{ ok: boolean, file?: string, reason?: string }>}
 */
export async function aiffToWav(aiffPath, { run = runCommand, rate = TTS_WAV_RATE, now = Date.now(), timeoutMs } = {}) {
  const file = tempPath('weixin-tts', 'wav', now)
  try {
    await run('afconvert', ['-f', 'WAVE', '-d', `LEI16@${rate}`, aiffPath, file], { timeoutMs })
  } catch (error) {
    return { ok: false, reason: `音频转 WAV 失败：${String(error?.message ?? error)}` }
  }
  if (!fs.existsSync(file)) return { ok: false, reason: '音频转 WAV 没有产出文件' }
  return { ok: true, file }
}

/**
 * 一句话 → 一个能发给微信的语音文件。中间产物（AIFF）无论成败都删掉。
 *
 * @param {string} text
 * @param {{ voice?: string, run?: Function, rate?: number, now?: number, timeoutMs?: number, keep?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, file?: string, chars?: number, truncated?: boolean, reason?: string }>}
 */
export async function synthesizeVoiceFile(text, { voice = '', run = runCommand, rate = TTS_WAV_RATE, now = Date.now(), timeoutMs, keep = false } = {}) {
  const speech = cleanSpeechText(text)
  if (speech.text === '') return { ok: false, reason: '没有可读的文字' }
  const aiff = await synthesizeAiff(text, { voice, run, now, timeoutMs })
  if (aiff.ok !== true) return aiff
  try {
    const wav = await aiffToWav(aiff.file, { run, rate, now: now + 1, timeoutMs })
    if (wav.ok !== true) return wav
    return { ok: true, file: wav.file, chars: speech.chars, truncated: speech.truncated }
  } finally {
    if (!keep) {
      try {
        fs.rmSync(aiff.file, { force: true })
      } catch {
        // 临时文件删不掉不是错误。
      }
    }
  }
}