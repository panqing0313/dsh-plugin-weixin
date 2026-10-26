import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendJournal } from '../src/message/journal.js'
import { readJournalRange, renderChatMarkdown, writeChatExport } from '../src/message/chat-export.js'

const DAY = 86_400_000

test('readJournalRange reads a day window, oldest first', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-weixin-export-'))
    try {
        const now = new Date('2026-10-26T12:00:00').getTime()
        // Four days of traffic; only the last three fall inside a 3-day window.
        appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'c1', text: '太早', at: now - 4 * DAY })
        appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'c1', text: '三天前', at: now - 2 * DAY })
        appendJournal(root, { dir: 'out', accountId: 'bot1', conversationId: 'c1', text: '昨天', at: now - DAY })
        appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'c1', text: '今天', at: now })
        // Noise from another account and another conversation.
        appendJournal(root, { dir: 'in', accountId: 'other', conversationId: 'c1', text: '别家', at: now })
        appendJournal(root, { dir: 'in', accountId: 'bot1', conversationId: 'c2', text: '别线', at: now })

        const entries = readJournalRange(root, { accountId: 'bot1', conversationId: 'c1', days: 3, now })
        assert.deepEqual(entries.map((e) => e.text), ['三天前', '昨天', '今天'])

        const all = readJournalRange(root, { accountId: 'bot1', conversationId: 'c1', days: 365, now })
        assert.deepEqual(all.map((e) => e.text), ['太早', '三天前', '昨天', '今天'])
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test('renderChatMarkdown groups by day and labels directions', () => {
    const now = new Date('2026-10-26T12:00:00').getTime()
    const markdown = renderChatMarkdown([
        { at: now - DAY + 60_000, dir: 'in', senderId: 'wxid_a', text: '第一句\n第二行' },
        { at: now - DAY + 120_000, dir: 'out', text: '回复' },
        { at: now, dir: 'in', senderId: 'wxid_a', text: '今天的话' },
    ], { title: '测试导出', now })
    assert.match(markdown, /^# 测试导出\n/)
    assert.match(markdown, /## 2026-10-25\n/)
    assert.match(markdown, /## 2026-10-26\n/)
    assert.match(markdown, /- \[\d{2}:\d{2}\] 对方（wxid_a）：第一句 ⏎ 第二行/)
    assert.match(markdown, /- \[\d{2}:\d{2}\] 我：回复/)
    assert.ok(markdown.indexOf('2026-10-25') < markdown.indexOf('2026-10-26'))
})

test('writeChatExport writes a uniquely named markdown file', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-weixin-export-'))
    try {
        const now = new Date('2026-10-26T18:30:00').getTime()
        const a = writeChatExport(root, 'bot1', 'wxid_a', '# 内容A', { now })
        const b = writeChatExport(root, 'bot1', 'wxid_a', '# 内容B', { now: now + 1000 })
        assert.notEqual(a, b, 'a second export must not overwrite the first')
        assert.match(a, /exports[\\/]chat-bot1-wxid_a-\d{8}-\d{6}\.md$/)
        assert.equal(readFileSync(a, 'utf8'), '# 内容A')
        assert.ok(existsSync(b))
        assert.ok(readdirSync(join(root, 'exports')).length === 2)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})
