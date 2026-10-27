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
	addEvent,
	removeEvent,
	completeEvent,
	saveProfile,
	setDigest,
	replaceFacts,
	formatProfile,
	formatEvents,
	DEFAULT_MEMORY_GLOBAL_MAX_FACTS,
  openThreadLines,
} from '../src/memory.js'
import { estimateTokens } from '../src/tokens.js'
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
	assert.deepEqual(readGlobalMemory(dir, 'bot@im.bot', { warn }), { facts: [], profile: { call: '', schedule: '', likes: [], dislikes: [], dates: [] }, events: [], digest: '', digestAt: 0, superseded: [] })
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
	assert.deepEqual(readGlobalMemory(dir, 'b@im.bot', { warn }), { facts: [], profile: { call: '', schedule: '', likes: [], dislikes: [], dates: [] }, events: [], digest: '', digestAt: 0, superseded: [] })
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

test('the structured profile merges only known fields and unions the lists', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mem-profile-'))
	const saved = saveProfile(dir, 'bot1', { call: '  小满 ', schedule: '夜里两点睡', gender: 'female' })
	assert.equal(saved.ok, true)
	assert.equal(saved.profile.call, '小满')
	assert.equal('gender' in saved.profile, false, 'an unknown key never lands in the file')
	saveProfile(dir, 'bot1', { likes: ['猫', '咖啡'] })
	const merged = saveProfile(dir, 'bot1', { likes: ['猫', '下雨天'], dislikes: ['香菜'] })
	assert.deepEqual(merged.profile.likes, ['猫', '下雨天'], 'an explicit edit replaces the list it names')
	assert.deepEqual(merged.profile.dislikes, ['香菜'])
	assert.equal(merged.profile.schedule, '夜里两点睡', 'a later patch does not erase the earlier fields')
	const again = saveProfile(dir, 'bot1', { dates: [{ label: '生日', date: '1998-03-04' }, { label: '坏日期', date: '3月4日' }] })
	assert.deepEqual(again.profile.dates, [{ label: '生日', date: '1998-03-04' }])
	const lines = formatProfile(again.profile)
	assert.equal(lines.some((line) => line.includes('称呼：小满')), true)
	assert.equal(lines.some((line) => line.includes('喜欢：猫、下雨天')), true)
	assert.equal(lines.some((line) => line.includes('重要日期：生日 1998-03-04')), true)
	rmSync(dir, { recursive: true, force: true })
})

test('events: add, refuse duplicates, complete and remove by number, prune the stale', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mem-events-'))
	const now = Date.parse('2026-10-27T10:00:00')
	assert.deepEqual(addEvent(dir, 'bot1', { text: '   ' }, { now }), { added: false, reason: 'empty' })
	assert.deepEqual(addEvent(dir, 'bot1', { text: '明天去体检', when: '2026-10-28' }, { now }), { added: true })
	assert.deepEqual(addEvent(dir, 'bot1', { text: '明天去体检', when: '2026-10-28' }, { now }), { added: false, reason: 'duplicate' })
	addEvent(dir, 'bot1', { text: '买猫粮' }, { now })
	let store = readGlobalMemory(dir, 'bot1', { now })
	assert.deepEqual(formatEvents(store.events), ['- · [2026-10-28] 明天去体检', '- · 买猫粮'])
	assert.deepEqual(completeEvent(dir, 'bot1', 2, { now }), { done: true, text: '买猫粮' })
	assert.deepEqual(removeEvent(dir, 'bot1', 1, { now }), { removed: true, text: '明天去体检' })
	assert.deepEqual(removeEvent(dir, 'bot1', 9, { now }), { removed: false, reason: 'no-such-index' })
	store = readGlobalMemory(dir, 'bot1', { now })
	assert.deepEqual(formatEvents(store.events), ['- ✅ 买猫粮'])

	addEvent(dir, 'bot1', { text: '上周体检', when: '2026-10-20' }, { now })
	addEvent(dir, 'bot1', { text: '前天体检', when: '2026-10-26' }, { now })
	store = readGlobalMemory(dir, 'bot1', { now })
	const texts = store.events.map((event) => event.text)
	assert.equal(texts.includes('上周体检'), false, 'a date long past is pruned rather than remembered forever')
	assert.equal(texts.includes('前天体检'), true, 'the grace window keeps yesterday-ish events')
	rmSync(dir, { recursive: true, force: true })
})

test('the digest leads the block, the profile follows, and the budget squeezes facts', () => {
	const digest = '小满是杭州人，夜里两点睡，养了一只猫，最近在学做饭。'
	const profile = { call: '小满', schedule: '夜里两点睡', likes: ['猫'], dislikes: [], dates: [] }
	const facts = [
		{ text: '随身带伞', at: 1, weight: 1 },
		{ text: '对花生过敏', at: 2, weight: 5 },
		{ text: '住在杭州西湖区', at: 3, weight: 3 },
	]
	const block = buildMemoryBlock({ global: { facts, profile, events: [{ text: '体检', when: '2026-10-28', done: false, at: 1 }], digest }, recent: [] })
	const lines = block.split('\n')
	assert.equal(lines[1], '【长期记忆 · 关于用户】')
	assert.equal(lines[2], digest, 'the digest is the first thing the model reads')
	assert.ok(block.includes('- 称呼：小满'))
	assert.ok(block.includes('【事件与待办】\n- · [2026-10-28] 体检'))
	// Importance, not insertion order.
	const allergyAt = block.indexOf('对花生过敏')
	const umbrellaAt = block.indexOf('随身带伞')
	assert.ok(allergyAt > 0 && allergyAt < umbrellaAt, 'a weight-5 fact precedes a weight-1 one')
	// A tight budget keeps the digest and drops facts tail-first.
	const longDigest = '小满'.repeat(100)
	const tight = buildMemoryBlock({ global: { facts, profile, events: [], digest: longDigest }, recent: [], maxChars: longDigest.length })
	assert.ok(tight.includes(longDigest))
	assert.equal(tight.includes('对花生过敏'), false, 'a budget that only fits the digest keeps only the digest')
	assert.equal(tight.includes('称呼：'), false)
})

test('openThreadLines offers open threads, and nothing when it knows nothing', () => {
  assert.deepEqual(openThreadLines({ events: [], digest: '' }, {}, 0), [])
  assert.deepEqual(openThreadLines(undefined, undefined, 0), [])

  const global = {
    events: [
      { text: '周五要交的方案', when: '2026-10-30', done: false },
      { text: '已经做完的事', when: '2026-10-20', done: true },
      { text: '给他带的书', when: '', done: false },
    ],
    digest: '在读一本关于灯塔的书。',
  }
  const lines = openThreadLines(global, {}, 0)
  assert.equal(lines[0], '<weixin_threads>')
  assert.equal(lines.at(-1), '</weixin_threads>')
  assert.ok(lines.some((line) => line.includes('[2026-10-30] 周五要交的方案')), 'a dated open event is offered')
  assert.ok(lines.some((line) => line.includes('给他带的书')), 'an undated open event is offered')
  assert.ok(lines.every((line) => line.includes('已经做完的事') === false), 'a finished event is not a topic')
  assert.ok(lines.some((line) => line.includes('灯塔')), 'the digest is offered as background')

  const fallback = openThreadLines({ events: [], digest: '' }, { summary: '上次在讨论周末去哪儿。' }, 0)
  assert.ok(fallback.some((line) => line.includes('周末去哪儿')), 'with no events, the conversation summary stands in')
})

test('a token budget stops the memory list before a character budget would', () => {
  const global = {
    facts: Array.from({ length: 12 }, (_, index) => ({ text: `关于我的第${index}条偏好说明`, at: index })),
    profile: { call: '小周', schedule: '', likes: [], dislikes: [], dates: [] },
  }
  const byChars = buildMemoryBlock({ global, conv: undefined, recent: [], now: 0, maxChars: 5000 })
  const byTokens = buildMemoryBlock({ global, conv: undefined, recent: [], now: 0, maxChars: 5000, maxTokens: 30 })
  assert.ok(estimateTokens(byTokens) <= estimateTokens(byChars), 'the token cap must not grow the block')
  assert.ok(byTokens.length < byChars.length, 'Chinese text hits the token cap well before the character cap')
  assert.equal(buildMemoryBlock({ global, conv: undefined, recent: [], now: 0, maxChars: 5000, maxTokens: 0 }).length, byChars.length, 'zero means no token cap')
})

test('a fact can replace the one it contradicts, and the old text is kept as history', () => {
	const dir = join(root, 'supersede')
	addGlobalFact(dir, 'a@im.bot', '用户住在北京', { warn, now: 1000 })
	const result = addGlobalFact(dir, 'a@im.bot', '用户搬到杭州了，住在杭州', { warn, now: 2000, supersedes: ['用户住在北京'] })
	assert.equal(result.added, true)
	assert.deepEqual(result.superseded, ['用户住在北京'])
	const store = readGlobalMemory(dir, 'a@im.bot', { warn })
	assert.deepEqual(store.facts.map((fact) => fact.text), ['用户搬到杭州了，住在杭州'])
	assert.deepEqual(store.superseded, [{ text: '用户住在北京', at: 2000, by: '用户搬到杭州了，住在杭州' }])
})

test('supersede matching is loose about wording and keeps the newest fact only', () => {
	const dir = join(root, 'supersede-loose')
	addGlobalFact(dir, 'b@im.bot', '用户不喜欢吃香菜', { warn, now: 1000 })
	addGlobalFact(dir, 'b@im.bot', '用户讨厌香菜', { warn, now: 1100 })
	// The new text is longer than the old one, so a substring match in either
	// direction is what makes a paraphrase still land.
	const result = addGlobalFact(dir, 'b@im.bot', '用户现在能吃香菜了', { warn, now: 2000, supersedes: ['不喜欢吃香菜'] })
	assert.equal(result.added, true)
	assert.deepEqual(result.superseded, ['用户不喜欢吃香菜'])
	const texts = readGlobalMemory(dir, 'b@im.bot', { warn }).facts.map((fact) => fact.text)
	assert.ok(texts.includes('用户讨厌香菜'), 'an unrelated fact with no matching words survives')
	assert.ok(!texts.includes('用户不喜欢吃香菜'))
})

test('superseding on a full store still works: the correction is not refused by the cap', () => {
	const dir = join(root, 'supersede-cap')
	for (let index = 0; index < 3; index += 1) {
		addGlobalFact(dir, 'c@im.bot', `第 ${index} 条事实`, { warn, now: 1000 + index, maxFacts: 3 })
	}
	const blocked = addGlobalFact(dir, 'c@im.bot', '第 4 条', { warn, now: 2000, maxFacts: 3 })
	assert.deepEqual(blocked, { added: false, reason: 'cap' })
	const result = addGlobalFact(dir, 'c@im.bot', '第 0 条事实（已更新）', { warn, now: 2000, maxFacts: 3, supersedes: ['第 0 条事实'] })
	assert.equal(result.added, true)
	const texts = readGlobalMemory(dir, 'c@im.bot', { warn }).facts.map((fact) => fact.text)
	assert.equal(texts.length, 3)
	assert.ok(texts.includes('第 0 条事实（已更新）'))
	assert.ok(!texts.includes('第 0 条事实'))
})
