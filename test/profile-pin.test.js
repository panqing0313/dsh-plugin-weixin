import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pinProfileDependency, pinProfileSpec } from '../bin/lib/profile-pin.mjs'

const PKG = 'dsh-plugin-weixin'

function profileHome(declared) {
	const home = mkdtempSync(join(tmpdir(), 'profile-pin-'))
	const dir = join(home, 'profiles', 'desktop')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'profile', dependencies: { [PKG]: declared } }, null, 2)}\n`)
	return { home, dir }
}

test('the spec rewrite only touches a caret range, and never reformats the file', () => {
	const raw = '{\n  "dependencies": {\n    "dsh-plugin-weixin": "^0.9.8",\n    "other": "1.0.0"\n  }\n}\n'
	const patch = pinProfileSpec(raw, '0.9.10')
	assert.equal(patch.from, '^0.9.8')
	assert.equal(patch.to, '^0.9.10')
	assert.match(patch.text, /"dsh-plugin-weixin": "\^0\.9\.10"/)
	assert.ok(patch.text.startsWith('{\n  "dependencies": {'), 'indentation is preserved')
	assert.equal(pinProfileSpec(raw, '0.9.8'), null, 'already pinned is a no-op')
	assert.equal(pinProfileSpec('{"dependencies":{"dsh-plugin-weixin":"file:/tmp/x.tgz"}}', '1.0.0'), null, 'a file: spec is left alone')
	assert.equal(pinProfileSpec('not json', '1.0.0'), null)
	assert.equal(pinProfileSpec('{"dependencies":{}}', '1.0.0'), null)
})

test('pinning rewrites the profile and refreshes its lockfile through the given spawn', () => {
	const { home, dir } = profileHome('^0.9.8')
	const calls = []
	const lines = []
	const outcome = pinProfileDependency({
		profile: 'desktop',
		version: '0.9.10',
		dshHome: home,
		spawn: (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd })
			return { status: 0, stdout: '', stderr: '' }
		},
		ok: (line) => lines.push(line),
	})
	assert.equal(outcome.pinned, true)
	assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies[PKG], '^0.9.10')
	assert.equal(calls.length, 1)
	assert.deepEqual(calls[0].args.slice(-2), ['install', '--prefer-offline'])
	assert.equal(calls[0].cwd, dir)
	assert.ok(lines.some((line) => line.includes('^0.9.10')))
	rmSync(home, { recursive: true, force: true })
})

test('a profile without package.json is reported, not crashed on', () => {
	const home = mkdtempSync(join(tmpdir(), 'profile-pin-empty-'))
	const warnings = []
	const outcome = pinProfileDependency({ profile: 'ghost', version: '1.0.0', dshHome: home, warn: (line) => warnings.push(line) })
	assert.deepEqual(outcome, { pinned: false, reason: 'no-profile-package' })
	assert.equal(warnings.length, 1)
	rmSync(home, { recursive: true, force: true })
})

test('a failed lockfile refresh still leaves the pin in place and says so', () => {
	const { home } = profileHome('^0.9.8')
	const warnings = []
	const outcome = pinProfileDependency({
		profile: 'desktop',
		version: '0.9.10',
		dshHome: home,
		spawn: () => ({ status: 1, stdout: '', stderr: 'EAI_AGAIN registry unreachable' }),
		warn: (line) => warnings.push(line),
	})
	assert.deepEqual(outcome, { pinned: true, reason: 'lock-not-refreshed' })
	assert.ok(warnings.some((line) => line.includes('lockfile')))
	rmSync(home, { recursive: true, force: true })
})
