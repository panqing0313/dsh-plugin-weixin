import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
    MAX_STRANGERS,
    MAX_STRANGER_TEXT_CHARS,
    clearStranger,
    clearStrangerEverywhere,
    readStrangers,
    recordStranger,
} from '../src/message/strangers.js'

function tmpState() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-strangers-'))
}

test('a refused sender is recorded once and counted, newest first', () => {
    const root = tmpState()
    recordStranger(root, 'bot1', { senderId: 'wxid_a', conversationId: 'c1', text: '在吗', at: 1000 })
    recordStranger(root, 'bot1', { senderId: 'wxid_b', conversationId: 'c1', text: 'hello', at: 2000 })
    recordStranger(root, 'bot1', { senderId: 'wxid_a', conversationId: 'c1', text: '又来了', at: 3000 })

    const rows = readStrangers(root, 'bot1')
    assert.deepEqual(rows.map((row) => row.senderId), ['wxid_a', 'wxid_b'], 'newest refusal first')
    assert.equal(rows[0].count, 2, 'repeat refusals count, they do not duplicate')
    assert.equal(rows[0].firstAt, 1000, 'first sight is kept')
    assert.equal(rows[0].lastText, '又来了')
    // Accounts are separate: one account's refusals never leak into another's panel.
    assert.deepEqual(readStrangers(root, 'bot2'), [])
})

test('the last text is clipped, an empty sender id is ignored', () => {
    const root = tmpState()
    recordStranger(root, 'bot1', { senderId: 'wxid_a', text: 'x'.repeat(500), at: 1 })
    assert.equal(readStrangers(root, 'bot1')[0].lastText.length, MAX_STRANGER_TEXT_CHARS)

    const before = fs.readFileSync(path.join(root, 'strangers.json'), 'utf8')
    recordStranger(root, 'bot1', { senderId: '   ', at: 2 })
    assert.equal(fs.readFileSync(path.join(root, 'strangers.json'), 'utf8'), before)
    assert.deepEqual(readStrangers(root, 'bot1').map((row) => row.senderId), ['wxid_a'])
})

test('the list caps at fifty and evicts the quietest stranger first', () => {
    const root = tmpState()
    for (let i = 0; i < MAX_STRANGERS + 5; i += 1) {
        recordStranger(root, 'bot1', { senderId: `wxid_${i}`, at: 1000 + i })
    }
    const rows = readStrangers(root, 'bot1')
    assert.equal(rows.length, MAX_STRANGERS)
    assert.ok(!rows.some((row) => row.senderId === 'wxid_0'), 'the oldest refusal was evicted')
    assert.ok(rows.some((row) => row.senderId === `wxid_${MAX_STRANGERS + 4}`), 'the newest is kept')
})

test('clearing is scoped: one account, or everywhere for an allowlisted id', () => {
    const root = tmpState()
    recordStranger(root, 'bot1', { senderId: 'wxid_a', at: 1 })
    recordStranger(root, 'bot2', { senderId: 'wxid_a', at: 2 })
    recordStranger(root, 'bot2', { senderId: 'wxid_b', at: 3 })

    assert.equal(clearStranger(root, 'bot1', 'wxid_a'), true)
    assert.deepEqual(readStrangers(root, 'bot1'), [])
    assert.equal(readStrangers(root, 'bot2').length, 2, 'other accounts keep their records')
    assert.equal(clearStranger(root, 'bot1', 'wxid_a'), false, 'clearing twice is not an error')

    assert.equal(clearStrangerEverywhere(root, 'wxid_a'), 1, 'the remaining copy went too')
    assert.deepEqual(readStrangers(root, 'bot2').map((row) => row.senderId), ['wxid_b'])
    assert.equal(clearStrangerEverywhere(root, 'wxid_nobody'), 0)
})