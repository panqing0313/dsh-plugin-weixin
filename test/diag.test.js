import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildDiagReport } from '../src/message/diag.js'

test('the report names the gates that stop a reply', () => {
  const text = buildDiagReport({
    version: '0.9.17',
    hostVersion: '0.2.1-rc.5',
    hostTested: true,
    accountId: 'bot1',
    transportUp: true,
    modeName: '女友',
    companion: true,
    config: {
      proactiveEnabled: true,
      memoryEnabled: true,
      groupChatEnabled: false,
      quietHoursEnabled: true,
      documentExtract: true,
      proactiveMaxPerDay: 3,
    },
    reminders: 2,
    subscriptions: 1,
    proactive: { count: 1, lastAt: Date.UTC(2026, 9, 31, 1, 0, 0), misses: 0 },
    journalToday: 12,
    conversations: 4,
    allowlist: 1,
    quietDelayMs: 0,
  })
  assert.match(text, /自检 · v0\.9\.17 · 宿主 0\.2\.1-rc\.5（已测）/)
  assert.match(text, /账号：bot1/)
  assert.match(text, /模式：女友（陪聊）/)
  assert.match(text, /主动开口 开/)
  assert.match(text, /免打扰 开/)
  assert.match(text, /待发：提醒 2 条 · 订阅 1 条/)
  assert.match(text, /今天 1\/3 条/)
  assert.match(text, /今天流水 12 条 · 会话记忆 4 个 · 白名单 1 人/)
  assert.match(text, /当前不在静默时段/)
})

test('a quiet window and a missing connection are said plainly', () => {
  const text = buildDiagReport({
    version: '0.9.17',
    accountId: 'bot1',
    transportUp: false,
    modeName: '默认助手',
    companion: false,
    config: { quietHoursEnabled: true },
    quietDelayMs: 5 * 60_000,
  })
  assert.match(text, /连接未就绪，收不到消息/)
  assert.match(text, /免打扰：静默中（约 5 分钟后恢复）/)
  assert.match(text, /主动开口：今天还没有发过/)
  assert.doesNotMatch(text, /（陪聊）/)
})

test('no host version means no host claim', () => {
  const text = buildDiagReport({ version: '0.9.17', accountId: 'bot1', config: {} })
  assert.doesNotMatch(text, /宿主/)
  assert.match(text, /自检 · v0\.9\.17/)
})
