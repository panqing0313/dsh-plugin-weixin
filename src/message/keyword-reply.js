/**
 * 群关键词自动回复：mention / all 之外的第三种群策略。
 *
 * 规则写在配置里，一行一条：`正则 => 回复`。命中就发模板 —— 不起模型回合、
 * 不写记忆、不跑工具，所以没有循环风险（机器人自己的发言不是入站消息）。
 * 三道闸门在外面：只在群里、只对白名单内的人生效、免打扰时段沉默；这里补
 * 第四道 —— 同一会话同一条规则在冷却窗口内最多应一次，防刷屏。
 *
 * 解析是宽容的：坏正则、缺箭头、空回复的行跳过并 warn，其余照常生效。
 *
 * @module dsh-weixin/message/keyword-reply
 */

/** 同一会话同一条规则的冷却：60 秒内「打卡」刷一百遍也只应一句。 */
export const KEYWORD_COOLDOWN_MS = 60_000
/** 规则数上限：写错的人不应该能把配置文件变成一千条正则。 */
export const MAX_KEYWORD_RULES = 50
/** 冷却表上限（会话 × 规则），超了整表清空 —— 最坏情况是多应一句。 */
const MAX_COOLDOWN_KEYS = 512

const recent = new Map()

/**
 * @param {string} spec 配置原文，每行 `pattern => reply`。
 * @returns {Array<{source: string, reply: string, re: RegExp}>}
 */
export function parseKeywordRules(spec, { warn } = {}) {
  const rules = []
  for (const rawLine of String(spec ?? '').split(/\r?\n/)) {
    if (rules.length >= MAX_KEYWORD_RULES) break
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const arrow = line.indexOf('=>')
    if (arrow === -1) {
      warn?.(`keyword rule skipped (no =>): ${line.slice(0, 60)}`)
      continue
    }
    const source = line.slice(0, arrow).trim()
    const reply = line.slice(arrow + 2).trim()
    if (source === '' || reply === '') {
      warn?.(`keyword rule skipped (empty side): ${line.slice(0, 60)}`)
      continue
    }
    let re
    try {
      re = new RegExp(source)
    } catch {
      warn?.(`keyword rule skipped (bad regex): ${source.slice(0, 60)}`)
      continue
    }
    rules.push({ source, reply, re })
  }
  return rules
}

/** 第一条命中的规则赢 —— 顺序就是配置里的行序。 */
export function matchKeywordReply(rules, text) {
  const value = String(text ?? '')
  for (const rule of rules) {
    if (rule.re.test(value)) return rule
  }
  return null
}

/**
 * 命中且不在冷却里才放行，放行即记冷却。
 * @returns {{source: string, reply: string, re: RegExp} | null}
 */
export function keywordGate(rules, text, conversationId, { now = Date.now(), cooldownMs = KEYWORD_COOLDOWN_MS } = {}) {
  const rule = matchKeywordReply(rules, text)
  if (rule === null) return null
  const key = `${String(conversationId ?? '')}|${rule.source}`
  const last = recent.get(key) ?? 0
  if (now - last < cooldownMs) return null
  recent.set(key, now)
  if (recent.size > MAX_COOLDOWN_KEYS) recent.clear()
  return rule
}

/** 测试与重载用：把冷却表整个清掉。 */
export function resetKeywordCooldowns() {
  recent.clear()
}