import assert from 'node:assert/strict'
import test from 'node:test'

import { rankFacts } from '../src/memory.js'

const DAY = 24 * 60 * 60 * 1000

test('facts rank by importance, then by a banded recency that restating cannot reshuffle', () => {
  const now = Date.parse('2026-11-04T10:00:00+08:00')
  const facts = [
    { text: 'one year ago', weight: 1, at: now - 400 * DAY },
    { text: 'half a year ago', weight: 1, at: now - 200 * DAY },
    { text: 'this month', weight: 1, at: now - 2 * DAY },
    { text: 'yesterday', weight: 1, at: now - 1 * DAY },
    { text: 'pinned long ago', weight: 5, at: now - 900 * DAY },
  ]
  assert.deepEqual(rankFacts(facts, now).map((fact) => fact.text), [
    'pinned long ago',
    'yesterday',
    'this month',
    'half a year ago',
    'one year ago',
  ])
})

test('two confirmations inside the same month keep their order, even as the clock moves on', () => {
  const now = Date.parse('2026-11-04T10:00:00+08:00')
  const facts = [
    { text: 'mentioned three days ago', weight: 1, at: now - 3 * DAY, updatedAt: now - 3 * DAY },
    { text: 'mentioned twenty days ago', weight: 1, at: now - 20 * DAY, updatedAt: now - 20 * DAY },
  ]
  assert.deepEqual(rankFacts(facts, now).map((fact) => fact.text), ['mentioned three days ago', 'mentioned twenty days ago'])
  // A month later both are older than the band, so they fall into one bucket and
  // the exact timestamps decide — the older one never jumps ahead.
  assert.deepEqual(rankFacts(facts, now + 365 * DAY).map((fact) => fact.text), ['mentioned three days ago', 'mentioned twenty days ago'])
})

test('a fact with no timestamp at all sorts last among equal weights', () => {
  const now = Date.parse('2026-11-04T10:00:00+08:00')
  const facts = [{ text: 'undated', weight: 1 }, { text: 'dated', weight: 1, at: now - 400 * DAY }]
  assert.deepEqual(rankFacts(facts, now).map((fact) => fact.text), ['dated', 'undated'])
})
