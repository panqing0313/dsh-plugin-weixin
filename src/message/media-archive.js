/**
 * 媒体归档：微信发来的图片、文件、语音、视频存在一个目录里，时间一长就只剩
 * 一堆 UUID 名字。这个模块把它们按时间倒序列出来，让人能认出「上周那张截图」，
 * 并且能把其中一件重新发回当前会话。
 *
 * 只做两件事，别的都不碰：
 *   1. `listInboundMedia(dir, {limit, now})` 读目录（不递归），按 mtime 倒序，
 *      带扩展名、大小、人话时间与 kind；
 *   2. `createMediaCommands({ dir, conversationId, ... })` 提供 `/media`、
 *      `/media resend <序号>`。
 *
 * 重发走的是**同一条出站管线**（`mediaDirs` 白名单 + `sendMedia`），不是
 * 「把 inbox 目录加进白名单」—— 归档可以看，但不能因此变成任意文件发送的
 * 后门。所以路径必须落在调用方给的 `dir` 内（realpath 后判断），
 * 且必须是普通文件。
 *
 * @module dsh-weixin/message/media-archive
 */

import fs from 'node:fs'
import path from 'node:path'

/** 默认列最近多少件。 */
export const DEFAULT_MEDIA_LIMIT = 8
/** 一次最多列多少（防止刷屏）。 */
export const MAX_MEDIA_LIMIT = 20

const KIND_BY_EXT = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video',
  silk: 'voice', wav: 'voice', mp3: 'voice', m4a: 'voice', ogg: 'voice',
  pdf: 'document', doc: 'document', docx: 'document', xls: 'document', xlsx: 'document',
  ppt: 'document', pptx: 'document', csv: 'document', txt: 'document', md: 'document',
  json: 'document', log: 'document', zip: 'document', gz: 'document', tar: 'document',
}

/** Human kind for a file name; 'file' when the extension says nothing. */
export function mediaKind(name) {
  const ext = path.extname(String(name ?? '')).replace(/^\./, '').toLowerCase()
  return KIND_BY_EXT[ext] ?? 'file'
}

/** 人话时间：今天 14:03 / 昨天 / 10-28 09:12。 */
export function humanTime(at, { now = Date.now() } = {}) {
  if (!Number.isFinite(at)) return '—'
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const today = new Date(now)
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(date, today)) return `今天 ${clock}`
  const yesterday = new Date(today.getTime() - 24 * 60 * 60_000)
  if (sameDay(date, yesterday)) return `昨天 ${clock}`
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`
}

/** Bytes in a phone-screen friendly form. */
export function humanBytes(bytes) {
  const value = Number(bytes ?? 0)
  if (!Number.isFinite(value) || value < 0) return '0 B'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 最近的入站媒体，按 mtime 倒序。
 *
 * @param {string} dir
 * @param {{ limit?: number, now?: number, warn?: (line: string) => void }} [options]
 * @returns {Array<{ name: string, path: string, bytes: number, at: number, kind: string }>}
 */
export function listInboundMedia(dir, { limit = DEFAULT_MEDIA_LIMIT, warn } = {}) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    if (error?.code !== 'ENOENT') warn?.(`could not read the media archive: ${String(error?.message ?? error)}`)
    return []
  }
  const items = []
  for (const name of names) {
    const target = path.join(dir, name)
    let stat
    try {
      stat = fs.statSync(target)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    items.push({ name, path: target, bytes: stat.size, at: stat.mtimeMs, kind: mediaKind(name) })
  }
  // Newest first. The name is a tie-breaker, not decoration: files written in
  // the same tick share an mtime (CI runners and a burst of downloads both do
  // this), and without it the order depends on readdir, which differs by
  // platform. A listing whose numbering changes between machines cannot be
  // addressed by `/media resend <n>`.
  items.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))
  const cap = Math.max(1, Math.min(Number(limit) || DEFAULT_MEDIA_LIMIT, MAX_MEDIA_LIMIT))
  return items.slice(0, cap)
}

/** @param {ReturnType<typeof listInboundMedia>} items */
export function formatMediaList(items, { now = Date.now() } = {}) {
  if (items.length === 0) return '媒体归档里还没有东西（收到图片/文件/语音才会存进去）。'
  const lines = items.map((item, index) =>
    `${index + 1}. ${humanTime(item.at, { now })} · ${item.kind} · ${humanBytes(item.bytes)} · ${item.name}`)
  return `最近的媒体（${items.length} 件）：\n${lines.join('\n')}\n\n/media resend <序号> 重新发回这个会话。`
}

/** 序号从 1 开始；resolve symlink 后必须仍在 `dir` 里。 */
export function resolveArchivePath(dir, index, items) {
  const position = Number(String(index ?? '').trim())
  if (!Number.isInteger(position) || position < 1 || position > items.length) return undefined
  const target = items[position - 1].path
  let real
  let realDir
  try {
    real = fs.realpathSync(target)
    realDir = fs.realpathSync(dir)
    if (!fs.statSync(real).isFile()) return undefined
  } catch {
    return undefined
  }
  if (real !== realDir && !real.startsWith(realDir + path.sep)) return undefined
  return real
}

/**
 * @param {{
 *   dir: string,
 *   conversationId: string,
 *   contextToken?: string,
 *   sendMedia: (params: { filePath: string, conversationId: string, contextToken?: string }) => Promise<unknown>,
 *   limit?: number,
 *   warn?: (line: string) => void,
 *   now?: () => number,
 * }} options
 * @returns {{ media: (arg?: string) => Promise<string> }}
 */
export function createMediaCommands({ dir, conversationId, contextToken, sendMedia, limit = DEFAULT_MEDIA_LIMIT, warn, now = () => Date.now() }) {
  return {
    async media(arg = '') {
      const raw = String(arg ?? '').trim()
      if (raw === '') return formatMediaList(listInboundMedia(dir, { limit, warn }), { now: now() })

      const match = /^(?:resend|重发|再发)\s+(\S+)$/i.exec(raw)
      if (match === null) return '用法：/media 看最近收到的媒体；/media resend 3 把第 3 件重新发回来。'

      const items = listInboundMedia(dir, { limit: MAX_MEDIA_LIMIT, warn })
      const filePath = resolveArchivePath(dir, match[1], items)
      if (filePath === undefined) return `没有第 ${match[1]} 件（发 /media 看一遍序号）。`
      try {
        await sendMedia({ filePath, conversationId, ...(contextToken === undefined ? {} : { contextToken }) })
        return `已重发：${path.basename(filePath)}`
      } catch (error) {
        return `重发失败：${String(error?.message ?? error)}（文件还在 ${filePath}）`
      }
    },
  }
}