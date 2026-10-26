import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { manifestVersionProblems, pinProfileSpec, VERSION_FILES, snapshotTextFiles } from '../bin/release.mjs'

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

/**
 * A dry run must leave the tree exactly as it found it, and that promise is a
 * snapshot of the files the bump rewrites. It once missed `src/client.js`, so a
 * green "tree unchanged" line hid a bumped PLUGIN_VERSION. Pinning the file list
 * keeps the bump and the snapshot from drifting apart again.
 */
test('the dry-run snapshot covers every file the version bump rewrites', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const snapshot = snapshotTextFiles(root)
  assert.deepEqual(snapshot.map((f) => f.path), VERSION_FILES)
  for (const file of snapshot) {
    assert.ok(file.text.length > 0, `${file.path} must be readable so a dry run can restore it`)
  }
  // The client constant is rewritten by the bump, so it must be snapshotted.
  assert.ok(VERSION_FILES.includes('src/client.js'), 'src/client.js carries PLUGIN_VERSION')
  assert.match(snapshot.find((f) => f.path === 'src/client.js').text, /const PLUGIN_VERSION = "\d+\.\d+\.\d+";/)
})

/**
 * Step 9 copies files into the profile, but the app's own startup `pnpm install`
 * restores whatever the profile's dependency graph says — so on 0.9.5 the
 * running app served the published tarball while the profile still declared
 * `^0.9.3`. Making the copy survive a restart means moving the declared spec too,
 * and that rewrite is what these cases pin down.
 */
test('pinning the profile dependency rewrites the spec in place, keeping the file as it was', () => {
  const raw = [
    '{',
    '  "name": "dsh-profile-desktop",',
    '  "private": true,',
    '  "dependencies": {',
    '    "@dsh-market/plugin": "^0.4.16",',
    '    "dsh-plugin-weixin": "^0.9.5"',
    '  },',
    '  "dsh": { "enabled": true }',
    '}',
    '',
  ].join('\n')
  const patch = pinProfileSpec(raw, '0.9.6')
  assert.equal(patch.from, '^0.9.5')
  assert.equal(patch.to, '^0.9.6')
  // Text, not a re-serialised object: the profile keeps its own shape.
  assert.ok(patch.text.includes('    "dsh-plugin-weixin": "^0.9.6"'), `expected the indentation to survive, got: ${patch.text}`)
  assert.ok(patch.text.includes('"@dsh-market/plugin": "^0.4.16"'), 'unrelated dependencies are untouched')
  assert.ok(patch.text.includes('"dsh": { "enabled": true }'), 'the rest of the file is untouched')
  assert.deepEqual(JSON.parse(patch.text).dependencies['dsh-plugin-weixin'], '^0.9.6')
})

test('pinning does nothing when there is nothing to pin', () => {
  const withSpec = (spec) => JSON.stringify({ dependencies: { 'dsh-plugin-weixin': spec } })
  assert.equal(pinProfileSpec(withSpec('^0.9.6'), '0.9.6'), null, 'already pinned is not a patch')
  // A file: pin is the operator's deliberate choice (0.9.3 shipped that way once);
  // the release warns instead of silently converting it to a registry range.
  assert.equal(pinProfileSpec(withSpec('file:/tmp/dsh-plugin-weixin-0.8.0.tgz'), '0.9.6'), null)
  assert.equal(pinProfileSpec(JSON.stringify({ dependencies: {} }), '0.9.6'), null)
  assert.equal(pinProfileSpec('not json at all', '0.9.6'), null)
})
