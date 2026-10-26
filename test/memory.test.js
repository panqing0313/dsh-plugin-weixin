import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	addGlobalFact,
	readGlobalMemory,
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
