import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  AWAY_REPLY_EVERY_MS,
  MAX_MISSED,
  awaySummary,
  buildAwayReply,
  clearAway,
  createAwayCommands,
  noteMissed,
  readAway,
  startAway,
} from '../src/message/away.js'
import { parseSessionCommand } from '../src/sessions.js'
import { parseWhen } from '../src/message/scheduler.js'

function stateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-away-'))
}

const HOUR = 60 * 60 * 1000

test('/away and /back are session commands', () => {
  assert.deepEqual(parseSessionCommand('/away 2h 开会'), { command: 'away', arg: '2h 开会' })
  assert.deepEqual(parseSessionCommand('/away'), { command: 'away', arg: '' })
  assert.deepEqual(parseSessionCommand('/back'), { command: 'back' })
  assert.equal(parseSessionCommand('/awaypoint'), undefined)
})

test('a window is active until its deadline, then it is not', () => {
  const root = stateRoot()
  const now = 1_000_000
  startAway(root, 'bot1', { until: now + HOUR, note: '开会', now })

  const open = readAway(root, 'bot1', { now })
  assert.equal(open.active, true)
  assert.equal(open.note, '开会')
  assert.equal(open.missed.length, 0)

  assert.equal(readAway(root, 'bot1', { now: now + HOUR }).active, false)
  assert.equal(readAway(root, 'bot2', { now }), undefined)
})

test('one auto-reply per conversation per half hour, and the rest are recorded', () => {
  const root = stateRoot()
  const now = 1_000_000
  startAway(root, 'bot1', { until: now + 4 * HOUR, now })

  const first = noteMissed(root, 'bot1', { conversationId: 'alice', text: '在吗', at: now })
  assert.equal(first.shouldReply, true)
  assert.equal(first.count, 1)

  const second = noteMissed(root, 'bot1', { conversationId: 'alice', text: '人呢', at: now + 60_000 })
  assert.equal(second.shouldReply, false, 'the same chat is not answered twice within 30 minutes')
  assert.equal(second.count, 2)

  const later = noteMissed(root, 'bot1', { conversationId: 'alice', text: '还在吗', at: now + AWAY_REPLY_EVERY_MS })
  assert.equal(later.shouldReply, true, 'half an hour later it may answer again')

  const other = noteMissed(root, 'bot1', { conversationId: 'bob', text: 'hi', at: now + 1_000 })
  assert.equal(other.shouldReply, true, 'a different conversation has its own clock')
})

test('nothing is recorded while the window is closed', () => {
  const root = stateRoot()
  const now = 1_000_000
  const missed = noteMissed(root, 'bot1', { conversationId: 'alice', text: '在吗', at: now })
  assert.equal(missed.shouldReply, false)
  assert.equal(missed.away, undefined)
  assert.equal(readAway(root, 'bot1', { now }), undefined)
})

test('the record is capped instead of growing without bound', () => {
  const root = stateRoot()
  const now = 1_000_000
  startAway(root, 'bot1', { until: now + 4 * HOUR, now })
  for (let i = 0; i < MAX_MISSED + 5; i += 1) {
    noteMissed(root, 'bot1', { conversationId: 'alice', text: `第 ${i} 条`, at: now + i * 1000 })
  }
  const away = readAway(root, 'bot1', { now })
  assert.equal(away.missed.length, MAX_MISSED)
  assert.equal(away.missed.at(-1).text, `第 ${MAX_MISSED + 4} 条`)
})

test('the summary says how many, from how many people, and what they said', () => {
  const root = stateRoot()
  const now = 1_000_000
  startAway(root, 'bot1', { until: now + HOUR, now })
  noteMissed(root, 'bot1', { conversationId: 'alice', text: '在吗', at: now })
  noteMissed(root, 'bot1', { conversationId: 'bob', text: '文件发我', at: now + 1000 })

  const away = clearAway(root, 'bot1')
  const summary = awaySummary(away)
  assert.match(summary, /2 条消息/)
  assert.match(summary, /2 个人/)
  assert.match(summary, /在吗/)
  assert.match(summary, /文件发我/)
  assert.equal(readAway(root, 'bot1', { now }), undefined)
})

test('an empty window still gets a welcome, not a blank message', () => {
  const root = stateRoot()
  const now = 1_000_000
  startAway(root, 'bot1', { until: now + HOUR, now })
  const summary = awaySummary(clearAway(root, 'bot1'))
  assert.match(summary, /没有新消息/)
})

test('the auto-reply carries the return time unless the user wrote their own', () => {
  const away = { until: new Date(2026, 9, 28, 20, 30).getTime() }
  assert.match(buildAwayReply(away), /20:30/)
  assert.equal(buildAwayReply(away, { reply: '在开车，晚点回' }), '在开车，晚点回')
})

test('/away opens a window, reports it, and /back closes it with the summary', () => {
  const root = stateRoot()
  const fixed = 1_000_000
  const commands = createAwayCommands({
    stateRoot: root,
    accountId: 'bot1',
    now: () => fixed,
    parseWhen: (spec) => parseWhen(spec, new Date(fixed)),
  })

  const idle = commands.away('')
  assert.match(idle, /没在离开模式/)

  const opened = commands.away('2h 开会')
  assert.match(opened, /好/)
  assert.match(opened, /开会/)
  assert.equal(readAway(root, 'bot1', { now: fixed }).active, true)

  const status = commands.away('')
  assert.match(status, /离开模式中/)
  assert.match(status, /开会/)

  noteMissed(root, 'bot1', { conversationId: 'alice', text: '在吗', at: fixed })
  const back = commands.back()
  assert.match(back, /欢迎回来/)
  assert.match(back, /在吗/)
  assert.equal(readAway(root, 'bot1', { now: fixed }), undefined)
  assert.match(commands.back(), /没在离开模式/)
})

test('/away refuses a time it cannot read instead of opening a broken window', () => {
  const root = stateRoot()
  const commands = createAwayCommands({ stateRoot: root, accountId: 'bot1', parseWhen })
  const reply = commands.away('胡说八道')
  assert.match(reply, /没有开启/)
  assert.equal(readAway(root, 'bot1'), undefined)
})
