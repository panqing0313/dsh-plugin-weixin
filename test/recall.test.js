import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendJournal } from '../src/message/journal.js'
import {
	buildRecallBlock,
	ensureIndex,
	formatRecallHits,
	indexFilePath,
	queryRecall,
	shouldRecall,
	tokenize,
} from '../src/message/recall.js'

const ACCOUNT = 'bot1'
const OTHER = 'bot2'
const DAY = 24 * 60 * 60 * 1000

function makeRoot() {
	return mkdtempSync(join(tmpdir(), 'recall-'))
}

function seed(root, entries) {
	for (const entry of entries) appendJournal(root, entry)
}

const NOW = new Date('2026-10-26T12:00:00').getTime()

test('tokenize: CJK runs become bigrams, latin words stay whole', () => {
	assert.deepEqual(tokenize('上次那个报错'), ['上次', '次那', '那个', '个报', '报错'])
	// single-character latin/digit runs are dropped: they would match everything
	assert.deepEqual(tokenize('ECONNREFUSED 127.0.0.1'), ['econnrefused', '127'])
	assert.deepEqual(tokenize('吃'), ['吃'])
	assert.deepEqual(tokenize(''), [])
	assert.deepEqual(tokenize('   '), [])
})

test('queryRecall finds the original line and hands back its date and direction', () => {
	const root = makeRoot()
	try {
		seed(root, [
			{ at: NOW - 2 * DAY, dir: 'in', accountId: ACCOUNT, conversationId: 'wxid_a', text: '上次那个报错是 ECONNREFUSED 吧' },
			{ at: NOW - 2 * DAY + 1000, dir: 'out', accountId: ACCOUNT, conversationId: 'wxid_a', text: '对，端口没起，重启就好了' },
			{ at: NOW - DAY, dir: 'in', accountId: ACCOUNT, conversationId: 'wxid_a', text: '今天天气不错' },
		])
		const hits = queryRecall(root, '报错 ECONNREFUSED', { accountId: ACCOUNT, conversationId: 'wxid_a', now: NOW })
		assert.equal(hits.length, 1, 'only the line that mentions the error matches')
		assert.equal(hits[0].dir, 'in')
		assert.match(hits[0].text, /ECONNREFUSED/)
		assert.equal(hits[0].matched, 2, 'both query terms hit the same document')
		assert.ok(hits[0].at <= NOW)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('the index is per account: another account\'s lines never leak in', () => {
	const root = makeRoot()
	try {
		seed(root, [
			{ at: NOW - 1000, dir: 'in', accountId: ACCOUNT, conversationId: 'wxid_a', text: '我的密码是花生酱' },
			{ at: NOW - 900, dir: 'in', accountId: OTHER, conversationId: 'wxid_b', text: '我的密码是花生酱 too' },
		])
		const hits = queryRecall(root, '花生酱', { accountId: ACCOUNT, now: NOW })
		assert.equal(hits.length, 1)
		assert.equal(hits[0].accountId, ACCOUNT)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('append-only journal grows the index instead of rebuilding it', () => {
	const root = makeRoot()
	try {
		seed(root, [{ at: NOW - 1000, dir: 'in', accountId: ACCOUNT, conversationId: 'wxid_a', text: '第一句话' }])
		const first = ensureIndex(root, { accountId: ACCOUNT, now: NOW })
		const file = Object.keys(first.files)[0]
		assert.equal(first.files[file].lines, 1)
		seed(root, [{ at: NOW - 500, dir: 'out', accountId: ACCOUNT, conversationId: 'wxid_a', text: '第二句话提到草莓蛋糕' }])
		const second = ensureIndex(root, { accountId: ACCOUNT, now: NOW })
		assert.equal(second.files[file].lines, 2, 'the file grew by exactly the new line')
		const hits = queryRecall(root, '草莓蛋糕', { accountId: ACCOUNT, now: NOW })
		assert.equal(hits.length, 1, 'the newly appended line is already searchable')
		assert.match(hits[0].text, /草莓蛋糕/)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('day files outside the recall window drop out of the index', () => {
	const root = makeRoot()
	try {
		seed(root, [
			{ at: NOW - 400 * DAY, dir: 'in', accountId: ACCOUNT, conversationId: 'wxid_a', text: '很久以前说过火龙果' },
			{ at: NOW - 1000, dir: 'in', accountId: ACCOUNT, conversationId: 'wxid_a', text: '最近说过火龙果' },
		])
		const wide = queryRecall(root, '火龙果', { accountId: ACCOUNT, now: NOW, days: 1800 })
		assert.equal(wide.length, 2)
		const narrow = queryRecall(root, '火龙果', { accountId: ACCOUNT, now: NOW, days: 30 })
		assert.equal(narrow.length, 1, 'the old day file is no longer searched')
		assert.match(narrow[0].text, /最近/)
		const index = ensureIndex(root, { accountId: ACCOUNT, now: NOW, days: 30 })
		assert.equal(Object.keys(index.files).length, 1, 'the pruned file leaves the index')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('the message being answered never comes back as its own recall hit', () => {
	const root = makeRoot()
	try {
		seed(root, [
			{ at: NOW - 2000, dir: 'in', accountId: ACCOUNT, conversationId: 'wxid_a', text: '上次那个报错还记得吗' },
			{ at: NOW, dir: 'in', accountId: ACCOUNT, conversationId: 'wxid_a', text: '上次那个报错是什么来着' },
		])
		const byAt = queryRecall(root, '报错', { accountId: ACCOUNT, now: NOW, excludeAt: NOW })
		assert.equal(byAt.length, 1)
		assert.match(byAt[0].text, /还记得吗/)
		const byText = queryRecall(root, '报错', { accountId: ACCOUNT, now: NOW, excludeText: '上次那个报错是什么来着' })
		assert.equal(byText.length, 1)
		assert.match(byText[0].text, /还记得吗/)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('shouldRecall pays for a search only when the message refers back or hits hard', () => {
	const strong = [{ score: 9, matched: 3 }]
	assert.equal(shouldRecall('上次那个报错怎么解决的', strong), true, 'a cue word always searches')
	assert.equal(shouldRecall('ECONNREFUSED 是怎么处理的', strong), true, 'a dense hit is worth it even without a cue')
	assert.equal(shouldRecall('今天吃什么', [{ score: 0.4, matched: 1 }]), false, 'a weak single-term hit is noise')
	assert.equal(shouldRecall('上次那个报错', []), false, 'no hits, nothing to inject')
	assert.equal(shouldRecall('在吗', []), false, '小聊没有命中就没有块')
})

test('buildRecallBlock renders dated originals inside one tag, formatRecallHits stays plain', () => {
	const hits = [
		{ at: NOW - 2 * DAY, dir: 'in', text: '上次那个报错是 ECONNREFUSED' },
		{ at: NOW - DAY, dir: 'out', text: '端口没起，重启就好了' },
	]
	const block = buildRecallBlock(hits)
	assert.equal(block.startsWith('<weixin_recall>'), true)
	assert.equal(block.endsWith('</weixin_recall>'), true)
	assert.match(block, /\[2026-10-24 \d{2}:\d{2}\] 用户：上次那个报错/)
	assert.match(block, /助手：端口没起/)
	assert.equal(buildRecallBlock([]), '')

	const plain = formatRecallHits(hits, { query: '报错' })
	assert.match(plain, /找到 2 条和「报错」相关的记录/)
	assert.match(plain, /1\. \[2026-10-24 .*\] 对方：/)
	assert.match(plain, /2\. \[.*\] 我：/)
	assert.match(formatRecallHits([], { query: 'zzz' }), /没有在本地流水里找到/)
})

test('command lines are not conversation content and stay out of the index', () => {
	const root = makeRoot()
	try {
		seed(root, [
			{ at: NOW - 2000, dir: 'in', accountId: ACCOUNT, conversationId: 'wxid_a', text: '/recall 报错' },
			{ at: NOW - 1000, dir: 'in', accountId: ACCOUNT, conversationId: 'wxid_a', text: '上次那个报错是 ECONNREFUSED' },
		])
		const hits = queryRecall(root, '报错', { accountId: ACCOUNT, now: NOW })
		assert.equal(hits.length, 1, 'the /recall command itself must not match its own search')
		assert.match(hits[0].text, /ECONNREFUSED/)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('a corrupt index file is rebuilt instead of thrown', () => {
	const root = makeRoot()
	try {
		seed(root, [{ at: NOW - 1000, dir: 'in', accountId: ACCOUNT, conversationId: 'wxid_a', text: '需要被找回来的一句话' }])
		const file = indexFilePath(root, ACCOUNT)
		mkdirSync(join(root, 'memory', 'index'), { recursive: true })
		writeFileSync(file, '{not json')
		const hits = queryRecall(root, '找回来', { accountId: ACCOUNT, now: NOW })
		assert.equal(hits.length, 1)
		const parsed = JSON.parse(readFileSync(file, 'utf8'))
		assert.equal(parsed.version, 1, 'the rebuilt index is written back in the current shape')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
