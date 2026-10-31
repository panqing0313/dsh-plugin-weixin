import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendJournal } from '../src/message/journal.js'
import { buildHealth, computeStats } from '../src/message/stats.js'

const DAY = 86_400_000
const NOW = new Date('2026-10-26T12:00:00').getTime()

function withRoot(fn) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-weixin-stats-'))
    try {
        return fn(root)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

test('daily buckets are zero-filled and exactly `days` wide, oldest first', () => {
    withRoot((root) => {
        appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'c1', text: '今天来', at: NOW })
        appendJournal(root, { dir: 'out', accountId: 'bot1', conversationId: 'c1', text: '今天回', at: NOW - 1000 })
        appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'c1', text: '前天', at: NOW - 2 * DAY })
        // Outside a 3-day window: counted in the totals, no bucket.
        appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'c1', text: '太早', at: NOW - 5 * DAY })

        const stats = computeStats(root, { days: 3, now: NOW })
        assert.equal(stats.days, 3)
        assert.equal(stats.daily.length, 3)
        assert.deepEqual(stats.daily.map((d) => d.day), ['2026-10-24', '2026-10-25', '2026-10-26'])
        assert.deepEqual(stats.daily.map((d) => d.all), [1, 0, 2])
        assert.deepEqual(stats.daily.map((d) => d.in), [1, 0, 1])
        assert.deepEqual(stats.daily.map((d) => d.out), [0, 0, 1])
        // Totals describe the window itself, so the too-early entry is not counted.
        assert.deepEqual(stats.total, { in: 2, out: 1, all: 3 })
    })
})

test('the 24-hour distribution lands in the local hour bucket', () => {
    withRoot((root) => {
        appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'c1', text: '九点', at: new Date('2026-10-26T09:10:00').getTime() })
        appendJournal(root, { dir: 'out', accountId: 'bot1', conversationId: 'c1', text: '九点回', at: new Date('2026-10-26T09:50:00').getTime() })
        appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'c1', text: '深夜', at: new Date('2026-10-26T23:05:00').getTime() })

        const stats = computeStats(root, { days: 3, now: NOW })
        assert.equal(stats.hours.length, 24)
        assert.equal(stats.hours[9], 2)
        assert.equal(stats.hours[23], 1)
        assert.equal(stats.hours.reduce((a, b) => a + b, 0), 3)
    })
})

test('conversations are ranked by volume, capped, and split by direction', () => {
    withRoot((root) => {
        for (let i = 0; i < 5; i += 1) {
            appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'busy', text: `a${i}`, at: NOW - i * 60_000 })
        }
        appendJournal(root, { dir: 'out', accountId: 'bot1', conversationId: 'busy', text: 'reply', at: NOW })
        appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'quiet', text: 'one', at: NOW })
        appendJournal(root, { dir: 'in', accountId: 'other', conversationId: 'other-line', text: 'elsewhere', at: NOW })

        const stats = computeStats(root, { days: 3, now: NOW, conversationLimit: 2 })
        assert.equal(stats.conversations.length, 2)
        assert.equal(stats.conversations[0].conversationId, 'busy')
        assert.deepEqual({ in: stats.conversations[0].in, out: stats.conversations[0].out, all: stats.conversations[0].all }, { in: 5, out: 1, all: 6 })
        assert.equal(stats.conversations[1].all, 1)
    })
})

test('an accountId filter narrows every number, and an empty window is all zeroes', () => {
    withRoot((root) => {
        appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'c1', text: 'mine', at: NOW })
        appendJournal(root, { dir: 'in', accountId: 'bot2', conversationId: 'c2', text: 'theirs', at: NOW })

        const mine = computeStats(root, { days: 3, now: NOW, accountId: 'bot1' })
        assert.equal(mine.total.all, 1)
        assert.equal(mine.daily[2].all, 1)
        assert.equal(mine.conversations.length, 1)
        assert.equal(mine.conversations[0].accountId, 'bot1')

        const empty = computeStats(root, { days: 3, now: NOW, accountId: 'nobody' })
        assert.deepEqual(empty.total, { in: 0, out: 0, all: 0 })
        assert.deepEqual(empty.daily.map((d) => d.all), [0, 0, 0])
        assert.equal(empty.hours.every((h) => h === 0), true)
        assert.deepEqual(empty.conversations, [])
    })
})

test('each conversation carries its own per-day series, zero-filled to the window', () => {
    withRoot((root) => {
        appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'busy', text: 'a', at: NOW })
        appendJournal(root, { dir: 'out', accountId: 'bot1', conversationId: 'busy', text: 'b', at: NOW })
        appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'busy', text: 'c', at: NOW - 2 * DAY })
        appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'quiet', text: 'd', at: NOW })

        const stats = computeStats(root, { days: 3, now: NOW })
        const busy = stats.conversations.find((c) => c.conversationId === 'busy')
        // Oldest → newest, one entry per day in the window.
        assert.deepEqual(busy.series, [1, 0, 2])
        const quiet = stats.conversations.find((c) => c.conversationId === 'quiet')
        assert.deepEqual(quiet.series, [0, 0, 1])
    })
})

test('health scores four things out of 25 and always explains itself', () => {
    const perfect = buildHealth({
        connected: true,
        outboxPending: 0,
        budgetUsed: 2,
        budgetLimit: 10,
        retention: { journalDays: 30, auditDays: 30, mediaDays: 30 },
    })
    assert.equal(perfect.score, 100)
    assert.equal(perfect.parts.length, 4)
    assert.deepEqual(perfect.parts.map((p) => p.max), [25, 25, 25, 25])

    const down = buildHealth({ connected: false, outboxPending: 9, budgetUsed: 10, budgetLimit: 10, retention: {} })
    assert.equal(down.score, 0 + 5 + 0 + 10)
    assert.equal(down.parts[0].key, 'connected')
    assert.equal(down.parts[1].score, 5, 'a long retry queue is worse than a short one')

    // No budget configured is not a failure — it just means nothing to spend.
    assert.equal(buildHealth({ connected: true, outboxPending: 1, budgetUsed: 0, budgetLimit: 0, retention: { journalDays: 1, auditDays: 1, mediaDays: 1 } }).score, 90)
})
