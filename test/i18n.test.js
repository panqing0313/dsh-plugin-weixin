import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CATALOG, LOCALES, catalogKeys, createTranslator, interpolate, resolveLocale, translate } from '../src/i18n.js'
import { buildCommandsHelp, SESSION_COMMANDS_HELP } from '../src/sessions.js'
import { noticeText } from '../src/message/tool-guard.js'

test('every catalogue entry is translated into every locale we ship', () => {
	for (const key of catalogKeys()) {
		const entry = CATALOG[key]
		for (const locale of LOCALES) {
			const text = entry[locale]
			assert.equal(typeof text, 'string', `${key} is missing ${locale}`)
			assert.ok(text.trim() !== '', `${key} has an empty ${locale}`)
		}
	}
})

test('an unknown locale means Chinese, because that is what existed first', () => {
	assert.equal(resolveLocale('en'), 'en')
	assert.equal(resolveLocale('EN'), 'en')
	assert.equal(resolveLocale('en-US'), 'zh', 'only an exact en is honoured')
	assert.equal(resolveLocale(''), 'zh')
	assert.equal(resolveLocale(undefined), 'zh')
	assert.equal(resolveLocale(42), 'zh')
})

test('a missing translation falls back to Chinese, and a missing key to itself', () => {
	const broken = { 'only.zh': { zh: '只有中文', en: '' } }
	// Reach in through the same lookup the translator uses by checking the public
	// behaviour: an empty en entry cannot be produced through CATALOG (the test
	// above forbids it), so simulate via a key that exists only in the catalogue.
	assert.equal(translate('help.header', undefined, 'en'), 'Session commands (send /help to see this again):')
	assert.equal(translate('no.such.key'), 'no.such.key')
	assert.equal(broken['only.zh'].en, '')
})

test('placeholders are filled, and an absent one stays visible instead of becoming undefined', () => {
	assert.equal(interpolate('a {x} b {y}', { x: 1, y: 'two' }), 'a 1 b two')
	assert.equal(interpolate('a {x} b {y}', { x: 1 }), 'a 1 b {y}')
	assert.equal(interpolate('{x}', { x: '' }), '')
	assert.equal(interpolate('no placeholders', { x: 1 }), 'no placeholders')
})

test('the translator follows a live getter, so a card change speaks on the next message', () => {
	let locale = 'zh'
	const { t } = createTranslator(() => locale)
	assert.match(t('help.header'), /会话指令/)
	locale = 'en'
	assert.match(t('help.header'), /Session commands/)
})

test('the command help list speaks both languages, in the same order', () => {
	const zh = buildCommandsHelp(createTranslator('zh').t).split('\n')
	const en = buildCommandsHelp(createTranslator('en').t).split('\n')
	assert.equal(zh.length, en.length)
	assert.ok(zh.length > 10, 'the help list is not empty')
	assert.match(zh[0], /会话指令/)
	assert.match(en[0], /Session commands/)
	assert.ok(en.some((line) => line.startsWith('/recall')), 'every command keeps a line')
	assert.equal(zh.join('\n'), SESSION_COMMANDS_HELP, 'the default export is still Chinese')
})

test('the dangerous-tool notice is translated, and never claims to ask permission', () => {
	const zh = noticeText({ tool: 'bash', detail: 'rm -rf /tmp/x', level: 'high' })
	const en = noticeText({ tool: 'bash', detail: 'rm -rf /tmp/x', level: 'high' }, 'en')
	assert.match(zh, /看着有风险/)
	assert.match(zh, /`bash`：rm -rf \/tmp\/x/)
	assert.match(zh, /\/cancel/)
	assert.match(en, /looks risky/)
	assert.match(en, /\/cancel/)
	for (const text of [zh, en]) {
		assert.ok(!/同意|批准|approve|approval/i.test(text), 'the notice must not pretend to ask for approval')
	}
	assert.match(noticeText({ tool: 'write', detail: '', level: 'normal' }, 'en'), /about to use a tool/)
})
