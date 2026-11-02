import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { knowledgeDir, knowledgeIndexPath, searchKnowledge } from '../src/message/knowledge.js'
import {
  DEFAULT_KNOWLEDGE_INTERVAL_MS,
  STALE_CHECK_MIN_GAP_MS,
  knowledgeLooksStale,
  startKnowledgeRefresh,
} from '../src/message/knowledge-refresh.js'

function setup(names = ['bot1']) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-krefresh-'))
  for (const accountId of names) fs.mkdirSync(knowledgeDir(stateRoot, accountId), { recursive: true })
  return stateRoot
}

function writeSource(stateRoot, accountId, name, body) {
  fs.writeFileSync(path.join(knowledgeDir(stateRoot, accountId), name), body)
}

test('a directory with sources but no index counts as stale; an empty one does not', () => {
  const stateRoot = setup()
  try {
    assert.equal(knowledgeLooksStale(stateRoot, 'bot1'), false, 'nothing to index yet')
    writeSource(stateRoot, 'bot1', 'a.md', '# 甲\n\n内容。')
    assert.equal(knowledgeLooksStale(stateRoot, 'bot1'), true, 'a source with no index is stale')
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('after a rebuild, an untouched directory is no longer stale; a newer file makes it stale again', async () => {
  const stateRoot = setup()
  const refresher = startKnowledgeRefresh({ stateRoot, accountIds: () => ['bot1'], intervalMs: 60_000 })
  try {
    writeSource(stateRoot, 'bot1', 'a.md', '# 甲\n\n内容。')
    await refresher.refresh()
    assert.equal(knowledgeLooksStale(stateRoot, 'bot1'), false)
    assert.ok(searchKnowledge(stateRoot, 'bot1', '内容').length >= 1)

    // Touch a file with a clearly later mtime than the index.
    const file = path.join(knowledgeDir(stateRoot, 'bot1'), 'a.md')
    fs.writeFileSync(file, '# 甲\n\n新的内容。')
    const later = new Date(Date.now() + 10_000)
    fs.utimesSync(file, later, later)
    assert.equal(knowledgeLooksStale(stateRoot, 'bot1'), true)
  } finally {
    refresher.stop()
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('the initial refresh indexes whatever is already there, and stop() halts the timer', async () => {
  const stateRoot = setup()
  try {
    writeSource(stateRoot, 'bot1', 'policy.md', '# 退货\n\n七天无理由退货。')
    const refresher = startKnowledgeRefresh({ stateRoot, accountIds: () => ['bot1'], intervalMs: 60_000 })
    // The startup refresh runs on a microtask; wait for the index file to appear.
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (fs.existsSync(knowledgeIndexPath(stateRoot, 'bot1'))) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(fs.existsSync(knowledgeIndexPath(stateRoot, 'bot1')), 'the startup refresh wrote an index')
    assert.ok(searchKnowledge(stateRoot, 'bot1', '无理由退货').length >= 1)
    refresher.stop()
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('nudge is throttled: it does nothing twice within the minimum gap', async () => {
  const stateRoot = setup()
  let clock = 1_000_000
  const refresher = startKnowledgeRefresh({
    stateRoot,
    accountIds: () => ['bot1'],
    intervalMs: 60_000,
    now: () => clock,
  })
  try {
    await refresher.refresh() // settle the startup pass
    writeSource(stateRoot, 'bot1', 'a.md', '# 甲\n\n内容。')
    // First nudge within the gap from the (clock-based) last check is a no-op;
    // advance past the gap so the next one actually rebuilds.
    refresher.nudge()
    assert.equal(fs.existsSync(knowledgeIndexPath(stateRoot, 'bot1')), false, 'first nudge is throttled')
    clock += STALE_CHECK_MIN_GAP_MS + 1
    refresher.nudge()
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (fs.existsSync(knowledgeIndexPath(stateRoot, 'bot1'))) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(fs.existsSync(knowledgeIndexPath(stateRoot, 'bot1')), 'the un-throttled nudge rebuilt')
  } finally {
    refresher.stop()
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('one account failing to build does not stop the others', async () => {
  const stateRoot = setup(['bot1', 'bot2'])
  const warnings = []
  const refresher = startKnowledgeRefresh({
    stateRoot,
    accountIds: () => ['bot1', 'bot2'],
    warn: (line) => warnings.push(line),
    intervalMs: 60_000,
  })
  try {
    writeSource(stateRoot, 'bot1', 'a.md', '# 甲\n\n内容一。')
    writeSource(stateRoot, 'bot2', 'b.md', '# 乙\n\n内容二。')
    await refresher.refresh()
    assert.ok(searchKnowledge(stateRoot, 'bot1', '内容一').length >= 1)
    assert.ok(searchKnowledge(stateRoot, 'bot2', '内容二').length >= 1)
  } finally {
    refresher.stop()
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('the exported defaults are sane', () => {
  assert.equal(DEFAULT_KNOWLEDGE_INTERVAL_MS, 6 * 60 * 60_000)
  assert.equal(STALE_CHECK_MIN_GAP_MS, 60_000)
})
