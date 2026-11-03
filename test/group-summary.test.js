import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_GROUP_SUMMARY_EVERY,
  DEFAULT_GROUP_SUMMARY_TTL_MINUTES,
  GROUP_RING_MAX,
  MAX_SUMMARY_CHARS,
  buildGroupSummaryBlock,
  createGroupSummaries,
  groupSummaryFile,
  groupSummaryPrompt,
  readAccountGroupSummaries,
  readGroupSummary,
} from '../src/message/group-summary.js'

const ACCOUNT = 'bot1'
const GROUP = 'group:123'

function stateRootOf() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-group-'))
}

test('the summarization prompt asks for three sentences and nothing invented', () => {
  const prompt = groupSummaryPrompt(['小明：周五打球吗', '小红：我加班'])
  assert.match(prompt, /不超过三句话/)
  assert.match(prompt, /不要推测/)
  assert.match(prompt, /小明：周五打球吗/)
  assert.match(prompt, /小红：我加班/)
})

test('the prompt block carries a fresh summary and drops a stale one', () => {
  const now = new Date(2026, 10, 4, 12, 0).getTime()
  const fresh = buildGroupSummaryBlock({ summary: '大家在约周五打球，小红要加班。', at: now - 20 * 60_000 }, { now })
  assert.match(fresh, /^<weixin_group_summary at="20 分钟前">/)
  assert.match(fresh, /群里最近聊到：大家在约周五打球/)
  assert.match(fresh, /<\/weixin_group_summary>$/)

  assert.equal(buildGroupSummaryBlock(undefined, { now }), '', 'nothing stored -> no block')
  assert.equal(buildGroupSummaryBlock({ summary: '   ', at: now }, { now }), '', 'blank -> no block')

  const stale = buildGroupSummaryBlock(
    { summary: '上周的事', at: now - (DEFAULT_GROUP_SUMMARY_TTL_MINUTES + 1) * 60_000 },
    { now },
  )
  assert.equal(stale, '', 'a three-day-old summary must not pretend to be context')

  const justNow = buildGroupSummaryBlock({ summary: '刚说完', at: now - 20_000 }, { now })
  assert.match(justNow, /at="刚刚"/)
})

test('group chatter accumulates in the ring until a batch is due', () => {
  const stateRoot = stateRootOf()
  const summaries = createGroupSummaries({ stateRoot, now: () => 1_700_000_000_000 })
  try {
    for (let index = 1; index < DEFAULT_GROUP_SUMMARY_EVERY; index += 1) {
      summaries.note(ACCOUNT, GROUP, { sender: '小明', text: `第 ${index} 句` })
      assert.equal(summaries.due(ACCOUNT, GROUP).due, false, `not due at ${index}`)
    }
    const last = summaries.note(ACCOUNT, GROUP, { sender: '小红', text: '最后一句' })
    assert.equal(last.count, DEFAULT_GROUP_SUMMARY_EVERY)
    const batch = summaries.due(ACCOUNT, GROUP)
    assert.equal(batch.due, true)
    assert.equal(batch.lines.length, DEFAULT_GROUP_SUMMARY_EVERY)
    assert.match(batch.lines[0], /^小明：第 1 句$/)
    assert.match(batch.lines.at(-1), /^小红：最后一句$/)

    // An empty message is not chatter.
    const before = summaries.due(ACCOUNT, GROUP).count
    assert.equal(summaries.note(ACCOUNT, GROUP, { sender: '小明', text: '   ' }).count, 0)
    assert.equal(summaries.due(ACCOUNT, GROUP).count, before)
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('the ring keeps the newest lines and never grows without bound', () => {
  const stateRoot = stateRootOf()
  const summaries = createGroupSummaries({ stateRoot })
  try {
    for (let index = 0; index < GROUP_RING_MAX + 10; index += 1) {
      summaries.note(ACCOUNT, GROUP, { sender: '小明', text: `第 ${index} 句` })
    }
    const { lines } = summaries.due(ACCOUNT, GROUP)
    assert.equal(lines.length, GROUP_RING_MAX)
    assert.match(lines[0], /第 10 句/)
    assert.match(lines.at(-1), new RegExp(`第 ${GROUP_RING_MAX + 9} 句`))
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('saving a summary resets the batch and survives a reload', () => {
  const stateRoot = stateRootOf()
  try {
    const summaries = createGroupSummaries({ stateRoot, now: () => 1_700_000_000_000 })
    summaries.note(ACCOUNT, GROUP, { sender: '小明', text: '周五打球吗' })
    summaries.save(ACCOUNT, GROUP, { summary: '大家在约周五打球。', covered: 1 })

    const stored = readGroupSummary(stateRoot, ACCOUNT, GROUP)
    assert.equal(stored.summary, '大家在约周五打球。')
    assert.equal(stored.sinceSummary, 0)
    assert.equal(summaries.due(ACCOUNT, GROUP).due, false, 'a fresh summary starts the next batch')
    assert.deepEqual(summaries.due(ACCOUNT, GROUP).lines, [], 'the ring was handed over to the summary')

    // A summary for another conversation or account does not leak.
    assert.equal(readGroupSummary(stateRoot, ACCOUNT, 'group:456'), undefined)
    assert.equal(readGroupSummary(stateRoot, 'bot2', GROUP), undefined)
    assert.deepEqual(Object.keys(readAccountGroupSummaries(stateRoot, ACCOUNT)), [GROUP])

    // Reloaded from disk: the file is the record, not the in-memory ring.
    const reloaded = createGroupSummaries({ stateRoot })
    assert.match(reloaded.due(ACCOUNT, GROUP).due === false ? 'idle' : 'due', /idle/)
    assert.equal(readGroupSummary(stateRoot, ACCOUNT, GROUP).summary, '大家在约周五打球。')

    // Saving an empty result leaves the previous summary alone.
    assert.equal(summaries.save(ACCOUNT, GROUP, { summary: '  ' }), undefined)
    assert.equal(readGroupSummary(stateRoot, ACCOUNT, GROUP).summary, '大家在约周五打球。')

    // And an over-long one is clipped so it cannot crowd out the real context.
    summaries.save(ACCOUNT, GROUP, { summary: 'x'.repeat(MAX_SUMMARY_CHARS + 200) })
    assert.equal(readGroupSummary(stateRoot, ACCOUNT, GROUP).summary.length, MAX_SUMMARY_CHARS)
    assert.ok(fs.statSync(groupSummaryFile(stateRoot)).isFile())
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})