import assert from 'node:assert/strict'
import test from 'node:test'

import { CONFIG_EFFECTS, describeConfigEffect, effectLabel, effectOf } from '../src/config-effect.js'
import { Config } from '../src/index.js'

test('every schema field has a stated effect, and no stale names linger', () => {
  const fields = Object.keys(Config.dict ?? {})
  assert.ok(fields.length > 50, 'the schema should have plenty of fields')
  const missing = fields.filter((field) => !(field in CONFIG_EFFECTS))
  assert.deepEqual(missing, [], 'a missing field would silently read as "applies immediately"')
  const extra = Object.keys(CONFIG_EFFECTS).filter((field) => !fields.includes(field))
  assert.deepEqual(extra, [], 'a renamed field would leave a stale row behind')
})

test('the restart list holds only what is built once at startup', () => {
  const restart = Object.entries(CONFIG_EFFECTS)
    .filter(([, kind]) => kind === 'restart')
    .map(([field]) => field)
    .sort()
  assert.deepEqual(restart, ['asr', 'eventPollMs', 'notifyPort', 'ocrTimeoutMs', 'sendIntervalMs', 'voiceOutbound'])
  // The hot path re-reads the saved file every message; these must therefore be live.
  for (const field of ['allowedSenders', 'proactiveEnabled', 'memoryEnabled', 'groupKeywords', 'senderDailyLimit']) {
    assert.equal(effectOf(field), 'live', `${field} is read on the hot path`)
  }
})

test('an unknown field is described as live rather than crashing', () => {
  assert.equal(effectOf('somethingFromAFutureVersion'), 'live')
  assert.equal(effectLabel('live').label, '保存即生效')
  assert.equal(effectLabel('restart').labelEn, 'takes effect after a restart')
})

test('the /config answer splits the fields, names the file, and says when it was saved', () => {
  const now = new Date(2026, 10, 1, 12, 0).getTime()
  const text = describeConfigEffect({
    fields: ['allowedSenders', 'proactiveEnabled', 'eventPollMs', 'notifyPort'],
    configFile: '/tmp/weixin/config.json',
    savedAt: now - 5 * 60_000,
    now,
  })
  assert.match(text, /配置一共 4 项：2 项保存即生效，2 项要重启。/)
  assert.match(text, /保存即生效（下一条消息就按新值走）：allowedSenders、proactiveEnabled/)
  assert.match(text, /重启 DSH 后才生效：eventPollMs、notifyPort/)
  assert.match(text, /存档：\/tmp\/weixin\/config\.json/)
  assert.match(text, /上次保存：5 分钟前/)
})

test('a config the card never saved says so instead of inventing a time', () => {
  const text = describeConfigEffect({ fields: ['allowedSenders'] })
  assert.match(text, /还没通过设置卡保存过，用的是默认值。/)
  assert.equal(text.includes('上次保存'), false)

  const long = describeConfigEffect({ fields: ['allowedSenders'], savedAt: Date.now() - 3 * 86_400_000 })
  assert.match(long, /上次保存：3 天前/)
})

test('the answer never claims a restart is needed for a live field', () => {
  const text = describeConfigEffect({ fields: ['allowedSenders', 'memoryEnabled'] })
  const restartLine = text.split('\n').find((line) => line.startsWith('· 重启 DSH 后才生效'))
  assert.match(restartLine, /（没有）/)
})
