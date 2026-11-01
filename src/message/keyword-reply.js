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
 * ⑥ 命中计数：哪条规则真的在工作、哪条写了没人用。
 *
 * 只记内存里的累计值（进程重启清零），因为它回答的是「这条规则最近有没有被
 * 触发」，而不是账本数据 —— 落盘反而会让「重置它」变成一件需要解释的事。
 * 同时记「命中但被冷却吃掉」的次数：这个数字大说明规则写得太宽。
 */
const hits = new Map()
/** 统计表上限：比规则数多得多，但仍然有界。 */
const MAX_HIT_KEYS = 256

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
  // `recent.has` instead of `?? 0`: a rule that has never fired has no cooldown,
  // and treating "never" as timestamp 0 would make the first hit disappear
  // whenever the clock happens to be within one window of the epoch (`now`
  // defaults to Date.now(), but tests and callers may pass any clock).
  const last = recent.get(key)
  if (last !== undefined && now - last < cooldownMs) {
    bumpHits(rule.source, { cooled: true })
    return null
  }
  recent.set(key, now)
  bumpHits(rule.source, {})
  if (recent.size > MAX_COOLDOWN_KEYS) recent.clear()
  return rule
}

function bumpHits(source, { cooled }) {
  const entry = hits.get(source) ?? { triggered: 0, cooled: 0, lastAt: 0 }
  if (cooled === true) entry.cooled += 1
  else {
    entry.triggered += 1
    entry.lastAt = Date.now()
  }
  hits.set(source, entry)
  if (hits.size > MAX_HIT_KEYS) {
    // Drop the least recently used rule rather than the oldest inserted: a rule
    // that fired a minute ago is not the one to forget.
    let oldestSource
    let oldestAt = Infinity
    for (const [key, value] of hits) {
      const at = value.lastAt === 0 ? 0 : value.lastAt
      if (at < oldestAt) {
        oldestAt = at
        oldestSource = key
      }
    }
    if (oldestSource !== undefined) hits.delete(oldestSource)
  }
}

/** 测试与重载用：把冷却表整个清掉。 */
export function resetKeywordCooldowns() {
  recent.clear()
}

/** 测试用：把命中计数清掉。 */
export function resetKeywordHits() {
  hits.clear()
}

/**
 * ⑥ `/keyword stats`：把配置里的规则与命中计数并起来，配置里的顺序就是
 * 输出顺序 —— 没命中的规则也要出现，否则「为什么没有统计」会被误读成
 * 「这条规则不存在」。
 *
 * @param {string} spec 配置原文
 * @returns {Array<{source: string, reply: string, triggered: number, cooled: number, lastAt: number}>}
 */
export function keywordStats(spec, { warn } = {}) {
  return parseKeywordRules(spec, { warn }).map((rule) => {
    const entry = hits.get(rule.source) ?? { triggered: 0, cooled: 0, lastAt: 0 }
    return {
      source: rule.source,
      reply: rule.reply,
      triggered: entry.triggered,
      cooled: entry.cooled,
      lastAt: entry.lastAt,
    }
  })
}
