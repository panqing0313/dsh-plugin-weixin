import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { manifestVersionProblems } from '../bin/release.mjs'

/**
 * The release script's preflight guard, exercised on fixture manifests.
 *
 * The guard exists because package-lock.json sat at 0.1.1 through nine releases
 * while package.json moved on: nothing in the release path ever read the
 * lockfile's version. These fixtures are the smallest thing that proves the
 * comparison looks at both places npm writes the version.
 */
function fixture({ pkgVersion = '0.9.2', topVersion = pkgVersion, rootVersion = pkgVersion } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-lockfile-'))
	fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'dsh-plugin-weixin', version: pkgVersion }, null, 2)}\n`)
	fs.writeFileSync(
		path.join(root, 'package-lock.json'),
		`${JSON.stringify(
			{
				name: 'dsh-plugin-weixin',
				version: topVersion,
				lockfileVersion: 3,
				requires: true,
				packages: { '': { name: 'dsh-plugin-weixin', version: rootVersion } },
			},
			null,
			2,
		)}\n`,
	)
	return root
}

function clean(t, root) {
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))
	return root
}

test('manifests that agree produce no problems', (t) => {
	const root = clean(t, fixture())
	const { pkgVersion, problems } = manifestVersionProblems(root)
	assert.equal(pkgVersion, '0.9.2')
	assert.deepEqual(problems, [])
})

test('a lockfile stuck at an older release is reported in both places', (t) => {
	const root = clean(t, fixture({ topVersion: '0.1.1', rootVersion: '0.1.1' }))
	const { problems } = manifestVersionProblems(root)
	assert.equal(problems.length, 2)
	assert.ok(problems.some((p) => p.includes('lockfile "version"') && p.includes('0.1.1')))
	assert.ok(problems.some((p) => p.includes('lockfile packages[""].version') && p.includes('0.1.1')))
})

test('a single stale field is enough to refuse the release', (t) => {
	const root = clean(t, fixture({ rootVersion: '0.1.1' }))
	const { problems } = manifestVersionProblems(root)
	assert.deepEqual(problems, ['lockfile packages[""].version says 0.1.1'])
})

test('a missing version field counts as a mismatch, not a pass', (t) => {
	const root = clean(t, fixture())
	const lockPath = path.join(root, 'package-lock.json')
	const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
	delete lock.packages[''].version
	fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
	const { problems } = manifestVersionProblems(root)
	assert.deepEqual(problems, ['lockfile packages[""].version says (missing)'])
})

test('an unreadable lockfile cannot be waved through', (t) => {
	const root = clean(t, fixture())
	fs.writeFileSync(path.join(root, 'package-lock.json'), '{ not json')
	const { problems } = manifestVersionProblems(root)
	assert.equal(problems.length, 1)
	assert.match(problems[0], /^package-lock\.json cannot be read as JSON: /)
})
