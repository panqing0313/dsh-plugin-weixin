import test from 'node:test'
import assert from 'node:assert/strict'
import { isGroupMessage, mentionsBot, groupReplyPolicy, groupSharesMemory } from '../src/message/groups.js'

const direct = { conversationId: 'wxid_a', senderId: 'wxid_a', text: '在吗' }
const group = { conversationId: 'room@chatroom', senderId: 'wxid_a', text: '今天吃什么' }
const on = { groupChatEnabled: true }

test('a group message is one whose conversation is not the sender', () => {
  assert.equal(isGroupMessage(direct), false)
  assert.equal(isGroupMessage(group), true)
  assert.equal(isGroupMessage({ conversationId: '', senderId: 'x' }), false)
})

test('addressing the bot is matched on the first line, by name', () => {
  assert.equal(mentionsBot('@小助手 帮我看看', { names: ['小助手'] }), true)
  assert.equal(mentionsBot('小助手在吗', { names: ['小助手'] }), true)
  assert.equal(mentionsBot('今天吃什么', { names: ['小助手'] }), false, 'a mention must be a name, not any substring')
  assert.equal(mentionsBot('先说一句\n@小助手 后面才算', { names: ['小助手'] }), false, 'only the first line counts')
  assert.equal(mentionsBot('', { names: ['小助手'] }), false)
  assert.equal(mentionsBot('@a.b 在吗', { names: ['a.b'] }), true, 'regex metacharacters in a name are escaped')
})

test('a group is silent until the operator turns it on', () => {
  assert.deepEqual(groupReplyPolicy(group, {}, { botNames: ['小助手'] }), { reply: false, reason: 'groups-disabled' })
  assert.deepEqual(groupReplyPolicy(direct, {}, { botNames: ['小助手'] }), { reply: true, reason: 'direct' })
  assert.deepEqual(groupReplyPolicy(group, on, { botNames: ['小助手'] }), { reply: false, reason: 'not-addressed' })
  assert.deepEqual(groupReplyPolicy({ ...group, text: '@小助手 在吗' }, on, { botNames: ['小助手'] }), { reply: true, reason: 'group-mention' })
  assert.deepEqual(groupReplyPolicy(group, { ...on, groupReplyWhen: 'all' }, { botNames: [] }), { reply: true, reason: 'group-all' })
})

test('private memory does not follow the bot into a group unless asked', () => {
  assert.equal(groupSharesMemory(group, on), false)
  assert.equal(groupSharesMemory(group, { ...on, groupShareMemory: true }), true)
  assert.equal(groupSharesMemory(direct, {}), true, 'a direct message always gets its memory')
})

test('a mention survives full-width @, the thin space WeChat inserts, and case', () => {
  assert.equal(mentionsBot('＠小助手 帮我看看', { names: ['小助手'] }), true)
  assert.equal(mentionsBot('@小助手\u2005帮我看下', { names: ['小助手'] }), true)
  assert.equal(mentionsBot('@Helper please look', { names: ['helper'] }), true)
  assert.equal(mentionsBot('今天小助手没来', { names: ['小助手'] }), false)
  assert.equal(mentionsBot('小助手 在吗', { names: ['小助手'] }), true)
})

test('the names people actually use in a group can be configured separately', () => {
  const policy = groupReplyPolicy(
    { ...group, text: '＠阿伟 帮我查一下' },
    { ...on, groupBotNames: '阿伟, 小助手' },
    { botNames: ['阿伟', '小助手'] },
  )
  assert.equal(policy.reply, true)
  assert.equal(policy.reason, 'group-mention')
})
