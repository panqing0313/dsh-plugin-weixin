/**
 * 「太长了」「别老用 emoji」——对方说出口的偏好，应该下一条就体现。
 *
 * 提示词里的风格规则（`human-pace.js`）是我们替所有人写死的；这一层是**这个人**
 * 亲口说的：`/bad 太长了` 记下一条「别这样」，`/good 多用点表情` 记下一条「保持」，
 * 下一次拼提示词时带上。规则按模式隔离（女友模式里嫌的设置卡不会带去工作助手），
 * 有上限（12 条 × 60 字），最新的排在最后，模型看到的是「对方最近明确提过的」。
 *
 * 状态文件 `style-rules.json`：`{schemaVersion, accounts:{[accountId]:{rules:[…]}}}`。
 * 只记反馈本身，不改模式定义、不调用模型。
 *
 * @module dsh-weixin/message/style-feedback
 */

import path from 'node:path'
import { atomicWriteJson, readJsonFile } from '../atomic.js'

export const STYLE_SCHEMA_VERSION = 1
/** 规则条数上限：再多就不是「偏好」而是写文档了，也白烧提示词。 */
export const MAX_STYLE_RULES = 12
/** 单条长度上限：`/bad` 后面跟一整段抱怨时截断，别让一条占满提示词。 */
export const MAX_STYLE_RULE_CHARS = 60

function fileOf(stateRoot) {
  return path.join(stateRoot, 'style-rules.json')
}

function readStore(stateRoot, warn) {
  const store = readJsonFile(fileOf(stateRoot), { fallback: () => ({ accounts: {} }), warn })
  return store && typeof store === 'object' ? store : { accounts: {} }
}

/** A rule with no mode was recorded before modes mattered: it applies everywhere. */
function matchesMode(rule, modeId) {
  const scoped = typeof rule?.modeId === 'string' && rule.modeId !== ''
  if (!scoped) return true
  return modeId !== undefined && rule.modeId === modeId
}

function normalize(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim().slice(0, MAX_STYLE_RULE_CHARS)
}

/**
 * Rules for one account, oldest first, narrowed to a mode.
 *
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ modeId?: string, warn?: (line: string) => void }} [options]
 */
export function readStyleRules(stateRoot, accountId, { modeId, warn } = {}) {
  const list = readStore(stateRoot, warn).accounts?.[accountId]?.rules
  if (!Array.isArray(list)) return []
  return list.filter((rule) => matchesMode(rule, modeId))
}

/**
 * Record one piece of feedback. Identical feedback refreshes its place instead of
 * piling up ("太长了" said five times is still one rule).
 *
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ kind: 'bad' | 'good', text: string, modeId?: string, at?: number, warn?: (line: string) => void }} options
 * @returns {{ ok: true, rule: object, count: number } | { ok: false, reason: string }}
 */
export function addStyleRule(stateRoot, accountId, { kind, text, modeId, at = Date.now(), warn } = {}) {
  const clean = normalize(text)
  if (clean === '') return { ok: false, reason: 'empty' }
  if (kind !== 'bad' && kind !== 'good') return { ok: false, reason: 'kind' }

  const store = readStore(stateRoot, warn)
  store.accounts ??= {}
  const bucket = (store.accounts[accountId] ??= {})
  const rules = Array.isArray(bucket.rules) ? bucket.rules : []
  const scoped = typeof modeId === 'string' && modeId !== '' ? modeId : undefined
  const kept = rules.filter(
    (rule) => !(rule.kind === kind && normalize(rule.text) === clean && (rule.modeId ?? undefined) === scoped),
  )
  const rule = { kind, text: clean, at }
  if (scoped !== undefined) rule.modeId = scoped
  kept.push(rule)
  // Newest win when the cap is reached: old preferences are the ones superseded.
  bucket.rules = kept.slice(-MAX_STYLE_RULES)

  atomicWriteJson(fileOf(stateRoot), { schemaVersion: STYLE_SCHEMA_VERSION, accounts: store.accounts }, { warn })
  return { ok: true, rule, count: bucket.rules.filter((entry) => matchesMode(entry, modeId)).length }
}

/**
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ modeId?: string, warn?: (line: string) => void }} [options]
 * @returns {number} how many rules were removed
 */
export function clearStyleRules(stateRoot, accountId, { modeId, warn } = {}) {
  const store = readStore(stateRoot, warn)
  const bucket = store.accounts?.[accountId]
  if (bucket === undefined || !Array.isArray(bucket.rules)) return 0
  const before = bucket.rules.length
  const keptRules = bucket.rules.filter((rule) => !matchesMode(rule, modeId))
  bucket.rules = keptRules
  atomicWriteJson(fileOf(stateRoot), { schemaVersion: STYLE_SCHEMA_VERSION, accounts: store.accounts }, { warn })
  return before - keptRules.length
}

/**
 * The prompt section: `''` when there is nothing to say, so it costs nothing on
 * a fresh install.
 *
 * @param {Array<{ kind: string, text: string }>} rules
 */
export function buildStyleFeedbackBlock(rules) {
  const list = Array.isArray(rules) ? rules : []
  if (list.length === 0) return ''
  const lines = list.map((rule) => (rule.kind === 'good' ? `- 保持：${rule.text}` : `- 别这样：${rule.text}`))
  return [
    '<style_feedback>',
    '对方亲口提过的偏好（越后面越新；照这个改，别再犯）：',
    ...lines,
    '这是对方本人的要求，优先于上面对风格的通用描述。',
    '</style_feedback>',
  ].join('\n')
}

/**
 * `- 别这样：太长了（昨天）` for `/style`.
 *
 * @param {Array<{ kind: string, text: string, at?: number }>} rules
 * @param {{ now?: number, modeLabel?: string }} [options]
 */
export function formatStyleRules(rules, { now = Date.now(), modeLabel } = {}) {
  const list = Array.isArray(rules) ? rules : []
  if (list.length === 0) {
    return '还没记过偏好反馈。回复不满意就发 `/bad 太长了`，满意就发 `/good 就这样`，下一条回复起生效。'
  }
  const where = modeLabel === undefined ? '' : `（${modeLabel}）`
  const lines = list.map((rule) => {
    const when = Number.isFinite(rule.at) ? ageLabel(now - rule.at) : ''
    return `${rule.kind === 'good' ? '保持' : '别这样'}：${rule.text}${when === '' ? '' : `　${when}`}`
  })
  return [`记下的偏好${where}（${list.length} 条，越下面越新）：`, ...lines.map((line) => `- ${line}`), '清空：`/style clear`。'].join(
    '\n',
  )
}

function ageLabel(gapMs) {
  if (!Number.isFinite(gapMs) || gapMs < 0) return ''
  const minutes = Math.floor(gapMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/**
 * `/bad` `/good` `/style` handlers.
 *
 * @param {{ stateRoot: string, accountId: string, modeId?: () => string | undefined, modeLabel?: () => string | undefined, warn?: (line: string) => void }} options
 */
export function createStyleCommands({ stateRoot, accountId, modeId, modeLabel, warn }) {
  const here = () => (typeof modeId === 'function' ? modeId() : modeId)
  const label = () => (typeof modeLabel === 'function' ? modeLabel() : modeLabel)

  const record = (kind, arg) => {
    const text = normalize(arg)
    if (text === '') {
      return kind === 'bad'
        ? '用法：`/bad 太长了` —— 说清楚哪里不好，我记下来，下一条起改。'
        : '用法：`/good 就这样` —— 说清楚哪里好，我记下来，继续保持。'
    }
    const result = addStyleRule(stateRoot, accountId, { kind, text, modeId: here(), warn })
    if (result.ok !== true) return '这条没记下来（内容为空或太长）。'
    const head = kind === 'bad' ? `记下了：别「${text}」` : `记下了：保持「${text}」`
    const where = label() === undefined ? '' : `（${label()}）`
    return `${head}${where}。下一条回复起生效，现在一共 ${result.count} 条；看全部发 /style。`
  }

  return {
    bad: (arg) => record('bad', arg),
    good: (arg) => record('good', arg),
    style: (arg) => {
      const raw = String(arg ?? '').trim()
      if (raw === '') return formatStyleRules(readStyleRules(stateRoot, accountId, { modeId: here(), warn }), { modeLabel: label() })
      if (/^(clear|清空|重置|reset)$/i.test(raw)) {
        const removed = clearStyleRules(stateRoot, accountId, { modeId: here(), warn })
        return removed === 0 ? '本来就没有记过偏好。' : `清掉了 ${removed} 条偏好反馈。`
      }
      return '用法：`/style` 看记下的偏好，`/style clear` 清空。'
    },
  }
}