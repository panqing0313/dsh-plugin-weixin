import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildUsageReport, usageSummary } from '../src/message/usage.js'

test('a full day of numbers reads as one compact block', () => {
  const report = buildUsageReport({
    backgroundUsed: 7,
    backgroundLimit: 20,
    proactiveCount: 2,
    proactiveLimit: 3,
    proactiveLastAt: new Date(2026, 9, 31, 15, 42).getTime(),
    proactiveMisses: 1,
    outboxPending: 1,
    reminders: 4,
    subscriptions: 2,
    journalEntries: 12,
    journalChars: 800,
    now: new Date(2026, 9, 31, 18, 0).getTime(),
  })
  assert.match(report, /^用量 · 今天/)
  assert.match(report, /后台调用：7\/20 次/)
  assert.match(report, /主动开口：2\/3 条 · 上次 15:42 · 连发未回 1 次（退避中）/)
  assert.match(report, /待重发：1 条/)
  assert.match(report, /待发提醒：4 条 · 订阅：2 条/)
  assert.match(report, /今天流水：12 条 · 正文粗估约 \d+ token/)
})

test('no budget and no proactive line says so instead of dividing by zero', () => {
  const report = buildUsageReport({ backgroundLimit: 0, proactiveLimit: 0, proactiveLastAt: 0 })
  assert.match(report, /后台调用：0 次（未设上限）/)
  assert.match(report, /主动开口：0 条 · 今天还没开口/)
  assert.ok(!report.includes('连发未回'))
  assert.ok(!report.includes('已用完'))
})

test('a spent budget explains what stops until tomorrow', () => {
  const report = buildUsageReport({ backgroundUsed: 20, backgroundLimit: 20 })
  assert.match(report, /后台预算今天已用完/)
  assert.match(report, /明天零点重置/)
})

test('the summary is the budget line, for /diag to reuse', () => {
  assert.equal(usageSummary({ backgroundUsed: 3, backgroundLimit: 10 }), '后台调用：3/10 次')
})