import assert from 'node:assert/strict'
import test from 'node:test'

import {
  KNOWN_MODEL_ERRORS,
  NOTICE_MAX_CHARS,
  classifyModelError,
  clearRecentModelErrors,
  describeModelError,
  noteModelError,
  oneLine,
  readRecentModelErrors,
  summarizeRecentModelErrors,
} from '../src/model-errors.js'

test('the error that was actually reported gets a sentence a user can act on', () => {
  // This is the exact string a real user received in WeChat (1.5.0, host
  // 0.2.1-rc.5): the provider name and the model name are both in it, and
  // neither fact alone tells the reader which option to change.
  const raw = 'pi-ai provider "magpie" has no configured model "auto/deepseek-v4.1-flash"'
  const info = classifyModelError(raw)
  assert.equal(info.kind, 'no-model')
  assert.equal(info.setting, 'chatModel')
  const text = describeModelError(raw)
  assert.match(text, /没有配置可用的模型/, 'the first line is the translation')
  assert.match(text, /chatModel/, 'and it names the option to change')
  assert.match(text, /原文：pi-ai provider/, 'the raw line survives, for whoever debugs it')
  assert.ok(text.includes('\n'), 'translation and raw line are on separate lines')
})

test('the raw line is capped, and a long one is truncated not dropped', () => {
  const long = `pi-ai provider "x" has no configured model "${'m'.repeat(400)}"`
  const text = describeModelError(long)
  assert.ok(text.length <= NOTICE_MAX_CHARS, `kept under the cap: ${text.length}`)
  assert.match(text, /…/, 'the truncation is visible')
  assert.match(text, /原文：/)
})

test('each known shape lands in its own bucket', () => {
  const cases = [
    ['401 Unauthorized: invalid api key', 'auth'],
    ['429 Too Many Requests', 'quota'],
    ['insufficient_quota: billing hard limit', 'quota'],
    ['This model\'s maximum context length is 128000 tokens', 'context'],
    ['ETIMEDOUT while calling provider', 'timeout'],
    ['fetch failed', 'network'],
    ['unknown provider "nope"', 'no-provider'],
  ]
  for (const [raw, kind] of cases) {
    assert.equal(classifyModelError(raw).kind, kind, raw)
  }
  assert.ok(KNOWN_MODEL_ERRORS.length >= 7)
})

test('an unrecognised error is not swallowed: same shape, no advice', () => {
  const info = classifyModelError('something new broke in an unexpected way')
  assert.equal(info.kind, 'unknown')
  assert.equal(info.setting, '')
  const text = describeModelError(info.raw)
  assert.match(text, /模型调用失败/)
  assert.match(text, /something new broke/)
  assert.match(text, /报给开发者/)
})

test('oneLine flattens control characters, so a stack trace cannot land in WeChat', () => {
  assert.equal(oneLine('a\nb\rc\td  e'), 'a b c d e')
  assert.equal(oneLine(new Error('boom\n second line')), 'Error: boom second line')
  assert.equal(oneLine(undefined), '')
  assert.equal(oneLine(Object.create(null)), '') /* String() would throw */
})

test('/diag gets one summarizing line, not the whole error', () => {
  clearRecentModelErrors()
  noteModelError('pi-ai provider "magpie" has no configured model "auto/x"', { at: 1000 })
  noteModelError('pi-ai provider "magpie" has no configured model "auto/y"', { at: 2000 })
  assert.equal(readRecentModelErrors().length, 2)
  const line = summarizeRecentModelErrors(readRecentModelErrors(), { now: 2000 + 5 * 60_000 })
  assert.match(line, /最近一次模型错误：5 分钟前/)
  assert.match(line, /没有配置可用的模型/)
  assert.match(line, /相关配置 chatModel/)
  assert.match(line, /最近 2 次失败都归到这一类/)
  assert.equal(summarizeRecentModelErrors([]), '')
})

test('the ring buffer forgets old errors; it is not an audit log', () => {
  clearRecentModelErrors()
  for (let i = 0; i < 25; i += 1) noteModelError(`error ${i}`)
  assert.equal(readRecentModelErrors().length, 20)
  assert.match(readRecentModelErrors().at(-1).raw, /error 24/)
})