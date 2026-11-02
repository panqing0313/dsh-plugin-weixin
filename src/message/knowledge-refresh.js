/**
 * 知识库的夜间/启动时重建。
 *
 * 为什么不「查的时候顺手建」：`searchKnowledge` 跑在每条消息的热路径上，
 * 而建索引要读盘、抽取 PDF，一旦放进热路径，第一条消息就要为整个目录等一次。
 * 检索端只读 `index.json`（几毫秒），重建交给这里 —— 启动一次、之后每天一次，
 * 外加一个「有文件还没进索引」的廉价探测，让新放进去的文件不必等到明天。
 *
 * 与 recorder 的心跳分工相同：`start()` 立刻跑一次，然后每 `intervalMs` 跑一次；
 * `stop()` 清掉定时器。所有失败只 `warn`，绝不让知识库的问题影响聊天。
 *
 * @module dsh-weixin/message/knowledge-refresh
 */

import fs from 'node:fs'
import path from 'node:path'
import { buildKnowledgeIndex, knowledgeDir, knowledgeIndexPath, listKnowledgeSources } from './knowledge.js'

export const DEFAULT_KNOWLEDGE_INTERVAL_MS = 6 * 60 * 60_000
/** 距上次重建至少这么久才因为「有新文件」再建一次，避免每条消息都探一次盘。 */
export const STALE_CHECK_MIN_GAP_MS = 60_000

/**
 * 目录里有没有「比索引新」或「索引里还没有」的文件。
 *
 * 廉价：只 stat 目录和索引，不读文件内容。用来决定要不要真的重建。
 *
 * @param {string} stateRoot
 * @param {string} accountId
 * @returns {boolean}
 */
export function knowledgeLooksStale(stateRoot, accountId) {
  const sources = listKnowledgeSources(knowledgeDir(stateRoot, accountId))
  if (sources.length === 0) return false
  let indexMtime = 0
  try {
    indexMtime = fs.statSync(knowledgeIndexPath(stateRoot, accountId)).mtimeMs
  } catch {
    return true // no index yet
  }
  for (const file of sources) {
    try {
      if (fs.statSync(file).mtimeMs > indexMtime) return true
    } catch {
      // A file that vanished mid-check is not worth a rebuild by itself.
    }
  }
  return false
}

/**
 * 启动一个定时重建器。
 *
 * @param {{
 *   stateRoot: string,
 *   accountIds: () => string[],
 *   warn?: (line: string) => void,
 *   log?: (line: string) => void,
 *   intervalMs?: number,
 *   now?: () => number,
 * }} options
 */
export function startKnowledgeRefresh({
  stateRoot, accountIds, warn, log, intervalMs = DEFAULT_KNOWLEDGE_INTERVAL_MS, now = () => Date.now(),
}) {
  let timer
  let lastStaleCheck = 0
  let running = false

  const refresh = async ({ force = false } = {}) => {
    if (running) return
    running = true
    try {
      for (const accountId of accountIds()) {
        try {
          if (!force && !knowledgeLooksStale(stateRoot, accountId)) continue
          const result = await buildKnowledgeIndex(stateRoot, accountId, { warn })
          if (result.chunks > 0) {
            log?.(`knowledge index: ${result.files} file(s), ${result.chunks} chunk(s) for ${accountId}`)
          }
          for (const skipped of result.skipped) {
            warn?.(`knowledge file skipped: ${skipped.file} (${skipped.reason})`)
          }
        } catch (error) {
          warn?.(`knowledge refresh failed for ${accountId}: ${String(error?.message ?? error)}`)
        }
      }
    } finally {
      running = false
    }
  }

  // 启动时若有账号，先跑一次；用 microtask 让 apply() 尽快返回。
  void Promise.resolve().then(() => refresh())

  timer = setInterval(() => {
    lastStaleCheck = now()
    void refresh()
  }, intervalMs)
  timer.unref?.()

  /**
   * 每条消息前调用一次都行：距上次检查不足一分钟就跳过，否则仅当目录看起来
   * 变脏时才重建。
   */
  const nudge = () => {
    const at = now()
    if (at - lastStaleCheck < STALE_CHECK_MIN_GAP_MS) return
    lastStaleCheck = at
    void refresh()
  }

  return {
    refresh,
    nudge,
    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}

/** 供 `/diag` 用的路径说明。 */
export function knowledgeLocation(stateRoot, accountId) {
  return path.join(stateRoot, 'knowledge', accountId)
}
