import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CONFLICT_DIFF,
  MemoryConflictQueue,
  conflictReply,
  conflictWords,
  findMemoryConflict,
  parseConflictAnswer,
} from '../src/message/memory-conflict.js'

test('words split CJK into bigrams and keep latin words whole', () => {
  assert.deepEqual(conflictWords('我住在杭州'), ['我住', '住在', '在杭', '杭州'])
  assert.deepEqual(conflictWords('吃'), ['吃'], 'a lone character cannot pair up')
  assert.deepEqual(conflictWords('Lives in Hangzhou 2026'), ['lives', 'in', 'hangzhou', '2026'])
  assert.deepEqual(conflictWords(''), [])
  assert.deepEqual(conflictWords(undefined), [])
})

test('a fact that only changes one word in the same slot is a conflict', () => {
  const facts = [{ text: '我住在杭州' }, { text: '我对花生过敏' }]
  const conflict = findMemoryConflict('我住在上海', facts)
  assert.equal(conflict?.text, '我住在杭州')
  assert.equal(conflict?.distance, 2)
  assert.equal(conflict?.index, 1)
})

test('unrelated facts and too-short phrases are not conflicts', () => {
  const facts = [{ text: '我住在杭州' }]
  assert.equal(findMemoryConflict('我对花生过敏', facts), undefined, 'a different attribute')
  assert.equal(findMemoryConflict('早安', [{ text: '晚安' }]), undefined, 'short lines are noise')
  assert.equal(findMemoryConflict('我住在杭州', facts), undefined, 'identical is a duplicate, not a conflict')
})

test('two changes are the edge of the same slot, more is a different statement', () => {
  // 「我住杭州」→「我住上海」: one place name swapped, bigram distance 2.
  assert.ok(findMemoryConflict('我住上海', [{ text: '我住杭州' }]), 'a swapped place name compares')
  assert.ok(findMemoryConflict('我的生日是三月五日', [{ text: '我的生日是三月八日' }]), 'a swapped date compares')
  // Two unrelated attributes at once is a different sentence, not a correction.
  assert.equal(findMemoryConflict('我每天早上八点游泳', [{ text: '我每天早上七点跑步' }]), undefined, 'too much changed')
  assert.equal(findMemoryConflict('我每天晚上十点看书写日记', [{ text: '我每天早上七点跑步' }]), undefined)
  assert.equal(MAX_CONFLICT_DIFF, 2)
})

test('the closest fact wins when several are similar', () => {
  const facts = [{ text: '我喜欢在周末去爬山' }, { text: '我喜欢在周末去骑车' }]
  const conflict = findMemoryConflict('我喜欢在周末去爬坡', facts)
  assert.equal(conflict?.text, '我喜欢在周末去爬山')
})

test('the question reads naturally and honours a yes or a no', () => {
  const conflict = { text: '我住在上海', supersedes: ['我住在杭州'] }
  assert.match(conflictReply(conflict), /我记得你说过「我住在杭州」/)
  assert.match(conflictReply(conflict), /回「是」.*回「不用」/)
  assert.equal(conflictReply(conflict, 'yes'), '好，那就改成「我住在上海」。')
  assert.match(conflictReply(conflict, 'no'), /我还是记着「我住在杭州」/)
})

test('answers are parsed only from short, exact replies', () => {
  for (const yes of ['是', '是的', '对。', '嗯', '好！', 'yes', ' OK ']) assert.equal(parseConflictAnswer(yes), 'yes', yes)
  for (const no of ['不用', '不是', '别改', 'no', '算了。']) assert.equal(parseConflictAnswer(no), 'no', no)
  assert.equal(parseConflictAnswer('是的明天帮我订个外卖'), undefined, 'a long sentence is not an answer')
  assert.equal(parseConflictAnswer(''), undefined)
})

test('a pending question expires and is consumed once', () => {
  let clock = 1_000
  const queue = new MemoryConflictQueue({ ttlMs: 60_000, now: () => clock })
  queue.ask('acct', { text: '我住在上海', supersedes: ['我住在杭州'] })
  assert.deepEqual(queue.take('acct'), { text: '我住在上海', supersedes: ['我住在杭州'] })
  assert.equal(queue.take('acct'), undefined, 'consumed once')

  queue.ask('acct', { text: '我住在上海', supersedes: ['我住在杭州'] })
  clock += 61_000
  assert.equal(queue.take('acct'), undefined, 'a week-later answer must not apply')

  queue.ask('a', { text: 'x', supersedes: [] })
  queue.clear('a')
  assert.equal(queue.take('a'), undefined)
})