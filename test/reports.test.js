import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIGEST_WHEN,
  DEFAULT_REVIEW_WHEN,
  REVIEW_MAX_FACTS,
  ReportScheduler,
  buildDigestPrompt,
  buildReviewPrompt,
  describeReport,
  nextReportAt,
  pickConversation,
} from '../src/message/reports.js'

const HOUR = 60 * 60 * 1000

test('a daily and a weekly report both resolve to a future instant', () => {
  // 2026-10-28T02:00Z — 10:00 in Asia/Shanghai, a Wednesday.
  const now = Date.UTC(2026, 9, 28, 2, 0, 0)
  const today = nextReportAt('每天 21:00', now)
  assert.ok(today > now)
  assert.equal(new Date(today).getHours(), 21)

  const weekly = nextReportAt('每周日 20:00', now)
  assert.ok(weekly > now)
  assert.equal(new Date(weekly).getDay(), 0)

  // A time that already passed today moves to tomorrow, never to the past.
  const earlier = nextReportAt('每天 09:00', now)
  assert.ok(earlier > now + 20 * HOUR)

  assert.equal(nextReportAt('胡说八道', now), undefined)
})

test('the report goes to the conversation spoken in most recently', () => {
  const conversations = [
    { conversationId: 'a', bond: { lastMessageAt: 100 } },
    { conversationId: 'b', bond: { lastMessageAt: 900 } },
    { conversationId: 'c', bond: {} },
    { conversationId: '', bond: { lastMessageAt: 9999 } },
  ]
  assert.equal(pickConversation(conversations), 'b')
  assert.equal(pickConversation([]), undefined)
  assert.equal(pickConversation(undefined), undefined)
})

test('the digest prompt carries the measured numbers and forbids inventing them', () => {
  const prompt = buildDigestPrompt({
    day: '2026-10-28',
    total: { in: 12, out: 9, all: 21 },
    conversations: [
      { conversationId: 'wxid_a', all: 15 },
      { conversationId: 'wxid_b', all: 6 },
    ],
    events: [{ text: '周五交周报' }, { text: '体检 11-02' }],
    summary: '聊了搬家和周末安排',
  })
  assert.match(prompt, /收到 12 条、发出 9 条消息，一共 21 条/)
  assert.match(prompt, /wxid_a（15 条）/)
  assert.match(prompt, /周五交周报/)
  assert.match(prompt, /聊了搬家和周末安排/)
  assert.match(prompt, /不要编造/)
})

test('the review prompt lists facts by number and asks instead of editing', () => {
  const facts = Array.from({ length: REVIEW_MAX_FACTS + 4 }, (_, i) => ({ text: `事实${i + 1}` }))
  const prompt = buildReviewPrompt({
    day: '2026-10-28',
    facts,
    profile: { call: '老板', schedule: '十点睡', likes: ['咖啡'], dislikes: ['香菜'], dates: [{ label: '生日', date: '1998-03-04' }] },
    digest: '一个爱熬夜的人',
  })
  assert.match(prompt, /1\. 事实1/)
  assert.match(prompt, new RegExp(`${REVIEW_MAX_FACTS}\\. 事实${REVIEW_MAX_FACTS}`))
  assert.ok(!prompt.includes(`事实${REVIEW_MAX_FACTS + 1}`), 'only the first few facts are asked about')
  assert.match(prompt, /称呼：老板/)
  assert.match(prompt, /生日：1998-03-04/)
  assert.match(prompt, /一个爱熬夜的人/)
  assert.match(prompt, /不要替主人改/)
  assert.match(prompt, /\/forget 编号/)
})

test('describeReport names the kind in a way a log line can be read', () => {
  const at = Date.UTC(2026, 9, 28, 13, 0, 0)
  assert.match(describeReport('digest', at), /^日报 /)
  assert.match(describeReport('review', at), /^记忆核对 /)
})

test('the scheduler fires only what is due, then re-arms itself', async () => {
  const fired = []
  let nowMs = Date.UTC(2026, 9, 28, 12, 59, 0) // one minute before 21:00 local time
  const timers = []
  const scheduler = new ReportScheduler({
    config: () => ({ digestWhen: DEFAULT_DIGEST_WHEN, memoryReviewWhen: DEFAULT_REVIEW_WHEN }),
    fire: async (kind) => fired.push(kind),
    now: () => nowMs,
    setTimeoutRef: (fn, delay) => {
      const timer = { fn, delay, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimeoutRef: () => {},
  })
  scheduler.start()
  assert.equal(timers.length, 1)
  const armed = scheduler.armedFor
  assert.equal(armed.length, 2, 'both the daily digest and the weekly review are armed')
  assert.ok(armed.every((entry) => entry.at > nowMs))

  // Not due yet: the tick fires nothing.
  await scheduler.tick()
  assert.deepEqual(fired, [])
  assert.ok(timers.length >= 1, 'it re-armed after the tick')

  // Jump past the digest time: exactly the digest fires.
  const due = Math.min(...armed.filter((e) => e.kind === 'digest').map((e) => e.at))
  nowMs = due + 30_000
  await scheduler.tick()
  assert.deepEqual(fired, ['digest'])
})

test('a disabled report is not armed, and a broken clock spec does not throw', async () => {
  const fired = []
  const scheduler = new ReportScheduler({
    config: () => ({ digestEnabled: false, memoryReviewWhen: '连这个都不是时间' }),
    fire: async (kind) => fired.push(kind),
    setTimeoutRef: (fn, delay) => ({ fn, delay, unref() {} }),
    clearTimeoutRef: () => {},
  })
  scheduler.start()
  assert.deepEqual(scheduler.pending(), [])
  await scheduler.tick()
  assert.deepEqual(fired, [])
})

test('a fire that throws is warned about and does not stop the scheduler', async () => {
  const warnings = []
  let nowMs = Date.UTC(2026, 9, 28, 12, 59, 0)
  const scheduler = new ReportScheduler({
    config: () => ({ digestWhen: '每天 21:00', memoryReviewEnabled: false }),
    fire: async () => {
      throw new Error('side session died')
    },
    warn: (line) => warnings.push(line),
    now: () => nowMs,
    setTimeoutRef: (fn, delay) => ({ fn, delay, unref() {} }),
    clearTimeoutRef: () => {},
  })
  scheduler.start()
  const due = scheduler.armedFor[0].at
  nowMs = due + 1_000
  await scheduler.tick()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /digest report failed: side session died/)
  assert.ok(scheduler.armedFor.length >= 1, 'still armed for tomorrow')
})
