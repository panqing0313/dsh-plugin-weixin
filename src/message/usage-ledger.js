/**
 * 每个会话的「用了什么模型、花了多少 token、折合多少元」。
 *
 * 先说不擅长的地方，因为界面上也会这么说：
 *
 *   - **token 是估算的**。插件不在模型请求链路上（`dsh-llm` 的 usage 分片不经过
 *     这里，`dsh-agent` 的事件里也没有 usage 字段），所以只能拿**提示词与回复的
 *     字符数**按 {@link estimateTokens} 折算。它不含宿主自己拼的系统提示、工具
 *     结果与历史上下文，因此**永远小于**账单上的真实数字。
 *   - **元是估算的**。单价由使用者自己填（`pricePer1kInputYuan` /
 *     `pricePer1kOutputYuan`），没填就只显示 token。不同供应商、不同时段价格不同，
 *     我们不替谁猜。
 *   - **模型名是我们请求的那条路由**，不是宿主最终选用的模型。`chatProvider` 配成
 *     什么，这一格就写什么。
 *
 * 这套数字的用途只有一个：让「这个会话到底在用哪个模型、大概烧了多少」有个
 * 看得见的落点 —— 包括让人设自己知道。它不做计费、不做限额（限额是 `budget.js`）。
 *
 * 状态文件 `usage-ledger.json`（原子写，按账号 → 会话 → 汇总 + 最近 30 天日桶）。
 *
 * @module dsh-weixin/message/usage-ledger
 */

import path from 'node:path'

import { atomicWriteJson, readJsonFile } from '../atomic.js'
import { estimateTokens } from '../tokens.js'

export const USAGE_LEDGER_SCHEMA_VERSION = 1
/** 每个会话保留多少天的日桶。 */
export const USAGE_LEDGER_DAYS = 30
/** 每个账号最多保留多少个会话（按最近使用淘汰）。 */
export const MAX_LEDGER_CONVERSATIONS = 50
/** 价格单位：元 / 千 token。 */
export const DEFAULT_PRICE_PER_1K_YUAN = 0

function ledgerFile(stateRoot) {
  return path.join(stateRoot, 'usage-ledger.json')
}

/** 本地日期键。 */
export function dayKey(at = Date.now()) {
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function emptyConversation(now) {
  return { turns: 0, tokensIn: 0, tokensOut: 0, routes: {}, models: {}, days: {}, firstAt: now, lastAt: now }
}

function pruneDays(days, now) {
  const cutoff = dayKey(now - (USAGE_LEDGER_DAYS - 1) * 24 * 60 * 60 * 1000)
  const kept = {}
  for (const [day, bucket] of Object.entries(days ?? {})) {
    if (day >= cutoff) kept[day] = bucket
  }
  return kept
}

function bumpRoute(routes, key, tokensIn, tokensOut) {
  const bucket = (routes[key] ??= { turns: 0, tokensIn: 0, tokensOut: 0 })
  bucket.turns += 1
  bucket.tokensIn += tokensIn
  bucket.tokensOut += tokensOut
}

/**
 * 记一次模型回合。
 *
 * @param {string} stateRoot
 * @param {{ accountId: string, conversationId: string, route?: string, model?: string,
 *   prompt?: string, reply?: string, at?: number, warn?: (line: string) => void }} usage
 */
export function recordUsage(stateRoot, { accountId, conversationId, route = 'chat', model = '', prompt = '', reply = '', at = Date.now(), warn } = {}) {
  const id = String(accountId ?? '')
  const conversation = String(conversationId ?? '')
  if (id === '' || conversation === '') return { ok: false, reason: 'missing-ids' }
  const tokensIn = estimateTokens(typeof prompt === 'string' ? prompt : '')
  const tokensOut = estimateTokens(typeof reply === 'string' ? reply : '')

  const store = readJsonFile(ledgerFile(stateRoot), { fallback: () => ({ accounts: {} }), warn })
  const accounts = { ...(store?.accounts ?? {}) }
  const perAccount = { ...(accounts[id] ?? { conversations: {} }) }
  const conversations = { ...(perAccount.conversations ?? {}) }
  const existing = conversations[conversation] ?? emptyConversation(at)

  const next = {
    ...existing,
    turns: Number(existing.turns ?? 0) + 1,
    tokensIn: Number(existing.tokensIn ?? 0) + tokensIn,
    tokensOut: Number(existing.tokensOut ?? 0) + tokensOut,
    routes: { ...(existing.routes ?? {}) },
    models: { ...(existing.models ?? {}) },
    days: { ...(existing.days ?? {}) },
    firstAt: Number(existing.firstAt ?? at),
    lastAt: at,
  }
  bumpRoute(next.routes, String(route), tokensIn, tokensOut)

  const modelKey = String(model ?? '') === '' ? '（未指定）' : String(model)
  const modelBucket = (next.models[modelKey] ??= { turns: 0, tokensIn: 0, tokensOut: 0 })
  modelBucket.turns += 1
  modelBucket.tokensIn += tokensIn
  modelBucket.tokensOut += tokensOut

  const day = dayKey(at)
  const dayBucket = (next.days[day] ??= { turns: 0, tokensIn: 0, tokensOut: 0 })
  dayBucket.turns += 1
  dayBucket.tokensIn += tokensIn
  dayBucket.tokensOut += tokensOut
  next.days = pruneDays(next.days, at)

  conversations[conversation] = next

  // 按最近使用淘汰，避免一个跑了半年的账号把文件撑成几千行。
  const entries = Object.entries(conversations)
  if (entries.length > MAX_LEDGER_CONVERSATIONS) {
    entries.sort((a, b) => Number(b[1].lastAt ?? 0) - Number(a[1].lastAt ?? 0))
    for (const [key] of entries.slice(MAX_LEDGER_CONVERSATIONS)) delete conversations[key]
  }
  accounts[id] = { conversations }
  // The ledger is an estimate that rebuilds its view every time; losing the
  // last few minutes of it costs nothing an fsync would buy back.
  atomicWriteJson(ledgerFile(stateRoot), { schemaVersion: USAGE_LEDGER_SCHEMA_VERSION, accounts }, { warn, durable: false })
  return { ok: true, tokensIn, tokensOut }
}

/**
 * 折合元。单价是「元 / 千 token」，没设就是 0。
 */
export function costOf({ tokensIn = 0, tokensOut = 0 } = {}, { priceInPer1k = DEFAULT_PRICE_PER_1K_YUAN, priceOutPer1k = DEFAULT_PRICE_PER_1K_YUAN } = {}) {
  const input = Number.isFinite(priceInPer1k) && priceInPer1k > 0 ? priceInPer1k : 0
  const output = Number.isFinite(priceOutPer1k) && priceOutPer1k > 0 ? priceOutPer1k : 0
  return (tokensIn / 1000) * input + (tokensOut / 1000) * output
}

/** 人读的元：小额给三位小数，别写成 0.00。 */
export function formatYuan(value) {
  const amount = Number.isFinite(value) ? Math.max(0, value) : 0
  if (amount === 0) return '—'
  if (amount < 0.1) return `${amount.toFixed(3)} 元`
  return `${amount.toFixed(2)} 元`
}

/** 人读的 token：1200 → 1.2k。 */
export function formatTokens(value) {
  const tokens = Math.max(0, Math.round(Number(value) || 0))
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`
}

/**
 * 一个账号的会话明细（按「最近的在前」）。
 */
export function conversationRows(stateRoot, accountId, { now = Date.now(), priceInPer1k = DEFAULT_PRICE_PER_1K_YUAN, priceOutPer1k = DEFAULT_PRICE_PER_1K_YUAN, labels, warn } = {}) {
  const store = readJsonFile(ledgerFile(stateRoot), { fallback: () => ({ accounts: {} }), warn })
  const conversations = store?.accounts?.[String(accountId)]?.conversations ?? {}
  const rows = []
  for (const [conversationId, entry] of Object.entries(conversations)) {
    const tokensIn = Number(entry.tokensIn ?? 0)
    const tokensOut = Number(entry.tokensOut ?? 0)
    const cost = costOf({ tokensIn, tokensOut }, { priceInPer1k, priceOutPer1k })
    rows.push({
      conversationId,
      label: typeof labels === 'function' ? labels(conversationId) : undefined,
      turns: Number(entry.turns ?? 0),
      tokensIn,
      tokensOut,
      tokens: tokensIn + tokensOut,
      cost,
      models: Object.keys(entry.models ?? {}).filter((name) => name !== '（未指定）'),
      routes: Object.keys(entry.routes ?? {}),
      today: entry.days?.[dayKey(now)] ?? { turns: 0, tokensIn: 0, tokensOut: 0 },
      lastAt: Number(entry.lastAt ?? 0),
    })
  }
  rows.sort((a, b) => b.lastAt - a.lastAt)
  return rows
}

/** 把明细加总。 */
export function ledgerTotals(rows = []) {
  const totals = { conversations: rows.length, turns: 0, tokensIn: 0, tokensOut: 0, tokens: 0, cost: 0, todayTurns: 0, todayTokens: 0 }
  for (const row of rows) {
    totals.turns += row.turns
    totals.tokensIn += row.tokensIn
    totals.tokensOut += row.tokensOut
    totals.tokens += row.tokens
    totals.cost += row.cost
    totals.todayTurns += Number(row.today?.turns ?? 0)
    totals.todayTokens += Number(row.today?.tokensIn ?? 0) + Number(row.today?.tokensOut ?? 0)
  }
  return totals
}

/**
 * 给人设看的一行：这个会话用了多少、大概花了多少。
 * 读不到账本时返回 `''`（宁可不说，也不编一个数）。
 */
export function usageAwarenessLine(stateRoot, accountId, conversationId, { now = Date.now(), priceInPer1k, priceOutPer1k, warn } = {}) {
  const rows = conversationRows(stateRoot, accountId, { now, priceInPer1k, priceOutPer1k, warn })
  const row = rows.find((item) => item.conversationId === String(conversationId))
  if (row === undefined || row.turns === 0) return ''
  const parts = [`本会话已用 ${row.turns} 个回合、约 ${formatTokens(row.tokens)} token`]
  if (row.cost > 0) parts.push(`约 ${formatYuan(row.cost)}`)
  const todayTokens = Number(row.today?.tokensIn ?? 0) + Number(row.today?.tokensOut ?? 0)
  if (todayTokens > 0) parts.push(`其中今天约 ${formatTokens(todayTokens)} token`)
  return `（这些是你自己的消耗，估算值：${parts.join('，')}。可以据此说话更省一点。）`
}