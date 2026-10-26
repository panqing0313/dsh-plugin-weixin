import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	BUILTIN_MODES,
	DEFAULT_MODE_ID,
	readPersonaStore,
	writePersonaStore,
	resolveMode,
	activeModeFor,
	setActiveMode,
	clearActiveMode,
	listActiveOverrides,
	buildPersonaBlock,
	overrideKey,
	readGlobalDefaultMode,
	writeGlobalDefaultMode,
 readAccountDefaultMode, writeAccountDefaultMode,
} from '../src/persona.js'

let root
const warns = []
const warn = (line) => warns.push(line)

before(() => {
	root = mkdtempSync(join(tmpdir(), 'persona-test-'))
})

after(() => {
	rmSync(root, { recursive: true, force: true })
})

test('first read seeds the builtin catalog and persists it', () => {
	const modes = readPersonaStore(root, { warn })
	assert.deepEqual(modes.map((m) => m.id), BUILTIN_MODES.map((m) => m.id))
	const file = join(root, 'persona-modes.json')
	assert.equal(existsSync(file), true)
	const parsed = JSON.parse(readFileSync(file, 'utf8'))
	assert.equal(parsed.modes.length, BUILTIN_MODES.length)
	assert.equal(parsed.modes.find((m) => m.id === DEFAULT_MODE_ID).prompt, '')
})

test('a file that lost a builtin gets it re-added, keeping the rest', () => {
	const dir = join(root, 'reseed')
	writePersonaStore(dir, [{ id: 'girlfriend', name: '女友', prompt: 'x', builtin: true }], { warn })
	const modes = readPersonaStore(dir, { warn })
	assert.ok(modes.some((m) => m.id === DEFAULT_MODE_ID), 'default re-added')
	assert.ok(modes.some((m) => m.id === 'girlfriend'), 'existing kept')
})

test('a corrupt catalog warns and reseeds instead of throwing', () => {
	const dir = join(root, 'corrupt')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'persona-modes.json'), '{ not json')
	warns.length = 0
	const modes = readPersonaStore(dir, { warn })
	assert.deepEqual(modes.map((m) => m.id), BUILTIN_MODES.map((m) => m.id))
	assert.equal(warns.length, 0, 'corrupt json is a normal first-run shape, not a warning')
})

test('malformed entries are skipped with a warning, valid ones kept', () => {
	const dir = join(root, 'malformed')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'persona-modes.json'), JSON.stringify({
		modes: [
			{ id: '', name: 'no id', prompt: '' },
			{ id: 'ok1', name: '正常', prompt: 'p' },
			{ id: 'ok1', name: '重复', prompt: 'p' },
			{ id: 'ok2', prompt: 'no name' },
			'not an object',
		],
	}))
	warns.length = 0
	const modes = readPersonaStore(dir, { warn })
	assert.deepEqual(modes.map((m) => m.id), [...BUILTIN_MODES.map((m) => m.id), 'ok1'])
	assert.ok(warns.length >= 2, `blank/duplicate entries warned: ${JSON.stringify(warns)}`)
})

test('resolveMode falls back to default for unknown and blank ids', () => {
	const modes = readPersonaStore(root, { warn })
	assert.equal(resolveMode(modes, 'girlfriend').name, '女友')
	assert.equal(resolveMode(modes, 'no-such-mode').id, DEFAULT_MODE_ID)
	assert.equal(resolveMode(modes, '  ').id, DEFAULT_MODE_ID)
})

test('buildPersonaBlock: default/empty injects nothing, a persona renders one tag', () => {
	const modes = readPersonaStore(root, { warn })
	const gf = resolveMode(modes, 'girlfriend')
	assert.equal(buildPersonaBlock(undefined), '')
	assert.equal(buildPersonaBlock(null), '')
	assert.equal(buildPersonaBlock(resolveMode(modes, DEFAULT_MODE_ID)), '')
	assert.equal(buildPersonaBlock({ name: '空', prompt: '   ' }), '')
	const block = buildPersonaBlock(gf)
	assert.match(block, /^<weixin_persona mode="女友">/)
	assert.match(block, /撒娇/)
	assert.match(block, /<\/weixin_persona>$/)
	assert.equal((block.match(/<weixin_persona/g) ?? []).length, 1, 'exactly one tag, no nesting')
})

test('override set/resolve/clear round trip', () => {
	const dir = join(root, 'overrides')
	const modes = () => readPersonaStore(dir, { warn })
	const key = overrideKey('bot1@im.bot', 'user1@im.wechat')
	assert.equal(key, 'bot1@im.bot|user1@im.wechat')
	assert.equal(activeModeFor(dir, 'bot1@im.bot', 'user1@im.wechat', DEFAULT_MODE_ID, { warn }), DEFAULT_MODE_ID)
	setActiveMode(dir, 'bot1@im.bot', 'user1@im.wechat', 'girlfriend', { warn })
	assert.equal(activeModeFor(dir, 'bot1@im.bot', 'user1@im.wechat', DEFAULT_MODE_ID, { warn }), 'girlfriend')
	// A different conversation stays untouched.
	assert.equal(activeModeFor(dir, 'bot1@im.bot', 'user2@im.wechat', 'friend', { warn }), 'friend')
	// Pinning `default` is meaningful: it overrides a persona global default.
	setActiveMode(dir, 'bot1@im.bot', 'user1@im.wechat', DEFAULT_MODE_ID, { warn })
	assert.equal(activeModeFor(dir, 'bot1@im.bot', 'user1@im.wechat', 'girlfriend', { warn }), DEFAULT_MODE_ID)
	clearActiveMode(dir, 'bot1@im.bot', 'user1@im.wechat', { warn })
	assert.equal(activeModeFor(dir, 'bot1@im.bot', 'user1@im.wechat', 'girlfriend', { warn }), 'girlfriend')
})

test('listActiveOverrides splits keys and skips blank values', () => {
	const dir = join(root, 'overrides-list')
	setActiveMode(dir, 'b@im.bot', 'c@im.wechat', 'friend', { warn })
	const list = listActiveOverrides(dir, { warn })
	assert.deepEqual(list, [{ accountId: 'b@im.bot', conversationId: 'c@im.wechat', modeId: 'friend' }])
})

test('a missing overrides file reads as no overrides', () => {
	const dir = join(root, 'no-overrides')
	assert.equal(activeModeFor(dir, 'a', 'c', DEFAULT_MODE_ID, { warn }), DEFAULT_MODE_ID)
	assert.deepEqual(listActiveOverrides(dir, { warn }), [])
})

test('a /mode switch round-trips persona-active.json WITHOUT erasing the card default', () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-global-'))
  try {
    // The card wrote the account-wide default first…
    writeGlobalDefaultMode(root, 'girlfriend')
    assert.equal(readGlobalDefaultMode(root), 'girlfriend')
    // …then a WeChat-side /mode must keep it while adding the override…
    setActiveMode(root, 'bot1', 'conv1', 'friend')
    assert.equal(readGlobalDefaultMode(root), 'girlfriend', 'setActiveMode wiped the reserved key')
    // …and clearing the override (back to following the default) keeps it too.
    clearActiveMode(root, 'bot1', 'conv1')
    assert.equal(readGlobalDefaultMode(root), 'girlfriend')
    assert.deepEqual(listActiveOverrides(root), [])
    // The default survives a garbage blob next to it only in the sense that
    // both readers reseed — but a VALID file with both kinds of keys keeps both.
    writeFileSync(join(root, 'persona-active.json'), JSON.stringify({
      __global__: 'boyfriend',
      'bot1|conv1': 'friend',
    }))
    assert.equal(readGlobalDefaultMode(root), 'boyfriend')
    assert.equal(activeModeFor(root, 'bot1', 'conv1', 'default'), 'friend', 'override wins over the file default')
    assert.equal(activeModeFor(root, 'bot1', 'conv2', 'default'), 'boyfriend', 'no override falls to the file default')
    assert.deepEqual(listActiveOverrides(root), [{ accountId: 'bot1', conversationId: 'conv1', modeId: 'friend' }], 'the reserved key never lists as an override')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the role builtins cover the shipped roster, each with a boundary paragraph', () => {
  const roles = BUILTIN_MODES.filter((m) => m.game !== true)
  assert.deepEqual(roles.map((m) => m.id), ['default', 'girlfriend', 'boyfriend', 'friend', 'jarvis'])
  const jarvis = BUILTIN_MODES.find((m) => m.id === 'jarvis')
  assert.equal(jarvis.name, '贾维斯')
  assert.equal(jarvis.builtin, true)
  assert.ok(jarvis.prompt.length > 80, 'a persona needs a real prompt body')
  assert.match(jarvis.prompt, /边界/, 'every builtin says tone must not override facts')
  assert.match(jarvis.prompt, /先给结论/, 'the butler style is the point of the mode')
  assert.equal(BUILTIN_MODES.filter((m) => m.id === 'jarvis').length, 1, 'one id, one mode')
})

test('the game builtins carry playable rules and the game flag survives a rewrite', () => {
  const games = BUILTIN_MODES.filter((m) => m.game === true)
  assert.deepEqual(games.map((m) => m.name), ['海龟汤', '成语接龙', '文字冒险'])
  for (const game of games) {
    assert.ok(game.prompt.length > 80, `${game.name} needs real rules`)
  }
  const root = mkdtempSync(join(tmpdir(), 'persona-games-'))
  try {
    const modes = readPersonaStore(root)
    const turtle = modes.find((m) => m.id === 'turtle-soup')
    assert.equal(turtle.game, true)
    writePersonaStore(root, modes)
    const reread = readPersonaStore(root).find((m) => m.id === 'turtle-soup')
    assert.equal(reread.game, true, 'the game flag must survive a round trip')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('account-level default persona: write, read, precedence, listing', () => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-weixin-persona-acct-'))
	try {
		// Nothing set → every layer falls through to the caller default.
		assert.equal(readAccountDefaultMode(root, 'bot1'), '')
		assert.equal(activeModeFor(root, 'bot1', 'conv-1', 'girlfriend'), 'girlfriend')

		// Account default wins over the caller default.
		writeAccountDefaultMode(root, 'bot1', 'girlfriend')
		assert.equal(readAccountDefaultMode(root, 'bot1'), 'girlfriend')
		assert.equal(activeModeFor(root, 'bot1', 'conv-1', 'default'), 'girlfriend')
		assert.equal(activeModeFor(root, 'other', 'conv-1', 'default'), 'default', 'another account is unaffected')

		// Global file default loses to the account default.
		writeGlobalDefaultMode(root, 'boyfriend')
		assert.equal(activeModeFor(root, 'bot1', 'conv-1', 'default'), 'girlfriend')
		assert.equal(activeModeFor(root, 'other', 'conv-1', 'default'), 'boyfriend')

		// Conversation override beats everything.
		setActiveMode(root, 'bot1', 'conv-1', 'friend')
		assert.equal(activeModeFor(root, 'bot1', 'conv-1', 'default'), 'friend')
		assert.equal(activeModeFor(root, 'bot1', 'conv-2', 'default'), 'girlfriend')

		// Clearing the account default falls back to the global file default.
		writeAccountDefaultMode(root, 'bot1', '')
		assert.equal(readAccountDefaultMode(root, 'bot1'), '')
		assert.equal(activeModeFor(root, 'bot1', 'conv-2', 'default'), 'boyfriend')

		// The account key never shows up as a per-conversation override…
		writeAccountDefaultMode(root, 'bot2', 'friend')
		const listed = listActiveOverrides(root)
		assert.ok(listed.every((e) => e.conversationId !== ''), JSON.stringify(listed))
		assert.deepEqual(listed.map((e) => e.conversationId), ['conv-1'])
		// …and a /mode switch must not erase it.
		setActiveMode(root, 'bot2', 'conv-9', 'girlfriend')
		assert.equal(readAccountDefaultMode(root, 'bot2'), 'friend', 'the account default survives a conversation override write')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
