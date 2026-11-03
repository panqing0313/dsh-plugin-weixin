import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DRAFT_TTL_MS,
  MAX_DRAFT_CHARS,
  buildDraft,
  cleanDraft,
  clearDraft,
  composeReminder,
  createDraftCommands,
  formatDraft,
  readDraft,
  saveDraft,
} from '../src/message/drafts.js'

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-draft-'))
}

const ACCOUNT = 'bot1'

test('the draft follows the kind of day, and the person it is about', () => {
  assert.match(buildDraft({ kind: 'date', label: '她的生日' }), /生日快乐/)
  assert.match(buildDraft({ kind: 'date', label: '结婚纪念日', years: 3 }), /第 3 年/)
  assert.match(buildDraft({ kind: 'event', text: '交房租' }), /交房租/)
  assert.match(buildDraft({ kind: 'date', label: '母亲节' }), /母亲节/)
  assert.match(buildDraft({ kind: 'date', label: '她的生日' }, { who: '小鲸鱼' }), /小鲸鱼|生日快乐/)
})

test('asking again rotates the wording instead of repeating it', () => {
  const item = { kind: 'date', label: '生日' }
  const first = buildDraft(item, { turn: 0 })
  const second = buildDraft(item, { turn: 1 })
  const third = buildDraft(item, { turn: 2 })
  assert.notEqual(first, second)
  assert.notEqual(second, third)
  assert.equal(buildDraft(item, { turn: 3 }), first, 'it wraps around')
})

test('a draft is one clean sendable line, or it is refused', () => {
  assert.deepEqual(cleanDraft('  “生日快乐！”  '), { ok: true, text: '生日快乐！' })
  assert.deepEqual(cleanDraft('草稿：「早点睡」'), { ok: true, text: '早点睡' })
  assert.equal(cleanDraft('   ').ok, false)
  assert.equal(cleanDraft('x'.repeat(MAX_DRAFT_CHARS + 1)).ok, false, 'a half sentence is worse than none')
})

test('a stored draft survives a restart, and expires on its own', () => {
  const root = scratch()
  try {
    assert.equal(readDraft(root, ACCOUNT), undefined, 'nothing yet')
    const at = new Date(2026, 10, 4, 9, 0).getTime()
    saveDraft(root, ACCOUNT, { text: '生日快乐！', item: { kind: 'date', label: '生日' }, at, conversationId: 'conv1' })
    const held = readDraft(root, ACCOUNT, { now: at + 60_000 })
    assert.equal(held.text, '生日快乐！')
    assert.equal(held.forLabel, '生日')
    assert.equal(held.kind, 'date')
    assert.equal(held.conversationId, 'conv1')

    assert.equal(readDraft(root, ACCOUNT, { now: at + DRAFT_TTL_MS + 1 }), undefined, 'yesterday\u2019s greeting is not sent today')
    assert.equal(readDraft(root, 'other-bot'), undefined, 'accounts do not share drafts')

    assert.equal(clearDraft(root, ACCOUNT), true)
    assert.equal(clearDraft(root, ACCOUNT), false, 'clearing twice is not an error')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the reminder carries the draft and says how to send it', () => {
  const reminder = '📅 今天是重要日子\n· 她的生日（第 2 年）'
  const plain = composeReminder(reminder, undefined)
  assert.equal(plain, reminder, 'without a draft the reminder is unchanged')

  const withDraft = composeReminder(reminder, { text: '生日快乐！' })
  assert.match(withDraft, /^📅 今天是重要日子/)
  assert.match(withDraft, /`\/draft send` 就发/)
  assert.match(withDraft, /^> 生日快乐！$/m)

  assert.match(formatDraft(undefined), /现在没有待发的草稿/)
  assert.match(formatDraft({ text: '生日快乐！', forLabel: '她的生日' }), /待发的草稿（她的生日）：\n> 生日快乐！/)
})

test('/draft shows, rotates, sends and drops — and keeps the draft when sending fails', async () => {
  const root = scratch()
  try {
    const sent = []
    let fail = false
    const commands = createDraftCommands({
      stateRoot: root,
      accountId: ACCOUNT,
      item: () => ({ kind: 'date', label: '生日' }),
      send: async (text) => {
        if (fail) throw new Error('network down')
        sent.push(text)
      },
    })

    const created = await commands.draft('')
    assert.match(created, /待发的草稿（生日）/)
    assert.match(created, /`\/draft send` 发出去/)
    assert.match(await commands.draft(''), /待发的草稿/, 'looking again does not rotate it')
    assert.match(await commands.draft('随便写点什么'), /用法：`\/draft`/)

    const first = created
    const again = await commands.draft('换一句')
    assert.notEqual(first, again, 'asking again changes the wording')
    assert.match(again, /\/draft send/)
    assert.match(again, /不花额度/, 'and it says where the sentence came from')

    fail = true
    assert.match(await commands.draft('send'), /没发出去/)
    assert.notEqual(readDraft(root, ACCOUNT), undefined, 'the draft survives a failed send')

    fail = false
    assert.equal(await commands.draft('send'), '发了。')
    assert.equal(sent.length, 1)
    assert.equal(readDraft(root, ACCOUNT), undefined, 'sending clears it')

    assert.equal(await commands.draft('send'), '现在没有草稿可发。')
    assert.equal(await commands.draft('skip'), '本来就没有草稿。')
    saveDraft(root, ACCOUNT, { text: '早点睡', item: { kind: 'date', label: '生日' } })
    assert.equal(await commands.draft('skip'), '草稿丢了。')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('with no date in hand /draft reports what is stored instead of inventing one', async () => {
  const root = scratch()
  try {
    const commands = createDraftCommands({ stateRoot: root, accountId: ACCOUNT, item: () => undefined, send: async () => {} })
    assert.match(await commands.draft(''), /现在没有待发的草稿/)

    saveDraft(root, ACCOUNT, { text: '生日快乐！', item: { kind: 'date', label: '生日' } })
    assert.match(await commands.draft(''), /生日快乐！/)
    assert.match(await commands.draft('换一句'), /生日快乐！/, 'nothing to rotate, so it just shows the stored one')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})