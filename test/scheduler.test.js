import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseWhen, ReminderScheduler, readReminders, MAX_REMINDER_TEXT_CHARS, MAX_PENDING_PER_ACCOUNT } from '../src/message/scheduler.js'

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-sched-'))
}

test('parseWhen accepts durations, clock times and absolute dates', () => {
  const now = new Date(2026, 9, 18, 19, 0, 0) // 2026-10-18 19:00 local
  assert.equal(parseWhen('10m', now).ok, true)
  assert.equal(parseWhen('10m', now).fireAt, now.getTime() + 10 * 60_000)
  assert.equal(parseWhen('1d30m', now).ok, true)
  assert.equal(parseWhen('1d30m', now).fireAt, now.getTime() + (86_400_000 + 30 * 60_000))
  const tonight = parseWhen('21:30', now)
  assert.equal(tonight.ok, true)
  assert.equal(tonight.fireAt, new Date(2026, 9, 18, 21, 30).getTime())
  const tomorrow = parseWhen('07:00', now)
  assert.equal(tomorrow.fireAt, new Date(2026, 9, 19, 7, 0).getTime(), 'a clock time already past rolls to tomorrow')
  const absolute = parseWhen('2026-10-19 09:00', now)
  assert.equal(absolute.fireAt, new Date(2026, 9, 19, 9, 0).getTime())
})

test('parseWhen rejects the past, garbage, and absurd horizons', () => {
  const now = new Date(2026, 9, 18, 19, 0, 0)
  assert.equal(parseWhen('', now).ok, false)
  assert.equal(parseWhen('明天下午', now).ok, false, 'natural language is deliberately out of scope')
  assert.equal(parseWhen('2026-10-18 18:00', now).ok, false, 'a past moment is refused')
  assert.equal(parseWhen('25:00', now).ok, false)
  assert.equal(parseWhen('2026-13-01 09:00', now).ok, false)
  assert.equal(parseWhen('400d', now).ok, false, 'more than a year out is refused')
  assert.equal(parseWhen('0m', now).ok, false)
})

test('scheduler fires a due reminder exactly once and clears it from disk', async () => {
  const stateRoot = tmpState()
  try {
    let fired
    let fireCount = 0
    const scheduler = new ReminderScheduler({
      stateRoot,
      fire: async (reminder) => {
        fireCount += 1
        fired = reminder
      },
      setTimeoutRef: (ms, cb) => setTimeout(cb, Math.min(ms, 20)),
    })
    const result = scheduler.schedule({ accountId: 'a1', conversationId: 'c1', text: '该喝水了', fireAt: Date.now() - 1 })
    assert.ok(result.id, 'the scheduler returns the stored reminder')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(fireCount, 1)
    assert.equal(fired.text, '该喝水了')
    assert.equal(fired.accountId, 'a1')
    assert.deepEqual(readReminders(stateRoot).items, [], 'a fired reminder leaves the store')
    scheduler.stop()
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('scheduler re-arms from disk across a restart, firing the overdue one late', async () => {
  const stateRoot = tmpState()
  try {
    const first = new ReminderScheduler({
      stateRoot,
      fire: () => {},
      setTimeoutRef: () => 0,
      clearTimeoutRef: () => {},
    })
    const stored = first.schedule({ accountId: 'a1', conversationId: 'c1', text: '重启后仍要在', fireAt: Date.now() + 3_600_000 })
    first.stop()

    let fired
    const second = new ReminderScheduler({
      stateRoot,
      fire: async (reminder) => { fired = reminder },
      setTimeoutRef: (ms, cb) => setTimeout(cb, Math.min(ms, 20)),
    })
    assert.equal(second.list().length, 1, 'the pending reminder survives the restart')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(fired?.id, stored.id, 'an overdue reminder fires late rather than silently dying')
    assert.equal(readReminders(stateRoot).items.length, 0)
    second.stop()
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('cancel removes the pending reminder and its timer', async () => {
  const stateRoot = tmpState()
  try {
    let fireCount = 0
    const scheduler = new ReminderScheduler({
      stateRoot,
      fire: async () => { fireCount += 1 },
      setTimeoutRef: (ms, cb) => setTimeout(cb, Math.min(ms, 20)),
    })
    const reminder = scheduler.schedule({ accountId: 'a1', conversationId: 'c1', text: '别发', fireAt: Date.now() + 50 })
    assert.equal(scheduler.cancel(reminder.id), true)
    assert.equal(scheduler.cancel(reminder.id), false, 'a second cancel of the same id reports nothing removed')
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(fireCount, 0, 'a cancelled reminder never fires')
    scheduler.stop()
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('schedule validates text length and per-account capacity', () => {
  const stateRoot = tmpState()
  try {
    const scheduler = new ReminderScheduler({ stateRoot, fire: () => {}, setTimeoutRef: () => 0, clearTimeoutRef: () => {} })
    assert.ok(scheduler.schedule({ accountId: 'a1', conversationId: 'c1', text: '   ', fireAt: Date.now() }).error, 'empty text is refused')
    assert.ok(scheduler.schedule({ accountId: 'a1', conversationId: 'c1', text: 'x'.repeat(MAX_REMINDER_TEXT_CHARS + 1), fireAt: Date.now() }).error, 'over-long text is refused')
    for (let i = 0; i < MAX_PENDING_PER_ACCOUNT; i += 1) {
      scheduler.schedule({ accountId: 'a1', conversationId: 'c1', text: `t${i}`, fireAt: Date.now() + 3_600_000 })
    }
    assert.ok(scheduler.schedule({ accountId: 'a1', conversationId: 'c1', text: 'one too many', fireAt: Date.now() }).error, 'capacity is per account')
    assert.ok(scheduler.schedule({ accountId: 'a2', conversationId: 'c1', text: 'other account', fireAt: Date.now() }).id, 'a second account keeps its own budget')
    scheduler.stop()
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('a fire that throws is contained and does not break other timers', async () => {
  const stateRoot = tmpState()
  try {
    let good = 0
    const warnings = []
    const scheduler = new ReminderScheduler({
      stateRoot,
      fire: async (reminder) => {
        if (reminder.text === 'boom') throw new Error('transport down')
        good += 1
      },
      warn: (message) => warnings.push(message),
      setTimeoutRef: (ms, cb) => setTimeout(cb, Math.min(ms, 20)),
    })
    scheduler.schedule({ accountId: 'a1', conversationId: 'c1', text: 'boom', fireAt: Date.now() - 1 })
    scheduler.schedule({ accountId: 'a1', conversationId: 'c1', text: 'fine', fireAt: Date.now() - 1 })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(good, 1, 'the healthy reminder still fired')
    assert.ok(warnings.some((line) => line.includes('send failed') && line.includes('transport down')), 'the failing send is reported through warn, not swallowed')
    scheduler.stop()
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})
