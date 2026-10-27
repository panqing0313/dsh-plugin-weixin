import test from 'node:test'
import assert from 'node:assert/strict'
import { GO_AHEAD_PHRASES, buildDryRunBlock, describeDryRun, isGoAhead } from '../src/message/dry-run.js'
import { KNOWN_ITEM_TYPES, describeUnknownItems, firstSighting } from '../src/message/unknown-items.js'

test('only a whole-message go-ahead lifts the gate', () => {
  for (const phrase of ['执行', ' 执行吧 ', '好', 'GO', 'ok', 'run', 'do it']) {
    assert.equal(isGoAhead(phrase), true, `${phrase} should count`)
  }
  for (const phrase of ['执行一下这个看看', '好的那顺便再查一下日志', '我同意但不着急', '', undefined]) {
    assert.equal(isGoAhead(phrase), false, `${phrase} should not count`)
  }
  // The phrase list is data, not a regex: it is safe to extend and testable as a list.
  assert.ok(GO_AHEAD_PHRASES.includes('执行'))
})

test('the dry-run block asks for a plan, an ask, and nothing executed', () => {
  const block = buildDryRunBlock()
  assert.match(block, /^<weixin_dry_run>/)
  assert.match(block, /不要真的调用任何工具/)
  assert.match(block, /要我执行吗/)
  assert.match(block, /只是预演，不是审批/)
  assert.match(block, /<\/weixin_dry_run>$/)
  assert.match(describeDryRun(), /planning only/)
})

test('unfamiliar inbound shapes are named, and secrets inside them are redacted', () => {
  assert.deepEqual(describeUnknownItems({ items: [{ type: 1, text_item: { text: 'hi' } }] }), [])
  assert.deepEqual(
    describeUnknownItems({ items: [{ type: 1, appmsg: {} }], contextToken: 'x' }),
    ['item type 1 carries "appmsg"'],
  )
  const unknownType = describeUnknownItems({ items: [{ type: 77, appmsg: { url: 'x' } }] })
  assert.equal(unknownType.length, 1)
  assert.match(unknownType[0], /unknown item type 77/)
  assert.match(unknownType[0], /appmsg/)

  // A token in an unfamiliar field must not reach the audit log.
  const leaky = describeUnknownItems({ items: [{ type: 99, authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' }] })
  assert.ok(!leaky.join(' ').includes('abcdefghijklmnopqrstuvwxyz'), leaky.join(' '))
  assert.ok(KNOWN_ITEM_TYPES.includes(5))
})

test('a sighting is reported once per conversation, not once per message', () => {
  const seen = new Set()
  assert.equal(firstSighting(seen, 'item type 99', 'c1|item type 99'), true)
  assert.equal(firstSighting(seen, 'item type 99', 'c1|item type 99'), false)
  assert.equal(firstSighting(seen, 'item type 99', 'c2|item type 99'), true, 'another chat is its own story')
})
