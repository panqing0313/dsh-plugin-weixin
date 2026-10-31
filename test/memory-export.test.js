import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { renderMemoryMarkdown, writeMemoryExport } from '../src/message/memory-export.js'

const store = {
    digest: '她是设计师，喜欢手冲咖啡。',
    profile: { call: '阿沅', likes: ['手冲咖啡'] },
    events: [{ text: '周五交稿', done: false }],
    facts: [{ text: '生日是 3 月 8 日' }, { text: '对花生过敏' }],
    superseded: [{ text: '住在杭州', by: '搬到上海' }],
}

test('the export renders every layer it was given, and only those', () => {
    const markdown = renderMemoryMarkdown({
        store,
        conversations: [
            { conversationId: 'c1', summary: '聊了搬家的事。', bond: {} },
            { conversationId: 'c2', summary: '' },
        ],
        dates: [{ label: '生日', date: '03-08' }],
        accountId: 'bot1',
        conversationId: 'c1',
        now: new Date(2026, 10, 1, 9, 0).getTime(),
        formatProfile: (profile) => ['称呼：阿沅'],
        formatEvents: (events) => events.map((event) => event.text),
        bondLine: (bond) => (bond?.mood ? `心情：${bond.mood}` : ''),
        describeAffinity: () => '▁▂▄▆',
        affinity: {},
    })

    assert.match(markdown, /# 记忆导出 · 2026-11-01/)
    assert.match(markdown, /## 人物小传/)
    assert.match(markdown, /她是设计师/)
    assert.match(markdown, /- 称呼：阿沅/)
    assert.match(markdown, /- 周五交稿/)
    assert.match(markdown, /1\. 生日是 3 月 8 日/)
    assert.match(markdown, /- 住在杭州 → 搬到上海/)
    assert.match(markdown, /- 生日 · 03-08/)
    assert.match(markdown, /### c1/, 'only the conversation with a summary gets a section')
    assert.doesNotMatch(markdown, /### c2/)
    assert.match(markdown, /▁▂▄▆/)
    assert.match(markdown, /`bot1`/)
})

test('an empty memory still exports — the point is what it does NOT know', () => {
    const markdown = renderMemoryMarkdown({
        store: { digest: '', profile: {}, events: [], facts: [], superseded: [] },
        conversations: [],
        accountId: 'bot1',
        conversationId: 'c1',
    })
    assert.match(markdown, /用 \/remember 教我/)
    assert.doesNotMatch(markdown, /## 人物小传/)
})

test('writeMemoryExport lands in exports/ with the memory- prefix', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-memory-export-'))
    const file = writeMemoryExport(root, 'bot1', 'c1', '# md', { now: new Date(2026, 10, 1, 9, 30).getTime() })
    assert.equal(path.dirname(file), path.join(root, 'exports'))
    assert.match(path.basename(file), /^memory-bot1-c1-20261101-0930\d\d\.md$/)
    assert.equal(fs.readFileSync(file, 'utf8'), '# md')
    fs.rmSync(root, { recursive: true, force: true })
})
