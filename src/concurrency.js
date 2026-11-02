/**
 * 有界并发地跑一组异步任务，结果顺序与输入一致。
 *
 * 为什么要它：一条消息可以带好几个附件（三张图、图片+文件、语音+文档），
 * 每个附件都要下载、解密、抽取文字，全是网络或子进程等待。串行做的话
 * 总耗时是 N × t，而这些东西彼此没有依赖 —— 但也不能无脑 `Promise.all`：
 * OCR 桥每次都要起一个进程，十个附件同时起十个进程会把机器拖垮。
 *
 * 所以这里给一个上限，并且**出错时停止取新任务**：已经跑着的任务会跑完
 * （没法取消），但不会因为第一个失败还继续把剩下九个都发出去。
 *
 * @module dsh-weixin/concurrency
 */

/**
 * @template T, R
 * @param {Iterable<T> | ArrayLike<T>} items
 * @param {number} limit 同时最多跑几个；小于 1 按 1 处理
 * @param {(item: T, index: number) => Promise<R>} run
 * @returns {Promise<R[]>} 与 `items` 同序
 */
export async function mapWithConcurrency(items, limit, run) {
  const list = Array.from(items)
  if (list.length === 0) return []
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, list.length))

  const results = new Array(list.length)
  let next = 0
  /** @type {unknown} */
  let firstError
  let failed = false

  const worker = async () => {
    while (true) {
      if (failed) return
      const index = next
      next += 1
      if (index >= list.length) return
      try {
        results[index] = await run(list[index], index)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
        return
      }
    }
  }

  await Promise.all(Array.from({ length: width }, worker))
  if (failed) throw firstError
  return results
}

/**
 * 同步版本的「最多几个在飞」，用于不需要 promise 的场景（例如统计）。
 *
 * @param {number} limit
 */
export function concurrencyWidth(limit) {
  const width = Math.floor(Number(limit))
  return Number.isFinite(width) && width > 0 ? width : 1
}
