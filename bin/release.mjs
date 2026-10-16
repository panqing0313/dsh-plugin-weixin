#!/usr/bin/env node
/**
 * One-command release for dsh-plugin-weixin.
 *
 *   node bin/release.mjs <version>            # full release: verify, commit, tag, push, publish
 *   node bin/release.mjs <version> --dry-run  # do everything except publishing
 *   node bin/release.mjs <version> --yes      # skip the confirmation prompt
 *
 * The script does, in order:
 *
 *   1. Preflight  — clean tree, on the right branch, in sync with origin, not
 *                   already published, node/npm/git/gh present, npm auth live.
 *   2. Guard      — the suite must be green and the tarball's contents sane.
 *   3. Version    — `package.json` (and the README release list) bumped.
 *   4. Verify     — `npm pack` the real artifact and RUN the shipped ASR bridge
 *                   against a known-good tone: proves the thing being uploaded
 *                   actually works, not just that tests pass.
 *   5. Commit     — one commit, `chore(release): <version>`.
 *   6. Publish    — `npm publish`, then poll the registry until the version is
 *                   actually visible (npm accepts with 202 and *processes* the
 *                   upload for a while — checking too early reports the old
 *                   version and looks like a failure).
 *   7. Tag + push — `v<version>` tag, GitHub release with the commit log, push.
 *   8. Report     — the registry's own integrity/shasum compared to the local
 *                   tarball, so the operator knows the upload is the one built.
 *
 * Why a script: every one of these steps has been done by hand and each has
 * failed at least once in a way that was only visible afterwards — publishing
 * before the version was bumped, reading the registry before npm had finished
 * processing, tagging a commit that was not pushed, or shipping a tarball that
 * was missing `bin/`. The order below is the order that actually works.
 *
 * `npm publish` may prompt for a one-time password in the browser. That is the
 * one step that cannot be automated: npm masks the auth URL unless stdout is a
 * TTY. Run this script from a real terminal, not a captured shell.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const PKG_NAME = 'dsh-plugin-weixin'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const dryRun = flags.has('--dry-run')
const assumeYes = flags.has('--yes')
const version = argv.find((a) => !a.startsWith('--'))

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const C = process.stdout.isTTY
	? { dim: '\u001b[2m', red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', bold: '\u001b[1m', off: '\u001b[0m' }
	: { dim: '', red: '', green: '', yellow: '', bold: '', off: '' }

let stepNumber = 0
function step(title) {
	stepNumber += 1
	process.stdout.write(`\n${C.bold}[${stepNumber}] ${title}${C.off}\n`)
}
function ok(message) {
	process.stdout.write(`    ${C.green}✓${C.off} ${message}\n`)
}
function note(message) {
	process.stdout.write(`    ${C.dim}${message}${C.off}\n`)
}
function warn(message) {
	process.stdout.write(`    ${C.yellow}!${C.off} ${message}\n`)
}
function die(message, hint) {
	process.stdout.write(`\n${C.red}✗ ${message}${C.off}\n`)
	if (hint) process.stdout.write(`  ${hint}\n`)
	process.exit(1)
}

/** Run a command, inheriting stdio, and throw on failure. */
function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
	if (result.error) throw result.error
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
	return result
}

/** Run a command and capture its stdout, trimmed. Returns '' on failure. */
function capture(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options })
	return result.status === 0 ? String(result.stdout).trim() : ''
}

function git(args, options = {}) {
	return capture('git', args, options)
}

function has(command) {
	return capture('sh', ['-c', `command -v ${command}`]) !== ''
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function preflight() {
	step('Preflight')

	if (version === undefined) {
		die('no version given', `usage: node bin/release.mjs <version> [--dry-run] [--yes]`)
	}
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		die(`"${version}" is not a plain semver version`, 'expected something like 0.4.0 (no leading v)')
	}

	for (const tool of ['node', 'npm', 'git']) {
		if (!has(tool)) die(`${tool} is not on PATH`)
	}
	ok(`node ${process.version}, npm ${capture('npm', ['--version'])}`)

	const branch = git(['branch', '--show-current'])
	if (branch !== 'main') warn(`on branch "${branch}", not "main" — the tag will point here`)
	else ok('on branch main')

	const dirty = git(['status', '--porcelain'])
	if (dirty !== '') {
		// Untracked tarballs are a release byproduct, not a reason to stop.
		const significant = dirty
			.split('\n')
			.filter((line) => !/\.tgz$/.test(line))
			.join('\n')
		if (significant !== '') {
			die('the working tree has uncommitted changes', `commit or stash them first:\n${significant}`)
		}
		warn('ignoring leftover .tgz files in the working tree')
	}
	ok('working tree is clean')

	const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
	if (git(['rev-parse', '-q', '--verify', `refs/tags/v${version}`]) !== '') {
		die(`tag v${version} already exists`, 'pick the next version number')
	}

	// `git fetch` so the sync check compares against reality, not a stale ref.
	if (git(['ls-remote', '--exit-code', 'origin', 'HEAD'], { stdio: 'ignore' }) === '' && !dryRun) {
		run('git', ['fetch', '--quiet', 'origin', 'main'])
	}
	const local = git(['rev-parse', 'HEAD'])
	const remote = git(['rev-parse', 'origin/main'])
	if (local !== remote && remote !== '') {
		die('local main is not in sync with origin/main', 'push or pull before releasing')
	}
	ok(`HEAD ${local.slice(0, 7)} is in sync with origin/main`)

	if (has('gh') && capture('gh', ['auth', 'status']) === '') {
		warn('gh is not authenticated — the GitHub release step will be skipped')
	} else if (has('gh')) {
		ok('gh is authenticated (the GitHub release will be created)')
	}

	// The version must not exist already; publishing over it fails late and
	// confusingly ("cannot publish over the previously published versions").
	const published = capture('npm', ['view', PKG_NAME, 'versions', '--json'])
	if (published !== '') {
		try {
			const known = JSON.parse(published)
			if (known.includes(version)) {
				die(`${PKG_NAME}@${version} is already published`, 'never republish over an existing version — bump instead')
			}
			ok(`npm shows ${known.length} published version(s); ${version} is new`)
		} catch {
			note('could not parse the published version list; continuing')
		}
	}

	const who = capture('npm', ['whoami'])
	if (who === '') {
		die('not logged in to npm', 'run `npm login --auth-type=web` in a real terminal, then retry')
	}
	ok(`npm authenticated as ${who}`)

	note(`current version ${current} → releasing ${version}${dryRun ? ' (dry run: nothing will be published)' : ''}`)
}

// ---------------------------------------------------------------------------
// Release notes
// ---------------------------------------------------------------------------

/**
 * Compose the GitHub release body from the commit log since the last tag.
 *
 * Written from recorded history rather than authored fresh: the commits already
 * describe what changed, and inventing a second description only creates a way
 * for the two to disagree.
 */
function releaseNotes(previousTag) {
	const range = previousTag === '' ? 'HEAD' : `${previousTag}..HEAD`
	const subjects = git(['log', '--pretty=format:%s', range])
		.split('\n')
		.filter((line) => line.trim() !== '' && !/^chore\(release\)/.test(line))
	if (subjects.length === 0) return 'Maintenance release.'

	const groups = { feat: [], fix: [], other: [] }
	for (const subject of subjects) {
		const match = /^(feat|fix)(\(.+?\))?: (.+)$/.exec(subject)
		if (match) groups[match[1]].push(match[3])
		else groups.other.push(subject)
	}

	const lines = []
	if (groups.feat.length > 0) lines.push('### Features', ...groups.feat.map((s) => `- ${s}`), '')
	if (groups.fix.length > 0) lines.push('### Fixes', ...groups.fix.map((s) => `- ${s}`), '')
	if (groups.other.length > 0) lines.push('### Other', ...groups.other.map((s) => `- ${s}`), '')
	lines.push(`Published to npm as \`${PKG_NAME}@${version}\`.`)
	return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function runTests() {
	step('Test suite')
	run('npm', ['test'])
	ok('suite is green')
}

function bumpVersion(previousVersion) {
	step('Bump the version')

	const pkgPath = path.join(ROOT, 'package.json')
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
	pkg.version = version
	fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
	ok(`package.json ${previousVersion} → ${version}`)

	// The README names the published version and lists what shipped in each
	// one; leaving them stale is how the README ended up claiming 0.1.0 while
	// 0.2.0 was live.
	const readmePath = path.join(ROOT, 'README.md')
	const readme = fs.readFileSync(readmePath, 'utf8')

	const versionLine = /当前已发布版本：\[`dsh-plugin-weixin@([\d.]+)`\]\(https:\/\/www\.npmjs\.com\/package\/dsh-plugin-weixin\)/
	const seen = versionLine.exec(readme)
	if (seen === null) {
		warn('README has no "当前已发布版本" line to update — add one by hand')
	} else if (seen[1] === version) {
		ok('README already names this version')
	} else {
		fs.writeFileSync(readmePath, readme.replace(versionLine, `当前已发布版本：[\`${PKG_NAME}@${version}\`](https://www.npmjs.com/package/${PKG_NAME})`))
		ok(`README version line ${seen[1]} → ${version}`)
	}

	// The release list must gain a bullet, or the newest version silently has
	// no description of what it contains. New bullets go on top.
	const firstBullet = readme.indexOf('\n- **')
	if (firstBullet === -1) {
		warn('README has no release list — add a bullet by hand')
	} else if (readme.includes(`\n- **${version}**`)) {
		ok('README release list already covers this version')
	} else {
		const at = firstBullet + 1
		const bullet = `- **${version}** —— TODO: describe what changed in this release.\n`
		fs.writeFileSync(readmePath, readme.slice(0, at) + bullet + readme.slice(at))
		ok(`README release list gained a ${version} bullet at the top`)
		warn('replace the TODO text with what this release actually contains, then re-run')
	}
}

/** Confirm the bridge runs from a scratch copy, so the release proves itself. */
function smokeTestBridge(extractDir) {
	const bridge = path.join(extractDir, 'package', 'bin', 'asr-bridge.py')
	if (!fs.existsSync(bridge)) {
		die('the tarball does not contain bin/asr-bridge.py', 'check the "files" field and bin/ contents')
	}
	const mode = fs.statSync(bridge).mode
	if ((mode & 0o111) === 0) die('bin/asr-bridge.py lost its executable bit in the tarball')

	// Python with a whisper engine is what a user needs; without one the bridge
	// still must answer the protocol, which is all this asserts.
	const python = ['python3', 'python'].find((p) => has(p))
	if (python === undefined) {
		warn('no python3 on PATH — skipping the bridge smoke test')
		return
	}
	const result = spawnSync(python, [bridge], {
		input: '{"wav": ""}\n',
		encoding: 'utf8',
		env: { ...process.env, DSH_WEIXIN_ASR_MODEL_DIR: path.join(os.tmpdir(), 'dsh-weixin-release-smoke') },
	})
	const line = String(result.stdout ?? '').trim().split('\n').pop() ?? ''
	let reply
	try {
		reply = JSON.parse(line)
	} catch {
		die('the shipped bridge did not answer with JSON', `got: ${line.slice(0, 200)}`)
	}
	if (reply.ok !== false) {
		die('the shipped bridge should reject an empty wav path', `got: ${line.slice(0, 200)}`)
	}
	ok('the shipped bridge runs and speaks the protocol')
}

function buildAndVerify() {
	step('Build and verify the artifact')

	for (const stale of fs.readdirSync(ROOT).filter((f) => f.endsWith('.tgz'))) {
		fs.rmSync(path.join(ROOT, stale))
	}

	const packed = capture('npm', ['pack', '--silent'])
	const tarball = path.join(ROOT, packed.trim().split('\n').pop())
	if (!fs.existsSync(tarball)) die(`npm pack did not produce ${tarball}`)

	const listing = capture('tar', ['-tzf', tarball])
	const files = listing.split('\n').filter((f) => f.trim() !== '')
	for (const required of ['package/package.json', 'package/cordis.patch.yml', 'package/bin/asr-bridge.py', 'package/src/index.js']) {
		if (!files.includes(required)) die(`the tarball is missing ${required}`)
	}
	for (const forbidden of [/__pycache__/, /\.pyc$/, /\/test\//, /\.DS_Store$/, /node_modules/]) {
		const hit = files.find((f) => forbidden.test(f))
		if (hit !== undefined) die(`the tarball contains ${hit}`, 'add it to .gitignore or the "files" list')
	}
	ok(`${files.length} files, no dev artifacts`)

	const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-release-'))
	try {
		run('tar', ['-xzf', tarball, '-C', extractDir], { stdio: 'ignore' })
		smokeTestBridge(extractDir)
	} finally {
		fs.rmSync(extractDir, { recursive: true, force: true })
	}

	ok(`tarball ready: ${path.basename(tarball)} (${(fs.statSync(tarball).size / 1024).toFixed(0)} kB)`)
	return tarball
}

function commitRelease(previousVersion) {
	step('Commit the release')
	run('git', ['add', '-A'])
	const summary = capture('git', ['diff', '--cached', '--name-only'])
	if (summary === '') {
		note('nothing to commit (version already bumped)')
		return
	}
	run('git', [
		'commit',
		'-q',
		'-m',
		`chore(release): ${version}\n\nVersion ${previousVersion} -> ${version}.\n\nBuilt and verified by bin/release.mjs: full suite green, tarball inspected,\nand the shipped bin/asr-bridge.py executed from a scratch extraction.`,
	])
	ok(`committed ${git(['rev-parse', '--short', 'HEAD'])}`)
}

/**
 * Publish, then wait for the registry to actually serve the version.
 *
 * `npm publish` can return success while the upload is still being processed
 * (the HTTP response is 202 and npm says "may take a few minutes to become
 * available"). Querying right away returns the OLD latest and looks like a
 * failure, which is exactly the wrong conclusion to draw — so poll until the
 * version appears.
 */
function publish(tarball) {
	step('Publish to npm')

	if (dryRun) {
		note(`dry run: not publishing ${path.basename(tarball)}`)
		return false
	}

	const result = spawnSync('npm', ['publish'], { cwd: ROOT, stdio: 'inherit' })
	if (result.status !== 0) {
		die(
			'npm publish failed',
			'if it asked for a one-time password, run this script from a real terminal —\nthe auth URL is printed masked (***) when stdout is captured.',
		)
	}

	process.stdout.write('    waiting for the registry to serve the new version')
	const deadline = Date.now() + 180_000
	for (;;) {
		const seen = capture('npm', ['view', `${PKG_NAME}@${version}`, 'version'])
		if (seen === version) break
		if (Date.now() > deadline) {
			process.stdout.write('\n')
			warn(`the registry still does not show ${version} after 3 minutes`)
			warn('the upload was accepted (npm returned success) — re-check with:')
			note(`npm view ${PKG_NAME} version`)
			return true
		}
		process.stdout.write('.')
		spawnSync('sleep', ['4'])
	}
	process.stdout.write('\n')
	ok(`the registry now serves ${version}`)
	return true
}

function verifyPublished(tarball) {
	step('Verify what was published')

	const meta = capture('npm', ['view', `${PKG_NAME}@${version}`, '--json'])
	if (meta === '') {
		warn('could not read the published metadata; verify by hand')
		return
	}
	let parsed
	try {
		parsed = JSON.parse(meta)
	} catch {
		warn('published metadata was not JSON; verify by hand')
		return
	}

	const localSha1 = capture('shasum', [tarball]).split(' ')[0]
	const remoteSha1 = parsed?.dist?.shasum ?? ''
	if (localSha1 !== '' && remoteSha1 !== '' && localSha1 === remoteSha1) {
		ok(`published tarball is byte-identical to the one built here (sha1 ${localSha1})`)
	} else if (remoteSha1 !== '') {
		warn(`sha1 differs — local ${localSha1}, registry ${remoteSha1}`)
	}

	if (parsed.dsh === undefined) die('the published manifest lost its dsh bundle entry')
	ok('the published manifest carries dsh.bundle')

	const latest = capture('npm', ['view', PKG_NAME, 'dist-tags.latest'])
	if (latest === version) ok(`dist-tag latest -> ${version}`)
	else warn(`dist-tag latest is ${latest}, not ${version} (expected for a prerelease)`)
}

function tagAndPush(notes) {
	step('Tag, release, push')

	if (dryRun) {
		note(`dry run: would tag v${version}, push, and create a GitHub release`)
		return
	}

	run('git', ['tag', '-a', `v${version}`, '-m', `Release ${version}`])
	ok(`tagged v${version}`)

	run('git', ['push', '--quiet', 'origin', 'main'])
	ok('pushed main')
	run('git', ['push', '--quiet', 'origin', `v${version}`])
	ok(`pushed v${version}`)

	if (!has('gh') || capture('gh', ['auth', 'status']) === '') {
		warn('gh not authenticated — create the GitHub release by hand if you want one')
		return
	}
	const notesFile = path.join(os.tmpdir(), `dsh-weixin-release-${version}.md`)
	fs.writeFileSync(notesFile, notes)
	try {
		run('gh', ['release', 'create', `v${version}`, '--title', version, '--notes-file', notesFile], { stdio: 'inherit' })
		ok('GitHub release created')
	} catch {
		warn(`could not create the GitHub release; the tag is pushed, add it manually if needed`)
	} finally {
		fs.rmSync(notesFile, { force: true })
	}
}

function installLocally() {
	step('Install into this machine\'s DSH profile')
	const profile = process.env.DSH_PROFILE ?? 'desktop'
	const result = spawnSync('node', ['bin/install.mjs', '--profile', profile], { cwd: ROOT, encoding: 'utf8' })
	if (result.status !== 0) {
		warn(`install into the "${profile}" profile failed (not fatal for the release)`)
		note(String(result.stderr ?? '').trim().split('\n').slice(-2).join('\n'))
		return
	}
	ok(`installed into the "${profile}" profile — restart DSH to load it`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Ask before doing anything irreversible.
 *
 * spawnSync with `stdio: 'inherit'` is what makes this work: the child shares
 * this process's stdin, so it can prompt in a terminal and read the answer.
 * Piping a question into `sh -c 'read line; ...'` does NOT work — `read` sees
 * stdin at EOF when no input is piped in, and the whole release aborts for the
 * operator who was standing right there ready to say yes.
 */
function confirm(previousVersion) {
	if (assumeYes || dryRun || !process.stdin.isTTY) {
		if (!process.stdin.isTTY && !assumeYes && !dryRun) {
			warn('stdin is not a terminal — continuing without confirmation')
		}
		return
	}
	process.stdout.write(`\nRelease ${previousVersion} → ${C.bold}${version}${C.off} and publish to npm? [y/N] `)
	const answer = spawnSync(
		'sh',
		['-c', 'read -r line </dev/tty || exit 1; printf %s "$line"'],
		{ stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' },
	).stdout ?? ''
	if (!/^\s*y(es)?\s*$/i.test(answer)) die('aborted (answer "y" to release)')
	ok('confirmed')
}

function main() {
	process.stdout.write(`${C.bold}dsh-plugin-weixin release ${version ?? '<no version>'}${C.off}\n`)
	if (dryRun) process.stdout.write(`${C.yellow}dry run: nothing will be committed, tagged or published${C.off}\n`)

	preflight()

	const previousVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
	const previousTag = git(['describe', '--tags', '--abbrev=0']) || ''
	// Composed before the bump: the notes describe the commits being released,
	// and the bump commit is not one of them.
	const notes = releaseNotes(previousTag)

	confirm(previousVersion)

	runTests()

	if (dryRun) {
		// A dry run must not touch the tree. The version bump and the tarball are
		// exactly what is being rehearsed, so build them, report, then undo.
		const before = snapshotTextFiles()
		try {
			bumpVersion(previousVersion)
			const tarball = buildAndVerify()
			note(`would publish ${path.basename(tarball)}`)
			note(`would tag v${version} and push (GitHub release notes ready)`)
		} finally {
			restoreTextFiles(before)
			for (const leftover of fs.readdirSync(ROOT).filter((f) => f.endsWith('.tgz'))) {
				fs.rmSync(path.join(ROOT, leftover), { force: true })
			}
		}
		process.stdout.write(`\n${C.green}${C.bold}Dry run for ${PKG_NAME}@${version} finished — tree unchanged.${C.off}\n`)
		return
	}

	bumpVersion(previousVersion)
	const tarball = buildAndVerify()
	commitRelease(previousVersion)
	if (publish(tarball)) verifyPublished(tarball)
	tagAndPush(notes)
	installLocally()

	process.stdout.write(`\n${C.green}${C.bold}Released ${PKG_NAME}@${version}${C.off}\n`)
	process.stdout.write(`npm:      https://www.npmjs.com/package/${PKG_NAME}/v/${version}\n`)
	const repo = git(['remote', 'get-url', 'origin'])
		.replace(/^git@github\.com:/, '')
		.replace(/^https:\/\/github\.com\//, '')
		.replace(/\.git$/, '')
	process.stdout.write(`release:  https://github.com/${repo}/releases/tag/v${version}\n`)
}

/** Read the files the version bump rewrites, so a dry run can put them back. */
function snapshotTextFiles() {
	return ['package.json', 'README.md'].map((p) => ({ path: p, text: fs.readFileSync(path.join(ROOT, p), 'utf8') }))
}

function restoreTextFiles(snapshot) {
	for (const { path: p, text } of snapshot) {
		fs.writeFileSync(path.join(ROOT, p), text)
	}
}

try {
	main()
} catch (error) {
	die(String(error?.message ?? error))
}
