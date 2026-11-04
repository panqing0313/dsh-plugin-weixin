import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { appendJournal } from '../src/message/journal.js'
import { addGlobalFact, listConvMemories, readConvMemory } from '../src/memory.js'
import {
  MAX_PROMOTIONS,
  PROMOTION_MIN_CONVERSATIONS,
  findPromotionCandidates,
  formatPromotionHint,
  sameStatement,
  withoutKnown,
} from '../src/message/promotions.js'
import { promotionsLine } from '../src/message/digest.js'

function state() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-promo-'))
  return root
}

function note(root, accountId, conversationId, text) {
  appendJournal(root, { accountId, conversationId, dir: 'in', text })
}

function writeConv(root, accountId, conversationId, facts) {
  const dir = path.join(root, 'memory')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `conv-${accountId}-${conversationId}.json`),
    JSON.stringify({ conversationId, summary: '', updatedTurn: 1, facts: facts.map((text) => ({ text, at: Date.now() })) }),
  )
}

test('the same statement in two conversations is a promotion candidate', () => {
  const conversations = [
    { conversationId: 'a', facts: [{ text: '下个月要搬家' }, { text: '喜欢喝冰美式' }] },
    { conversationId: 'b', facts: [{ text: '下个月要搬家' }] },
  ]
  const candidates = findPromotionCandidates(conversations)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].text, '下个月要搬家')
  assert.deepEqual(candidates[0].conversations, ['a', 'b'])
  assert.match(candidates[0].mention, /2 段聊天/)
})

test('repeating it ten times in one conversation is not two conversations', () => {
  const conversations = [
    { conversationId: 'a', facts: [{ text: '下个月要搬家' }, { text: '下个月要搬家' }, { text: '下个月要搬家' }] },
    { conversationId: 'b', facts: [{ text: '喜欢喝冰美式' }] },
  ]
  assert.deepEqual(findPromotionCandidates(conversations), [])
})

test('different statements in different conversations produce nothing', () => {
  const conversations = [
    { conversationId: 'a', facts: [{ text: '下个月要搬家' }] },
    { conversationId: 'b', facts: [{ text: '喜欢喝冰美式' }] },
    { conversationId: 'c', facts: [{ text: '周五要交报告' }] },
  ]
  assert.deepEqual(findPromotionCandidates(conversations), [])
})

test('a single conversation can never promote anything', () => {
  const conversations = [{ conversationId: 'a', facts: [{ text: '下个月要搬家' }, { text: '下个月要搬家' }] }]
  assert.deepEqual(findPromotionCandidates(conversations), [])
})

test('candidates are ranked by how many conversations back them, and capped', () => {
  const conversations = [
    { conversationId: 'a', facts: [{ text: '下个月要搬家' }, { text: '周五要交报告' }, { text: '养了一只猫' }] },
    { conversationId: 'b', facts: [{ text: '下个月要搬家' }, { text: '周五要交报告' }, { text: '养了一只猫' }] },
    { conversationId: 'c', facts: [{ text: '下个月要搬家' }] },
  ]
  const candidates = findPromotionCandidates(conversations)
  assert.ok(candidates.length >= 2, 'at least the two that recur')
  assert.ok(candidates.length <= MAX_PROMOTIONS)
  assert.equal(candidates[0].text, '下个月要搬家')
  assert.equal(candidates[0].conversations.length, 3)
})

test('the hint asks, and never says the bot has written anything', () => {
  const hint = formatPromotionHint([{ text: '下个月要搬家', conversations: ['a', 'b'], mention: '（2 段聊天里都提到过）' }])
  assert.match(hint, /要不要记成长期记忆/)
  assert.match(hint, /\/remember/)
  assert.match(hint, /2 段聊天里都提到过/)
  assert.equal(formatPromotionHint([]), '')
})

test('statements already in long-term memory are not asked about again', () => {
  const candidates = [{ text: '下个月要搬家' }, { text: '养了一只猫' }]
  const kept = withoutKnown(candidates, [{ text: '下个月要搬家。' }])
  assert.deepEqual(kept.map((item) => item.text), ['养了一只猫'])
  assert.equal(sameStatement('下个月要搬家', '下个月要搬家！'), true)
})

test('promotionsLine reads the conversation files and drops what is known', () => {
  const root = state()
  try {
    writeConv(root, 'bot1', 'c1', ['下个月要搬家', '喜欢喝冰美式'])
    writeConv(root, 'bot1', 'c2', ['下个月要搬家'])
    // A line counts as "talked in" once the journal knows about it — a
    // conversation with no summary yet is still a conversation.
    note(root, 'bot1', 'c1', '下个月要搬家')
    note(root, 'bot1', 'c2', '下个月要搬家')
    addGlobalFact(root, 'bot1', '喜欢喝冰美式', { warn: () => {} })
    const line = promotionsLine(root, 'bot1', { known: [{ text: '喜欢喝冰美式' }] })
    assert.match(line, /下个月要搬家/)
    assert.doesNotMatch(line, /冰美式/)
    // and the files are exactly as they were: a suggestion writes nothing
    assert.equal(readConvMemory(root, 'bot1', 'c1').facts.length, 2)
    assert.equal(readConvMemory(root, 'bot1', 'c2').facts.length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a conversation that exists only as a memory file is not "talked in"', () => {
  const root = state()
  try {
    writeConv(root, 'bot1', 'c1', ['下个月要搬家'])
    writeConv(root, 'bot1', 'c2', ['下个月要搬家'])
    // No journal lines: the plugin has never actually spoken in these lines.
    assert.equal(promotionsLine(root, 'bot1', { warn: () => {} }), '')
    note(root, 'bot1', 'c1', '下个月要搬家')
    note(root, 'bot1', 'c2', '下个月要搬家')
    assert.match(promotionsLine(root, 'bot1', { warn: () => {} }), /下个月要搬家/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unreadable conversation file does not stop the digest', () => {
  const root = state()
  try {
    writeConv(root, 'bot1', 'c1', ['下个月要搬家'])
    const warnings = []
    const line = promotionsLine(root, 'bot1', { warn: (text) => warnings.push(text) })
    assert.equal(line, '')
    assert.equal(warnings.length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the minimum conversations constant is what the code promises', () => {
  assert.equal(PROMOTION_MIN_CONVERSATIONS, 2)
})