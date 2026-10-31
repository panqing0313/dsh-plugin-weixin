import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_DATE_REMINDER_WHEN,
  buildDateReminderText,
  clockMinutes,
  dateReminderDue,
  datesOnThisDay,
  markDateReminderSent,
} from '../src/message/dates.js'

const at = (iso) => new Date(iso)

test('clockMinutes reads HH:MM and refuses anything else', () => {
  assert.equal(clockMinutes('09:00'), 540)
  assert.equal(clockMinutes('9:05'), 545)
  assert.equal(clockMinutes('23:59'), 1439)
  assert.equal(clockMinutes('24:00'), undefined)
  assert.equal(clockMinutes('09:60'), undefined)
  assert.equal(clockMinutes('nine'), undefined)
  assert.equal(clockMinutes(''), undefined)
})

test('a date matches by month and day, whatever the year', () => {
  const memory = { profile: { dates: [{ label: '生日', date: '1990-10-31' }] } }
  const items = datesOnThisDay(memory, at('2026-10-31T08:00:00+08:00'))
  assert.deepEqual(items, [{ kind: 'date', label: '生日', years: 36 }])
  assert.deepEqual(datesOnThisDay(memory, at('2026-10-30T08:00:00+08:00')), [])
})

test('a date later this year does not fire today', () => {
  const memory = { profile: { dates: [{ label: '纪念日', date: '2026-12-24' }] } }
  assert.deepEqual(datesOnThisDay(memory, at('2026-10-31T08:00:00+08:00')), [])
})

test('a dated to-do fires on its day only, and not once it is done', () => {
  const today = at('2026-10-31T10:00:00+08:00')
  const memory = {
    events: [
      { text: '交房租', when: '2026-10-31', done: false },
      { text: '已经办完的事', when: '2026-10-31', done: true },
      { text: '明天的事', when: '2026-11-01', done: false },
      { text: '没日期的', when: '', done: false },
    ],
  }
  assert.deepEqual(datesOnThisDay(memory, today), [{ kind: 'event', text: '交房租' }])
})

test('the reminder text is short, and numbers anniversaries', () => {
  assert.equal(
    buildDateReminderText([{ kind: 'date', label: '生日', years: 36 }, { kind: 'event', text: '交房租' }]),
    '📅 今天是重要日子\n- 生日（第 36 年）\n- 交房租',
  )
  assert.equal(buildDateReminderText([{ kind: 'date', label: '纪念日', years: 0 }]), '📅 今天是重要日子\n- 纪念日')
})

test('due only after the configured time, once per day, and only when enabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-dates-'))
  // The reminder compares the runner's LOCAL clock with "09:00", so build the
  // instants locally. A fixed +08:00 instant is 01:00 in UTC, where CI runs —
  // that read as "before nine" and the test failed there while passing here.
  const before = new Date(2026, 9, 31, 8, 59)
  const after = new Date(2026, 9, 31, 9, 0)
  assert.equal(dateReminderDue(root, 'bot1', { now: before }), false)
  assert.equal(dateReminderDue(root, 'bot1', { now: after }), true)
  assert.equal(dateReminderDue(root, 'bot1', { now: after, enabled: false }), false)
  assert.equal(dateReminderDue(root, 'bot1', { now: after, at: '25:00' }), false)

  markDateReminderSent(root, 'bot1', { now: after })
  assert.equal(dateReminderDue(root, 'bot1', { now: new Date(2026, 9, 31, 21, 0) }), false)
  // A new day is due again.
  assert.equal(dateReminderDue(root, 'bot1', { now: new Date(2026, 10, 1, 9, 1) }), true)
  // Accounts do not share the "already sent" flag.
  assert.equal(dateReminderDue(root, 'bot2', { now: after }), true)
})

test('the state file is per account and survives a reload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-dates-'))
  markDateReminderSent(root, 'bot1', { now: new Date(2026, 9, 31, 9, 30) })
  markDateReminderSent(root, 'bot2', { now: new Date(2026, 9, 30, 9, 30) })
  const store = JSON.parse(fs.readFileSync(path.join(root, 'dates.json'), 'utf8'))
  assert.equal(store.accounts.bot1.lastSent, '2026-10-31')
  assert.equal(store.accounts.bot2.lastSent, '2026-10-30')
  assert.equal(DEFAULT_DATE_REMINDER_WHEN, '09:00')
})
