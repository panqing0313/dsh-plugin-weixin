/**
 * `/send <路径>` —— 把本机上的一个文件发到当前会话。
 *
 * 出站附件本来只由「模型回复里引用了文件」触发，用户没有直接要文件的入口：
 * 想让机器人把刚生成的那张图发过来，只能指望模型主动写一个路径。这个命令
 * 补上入口，但**不放松边界**：仍然走 `resolveAllowedPath`，只允许
 * 工作目录、状态目录与显式 mediaDirs 里的真实文件，并且受 `maxMediaBytes`
 * 限制。路径检查与自动附件完全同一套，不存在「命令绕过守卫」的缝。
 *
 * @module dsh-weixin/message/send-file
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_MAX_MEDIA_BYTES, resolveAllowedPath } from '../media/outbound.js'

function megabytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')
}

/**
 * @param {{ conversationId?: string, mediaDirs: string[], maxBytes?: number,
 *   contextToken?: string, warn?: (line: string) => void,
 *   sendMedia: (params: { filePath: string, conversationId?: string, contextToken?: string }) => Promise<void> }} options
 * @returns {{ send: (arg?: string) => Promise<string> }}
 */
export function createSendCommands({ conversationId, mediaDirs, maxBytes = DEFAULT_MAX_MEDIA_BYTES, contextToken, warn, sendMedia } = {}) {
  return {
    async send(arg = '') {
      const raw = String(arg ?? '').trim()
      if (raw === '') {
        return '用法：/send <文件路径>。只允许工作目录、状态目录与设置里 mediaDirs 的文件。'
      }
      const resolved = await resolveAllowedPath(raw, mediaDirs)
      if (!resolved.ok) return `发不了：${resolved.reason}`
      const stat = await fs.stat(resolved.path).catch(() => undefined)
      if (stat === undefined || !stat.isFile()) return '找不到这个文件（或它不是普通文件）。'
      if (stat.size > maxBytes) {
        return `文件太大（${megabytes(stat.size)} MB），上限 ${megabytes(maxBytes)} MB。`
      }
      try {
        await sendMedia({ filePath: resolved.path, conversationId, contextToken })
      } catch (error) {
        warn?.(`send command failed for ${resolved.path}: ${String(error)}`)
        return '发送失败，稍后再试；文件没有被删除。'
      }
      return `已发送：${path.basename(resolved.path)}（${megabytes(stat.size)} MB）`
    },
  }
}
