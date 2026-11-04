import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { estimateTokens } from '../src/tokens.js'
import {
  MAX_LEDGER_CONVERSATIONS,
  USAGE_LEDGER_DAYS,
  conversationRows,
  costOf,
  dayKey,
  formatTokens,
  formatYuan,
  ledgerTotals,
  recordUsage,
  usageAwarenessLine,
} from '../src/message/usage-ledger.js'

function stateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-usage-'))
}

test('one turn lands in the conversation, the route, the model and the day', () => {
  const stateRoot = stateDir()
  const at = new Date(2026, 10, 4, 10, 0).getTime()
  const result = recordUsage(stateRoot, {
    accountId: 'bot',
    conversationId: 'conv-1',
    route: 'dig',
    model: 'deepseek-chat',
    prompt: '四个字的问题',
    reply: '八个字的回答内容',
    at,
  })
  assert.equal(result.ok, true)
  assert.equal(result.tokensIn, estimateTokens('四个字的问题'))

  const store = JSON.parse(fs.readFileSync(path.join(stateRoot, 'usage-ledger.json'), 'utf8'))
  const entry = store.accounts.bot.conversations['conv-1']
  assert.equal(entry.turns, 1)
  assert.equal(entry.tokensIn, estimateTokens('四个字的问题'))
  assert.equal(entry.tokensOut, estimateTokens('八个字的回答内容'))
  assert.equal(entry.routes.dig.turns, 1)
  assert.ok(entry.models['deepseek-chat'].tokensIn > 0)
  assert.equal(entry.days[dayKey(at)].turns, 1)
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test('a conversation keeps its per-model split, and accounts do not mix', () => {
  const stateRoot = stateDir()
  recordUsage(stateRoot, { accountId: 'bot', conversationId: 'conv-1', route: 'chat', model: 'a', prompt: 'x', reply: 'y' })
  recordUsage(stateRoot, { accountId: 'bot', conversationId: 'conv-1', route: 'chat', model: 'b', prompt: 'x', reply: 'y' })
  recordUsage(stateRoot, { accountId: 'other', conversationId: 'conv-1', route: 'chat', model: 'a', prompt: 'x', reply: 'y' })

  const rows = conversationRows(stateRoot, 'bot')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].turns, 2)
  assert.deepEqual(rows[0].models.sort(), ['a', 'b'])
  assert.equal(conversationRows(stateRoot, 'other')[0].turns, 1)
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test('day buckets older than the window are dropped, and nothing else is', () => {
  const stateRoot = stateDir()
  const now = new Date(2026, 10, 4, 12, 0).getTime()
  const tooOld = now - (USAGE_LEDGER_DAYS + 2) * 24 * 60 * 60 * 1000
  recordUsage(stateRoot, { accountId: 'bot', conversationId: 'conv-1', prompt: 'a', reply: 'b', at: tooOld })
  recordUsage(stateRoot, { accountId: 'bot', conversationId: 'conv-1', prompt: 'a', reply: 'b', at: now })

  const store = JSON.parse(fs.readFileSync(path.join(stateRoot, 'usage-ledger.json'), 'utf8'))
  const days = Object.keys(store.accounts.bot.conversations['conv-1'].days)
  assert.deepEqual(days, [dayKey(now)])
  // The totals are lifetime numbers: pruning the daily buckets must not rewrite history.
  assert.equal(store.accounts.bot.conversations['conv-1'].turns, 2)
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test('the ledger keeps the conversations that were used most recently', () => {
  const stateRoot = stateDir()
  const base = new Date(2026, 10, 4, 9, 0).getTime()
  for (let index = 0; index < MAX_LEDGER_CONVERSATIONS + 3; index += 1) {
    recordUsage(stateRoot, { accountId: 'bot', conversationId: `conv-${index}`, prompt: 'a', reply: 'b', at: base + index * 1000 })
  }
  const store = JSON.parse(fs.readFileSync(path.join(stateRoot, 'usage-ledger.json'), 'utf8'))
  const kept = Object.keys(store.accounts.bot.conversations)
  assert.equal(kept.length, MAX_LEDGER_CONVERSATIONS)
  assert.ok(!kept.includes('conv-0'), 'the oldest conversation is the one to go')
  assert.ok(kept.includes(`conv-${MAX_LEDGER_CONVERSATIONS + 2}`))
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test('yuan comes from the price you set, and says nothing when you did not', () => {
  assert.equal(costOf({ tokensIn: 1000, tokensOut: 1000 }), 0)
  assert.equal(costOf({ tokensIn: 1000, tokensOut: 1000 }, { priceInPer1k: 0.5, priceOutPer1k: 2 }), 2.5)
  assert.equal(formatYuan(0), '—')
  assert.equal(formatYuan(0.0423), '0.042 元')
  assert.equal(formatYuan(3.456), '3.46 元')
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1200), '1.2k')
  assert.equal(formatTokens(24_000), '24k')
})

test('rows read newest first, carry the price, and add up', () => {
  const stateRoot = stateDir()
  const now = new Date(2026, 10, 4, 15, 0).getTime()
  recordUsage(stateRoot, { accountId: 'bot', conversationId: 'older', prompt: 'x'.repeat(100), reply: 'y'.repeat(50), at: now - 60_000 })
  recordUsage(stateRoot, { accountId: 'bot', conversationId: 'newer', prompt: 'x'.repeat(200), reply: 'y'.repeat(100), at: now })

  const rows = conversationRows(stateRoot, 'bot', { now, priceInPer1k: 1, priceOutPer1k: 2 })
  assert.deepEqual(rows.map((row) => row.conversationId), ['newer', 'older'])
  assert.ok(rows[0].cost > rows[1].cost)
  assert.equal(rows[0].today.turns, 1)

  const totals = ledgerTotals(rows)
  assert.equal(totals.conversations, 2)
  assert.equal(totals.turns, 2)
  assert.equal(totals.tokens, rows[0].tokens + rows[1].tokens)
  assert.equal(totals.todayTurns, 2)
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test('the awareness line quotes this conversation only, and stays quiet when there is nothing to say', () => {
  const stateRoot = stateDir()
  const now = new Date(2026, 10, 4, 16, 0).getTime()
  assert.equal(usageAwarenessLine(stateRoot, 'bot', 'conv-1', { now }), '')

  recordUsage(stateRoot, { accountId: 'bot', conversationId: 'conv-1', prompt: 'a'.repeat(120), reply: 'b'.repeat(80), at: now })
  const line = usageAwarenessLine(stateRoot, 'bot', 'conv-1', { now, priceInPer1k: 0.4, priceOutPer1k: 1.2 })
  assert.match(line, /1 个回合/)
  assert.match(line, /估算值/)
  assert.match(line, /元/)
  assert.equal(usageAwarenessLine(stateRoot, 'bot', 'conv-2', { now }), '', 'another conversation has no line')
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test('a missing file is an empty ledger, not an error', () => {
  const stateRoot = stateDir()
  assert.deepEqual(conversationRows(stateRoot, 'nobody'), [])
  assert.equal(ledgerTotals([]).tokens, 0)
  fs.rmSync(stateRoot, { recursive: true, force: true })
})
test('the ledger keeps a per-model breakdown, and counts failed turns', () => {
  // "which model did this conversation use, and how much of it" is the question
  // the bill tab exists to answer. The first version only stored the turn count
  // per model and showed a bare list of names with no numbers, so a
  // conversation that never set a model by hand looked like nothing was
  // recorded at all.
  const root = stateDir()
  const at = new Date(2026, 10, 4, 10, 0).getTime()
  try {
    recordUsage(root, { accountId: 'bot1', conversationId: 'c1', route: 'chat', model: 'deepseek/deepseek-chat', prompt: '你好', reply: '在的', at })
    recordUsage(root, { accountId: 'bot1', conversationId: 'c1', route: 'summarize', model: 'deepseek/deepseek-chat', prompt: '摘要一下', reply: '好的', at: at + 1 })
    // A provider that is misconfigured never answers, but the request still cost
    // whatever the model read before it failed. Counted, not silently dropped.
    recordUsage(root, { accountId: 'bot1', conversationId: 'c1', route: 'chat', model: 'deepseek/deepseek-chat', prompt: '还在吗', reply: '', failed: true, at: at + 2 })

    const rows = conversationRows(root, 'bot1', { now: at + 2 })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].turns, 2, 'a failed turn is not a turn')
    assert.equal(rows[0].failedTurns, 1)
    const [model] = rows[0].modelBreakdown
    assert.equal(model.model, 'deepseek/deepseek-chat')
    assert.equal(model.turns, 2, 'two turns produced a reply')
    assert.equal(model.tokensIn, rows[0].tokensIn)
    assert.equal(model.tokens, rows[0].tokens)
    assert.deepEqual(rows[0].routeBreakdown.map((entry) => entry.route).sort(), ['chat', 'summarize'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the awareness line names the model, and says so when there is none', () => {
  const root = stateDir()
  const at = new Date(2026, 10, 4, 10, 0).getTime()
  try {
    recordUsage(root, { accountId: 'bot1', conversationId: 'c1', route: 'chat', model: 'deepseek/deepseek-chat', prompt: '在吗', reply: '在', at })
    const line = usageAwarenessLine(root, 'bot1', 'c1', { now: at })
    assert.match(line, /deepseek\/deepseek-chat/)
    assert.match(line, /1 个回合/)

    recordUsage(root, { accountId: 'bot1', conversationId: 'c2', route: 'chat', model: '（未指定）', prompt: '在吗', reply: '在', at })
    const quiet = usageAwarenessLine(root, 'bot1', 'c2', { now: at })
    assert.match(quiet, /模型名没有记下来/, 'the persona should not name a model nobody chose')
    assert.doesNotMatch(quiet, /deepseek/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
