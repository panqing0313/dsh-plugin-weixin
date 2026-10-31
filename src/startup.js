/**
 * 启动期的扇出：把「每个账号各起一条长轮询」从串行改成并行。
 *
 * 之前是一个 `for … await`：N 个账号就要等 N 次握手，第二个账号的连接要等
 * 第一个账号的登录/拉取全部就绪才开始。它们本来就是互不依赖的长轮询，串行
 * 只是历史写法。
 *
 * 并行不能牺牲隔离：一个坏凭据（文件损坏、CDN 不可达、ticket 被拒）只应该
 * 让**它自己**起不来，其余账号照常。所以这里用 `Promise.allSettled`，把失败
 * 收集成列表交给调用方去 warn，而不是让第一个 rejection 中断整批。
 *
 * @module dsh-weixin/startup
 */

/**
 * @template {{ accountId: string }} T
 * @param {T[]} accounts
 * @param {(account: T) => Promise<unknown>} bringUp
 * @param {(line: string) => void} [warn]
 * @returns {Promise<{ started: number, failures: Array<{ accountId: string, reason: string }> }>}
 */
export async function startAccounts(accounts, bringUp, warn = () => {}) {
  const list = Array.isArray(accounts) ? accounts : []
  const results = await Promise.allSettled(
    list.map((account) => Promise.resolve().then(() => bringUp(account))),
  )
  const failures = []
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const accountId = list[index]?.accountId ?? '(unknown)'
      const reason = String(result.reason?.message ?? result.reason)
      failures.push({ accountId, reason })
      warn(`could not start the loop for ${accountId}: ${reason}`)
    }
  })
  return { started: list.length - failures.length, failures }
}