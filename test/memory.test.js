import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	addGlobalFact,
	setConvRecentSession,
	readGlobalMemory,
	bumpTurnAndBond,
	bondLine,
	moodFor,
	removeGlobalFact,
	readConvMemory,
	setConvSummary,
	setConvTurn,
	clearConvMemory,
	readRecentWindow,
	buildMemoryBlock,
	DEFAULT_MEMORY_GLOBAL_MAX_FACTS,
} from '../src/memory.js'
import { appendJournal } from '../src/message/journal.js'

let root
const warns = []
const warn = (line) => warns.push(line)

before(() => {
	root = mkdtempSync(join(tmpdir(), 'memory-test-'))
})

after(() => {
	rmSync(root, { recursive: true, force: true })
})

test('global facts: add, read back, duplicate refused', () => {
	const dir = join(root, 'global')
	assert.deepEqual(readGlobalMemory(dir, 'bot@im.bot', { warn }), { facts: [] })
	assert.deepEqual(addGlobalFact(dir, 'bot@im.bot', '用户对花生过敏', { warn }), { added: true })
	assert.deepEqual(addGlobalFact(dir, 'bot@im.bot', '  用户对花生过敏  ', { warn }), { added: false, reason: 'duplicate' })
	assert.deepEqual(addGlobalFact(dir, 'bot@im.bot', '', { warn }), { added: false, reason: 'empty' })
	const { facts } = readGlobalMemory(dir, 'bot@im.bot', { warn })
	assert.equal(facts.length, 1)
	assert.equal(facts[0].text, '用户对花生过敏')
	assert.equal(typeof facts[0].at, 'number')
})

test('global facts: cap refuses instead of silently dropping the oldest', () => {
	const dir = join(root, 'cap')
	for (let i = 1; i <= DEFAULT_MEMORY_GLOBAL_MAX_FACTS; i += 1) {
		assert.deepEqual(addGlobalFact(dir, 'a', `fact ${i}`, { warn }), { added: true })
	}
	const result = addGlobalFact(dir, 'a', 'one fact too many', { warn })
	assert.deepEqual(result, { added: false, reason: 'cap' })
	assert.equal(readGlobalMemory(dir, 'a', { warn }).facts.length, DEFAULT_MEMORY_GLOBAL_MAX_FACTS)
	assert.equal(readGlobalMemory(dir, 'a', { warn }).facts[0].text, 'fact 1', 'oldest kept')
})

test('global facts: remove by 1-based index', () => {
	const dir = join(root, 'remove')
	addGlobalFact(dir, 'a', 'first', { warn })
	addGlobalFact(dir, 'a', 'second', { warn })
	assert.deepEqual(removeGlobalFact(dir, 'a', 1, { warn }), { removed: true, text: 'first' })
	assert.deepEqual(removeGlobalFact(dir, 'a', 9, { warn }), { removed: false, reason: 'no-such-index' })
	assert.deepEqual(removeGlobalFact(dir, 'a', 0, { warn }), { removed: false, reason: 'no-such-index' })
	assert.deepEqual(readGlobalMemory(dir, 'a', { warn }).facts.map((f) => f.text), ['second'])
})

test('conversation memory: summary/turn set, clear resets', () => {
	const dir = join(root, 'conv')
	assert.deepEqual(readConvMemory(dir, 'b@im.bot', 'c@im.wechat', { warn }), { summary: '', facts: [], updatedTurn: 0 })
	setConvSummary(dir, 'b@im.bot', 'c@im.wechat', '用户在准备周四的面试，聊了简历和自我介绍', { warn })
	setConvTurn(dir, 'b@im.bot', 'c@im.wechat', 12, { warn })
	assert.equal(readConvMemory(dir, 'b@im.bot', 'c@im.wechat', { warn }).summary, '用户在准备周四的面试，聊了简历和自我介绍')
	assert.equal(readConvMemory(dir, 'b@im.bot', 'c@im.wechat', { warn }).updatedTurn, 12)
	clearConvMemory(dir, 'b@im.bot', 'c@im.wechat', { warn })
	assert.deepEqual(readConvMemory(dir, 'b@im.bot', 'c@im.wechat', { warn }), { summary: '', facts: [], updatedTurn: 0 })
})

test('conversation memory: summary is clamped to maxChars', () => {
	const dir = join(root, 'clamp')
	setConvSummary(dir, 'b', 'c', 'x'.repeat(5000), { warn, maxChars: 100 })
	assert.equal(readConvMemory(dir, 'b', 'c', { warn }).summary.length, 100)
})

test('recent window comes from the journal, clamped and ordered old→new', () => {
	const dir = join(root, 'recent')
	const acct = 'b@im.bot'
	const conv = 'c@im.wechat'
	for (let i = 1; i <= 8; i += 1) {
		appendJournal(dir, { dir: 'in', accountId: acct, conversationId: conv, text: `用户消息 ${i}`, at: i * 1000 })
		appendJournal(dir, { dir: 'out', accountId: acct, conversationId: conv, text: `回复 ${i}`, at: i * 1000 + 500 })
	}
	appendJournal(dir, { dir: 'in', accountId: 'other', conversationId: conv, text: '别的会话', at: 9000 })
	const window = readRecentWindow(dir, acct, conv, { warn, turns: 3 })
	assert.equal(window.length, 6)
	assert.equal(window[0].text, '用户消息 6')
	assert.equal(window[5].text, '回复 8')
	assert.deepEqual(window.map((e) => e.dir), ['in', 'out', 'in', 'out', 'in', 'out'])
	const clamped = readRecentWindow(dir, acct, conv, { warn, turns: 1, textChars: 5 })
	assert.equal(clamped.length, 2, 'a turn is one in+out pair')
	assert.ok(clamped.every((e) => e.text.length <= 5), JSON.stringify(clamped))
	assert.equal(clamped[1].text, '回复 8'.slice(0, 5))
})

test('the message being answered is excluded from its own window', () => {
	const dir = join(root, 'exclude')
	const acct = 'e@im.bot'
	const conv = 'e@im.wechat'
	appendJournal(dir, { dir: 'in', accountId: acct, conversationId: conv, text: '在吗', at: 1000 })
	appendJournal(dir, { dir: 'out', accountId: acct, conversationId: conv, text: '在的', at: 2000 })
	// The inbound journal write happens before the prompt is built, so the
	// newest entry IS the message being answered: it must not be repeated.
	appendJournal(dir, { dir: 'in', accountId: acct, conversationId: conv, text: '晚上吃啥好', at: 3000 })

	const window = readRecentWindow(dir, acct, conv, { warn, turns: 5, excludeText: '晚上吃啥好' })
	assert.deepEqual(window.map((e) => e.text), ['在吗', '在的'], 'the current message is dropped, the rest survives')
	// A different current message (or none at all) leaves the newest entry alone.
	assert.equal(readRecentWindow(dir, acct, conv, { warn, turns: 5 }).length, 3)
	assert.equal(readRecentWindow(dir, acct, conv, { warn, turns: 5, excludeText: '不是你' }).length, 3)
	// Only the NEWEST inbound entry is dropped — an older identical message stays.
	appendJournal(dir, { dir: 'in', accountId: acct, conversationId: conv, text: '在吗', at: 4000 })
	const reordered = readRecentWindow(dir, acct, conv, { warn, turns: 5, excludeText: '在吗' })
	assert.deepEqual(reordered.map((e) => e.text), ['在吗', '在的', '晚上吃啥好'], 'older duplicate kept')
})

test('the injected line is remembered, so only a cold line pays for the window', () => {
	const dir = join(root, 'coldline')
	const acct = 'l@im.bot'
	const conv = 'l@im.wechat'
	assert.equal(readConvMemory(dir, acct, conv, { warn }).recentSessionId, undefined, 'no key before any injection')
	assert.equal(setConvRecentSession(dir, acct, conv, 'sess-a', { warn }), true)
	assert.equal(readConvMemory(dir, acct, conv, { warn }).recentSessionId, 'sess-a')
	// An empty id is not a line: refuse rather than write a useless marker.
	assert.equal(setConvRecentSession(dir, acct, conv, '', { warn }), false)
	assert.equal(readConvMemory(dir, acct, conv, { warn }).recentSessionId, 'sess-a')
	// The marker rides alongside the rest of the file instead of replacing it.
	setConvSummary(dir, acct, conv, '聊到了搬家', { warn })
	setConvRecentSession(dir, acct, conv, 'sess-b', { warn })
	const conv2 = readConvMemory(dir, acct, conv, { warn })
	assert.equal(conv2.summary, '聊到了搬家')
	assert.equal(conv2.recentSessionId, 'sess-b')
})

test('buildMemoryBlock: sections, omission, and the empty case costs nothing', () => {
	assert.equal(buildMemoryBlock({}), '')
	assert.equal(buildMemoryBlock(undefined), '')
	const block = buildMemoryBlock({
		global: { facts: [{ text: '对花生过敏', at: 1 }] },
		conv: { summary: '在聊面试', facts: [{ text: '目标岗位是后端', at: 2 }], updatedTurn: 3 },
		recent: [
			{ dir: 'in', text: '帮我看看简历' },
			{ dir: 'out', text: '好啊，发来看看' },
		],
	})
	assert.match(block, /^<weixin_memory>/)
	assert.match(block, /【长期记忆 · 关于用户】\n- 对花生过敏/)
	assert.match(block, /【本会话记忆】\n摘要：在聊面试\n- 目标岗位是后端/)
	assert.match(block, /【最近消息】\n用户：帮我看看简历\n助手：好啊，发来看看/)
	assert.equal((block.match(/<weixin_memory>/g) ?? []).length, 1, 'one tag, no nesting')
	// No global facts → that section disappears entirely.
	const convOnly = buildMemoryBlock({ conv: { summary: '只有会话', facts: [], updatedTurn: 1 } })
	assert.doesNotMatch(convOnly, /长期记忆/)
	assert.doesNotMatch(convOnly, /最近消息/)
})

test('a broken memory file degrades to empty, not a throw', () => {
	const dir = join(root, 'broken')
	mkdirSync(join(dir, 'memory'), { recursive: true })
	writeFileSync(join(dir, 'memory', 'global-b@im.bot.json'), '{ broken')
	warns.length = 0
	assert.deepEqual(readGlobalMemory(dir, 'b@im.bot', { warn }), { facts: [] })
	assert.ok(warns.length === 1, `warned once: ${JSON.stringify(warns)}`)
})

test('bumpTurnAndBond counts days and messages, and derives the mood deterministically', () => {
	const a = 'bot1'; const c = 'conv-bond'
	// Morning of day one: first contact.
	const day1 = new Date('2026-10-26T09:00:00')
	let bumped = bumpTurnAndBond(root, a, c, { now: day1.getTime() })
	assert.equal(bumped.turn, 1)
	assert.equal(bumped.bond.firstDay, '2026-10-26')
	assert.equal(bumped.bond.msgs, 1)
	assert.equal(bumped.bond.msgsToday, 1)
	assert.equal(bumped.bond.mood, '刚认识', 'no prior message → the first-contact mood')
	// Same evening: the counters roll, the mood is the calm default.
	bumped = bumpTurnAndBond(root, a, c, { now: new Date('2026-10-26T20:00:00').getTime() })
	assert.equal(bumped.bond.msgs, 2)
	assert.equal(bumped.bond.msgsToday, 2)
	assert.equal(bumped.bond.mood, '平静')
	// A day and a half later: the per-day counter resets, the gap shows.
	bumped = bumpTurnAndBond(root, a, c, { now: new Date('2026-10-28T12:00:00').getTime() })
	assert.equal(bumped.bond.msgsToday, 1)
	assert.equal(bumped.bond.lastDate, '2026-10-28')
	assert.equal(bumped.bond.mood, '好久没聊，有点想你')
	const stored = readConvMemory(root, a, c)
	assert.equal(stored.bond.msgs, 3)
	assert.equal(stored.bond.firstDay, '2026-10-26')
	// The bond survives the summary write (separate fields in one file).
	setConvSummary(root, a, c, '聊过 bond')
	assert.equal(readConvMemory(root, a, c).bond.msgs, 3)
})

test('moodFor: late night, long gap, busy day, calm', () => {
	// Last message at noon → 10-27T15:00 is a 27h gap (past the 24h mood line).
	const prior = { msgs: 10, msgsToday: 3, lastMessageAt: new Date('2026-10-26T12:00:00').getTime() }
	assert.equal(moodFor(prior, new Date('2026-10-26T23:30:00').getTime()), '夜深了，还醒着')
	assert.equal(moodFor(prior, new Date('2026-10-27T02:00:00').getTime()), '夜深了，还醒着')
	assert.equal(moodFor(prior, new Date('2026-10-27T15:00:00').getTime()), '好久没聊，有点想你')
	assert.equal(moodFor({ ...prior, msgsToday: 19 }, new Date('2026-10-26T19:00:00').getTime()), '聊得很热络')
	assert.equal(moodFor(prior, new Date('2026-10-26T19:00:00').getTime()), '平静')
	assert.equal(moodFor({ msgs: 0, msgsToday: 0 }, new Date('2026-10-26T19:00:00').getTime()), '刚认识')
})

test('bondLine renders the one-liner; buildMemoryBlock leads with it', () => {
	const bond = { firstDay: '2026-10-01', msgs: 42, mood: '聊得很热络' }
	const now = new Date('2026-10-26T12:00:00').getTime()
	assert.equal(bondLine(bond, now), '我们认识第 26 天 · 聊过 42 条消息 · 此刻：聊得很热络')
	assert.equal(bondLine(undefined, now), '')
	assert.equal(bondLine({ firstDay: 'nope', msgs: 1 }, now), '')
	const block = buildMemoryBlock({ conv: { summary: '', facts: [], updatedTurn: 1, bond }, recent: [], now })
	assert.ok(block.startsWith('<weixin_memory>\n【我们】我们认识第 26 天'), block)
	const bare = buildMemoryBlock({ conv: { summary: 's', facts: [], updatedTurn: 1 }, recent: [] })
	assert.ok(!bare.includes('【我们】'), bare)
})
