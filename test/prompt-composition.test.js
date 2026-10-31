import test from 'node:test'
import assert from 'node:assert/strict'

import {
    COMPOSITION_LABELS,
    clearPromptComposition,
    readPromptComposition,
    recordPromptComposition,
} from '../src/message/prompt-composition.js'

test('a recorded turn is read back with its total, and the newest record wins', () => {
    clearPromptComposition()
    recordPromptComposition('bot1', [
        { key: 'persona', chars: 120 },
        { key: 'message', chars: 30 },
    ], { at: 1000, total: 150 })

    const first = readPromptComposition('bot1')
    assert.equal(first.at, 1000)
    assert.equal(first.total, 150)
    assert.deepEqual(first.sections, [
        { key: 'persona', chars: 120 },
        { key: 'message', chars: 30 },
    ])

    recordPromptComposition('bot1', [{ key: 'message', chars: 5 }], { at: 2000, total: 5 })
    assert.equal(readPromptComposition('bot1').at, 2000, 'one account keeps only the latest turn')

    assert.equal(readPromptComposition('nobody'), null, 'an unknown account has no composition')
    clearPromptComposition()
    assert.equal(readPromptComposition('bot1'), null)
})

test('empty and non-numeric sections are dropped, never drawn as a zero-width band', () => {
    clearPromptComposition()
    recordPromptComposition('bot1', [
        { key: 'persona', chars: 10 },
        { key: 'life', chars: 0 },
        { key: 'style', chars: -5 },
        { key: 'memory', chars: 'not a number' },
        null,
        { key: 'recall', chars: 2.6 },
    ], { total: 12 })

    assert.deepEqual(readPromptComposition('bot1').sections, [
        { key: 'persona', chars: 10 },
        { key: 'recall', chars: 3 },
    ])
})

test('at most eight accounts are kept, oldest evicted first', () => {
    clearPromptComposition()
    for (let i = 0; i < 10; i += 1) {
        recordPromptComposition(`bot${i}`, [{ key: 'message', chars: 1 }], { at: i, total: 1 })
    }
    assert.equal(readPromptComposition('bot0'), null, 'the oldest went away')
    assert.equal(readPromptComposition('bot1'), null)
    assert.equal(readPromptComposition('bot9').at, 9)
    clearPromptComposition()
})

test('every label the card can draw has both names', () => {
    for (const [key, names] of Object.entries(COMPOSITION_LABELS)) {
        assert.equal(Array.isArray(names) && names.length === 2, true, `${key} needs two names`)
        assert.equal(names.every((name) => typeof name === 'string' && name.length > 0), true)
    }
})