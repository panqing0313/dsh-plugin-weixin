import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { composeDigest } from '../src/message/digest.js'
import { appendJournal } from '../src/message/journal.js'

const NOW = new Date(2026, 9, 31, 12, 0).getTime()
const DAY = '2026-10-31'

function stateRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-digest-'))
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'memory', 'global-a1.json'), JSON.stringify({
    schemaVersion: 1,
    profile: {},
    facts: [],
    events: [{ text: '交房租', when: DAY }, { text: '已经做完的', when: DAY, done: true }],
    digest: '',
  }))
  fs.writeFileSync(path.join(dir, 'memory', 'conv-a1-c1.json'), JSON.stringify({ schemaVersion: 1, summary: '聊了发布' }))
  fs.writeFileSync(path.join(dir, 'habits.json'), JSON.stringify({
    schemaVersion: 1,
    accounts: { a1: { habits: [{ id: 'h1', name: '早起', createdAt: 1, days: [DAY] }] } },
  }))
  return dir
}

test('the digest prompt is computed from the journal, memory and habits', () => {
  const root = stateRoot()
  appendJournal(root, { at: NOW, dir: 'in', accountId: 'a1', conversationId: 'c1', text: '在吗' })
  appendJournal(root, { at: NOW + 1000, dir: 'out', accountId: 'a1', conversationId: 'c1', text: '在' })
  const { prompt, total, conversations } = composeDigest({
    stateRoot: root, accountId: 'a1', conversationId: 'c1', now: NOW, day: DAY,
  })
  assert.deepEqual(total, { in: 1, out: 1, all: 2 })
  assert.deepEqual(conversations, [{ conversationId: 'c1', all: 2 }])
  assert.match(prompt, /收到 1 条、发出 1 条消息，一共 2 条/)
  assert.match(prompt, /记着的事：交房租/, 'unfinished events only')
  assert.ok(!prompt.includes('已经做完的'), 'done events are not repeated')
  assert.match(prompt, /这段会话的摘要：聊了发布/)
  assert.match(prompt, /习惯打卡 1\/1：早起✅/)
})

test('a quiet day says so instead of inventing numbers', () => {
  const root = stateRoot()
  const { total, prompt } = composeDigest({
    stateRoot: root, accountId: 'a1', conversationId: 'c1', now: NOW, day: DAY,
  })
  assert.deepEqual(total, { in: 0, out: 0, all: 0 })
  assert.match(prompt, /收到 0 条、发出 0 条消息，一共 0 条/)
})

test('no habits means no habit line at all', () => {
  const root = stateRoot()
  fs.writeFileSync(path.join(root, 'habits.json'), JSON.stringify({ schemaVersion: 1, accounts: {} }))
  appendJournal(root, { at: NOW, dir: 'in', accountId: 'a1', conversationId: 'c1', text: 'hi' })
  const { prompt } = composeDigest({ stateRoot: root, accountId: 'a1', conversationId: 'c1', now: NOW, day: DAY })
  assert.ok(!prompt.includes('习惯打卡'))
})
