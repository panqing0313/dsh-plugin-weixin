/**
 * `/diag`：把「现在到底在不在工作」压缩成一条能发进微信的短信。
 *
 * 用户遇到的多数「它怎么没反应」都不是崩溃，而是某个闸门关着：免打扰、
 * 白名单为空、主动开口的每日额度用完、连接还没就绪。这些状态分散在
 * 配置、状态文件和调度器里，`/status` 只讲会话，doctor 只在终端跑。
 * 这里把它们拼成一段话，**不调模型、不读大文件**，随时可以问。
 *
 * @module dsh-weixin/message/diag
 */

function onOff(value) {
  return value ? '开' : '关'
}

function clock(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

/**
 * @param {object} input
 * @param {string} [input.version]
 * @param {string} [input.hostVersion]
 * @param {boolean} [input.hostTested]
 * @param {string} input.accountId
 * @param {boolean} [input.transportUp]
 * @param {string} [input.modeName]
 * @param {boolean} [input.companion]
 * @param {Record<string, unknown>} [input.config]
 * @param {number} [input.reminders]
 * @param {number} [input.subscriptions]
 * @param {{ count?: number, lastAt?: number, misses?: number }} [input.proactive]
 * @param {number} [input.journalToday]
 * @param {number} [input.conversations]
 * @param {number} [input.allowlist]
 * @param {number} [input.quietDelayMs]
 * @returns {string}
 */
export function buildDiagReport(input) {
  const config = input.config ?? {}
  const lines = []

  const host = input.hostVersion === undefined
    ? ''
    : ` · 宿主 ${input.hostVersion}${input.hostTested === true ? '（已测）' : '（未测）'}`
  lines.push(`自检 · v${input.version ?? '?'}${host}`)

  lines.push(`账号：${input.accountId ?? '?'}${input.transportUp === false ? '（连接未就绪，收不到消息）' : ''}`)
  lines.push(`模式：${input.modeName ?? '?'}${input.companion === true ? '（陪聊）' : ''}`)

  lines.push(
    `开关：主动开口 ${onOff(config.proactiveEnabled !== false)} · 记忆 ${onOff(config.memoryEnabled !== false)}`
    + ` · 群聊 ${onOff(config.groupChatEnabled === true)} · 免打扰 ${onOff(config.quietHoursEnabled === true)}`
    + ` · 文档抽取 ${onOff(config.documentExtract !== false)}`,
  )

  lines.push(`待发：提醒 ${input.reminders ?? 0} 条 · 订阅 ${input.subscriptions ?? 0} 条`)

  const proactive = input.proactive
  if (proactive === undefined || (proactive.count ?? 0) === 0 && proactive.lastAt === undefined) {
    lines.push(`主动开口：今天还没有发过（额度 ${config.proactiveMaxPerDay ?? 3} 条/天）`)
  } else {
    const cap = config.proactiveMaxPerDay ?? 3
    const last = proactive.lastAt === undefined ? '无' : clock(proactive.lastAt)
    lines.push(`主动开口：今天 ${proactive.count ?? 0}/${cap} 条 · 上次 ${last} · 连发未回 ${proactive.misses ?? 0} 次`)
  }

  lines.push(
    `数据：今天流水 ${input.journalToday ?? 0} 条 · 会话记忆 ${input.conversations ?? 0} 个`
    + ` · 白名单 ${input.allowlist ?? 0} 人`,
  )

  if ((input.quietDelayMs ?? 0) > 0) {
    lines.push(`免打扰：静默中（约 ${Math.ceil(input.quietDelayMs / 60_000)} 分钟后恢复）`)
  } else {
    lines.push('免打扰：当前不在静默时段')
  }

  return lines.join('\n')
}
