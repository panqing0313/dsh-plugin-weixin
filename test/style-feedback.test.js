import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MAX_STYLE_RULES,
  MAX_STYLE_RULE_CHARS,
  addStyleRule,
  buildStyleFeedbackBlock,
  clearStyleRules,
  createStyleCommands,
  formatStyleRules,
  readStyleRules,
} from '../src/message/style-feedback.js'

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-style-'))
}

const ACCOUNT = 'bot1'

test('feedback is remembered per account, per mode, and newest last', () => {
  const root = scratch()
  try {
    assert.deepEqual(readStyleRules(root, ACCOUNT), [], 'nothing recorded yet')

    addStyleRule(root, ACCOUNT, { kind: 'bad', text: '太长了', modeId: 'girlfriend', at: 1000 })
    addStyleRule(root, ACCOUNT, { kind: 'good', text: '多用点表情', modeId: 'girlfriend', at: 2000 })
    addStyleRule(root, ACCOUNT, { kind: 'bad', text: '别用编号列表', modeId: 'jarvis', at: 3000 })

    const girlfriend = readStyleRules(root, ACCOUNT, { modeId: 'girlfriend' })
    assert.deepEqual(
      girlfriend.map((rule) => [rule.kind, rule.text]),
      [['bad', '太长了'], ['good', '多用点表情']],
      'only this mode, oldest first',
    )
    assert.deepEqual(readStyleRules(root, ACCOUNT, { modeId: 'jarvis' }).map((rule) => rule.text), ['别用编号列表'])
    assert.deepEqual(readStyleRules(root, ACCOUNT, { modeId: 'neko' }), [], 'a mode nobody complained about')

    // A rule recorded without a mode applies everywhere: it predates scoping.
    addStyleRule(root, ACCOUNT, { kind: 'bad', text: '别问我在干嘛', at: 4000 })
    assert.equal(readStyleRules(root, ACCOUNT, { modeId: 'neko' }).length, 1)
    assert.equal(readStyleRules(root, ACCOUNT, { modeId: 'jarvis' }).length, 2)
    assert.equal(readStyleRules(root, 'other-bot').length, 0, 'accounts do not share feedback')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('saying the same thing twice refreshes it instead of piling up', () => {
  const root = scratch()
  try {
    addStyleRule(root, ACCOUNT, { kind: 'bad', text: '太长了', modeId: 'girlfriend', at: 1000 })
    addStyleRule(root, ACCOUNT, { kind: 'bad', text: '  太长了  ', modeId: 'girlfriend', at: 5000 })
    const rules = readStyleRules(root, ACCOUNT, { modeId: 'girlfriend' })
    assert.equal(rules.length, 1)
    assert.equal(rules[0].at, 5000, 'the later time wins')

    // Same words, other kind: that is a different statement, so both stay.
    addStyleRule(root, ACCOUNT, { kind: 'good', text: '太长了', modeId: 'girlfriend', at: 6000 })
    assert.equal(readStyleRules(root, ACCOUNT, { modeId: 'girlfriend' }).length, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('empty feedback is refused and long feedback is cut to a rule', () => {
  const root = scratch()
  try {
    assert.equal(addStyleRule(root, ACCOUNT, { kind: 'bad', text: '   ' }).ok, false)
    assert.equal(addStyleRule(root, ACCOUNT, { kind: 'whatever', text: '嗯' }).ok, false)
    const long = 'x'.repeat(MAX_STYLE_RULE_CHARS + 40)
    const result = addStyleRule(root, ACCOUNT, { kind: 'bad', text: long, modeId: 'girlfriend' })
    assert.equal(result.ok, true)
    assert.equal(result.rule.text.length, MAX_STYLE_RULE_CHARS)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the cap keeps the newest rules: old preferences are the superseded ones', () => {
  const root = scratch()
  try {
    for (let index = 0; index < MAX_STYLE_RULES + 4; index += 1) {
      addStyleRule(root, ACCOUNT, { kind: 'bad', text: `第${index}条`, modeId: 'girlfriend', at: 1000 + index })
    }
    const rules = readStyleRules(root, ACCOUNT, { modeId: 'girlfriend' })
    assert.equal(rules.length, MAX_STYLE_RULES)
    assert.equal(rules[0].text, '第4条', 'the first four fell off')
    assert.equal(rules.at(-1).text, `第${MAX_STYLE_RULES + 3}条`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('clearing takes only the rules of the mode asked about', () => {
  const root = scratch()
  try {
    addStyleRule(root, ACCOUNT, { kind: 'bad', text: '太长了', modeId: 'girlfriend' })
    addStyleRule(root, ACCOUNT, { kind: 'bad', text: '别用编号列表', modeId: 'jarvis' })
    assert.equal(clearStyleRules(root, ACCOUNT, { modeId: 'girlfriend' }), 1)
    assert.deepEqual(readStyleRules(root, ACCOUNT, { modeId: 'girlfriend' }), [])
    assert.equal(readStyleRules(root, ACCOUNT, { modeId: 'jarvis' }).length, 1, 'the other mode is untouched')
    assert.equal(clearStyleRules(root, ACCOUNT, { modeId: 'girlfriend' }), 0, 'clearing again removes nothing')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the prompt section is empty until there is feedback, then says who said it', () => {
  const root = scratch()
  try {
    assert.equal(buildStyleFeedbackBlock([]), '', 'a fresh install pays no tokens')
    assert.equal(
      buildStyleFeedbackBlock(readStyleRules(root, ACCOUNT, { modeId: 'girlfriend' })),
      '',
      'and neither does a mode with nothing recorded',
    )

    addStyleRule(root, ACCOUNT, { kind: 'bad', text: '太长了', modeId: 'girlfriend' })
    addStyleRule(root, ACCOUNT, { kind: 'good', text: '多用点表情', modeId: 'girlfriend' })
    const block = buildStyleFeedbackBlock(readStyleRules(root, ACCOUNT, { modeId: 'girlfriend' }))
    assert.match(block, /^<style_feedback>/)
    assert.match(block, /- 别这样：太长了/)
    assert.match(block, /- 保持：多用点表情/)
    assert.match(block, /优先于上面对风格的通用描述/, 'it is stated as the user\u2019s own requirement')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('/style reads like a list a person can check, and says where it is empty', () => {
  const root = scratch()
  try {
    assert.match(formatStyleRules([]), /还没记过偏好反馈/)
    assert.match(formatStyleRules([]), /\/bad 太长了/)

    const now = new Date(2026, 10, 4, 12, 0).getTime()
    const text = formatStyleRules(
      [
        { kind: 'bad', text: '太长了', at: now - 30_000 },
        { kind: 'good', text: '多用点表情', at: now - 3 * 3_600_000 },
      ],
      { now, modeLabel: '女友' },
    )
    assert.match(text, /记下的偏好（女友）（2 条/)
    assert.match(text, /- 别这样：太长了　刚刚/)
    assert.match(text, /- 保持：多用点表情　3 小时前/)
    assert.match(text, /\/style clear/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the commands record, report and clear without a model turn', () => {
  const root = scratch()
  try {
    const commands = createStyleCommands({ stateRoot: root, accountId: ACCOUNT, modeId: () => 'girlfriend', modeLabel: () => '女友' })

    assert.match(commands.bad(''), /用法：`\/bad 太长了`/)
    assert.match(commands.good(''), /用法：`\/good 就这样`/)

    assert.match(commands.bad('太长了'), /记下了：别「太长了」（女友）。下一条回复起生效，现在一共 1 条/)
    assert.match(commands.good('多用点表情'), /记下了：保持「多用点表情」/)
    assert.match(commands.style(''), /- 别这样：太长了/)
    assert.match(commands.style(''), /- 保持：多用点表情/)
    assert.match(commands.style('随便写点什么'), /用法：`\/style`/)

    assert.match(commands.style('clear'), /清掉了 2 条/)
    assert.match(commands.style(''), /还没记过偏好反馈/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a mode with no id records an unscoped rule the whole account sees', () => {
  const root = scratch()
  try {
    const commands = createStyleCommands({ stateRoot: root, accountId: ACCOUNT, modeId: () => undefined })
    assert.match(commands.bad('别催我'), /记下了：别「别催我」。/)
    assert.equal(readStyleRules(root, ACCOUNT, { modeId: 'neko' })[0].text, '别催我')
    assert.equal(readStyleRules(root, ACCOUNT, { modeId: 'jarvis' })[0].text, '别催我')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})