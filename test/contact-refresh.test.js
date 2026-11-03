/**
 * 群成员名片的自动补全：只补过时的、只补最近说过话的、只写话里有的。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CONTACT_LINE_CHARS,
  CONTACT_REFRESH_MIN_LINES,
  applyContactRefresh,
  buildContactRefreshPrompt,
  parseContactRefresh,
  pickRefreshCandidates,
  recentLinesForSender,
} from '../src/message/contact-refresh.js'
import { isContactStale, readContact, saveContact } from '../src/message/contacts.js'

const NOW = new Date(2026, 10, 4, 12, 0).getTime()
const DAY = 24 * 60 * 60 * 1000

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-contact-refresh-'))
}

function entry(senderId, text, at, dir = 'in') {
  return { dir, senderId, text, at }
}

test('only the lines this person said, only recent ones, newest last', () => {
  const lines = recentLinesForSender([
    entry('wxid_a', '  第一句\n 换行 ', NOW - 2 * DAY),
    entry('wxid_b', '别人的话', NOW - DAY),
    entry('wxid_a', '太久了', NOW - 30 * DAY),
    entry('wxid_a', '刚才这句', NOW - 60_000),
    { dir: 'out', senderId: 'wxid_a', text: '机器人说的', at: NOW - 30_000 },
  ], 'wxid_a', { now: NOW })
  assert.deepEqual(lines, ['第一句 换行', '刚才这句'], 'inbound, within the window, newest last')
})

test('a long line is trimmed, and the list keeps only the newest few', () => {
  const many = Array.from({ length: 20 }, (unused, index) => entry('wxid_a', `第 ${index} 句`, NOW - (20 - index) * 60_000))
  const lines = recentLinesForSender(many, 'wxid_a', { now: NOW })
  assert.equal(lines.length, 12, 'at most MAX_CONTACT_LINES')
  assert.equal(lines.at(-1), '第 19 句', 'the newest one is kept')

  const long = recentLinesForSender([entry('wxid_a', 'z'.repeat(CONTACT_LINE_CHARS * 2), NOW - 1000)], 'wxid_a', { now: NOW })
  assert.equal(long[0].length, CONTACT_LINE_CHARS)
})

test('candidates are the stale cards whose owner has been talking lately', () => {
  const root = scratch()
  const accountId = 'bot1'
  try {
    // 过时且有话可说 → 入选。
    saveContact(root, accountId, 'wxid_old', { profile: { call: '老张' } }, { now: NOW - 90 * DAY })
    // 刚更新过 → 不入选。
    saveContact(root, accountId, 'wxid_fresh', { profile: { call: '小李' } }, { now: NOW - 2 * DAY })
    // 过时但最近没说话 → 不入选。
    saveContact(root, accountId, 'wxid_quiet', { profile: { call: '阿静' } }, { now: NOW - 90 * DAY })

    const entries = [
      ...Array.from({ length: CONTACT_REFRESH_MIN_LINES }, (unused, index) => entry('wxid_old', `老张的第 ${index} 句`, NOW - index * 60_000)),
      ...Array.from({ length: CONTACT_REFRESH_MIN_LINES }, (unused, index) => entry('wxid_fresh', `小李的第 ${index} 句`, NOW - index * 60_000)),
      ...Array.from({ length: CONTACT_REFRESH_MIN_LINES - 1 }, (unused, index) => entry('wxid_quiet', `阿静的第 ${index} 句`, NOW - index * 60_000)),
    ]
    const picked = pickRefreshCandidates(root, accountId, entries, { now: NOW })
    assert.deepEqual(picked.map((item) => item.contact.contactId), ['wxid_old'])
    assert.equal(picked[0].lines.length >= CONTACT_REFRESH_MIN_LINES, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the pick is capped, so one run never rewrites the whole group', () => {
  const root = scratch()
  const accountId = 'bot1'
  try {
    const entries = []
    for (const id of ['a', 'b', 'c', 'd']) {
      saveContact(root, accountId, id, { profile: { call: id } }, { now: NOW - 90 * DAY })
      for (let index = 0; index < CONTACT_REFRESH_MIN_LINES; index += 1) {
        entries.push(entry(id, `${id} 的第 ${index} 句`, NOW - index * 60_000))
      }
    }
    assert.equal(pickRefreshCandidates(root, accountId, entries, { now: NOW }).length, 2, 'default cap is 2')
    assert.equal(pickRefreshCandidates(root, accountId, entries, { now: NOW, max: 4 }).length, 4)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the prompt shows what is known, what he said, and the exact JSON shape', () => {
  const prompt = buildContactRefreshPrompt({
    contact: { profile: { call: '老张', schedule: '夜班', likes: ['钓鱼'], dislikes: ['加班'] }, profileUpdatedAt: NOW - 90 * DAY },
    lines: ['最近钓到一条大的', '下周要出差'],
    now: NOW,
  })
  assert.match(prompt, /90 天没更新过/)
  assert.match(prompt, /称呼：老张/)
  assert.match(prompt, /喜欢：钓鱼/)
  assert.match(prompt, /- 最近钓到一条大的/)
  assert.match(prompt, /\{"call":/)
  assert.match(prompt, /不要编造/)
})

test('a reply is read from bare JSON, a fence, or a sentence around it', () => {
  const bare = parseContactRefresh('{"call":"老张","schedule":"","likes":["钓鱼"],"dislikes":[],"dates":[]}')
  assert.equal(bare.call, '老张')
  assert.deepEqual(bare.likes, ['钓鱼'])

  const fenced = parseContactRefresh('```json\n{"call":"小李","likes":[],"dislikes":[]}\n```')
  assert.equal(fenced.call, '小李')

  const chatty = parseContactRefresh('好的，这是名片：{"call":"阿静","dislikes":["烟"]} 就这样')
  assert.deepEqual(chatty.dislikes, ['烟'])

  const dates = parseContactRefresh('{"call":"","dates":[{"label":"生日","date":"2026-03-04"},{"label":"坏","date":"三月"}]}')
  assert.deepEqual(dates.dates, [{ label: '生日', date: '2026-03-04' }])
})

test('nothing usable comes back as undefined, not as an empty card', () => {
  assert.equal(parseContactRefresh('我看不出来'), undefined)
  assert.equal(parseContactRefresh('{}'), undefined)
  assert.equal(parseContactRefresh('{"call":"  ","likes":[]}'), undefined)
  assert.equal(parseContactRefresh(''), undefined)
  assert.equal(parseContactRefresh(undefined), undefined)
})

test('writing a card back clears the staleness', () => {
  const root = scratch()
  const accountId = 'bot1'
  try {
    saveContact(root, accountId, 'wxid_old', { profile: { call: '老张' } }, { now: NOW - 90 * DAY })
    assert.equal(isContactStale(readContact(root, accountId, 'wxid_old'), { now: NOW }), true)

    const saved = applyContactRefresh(root, accountId, 'wxid_old', { call: '老张', schedule: '夜班', likes: ['钓鱼'] }, { now: NOW })
    assert.equal(saved.ok, true)
    const after = readContact(root, accountId, 'wxid_old')
    assert.equal(after.profile.schedule, '夜班')
    assert.equal(after.firstSeenAt, NOW - 90 * DAY, 'when we first saw him does not move')
    assert.equal(isContactStale(after, { now: NOW }), false, 'a fresh card is not stale')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})