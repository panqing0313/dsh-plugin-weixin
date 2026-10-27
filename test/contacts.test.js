import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildContactBlock, contactFile, listContacts, readContact, saveContact, touchContact } from '../src/message/contacts.js'

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-contacts-'))
}

test('a contact keeps a name card, and one account never sees another account\'s', () => {
  const state = root()
  saveContact(state, 'accA', 'wxid_lin', { call: '小林', profile: { likes: ['美式'], schedule: '十点睡', dislikes: ['香菜'] } })
  saveContact(state, 'accB', 'wxid_lin', { call: '另一个账号里的小林' })

  const a = readContact(state, 'accA', 'wxid_lin')
  assert.equal(a.profile.call, '小林')
  assert.deepEqual(a.profile.likes, ['美式'])
  assert.deepEqual(a.profile.dislikes, ['香菜'])
  assert.equal(readContact(state, 'accB', 'wxid_lin').profile.call, '另一个账号里的小林')

  const list = listContacts(state, 'accA')
  assert.equal(list.length, 1)
  assert.equal(list[0].contactId, 'wxid_lin')
  assert.ok(fs.existsSync(contactFile(state, 'accA', 'wxid_lin')))
  assert.deepEqual(listContacts(state, 'nobody'), [])
  assert.equal(readContact(state, 'accA', 'stranger'), undefined)
})

test('a patch merges field by field instead of replacing the card', () => {
  const state = root()
  saveContact(state, 'acc', 'wxid', { profile: { likes: ['美式'], schedule: '十点睡' } })
  saveContact(state, 'acc', 'wxid', { profile: { dislikes: ['香菜'] } })
  const merged = readContact(state, 'acc', 'wxid')
  assert.deepEqual(merged.profile.likes, ['美式'], 'an untouched list survives')
  assert.deepEqual(merged.profile.dislikes, ['香菜'])
  assert.equal(merged.profile.schedule, '十点睡')

  // An empty contact id is a programming error, not a contact named "".
  assert.equal(saveContact(state, 'acc', '', { call: 'x' }).reason, 'empty-contact')
})

test('touching records the sighting without inventing a profile', () => {
  const state = root()
  const first = saveContact(state, 'acc', 'wxid_new', { call: '' }, { now: 1_000 })
  assert.equal(first.ok, true)
  const touched = touchContact(state, 'acc', 'wxid_new', { now: 5_000 })
  assert.equal(touched.ok, true)
  assert.equal(touched.contact.firstSeenAt, 1_000, 'first seen stays the first time')
  assert.equal(touched.contact.lastSeenAt, 5_000, 'last seen moves')
  assert.equal(buildContactBlock(touched.contact), '', 'nothing worth saying about a stranger')
})

test('the block names the person and asks not to read the card out loud', () => {
  const state = root()
  const saved = saveContact(state, 'acc', 'wxid_lin', { call: '小林', profile: { likes: ['美式'], dates: [{ label: '生日', date: '1998-03-04' }] } })
  const block = buildContactBlock(saved.contact, { senderId: 'wxid_lin' })
  assert.match(block, /^<weixin_contact id="wxid_lin">/)
  assert.match(block, /称呼：小林/)
  assert.match(block, /喜欢：美式/)
  assert.match(block, /重要日期：生日 1998-03-04/)
  assert.match(block, /不要主动念出来/)
  assert.match(block, /<\/weixin_contact>$/)
})
