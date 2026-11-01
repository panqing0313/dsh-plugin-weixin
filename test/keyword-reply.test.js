import test from 'node:test'
import assert from 'node:assert/strict'

import {
    KEYWORD_COOLDOWN_MS,
    keywordGate,
    keywordStats,
    matchKeywordReply,
    parseKeywordRules,
    resetKeywordCooldowns,
    resetKeywordHits,
} from '../src/message/keyword-reply.js'

test('rules parse line by line; broken lines are skipped, not fatal', () => {
    const warnings = []
    const rules = parseKeywordRules([
        '^打卡$ => 打卡成功',
        '   # a comment',
        '',
        'bad regex ( => should be skipped',
        '   => no pattern',
        'no reply =>',
        '.help => command list',
    ].join('\n'), { warn: (line) => warnings.push(line) })

    assert.deepEqual(rules.map((rule) => rule.source), ['^打卡$', '.help'], 'only the valid two survive')
    assert.equal(rules[0].reply, '打卡成功')
    assert.equal(warnings.length, 3, 'every skipped line says why')
    // A line without the arrow is a mistake the operator can fix; it must not
    // throw the whole config away.
    const noArrow = parseKeywordRules('just text')
    assert.deepEqual(noArrow, [])
})

test('the first matching rule wins, in config order', () => {
    const rules = parseKeywordRules('帮助 => generic\n帮助台 => specific')
    assert.equal(matchKeywordReply(rules, '请发帮助台').reply, 'generic', '帮助 matches 帮助台 first')
})

test('the cooldown lets one reply through per rule per chat, then silences', () => {
    resetKeywordCooldowns()
    const rules = parseKeywordRules('^打卡$ => ok')
    const t0 = 1_000_000
    assert.equal(keywordGate(rules, '打卡', 'c1', { now: t0 }).reply, 'ok')
    assert.equal(keywordGate(rules, '打卡', 'c1', { now: t0 + 1000 }), null, 'inside the window')
    assert.equal(keywordGate(rules, '打卡', 'c2', { now: t0 + 2000 }).reply, 'ok', 'another chat is its own clock')
    assert.equal(keywordGate(rules, '打卡', 'c1', { now: t0 + KEYWORD_COOLDOWN_MS + 1 }).reply, 'ok', 'the window opens again')

    // Two rules in one chat cool down independently: the window is per rule.
    const two = parseKeywordRules('^打卡$ => ok\n^签到$ => signed')
    assert.equal(keywordGate(two, '签到', 'c1', { now: t0 + 3000 }).reply, 'signed')
    resetKeywordCooldowns()
})

test('hits are counted per rule, cooldown swallows are counted separately', () => {
  resetKeywordHits()
  resetKeywordCooldowns()
  const spec = '^打卡$ => 打卡成功\n^帮助$ => 看这里\n^没人用$ => x'
  const rules = parseKeywordRules(spec)
  keywordGate(rules, '打卡', 'chat1', { now: 1_000 })
  keywordGate(rules, '打卡', 'chat1', { now: 30_000 }) // within the 60s cooldown
  keywordGate(rules, '帮助', 'chat1', { now: 31_000 })

  const stats = keywordStats(spec)
  assert.deepEqual(stats.map((entry) => [entry.source, entry.triggered, entry.cooled]), [
    ['^打卡$', 1, 1],
    ['^帮助$', 1, 0],
    ['^没人用$', 0, 0],
  ])
  // The last one never fired, and says so — that is what makes the command useful.
  assert.equal(stats[2].lastAt, 0)
})

test('hits accumulate across chats while the cooldown is per chat', () => {
  resetKeywordHits()
  resetKeywordCooldowns()
  const rules = parseKeywordRules('^打卡$ => ok')
  keywordGate(rules, '打卡', 'chat1', { now: 1_000 })
  keywordGate(rules, '打卡', 'chat2', { now: 1_000 })
  assert.equal(keywordStats('^打卡$ => ok')[0].triggered, 2)
})

test('rules added later start at zero without losing the others', () => {
  resetKeywordHits()
  resetKeywordCooldowns()
  keywordGate(parseKeywordRules('^a$ => A'), 'a', 'c', { now: 1_000 })
  const stats = keywordStats('^a$ => A\n^b$ => B')
  assert.deepEqual(stats.map((entry) => entry.triggered), [1, 0])
})
