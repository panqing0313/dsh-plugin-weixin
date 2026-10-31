import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MAX_TEMP_QUIET_MS,
  clearTempQuiet,
  describeTempQuiet,
  quietLabel,
  readTempQuiet,
  setTempQuiet,
  tempQuietDelay,
} from '../src/message/temp-quiet.js'

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-quiet-'))
}

const NOW = new Date(2026, 9, 31, 14, 0, 0).getTime()

test('a temporary quiet is stored, read and cleared', () => {
  const stateRoot = root()
  assert.equal(readTempQuiet(stateRoot, 'bot1', { now: NOW }), undefined)
  setTempQuiet(stateRoot, 'bot1', { until: NOW + 2 * 60 * 60_000, now: NOW })
  const quiet = readTempQuiet(stateRoot, 'bot1', { now: NOW + 10 * 60_000 })
  assert.equal(quiet.until, NOW + 2 * 60 * 60_000)
  assert.equal(quiet.remainingMs, 110 * 60_000)
  assert.equal(clearTempQuiet(stateRoot, 'bot1'), true)
  assert.equal(clearTempQuiet(stateRoot, 'bot1'), false)
  assert.equal(readTempQuiet(stateRoot, 'bot1', { now: NOW }), undefined)
})

test('it expires on its own and stays per account', () => {
  const stateRoot = root()
  setTempQuiet(stateRoot, 'bot1', { until: NOW + 60 * 60_000, now: NOW })
  assert.equal(readTempQuiet(stateRoot, 'bot1', { now: NOW + 61 * 60_000 }), undefined)
  assert.equal(tempQuietDelay(NOW, stateRoot, 'bot1'), 60 * 60_000)
  assert.equal(tempQuietDelay(NOW, stateRoot, 'bot2'), 0)
  assert.equal(tempQuietDelay(NOW, stateRoot, undefined), 0)
})

test('the span is bounded to one minute .. one day', () => {
  const stateRoot = root()
  assert.throws(() => setTempQuiet(stateRoot, 'bot1', { until: NOW + 30_000, now: NOW }), /between 1 minute and 24 hours/)
  assert.throws(() => setTempQuiet(stateRoot, 'bot1', { until: NOW + MAX_TEMP_QUIET_MS + 1, now: NOW }), /between 1 minute and 24 hours/)
  assert.doesNotThrow(() => setTempQuiet(stateRoot, 'bot1', { until: NOW + MAX_TEMP_QUIET_MS, now: NOW }))
})

test('the status reads like a sentence, including a crossing into tomorrow', () => {
  assert.equal(describeTempQuiet(undefined, NOW), '当前没有临时静默。')
  const sameDay = { until: NOW + 90 * 60_000, setAt: NOW, remainingMs: 90 * 60_000 }
  assert.match(describeTempQuiet(sameDay, NOW), /静默到 15:30（还剩约 90 分钟）/)
  const tomorrow = { until: new Date(2026, 10, 1, 1, 0, 0).getTime(), setAt: NOW, remainingMs: 0 }
  assert.match(describeTempQuiet(tomorrow, NOW), /明天 01:00/)
  assert.equal(quietLabel(NOW + 60 * 60_000, NOW), '15:00')
})
