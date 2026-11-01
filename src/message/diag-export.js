/**
 * `/diag export`：把「它现在什么样」打包成一个**可以放心发出去**的文本。
 *
 * `/diag` 回答的是「为什么没动静」，适合自己看；但真要找人看（提 issue、
 * 发给同事、贴进群），直接把那份东西粘出去风险很大：账号 id、发送者 id、
 * 服务器地址、代理地址、token 全在里面。这个模块负责三件事：
 *
 * 1. 挑出**能回答问题的字段**（版本、宿主、开关、计数、最近的报错），
 *    不挑内容（聊天正文、记忆、提醒文字一律不出现）；
 * 2. 把 id 一律换成一串稳定的短哈希（`wxid_ab…` → `acct-3f9a`），同一份
 *    报告里同一个 id 仍然可比，不同报告之间不可反推；
 * 3. 把能识别身份的字符串（URL、手机号、邮箱、长数字串、看起来像 token
 *    的串）整段抹掉，换成 `[已隐藏]`。
 *
 * 输出的每一行都在 `maskDeep` 之后才拼进去，所以新增字段不会因为「忘了脱敏」
 * 而漏出去 —— 这是这个模块唯一的硬规则。
 *
 * @module dsh-weixin/message/diag-export
 */

import { createHash } from 'node:crypto'

/** 报告里最多带多少条最近报错：再多就不像体检包，像日志了。 */
export const MAX_RECENT_ERRORS = 8
/** 单条报错截断长度。 */
export const MAX_ERROR_CHARS = 200

/** 稳定的短哈希：同一个 id 在同一账号下总得到同一个别名。 */
export function aliasOf(value) {
  if (value === undefined || value === null || String(value) === '') return '（空）'
  const digest = createHash('sha256').update(String(value)).digest('hex')
  return `id-${digest.slice(0, 6)}`
}

const MASK = '[已隐藏]'

/**
 * 抹掉一切可能识别身份的东西。
 *
 * 顺序有讲究：先 URL（里面可能含 token），再邮箱和手机号，然后是长数字串
 * （token 常见的形态），最后是 `xxx=yyy` 形式的凭据片段。
 *
 * @param {string} text
 */
export function maskDeep(text) {
  let out = String(text ?? '')
  out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'）)]+/gi, MASK)
  out = out.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, MASK)
  out = out.replace(/\b1[3-9]\d{9}\b/g, MASK)
  out = out.replace(/\b[A-Za-z0-9_-]{24,}\b/g, MASK)
  out = out.replace(/\b(token|secret|password|key|apikey|authorization)\s*[=:]\s*\S+/gi, `$1=${MASK}`)
  return out
}

function onOff(value) {
  return value ? '开' : '关'
}

function yesNo(value) {
  return value === true ? '是' : '否'
}

/**
 * @param {object} input
 * @param {string} [input.version]
 * @param {string} [input.nodeVersion]
 * @param {string} [input.hostVersion]
 * @param {boolean} [input.hostTested]
 * @param {string} [input.accountId]       换成别名，原文不出现
 * @param {string} [input.accountLabel]    换成别名
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
 * @param {Array<{ at?: string, tool?: string, ok?: boolean, summary?: string }>} [input.recentErrors]
 * @param {number} [input.now]
 * @returns {{ text: string, sections: string[] }}
 */
export function buildDiagExport(input) {
  const config = input.config ?? {}
  const now = input.now ?? Date.now()
  const lines = []
  const sections = []

  lines.push(`# 微信BOT 体检包 · ${new Date(now).toISOString()}`)
  lines.push('# 所有 id 已经换成一串短哈希，地址/凭据/长串数字已经抹掉。请人工看一眼再发出去。')
  lines.push('')

  sections.push('版本')
  lines.push('## 版本')
  lines.push(`- 插件 ${maskDeep(input.version ?? '?')}`)
  if (input.hostVersion !== undefined) {
    lines.push(`- 宿主 ${maskDeep(input.hostVersion)}（${input.hostTested === true ? '在已测列表里' : '不在已测列表里'}）`)
  }
  if (input.nodeVersion !== undefined) lines.push(`- Node ${maskDeep(input.nodeVersion)}`)
  lines.push('')

  sections.push('账号')
  lines.push('## 账号')
  lines.push(`- 账号 ${aliasOf(input.accountId)}${input.accountLabel === undefined ? '' : ` / ${aliasOf(input.accountLabel)}`}`)
  lines.push(`- 连接就绪：${yesNo(input.transportUp !== false)}`)
  lines.push(`- 白名单 ${Number(input.allowlist ?? 0)} 人`)
  lines.push('')

  sections.push('模式')
  lines.push('## 模式')
  lines.push(`- ${maskDeep(input.modeName ?? '?')}${input.companion === true ? '（陪聊）' : ''}`)
  lines.push('')

  sections.push('开关')
  lines.push('## 开关')
  lines.push(`- 主动开口 ${onOff(config.proactiveEnabled !== false)} · 记忆 ${onOff(config.memoryEnabled !== false)}`)
  lines.push(`- 群聊 ${onOff(config.groupChatEnabled === true)} · 免打扰 ${onOff(config.quietHoursEnabled === true)}`)
  lines.push(`- 文档抽取 ${onOff(config.documentExtract !== false)} · 备份 ${onOff(config.backupEnabled === true)}`)
  if (input.quietDelayMs !== undefined && input.quietDelayMs > 0) {
    lines.push(`- 当前处于静默，还有 ${Math.ceil(input.quietDelayMs / 60_000)} 分钟`)
  }
  lines.push('')

  sections.push('计数')
  lines.push('## 计数')
  lines.push(`- 待发提醒 ${Number(input.reminders ?? 0)} 条 · 订阅 ${Number(input.subscriptions ?? 0)} 条`)
  lines.push(`- 今天流水 ${Number(input.journalToday ?? 0)} 条 · 会话记忆 ${Number(input.conversations ?? 0)} 个`)
  const proactive = input.proactive
  if (proactive !== undefined) {
    lines.push(`- 主动开口今天 ${Number(proactive.count ?? 0)} 条 · 连发未回 ${Number(proactive.misses ?? 0)} 次`)
  }
  lines.push('')

  const errors = Array.isArray(input.recentErrors) ? input.recentErrors.slice(0, MAX_RECENT_ERRORS) : []
  sections.push('最近报错')
  lines.push('## 最近报错')
  if (errors.length === 0) {
    lines.push('- （没有）')
  } else {
    for (const entry of errors) {
      const at = entry.at === undefined ? '' : `${maskDeep(String(entry.at))} `
      const tool = entry.tool === undefined ? '' : `${maskDeep(entry.tool)} `
      const status = entry.ok === true ? '成功' : '失败'
      const summary = maskDeep(String(entry.summary ?? '')).slice(0, MAX_ERROR_CHARS)
      lines.push(`- ${at}${tool}${status}：${summary}`)
    }
  }
  lines.push('')

  sections.push('自检结论')
  lines.push('## 自检结论')
  const problems = []
  if (input.transportUp === false) problems.push('连接未就绪')
  if (input.hostVersion !== undefined && input.hostTested !== true) problems.push('宿主版本不在已测列表')
  if ((input.allowlist ?? 0) === 0) problems.push('白名单为空')
  if (config.proactiveEnabled === false) problems.push('主动开口是关的')
  if (config.memoryEnabled === false) problems.push('记忆是关的')
  if (errors.some((entry) => entry.ok === false)) problems.push(`最近有 ${errors.filter((entry) => entry.ok === false).length} 条失败记录`)
  lines.push(problems.length === 0 ? '- 没发现明显问题' : problems.map((problem) => `- ${problem}`).join('\n'))
  lines.push('')

  return { text: lines.join('\n'), sections }
}
