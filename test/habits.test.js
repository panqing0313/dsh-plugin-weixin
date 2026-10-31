import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  addHabit,
  bestStreakOf,
  checkHabit,
  createHabitCommands,
  dayKey,
  formatHabits,
  habitDigestLine,
  habitsList,
  MAX_HABITS,
  removeHabit,
  streakOf,
  weekCount,
} from '../src/message/habits.js'

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-habits-'))
}

test('a habit is added once, named, and refuses a duplicate or an empty name', () => {
  const root = tmpState()
  const first = addHabit(root, 'a1', { name: '早起', at: 1 })
  assert.equal(first.ok, true)
  assert.equal(first.habit.name, '早起')
  assert.equal(addHabit(root, 'a1', { name: '早起' }).reason, 'duplicate')
  assert.equal(addHabit(root, 'a1', { name: '   ' }).reason, 'empty')
  assert.equal(habitsList(root, 'a1').length, 1)
  assert.equal(habitsList(root, 'a2').length, 0, 'habits are per account')
})

test('the cap refuses the 21st instead of quietly dropping the oldest', () => {
  const root = tmpState()
  for (let i = 0; i < MAX_HABITS; i += 1) assert.equal(addHabit(root, 'a1', { name: `h${i}` }).ok, true)
  assert.equal(addHabit(root, 'a1', { name: 'h-extra' }).reason, 'full')
  assert.equal(habitsList(root, 'a1').length, MAX_HABITS)
})

test('checking twice on the same day is refused, and the streak counts', () => {
  const root = tmpState()
  addHabit(root, 'a1', { name: '早起', at: 1 })
  const day = '2026-10-31'
  assert.equal(checkHabit(root, 'a1', { key: '早起', day }).streak, 1)
  assert.equal(checkHabit(root, 'a1', { key: '早起', day }).reason, 'already')
  assert.equal(checkHabit(root, 'a1', { key: '1', day: '2026-11-01' }).streak, 2)
  assert.equal(checkHabit(root, 'a1', { key: '早起', day: '2026-11-02' }).streak, 3)
})

test('a missed day resets the streak, but today still has a chance', () => {
  const habit = { days: ['2026-10-28', '2026-10-29'] }
  // Today is 30th and nothing is checked yet: the run from yesterday still counts.
  assert.equal(streakOf(habit, '2026-10-30'), 2)
  // Two days later, yesterday was missed: the streak is gone.
  assert.equal(streakOf(habit, '2026-10-31'), 0)
  // Checking today continues yesterday's run.
  assert.equal(streakOf({ days: [...habit.days, '2026-10-30'] }, '2026-10-30'), 3)
})

test('the best streak survives a later gap, and the week counts the last seven days', () => {
  const habit = { days: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-10', '2026-10-25', '2026-10-30'] }
  assert.equal(bestStreakOf(habit, '2026-10-31'), 3)
  assert.equal(weekCount(habit, '2026-10-31'), 2, 'the 25th and the 30th inside 25..31')
  assert.equal(weekCount({ days: ['2026-10-24'] }, '2026-10-31'), 0, 'eight days ago is outside')
})

test('a day key is a local date, not a UTC one', () => {
  const at = new Date(2026, 9, 31, 0, 30).getTime()
  assert.equal(dayKey(at), '2026-10-31')
})

test('the list reads as streaks, and an empty list teaches the syntax', () => {
  assert.match(formatHabits([], { today: '2026-10-31' }), /还没有习惯。发 \/habit add 早起/)
  const text = formatHabits([
    { name: '早起', days: ['2026-10-30', '2026-10-31'] },
    { name: '跑步', days: [] },
  ], { today: '2026-10-31' })
  assert.match(text, /习惯 · 今天 1\/2/)
  assert.match(text, /1\. ✅ 早起 · 连续 2 天 · 本周 2\/7/)
  assert.match(text, /2\. ⬜ 跑步 · 连续 0 天 · 本周 0\/7/)
})

test('the digest line is one sentence, and empty when nothing is tracked', () => {
  assert.equal(habitDigestLine([], { today: '2026-10-31' }), '')
  const line = habitDigestLine([
    { name: '早起', days: ['2026-10-31'] },
    { name: '跑步', days: [] },
  ], { today: '2026-10-31' })
  assert.match(line, /^习惯打卡 1\/2：/)
  assert.match(line, /早起✅（连续 1 天）/)
  assert.match(line, /跑步⬜（连续 0 天）/)
})

test('the command handles add, done, list and rm without opening a session', () => {
  const root = tmpState()
  const now = () => new Date(2026, 9, 31, 9, 0).getTime()
  const commands = createHabitCommands({ stateRoot: root, accountId: 'a1', now })
  assert.match(commands.habit(''), /还没有习惯/)
  assert.match(commands.habit('add 早起'), /开始追踪：早起（第 1 个）/)
  assert.match(commands.habit(''), /习惯 · 今天 0\/1/)
  assert.match(commands.habit('done 早起'), /打卡成功：早起 · 连续 1 天 · 本周 1\/7/)
  assert.match(commands.habit('done 1'), /今天已经打过卡了：早起/)
  assert.match(commands.habit('done 没有这个'), /没有这个习惯/)
  assert.match(commands.habit('rm 早起'), /不再追踪：早起/)
  assert.match(commands.habit('rm 早起'), /没有这个习惯/)
  assert.match(commands.habit('乱写'), /用法：\/habit/)
  assert.equal(removeHabit(root, 'a1', { key: '早起' }).reason, 'missing')
})