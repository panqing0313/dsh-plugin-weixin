/**
 * OCR 桥：把图片里的字读出来，让模型能回答「截图里写了什么」。
 *
 * 不做内置识别。识别引擎（tesseract、PaddleOCR、云 OCR 的 CLI）各有各的安装
 * 方式与模型体积，插件替用户选一个既装不下也猜不准。这里只规定一个最小的
 * 约定：**一个可执行文件，参数是图片路径，stdout 是文字**。用户写一个三行
 * 的 wrapper 就能接上任何引擎；没有配置就完全不走这条路径，图片仍按原来的
 * 方式（保存 + 路径）交给模型。
 *
 * 一次调用一个进程：OCR 是低频操作（一条消息最多一张图），常驻进程带来的
 * 生命周期问题不值得。
 *
 * @module dsh-weixin/media/ocr
 */

import { spawn } from 'node:child_process'

export const DEFAULT_OCR_TIMEOUT_MS = 20_000
export const DEFAULT_OCR_CHARS = 2_000

/**
 * 从配置里解析 OCR 设置；没开或没填命令时返回 undefined。
 *
 * @param {Record<string, unknown>} config
 * @returns {{ command: string, timeoutMs: number, maxChars: number } | undefined}
 */
export function resolveOcrSettings(config) {
  if (config?.ocrEnabled !== true) return undefined
  const command = typeof config?.ocrCommand === 'string' ? config.ocrCommand.trim() : ''
  if (command === '') return undefined
  const timeoutMs =
    Number.isFinite(config?.ocrTimeoutMs) && config.ocrTimeoutMs > 0
      ? Math.floor(config.ocrTimeoutMs)
      : DEFAULT_OCR_TIMEOUT_MS
  const maxChars =
    Number.isFinite(config?.ocrMaxChars) && config.ocrMaxChars > 0
      ? Math.floor(config.ocrMaxChars)
      : DEFAULT_OCR_CHARS
  return { command, timeoutMs, maxChars }
}

/**
 * 跑一次识别。**永远不抛**：图片识别失败只该降级成「没有文字」，不该让整个
 * 回合失败。
 *
 * @param {string} filePath
 * @param {{ command: string, timeoutMs?: number, maxChars?: number }} settings
 * @param {{ spawnImpl?: typeof spawn }} [hooks]
 * @returns {Promise<{ ok: true, text: string, truncated: boolean } | { ok: false, reason: string, code: string }>}
 */
export function extractImageText(filePath, settings, { spawnImpl = spawn } = {}) {
  const timeoutMs = settings.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS
  const maxChars = settings.maxChars ?? DEFAULT_OCR_CHARS
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    let child
    try {
      child = spawnImpl(settings.command, [filePath], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, reason: String(error?.message ?? error), code: 'spawn-failed' })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      finish({ ok: false, reason: `OCR timed out after ${timeoutMs}ms`, code: 'timeout' })
    }, timeoutMs)
    timer.unref?.()

    const out = []
    const err = []
    child.stdout?.on('data', (chunk) => out.push(chunk))
    child.stderr?.on('data', (chunk) => err.push(chunk))
    child.on('error', (error) => finish({ ok: false, reason: String(error?.message ?? error), code: 'spawn-failed' }))
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const reason = Buffer.concat(err).toString('utf8').trim()
        finish({ ok: false, reason: reason === '' ? `OCR exited with ${code ?? signal}` : reason, code: 'exit' })
        return
      }
      const text = Buffer.concat(out).toString('utf8').replace(/\r\n/g, '\n').trim()
      if (text === '') {
        finish({ ok: false, reason: 'OCR produced no text', code: 'empty' })
        return
      }
      finish({ ok: true, text: text.length > maxChars ? text.slice(0, maxChars) : text, truncated: text.length > maxChars })
    })
  })
}
