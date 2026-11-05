import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendJournal, readJournal, describeDelivery, MAX_JOURNAL_TEXT_CHARS } from '../src/message/journal.js'
import { sendOutcome } from '../src/transport/ilink.js'

let root

before(() => {
	root = mkdtempSync(join(tmpdir(), 'journal-test-'))
})

after(() => {
	rmSync(root, { recursive: true, force: true })
})

test('append and read back newest-first', () => {
	appendJournal(root, { dir: 'in', accountId: 'a1', conversationId: 'c1', senderId: 's1', text: '你好', at: 1000 })
	appendJournal(root, { dir: 'out', accountId: 'a1', conversationId: 'c1', text: '回复', at: 2000 })
	const entries = readJournal(root)
	assert.equal(entries.length, 2)
	assert.equal(entries[0].text, '回复')
	assert.equal(entries[0].dir, 'out')
	assert.equal(entries[1].text, '你好')
	assert.equal(entries[1].senderId, 's1')
})

test('filter by accountId', () => {
	appendJournal(root, { dir: 'in', accountId: 'a2', conversationId: 'c2', senderId: 's2', text: '别的账号', at: 3000 })
	const only = readJournal(root, { accountId: 'a1' })
	assert.ok(only.every((entry) => entry.accountId === 'a1'))
	assert.ok(only.length >= 2)
	assert.ok(readJournal(root, { accountId: 'a2' }).some((entry) => entry.text === '别的账号'))
})

test('limit keeps the newest entries', () => {
	for (let i = 0; i < 8; i += 1) {
		appendJournal(root, { dir: 'in', accountId: 'a3', conversationId: 'c3', senderId: 's3', text: `第${i}条`, at: 4000 + i })
	}
	const last3 = readJournal(root, { limit: 3, accountId: 'a3' })
	assert.equal(last3.length, 3)
	assert.equal(last3[0].text, '第7条')
	assert.equal(last3[2].text, '第5条')
})

test('long text is truncated', () => {
	appendJournal(root, { dir: 'in', accountId: 'a4', conversationId: 'c4', senderId: 's4', text: 'x'.repeat(999), at: 6000 })
	const entry = readJournal(root, { accountId: 'a4' })[0]
	assert.equal(entry.text.length, MAX_JOURNAL_TEXT_CHARS)
})

test('append failures never throw and bad state roots read as empty', () => {
	const bogus = join(root, 'not-a-dir', 'file')
	// appending into an unwritable path must not throw
	assert.doesNotThrow(() => appendJournal(bogus, { dir: 'in', accountId: 'a', conversationId: 'c', text: 't', at: 7000 }, { warn: () => {} }))
	assert.deepEqual(readJournal(join(root, 'missing-root')), [])
})

test('torn lines are skipped', async () => {
	const fs = await import('node:fs')
	appendJournal(root, { dir: 'in', accountId: 'a5', conversationId: 'c5', senderId: 's5', text: '完好', at: 8000 })
	fs.mkdirSync(join(root, 'journal'), { recursive: true })
	fs.appendFileSync(join(root, 'journal', `journal-${new Date(8000).toISOString().slice(0, 10)}.jsonl`), '{"torn":\n')
	const entries = readJournal(root, { accountId: 'a5' })
	assert.ok(entries.some((entry) => entry.text === '完好'))
})

test('readJournal pages backwards with before, and filters by conversation', () => {
	appendJournal(root, { dir: 'in', accountId: 'a9', conversationId: 'cA', senderId: 's9', text: '旧', at: 100 })
	appendJournal(root, { dir: 'out', accountId: 'a9', conversationId: 'cA', text: '中', at: 200 })
	appendJournal(root, { dir: 'in', accountId: 'a9', conversationId: 'cB', senderId: 's9', text: '新', at: 300 })

	// before is strict: "everything older than what I already have", so the
	// card can page without re-reading the entry on screen.
	assert.deepEqual(readJournal(root, { before: 200 }).map((entry) => entry.at), [100])
	assert.deepEqual(readJournal(root, { before: 100 }), [], 'nothing older than the oldest')
	// Conversation filter is what the stats-row drill-down passes.
	assert.deepEqual(readJournal(root, { conversationId: 'cB' }).map((entry) => entry.text), ['新'])
	const both = readJournal(root, { conversationId: 'cA', before: 300 })
	assert.deepEqual(both.map((entry) => entry.text), ['中', '旧'], 'filters compose')
})

// issue #13: an `out` line used to be written before the send and never told
// anyone how the send ended, so "the agent wrote a reply" read as "the phone got
// one". The line now carries a provisional state and the outcome lands as a
// second line; the reader has to put them back together.
test('a reply records the send outcome, and the reader merges the pair', () => {
	appendJournal(root, { dir: 'out', accountId: 'a10', conversationId: 'c10', text: '在的', delivery: 'sending', phase: 'sending', at: 50_000 })
	appendJournal(root, { dir: 'out', accountId: 'a10', conversationId: 'c10', text: '', delivery: 'accepted', phase: 'settled', clientId: 'dsh-weixin-1-abcdefgh', messageId: 'srv-123456789', at: 50_001 })

	const entries = readJournal(root, { accountId: 'a10', conversationId: 'c10' })
	assert.equal(entries.length, 1, 'one message, not a blank bubble next to it')
	assert.equal(entries[0].text, '在的')
	assert.equal(entries[0].delivery, 'accepted')
	assert.equal(entries[0].messageId, 'srv-123456789', 'the id the phone can be matched against')
})

test('ret=0 without a message id is "unconfirmed", not a success', () => {
	assert.deepEqual(sendOutcome({ ret: 0 }, 'cid-1'), { direction: 'unconfirmed', clientId: 'cid-1', ret: 0 })
	assert.deepEqual(sendOutcome({ ret: 0, message_id: 'm-1' }, 'cid-2'), { direction: 'accepted', clientId: 'cid-2', ret: 0, messageId: 'm-1' })
})

test('a failed send nobody can retry stays visible on its own', () => {
	appendJournal(root, { dir: 'out', accountId: 'a11', conversationId: 'c11', text: '', delivery: 'queued', phase: 'settled', at: 60_000 })
	const entries = readJournal(root, { accountId: 'a11' })
	assert.equal(entries.length, 1)
	assert.equal(entries[0].delivery, 'queued')
	assert.equal(entries[0].text, '')
})

test('journal lines from before 1.5.10 have no delivery field and still read', () => {
	appendJournal(root, { dir: 'out', accountId: 'a12', conversationId: 'c12', text: '老日志', at: 70_000 })
	const [entry] = readJournal(root, { accountId: 'a12' })
	assert.equal(entry.text, '老日志')
	assert.equal(entry.delivery, undefined, 'never guesses "sent"')
	assert.equal(describeDelivery(entry), '')
})
