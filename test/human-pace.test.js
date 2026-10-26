import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHumanStyleBlock,
  DEFAULT_BUBBLE_SPLIT_MAX,
  DEFAULT_REPLY_DELAY_MAX_MS,
  isCompanionMode,
  planCompanionReply,
  replyDelayMs,
  splitIntoBubbles,
} from '../src/message/human-pace.js'
import { BUILTIN_MODES, DEFAULT_MODE_ID, resolveMode } from '../src/persona.js'

const fixed = (value) => () => value

test('isCompanionMode: the stock assistant is the only mode that is not a companion', () => {
  assert.equal(isCompanionMode(null), false)
  assert.equal(isCompanionMode(undefined), false)
  assert.equal(isCompanionMode({ id: DEFAULT_MODE_ID }), false)
  assert.equal(isCompanionMode({ id: 'girlfriend' }), true)
  for (const mode of BUILTIN_MODES) {
    assert.equal(isCompanionMode(mode), mode.id !== DEFAULT_MODE_ID, mode.id)
  }
  // resolveMode always hands back an object, so the card's "follow the default"
  // case lands on the default mode and is paced like a tool — as intended.
  assert.equal(isCompanionMode(resolveMode(BUILTIN_MODES, 'nope')), false)
})

test('splitIntoBubbles: paragraphs first, then sentences, never a wall of text', () => {
  // Short replies are already human: one bubble.
  assert.deepEqual(splitIntoBubbles('在呢'), ['在呢'])
  assert.deepEqual(splitIntoBubbles(''), [])

  // A deliberate blank line is a deliberate beat.
  assert.deepEqual(
    splitIntoBubbles('今天路过那家店了，顺手给你带了点吃的。\n\n明天中午一起？'),
    ['今天路过那家店了，顺手给你带了点吃的。', '明天中午一起？'],
  )

  // Long single-paragraph text is cut at sentence enders.
  const long = '今天降温了，你出门记得穿厚一点。我这边风也很大，吹得人站不住。晚上早点回家。'
  assert.deepEqual(splitIntoBubbles(long), [
    '今天降温了，你出门记得穿厚一点。',
    '我这边风也很大，吹得人站不住。',
    '晚上早点回家。',
  ])

  // Cap: everything past the cap rides in the last bubble.
  assert.deepEqual(splitIntoBubbles(long, 2), [
    '今天降温了，你出门记得穿厚一点。',
    '我这边风也很大，吹得人站不住。晚上早点回家。',
  ])
  assert.deepEqual(splitIntoBubbles(long, 1), [long])

  // A short closing line may stay alone — that is the "晚安。" beat.
  assert.deepEqual(splitIntoBubbles('今天确实跑了一整天，有点累，先躺一会儿。晚安。'), [
    '今天确实跑了一整天，有点累，先躺一会儿。',
    '晚安。',
  ])

  // A short NON-final fragment rides with its neighbour instead of flashing by.
  assert.deepEqual(splitIntoBubbles('我先去开会了。很快。'), ['我先去开会了。很快。'])
})

test('splitIntoBubbles leaves code and machine-shaped text alone', () => {
  const code = '改好了，你试试：\n\n```\nnpm test\n```\n\n有问题喊我。'
  assert.deepEqual(splitIntoBubbles(code), [code])
})

test('replyDelayMs: a beat that grows with the reply, jitters, and stretches when tired', () => {
  assert.equal(replyDelayMs('在吗', null, 0), 0, 'maxDelay 0 turns pacing off')

  const short = replyDelayMs('好', { energy: 80 }, DEFAULT_REPLY_DELAY_MAX_MS, fixed(0.5))
  const long = replyDelayMs('今天真的发生了好多事，我一件一件跟你说。', { energy: 80 }, DEFAULT_REPLY_DELAY_MAX_MS, fixed(0.5))
  assert.ok(long > short, `${long} should exceed ${short}`)

  const rested = replyDelayMs('今天真的发生了好多事。', { energy: 85 }, DEFAULT_REPLY_DELAY_MAX_MS, fixed(0.5))
  const tired = replyDelayMs('今天真的发生了好多事。', { energy: 12 }, DEFAULT_REPLY_DELAY_MAX_MS, fixed(0.5))
  assert.ok(tired > rested, `tired ${tired} should exceed rested ${rested}`)

  // Never over the cap, never below the floor.
  assert.ok(replyDelayMs('x'.repeat(4000), null, 2400, fixed(1.2)) <= 2400)
  assert.ok(replyDelayMs('好', null, DEFAULT_REPLY_DELAY_MAX_MS, fixed(0)) >= 220)
})

test('planCompanionReply: default mode is instant and single, a companion breathes', () => {
  const text = '今天降温了，你出门记得穿厚一点。我这边风也很大，吹得人站不住。'

  const stock = planCompanionReply({ text, mode: { id: DEFAULT_MODE_ID }, rng: fixed(0.5) })
  assert.deepEqual(stock, { delayMs: 0, bubbles: [text], gapMs: 0 })

  const stockOff = planCompanionReply({ text, mode: { id: 'girlfriend' }, config: { humanPacing: false } })
  assert.deepEqual(stockOff, { delayMs: 0, bubbles: [text], gapMs: 0 })

  const companion = planCompanionReply({ text, mode: { id: 'girlfriend' }, rng: fixed(0.5) })
  assert.ok(companion.delayMs > 0)
  assert.equal(companion.bubbles.length, 2)
  assert.ok(companion.gapMs > 0)

  // One bubble means no gap to sit through.
  const single = planCompanionReply({ text, mode: { id: 'girlfriend' }, config: { bubbleSplitMax: 1 }, rng: fixed(0.5) })
  assert.equal(single.bubbles.length, 1)
  assert.equal(single.gapMs, 0)
  assert.ok(single.delayMs > 0)
})

test('buildHumanStyleBlock: it says how a chat message looks', () => {
  const block = buildHumanStyleBlock()
  assert.match(block, /^<weixin_style>/)
  assert.match(block, /<\/weixin_style>$/)
  assert.match(block, /不要用标题、编号列表/)
  assert.match(block, /emi|emoji/)
  assert.equal(DEFAULT_BUBBLE_SPLIT_MAX, 3)
})
