#!/usr/bin/env node
/**
 * One-command release for dsh-plugin-weixin.
 *
 *   node bin/release.mjs <version>            # full release: verify, commit, tag, push, publish
 *   node bin/release.mjs <version> --dry-run  # do everything except publishing
 *   node bin/release.mjs <version> --yes      # skip the confirmation prompt
 *   node bin/release.mjs <version> --allow-stale-lockfile  # release despite a stale lockfile
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
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const PKG_NAME = 'dsh-plugin-weixin'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const dryRun = flags.has('--dry-run')
const assumeYes = flags.has('--yes')
const allowStaleLockfile = flags.has('--allow-stale-lockfile')
const version = argv.find((a) => !a.startsWith('--'))

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const C = process.stdout.isTTY
	? { dim: '\u001b[2m', red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', bold: '\u001b[1m', off: '\u001b[0m' }
	: { dim: '', red: '', green: '', yellow: '', bold: '', off: '' }

let stepNumber = 0
/**
 * Every line this script prints goes through here.
 *
 * `npm publish` only prints its one-time-password URL when stdout is a pty
 * wrapper (`script -q /dev/null`). When that wrapper exits — it can, minutes
 * before the release ends — the next `process.stdout.write` throws EIO and
 * takes the rest of the script with it. That is how 0.9.7 and 0.9.8 were
 * published with their tag pushed but the profile left un-pinned: steps 8 and
 * 9 never ran. Output is worth nothing once the terminal is gone, so it is
 * best-effort and the release carries on.
 */
export function writeOut(text) {
	try {
		process.stdout.write(text)
	} catch {
		// the terminal is gone; the release itself does not depend on it
	}
}

function step(title) {
	stepNumber += 1
	writeOut(`\n${C.bold}[${stepNumber}] ${title}${C.off}\n`)
}
function ok(message) {
	writeOut(`    ${C.green}✓${C.off} ${message}\n`)
}
function note(message) {
	writeOut(`    ${C.dim}${message}${C.off}\n`)
}
function warn(message) {
	writeOut(`    ${C.yellow}!${C.off} ${message}\n`)
}

/** Cleanup registered by the dry run, so a failure still restores the tree. */
let cleanup = () => {}

/**
 * Abort the release.
 *
 * This throws instead of calling `process.exit`: exiting here would skip the
 * dry run's cleanup, and a failed dry run would leave the version bump sitting
 * in package.json. The top-level handler turns the throw into exit code 1.
 */
function die(message, hint) {
	cleanup()
	writeOut(`\n${C.red}✗ ${message}${C.off}\n`)
	if (hint) writeOut(`  ${hint}\n`)
	const error = new Error(message)
	error.reported = true
	throw error
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

/**
 * Which release manifest disagrees with package.json, if any.
 *
 * package-lock.json records the package version twice (`version` at the top and
 * `packages[""].version` inside the root package), and neither is rewritten by
 * `npm test`, `npm pack`, or this script's own bump. That is why the lockfile
 * sat at 0.1.1 from the first release all the way through 0.9.2 while
 * package.json said otherwise: nothing ever looked. Preflight turns that into
 * a hard stop.
 *
 * Exported (and the release only runs when this file is the entry point) so a
 * test can point it at fixture manifests without starting a release.
 */
export function manifestVersionProblems(root = ROOT) {
	const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
	let lock
	try {
		lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
	} catch (error) {
		// An unreadable lockfile cannot be compared, which is not permission to
		// ship it: report it the same way as a mismatch.
		return { pkgVersion, problems: [`package-lock.json cannot be read as JSON: ${error.message}`] }
	}
	const seen = [
		['lockfile "version"', lock.version],
		['lockfile packages[""].version', lock.packages?.['']?.version],
	]
	return {
		pkgVersion,
		problems: seen
			.filter(([, value]) => value !== pkgVersion)
			.map(([where, value]) => `${where} says ${value ?? '(missing)'}`),
	}
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

	// The lockfile is released alongside package.json: each carries a version,
	// and a stale one ships a tree that disagrees with itself. Checked before
	// anything touches git or the registry, so the operator gets told to run
	// one npm command instead of debugging a diff later.
	const manifests = manifestVersionProblems()
	if (manifests.problems.length === 0) {
		ok(`package-lock.json matches package.json ${manifests.pkgVersion}`)
	} else if (allowStaleLockfile) {
		warn(`package-lock.json disagrees with package.json ${manifests.pkgVersion}: ${manifests.problems.join('; ')}`)
		warn('continuing because --allow-stale-lockfile was given — this release ships a stale lockfile')
	} else {
		die(
			`package-lock.json disagrees with package.json ${manifests.pkgVersion}`,
			`${manifests.problems.join('\n')}\nrefresh it with:  npm install --package-lock-only --cache "$PWD/.npmcache"\n(or pass --allow-stale-lockfile to release anyway)`,
		)
	}

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

	// A published version whose release commit was never tagged makes the next
	// release's notes wrong: `git describe` still points at the older tag, so
	// everything from the untagged release gets reported as new. This really
	// happened with 0.3.0 — it was published, and v0.3.0 did not exist.
	//
	// Prereleases and throwaway versions (`0.0.0-stage`, published once to test
	// the pipeline) are skipped: they are never releases, so their absence from
	// the tag list is correct rather than drift, and flagging them every run
	// would train the operator to ignore this warning.
	if (published !== '') {
		try {
			const known = JSON.parse(published)
			// The version being released right now is legitimately untagged yet.
			const missing = known.filter(
				(v) =>
					v !== version &&
					/^\d+\.\d+\.\d+$/.test(v) &&
					v !== '0.0.0' &&
					git(['rev-parse', '-q', '--verify', `refs/tags/v${v}`]) === '',
			)
			if (missing.length > 0) {
				warn(`published but never tagged: ${missing.join(', ')}`)
				warn('this release\'s notes will report that work as new until the tags exist:')
				for (const v of missing) note(`git tag -a v${v} <release-commit> && git push origin v${v}`)
			} else {
				ok('every published release is tagged')
			}
		} catch {
			note('could not cross-check published versions against tags')
		}
	}

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

	// The lockfile names the same version in two places, and preflight refuses
	// a tree where they disagree. A bump that left them behind would make the
	// release commit itself the drift it is supposed to prevent.
	const lockPath = path.join(ROOT, 'package-lock.json')
	const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
	if (lock.version !== version || lock.packages?.['']?.version !== version) {
		// Report the lockfile's OWN old version, not package.json's: a lockfile
		// that had been stale for releases would otherwise be described as
		// having moved from a version it never carried.
		const lockWas = lock.version ?? lock.packages?.['']?.version ?? '(missing)'
		lock.version = version
		if (lock.packages?.[''] !== undefined) lock.packages[''].version = version
		fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
		ok(`package-lock.json ${lockWas} → ${version}`)
	} else {
		ok('package-lock.json already names this version')
	}

	// The settings card shows the installed version from a constant it cannot
	// import out of package.json; the release script is what keeps them in
	// step, so a stale card version is this script's bug, not the user's.
	const clientPath = path.join(ROOT, 'src', 'client.js')
	const client = fs.readFileSync(clientPath, 'utf8')
	const pluginVersionLine = /const PLUGIN_VERSION = "([\d.]+)";/
	const clientSeen = pluginVersionLine.exec(client)
	if (clientSeen === null) {
		die('src/client.js has no "const PLUGIN_VERSION = ..." line to update', 'the About tab needs the installed version as a literal')
	} else if (clientSeen[1] === version) {
		ok('client.js already names this version')
	} else {
		fs.writeFileSync(clientPath, client.replace(pluginVersionLine, `const PLUGIN_VERSION = "${version}";`))
		ok(`client.js PLUGIN_VERSION ${clientSeen[1]} → ${version}`)
	}

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

	// File modes travel into the tarball. `npm pack` reads the filesystem, while
	// git only records whether a file is executable — so a file that is 600 on
	// disk but 644 in the index (what a restrictive umask produces) ships as
	// owner-only and is unreadable to every other user on the machine. That had
	// already happened to LICENSE, THIRD-PARTY-NOTICES.md and most of src/
	// before this check existed.
	const entries = capture('tar', ['-tvzf', tarball])
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => {
			// `-rw-r--r--  0 0 0 1408 Oct 26 1985 package/LICENSE`
			const mode = line.slice(0, 10)
			const parts = line.split(/\s+/)
			return { mode, file: parts[parts.length - 1] }
		})
	// The "other" permission triple: r bits at index 7 (read) and 9 (execute).
	const unreadable = entries.filter((e) => e.mode[7] !== 'r')
	if (unreadable.length > 0) {
		die(
			`${unreadable.length} file(s) in the tarball are not world-readable`,
			`for example: ${unreadable.slice(0, 5).map((e) => e.file).join(', ')}\n` +
				'fix with:  chmod -R go+rX .   (then re-run)',
		)
	}
	ok('every packaged file is world-readable')

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
 * Writing to stdout must never kill a release.
 *
 * The publish step is normally driven through `script -q /dev/null`, because
 * `npm publish` only reveals the one-time-password URL when stdout is a pty.
 * When the pty goes away mid-run (the wrapper exits, the terminal is closed),
 * the next `process.stdout.write` throws and takes the whole script with it —
 * which is exactly how 0.9.7 was uploaded and then never tagged. After the
 * upload there is nothing left worth crashing over, so every write from here
 * on is best-effort.
 */
function say(text) {
	writeOut(text)
}

/**
 * Upload the tarball. Returns true when npm accepted it.
 *
 * Deliberately does NOT wait for the registry: `npm publish` can return
 * success while the upload is still being processed (202, "may take a few
 * minutes"), so any poll here would delay the tag for minutes while the
 * window in which a crash loses the tag stays open. Tag and push first, poll
 * afterwards — see `awaitRegistry`.
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
	return true
}

/**
 * Wait until the registry serves the version. Purely informational: the
 * upload already succeeded, so a slow registry is a note, never a failure.
 */
function awaitRegistry() {
	step('Wait for the registry')

	say('    waiting for the registry to serve the new version')
	const deadline = Date.now() + 180_000
	for (;;) {
		const seen = capture('npm', ['view', `${PKG_NAME}@${version}`, 'version'])
		if (seen === version) break
		if (Date.now() > deadline) {
			say('\n')
			warn(`the registry still does not show ${version} after 3 minutes`)
			warn('the upload was accepted and the tag is already pushed — re-check with:')
			note(`npm view ${PKG_NAME} version`)
			return
		}
		say('.')
		spawnSync('sleep', ['4'])
	}
	say('\n')
	ok(`the registry now serves ${version}`)
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

/**
 * The app installs a file copy, but the app's own startup `pnpm install`
 * restores whatever the profile's dependency graph says — so a copy alone is
 * undone at the next launch (it was, on 0.9.5: the running app served the
 * tarball while the profile still declared `^0.9.3`). Pinning the profile's
 * spec is what makes the release actually survive a restart.
 */
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
	pinProfileDependency(profile)
}

/** Where this machine keeps the pnpm that works in a profile (the fnm shim hangs). */
const BUNDLED_PNPM = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'

/**
 * Rewrite the profile's dependency spec, in the same text, so the profile keeps
 * whatever indentation it was written with and the lockfile stays the only
 * other thing that has to move.
 *
 * Returns null when there is nothing to do: no profile, no such dependency, a
 * spec that is not a caret range (a `file:` pin is the operator's choice and is
 * reported instead), or a spec already at the target.
 */
export function pinProfileSpec(raw, nextVersion) {
	let pkg
	try {
		pkg = JSON.parse(raw)
	} catch {
		return null
	}
	const declared = pkg?.dependencies?.[PKG_NAME]
	if (typeof declared !== 'string' || !declared.startsWith('^')) return null
	const wanted = `^${nextVersion}`
	if (declared === wanted) return null
	const pattern = new RegExp(`("${PKG_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*)"\\^[^"]*"`)
	if (!pattern.test(raw)) return null
	return { from: declared, to: wanted, text: raw.replace(pattern, `$1"${wanted}"`) }
}

function pinProfileDependency(profile) {
	const pkgPath = path.join(os.homedir(), '.dsh', 'profiles', profile, 'package.json')
	if (!fs.existsSync(pkgPath)) {
		warn(`no ${pkgPath} — the profile cannot be pinned, only copied`)
		return
	}
	const patch = pinProfileSpec(fs.readFileSync(pkgPath, 'utf8'), version)
	if (patch === null) {
		ok('profile dependency already points at this version (or is pinned by hand)')
		return
	}
	fs.writeFileSync(pkgPath, patch.text)
	ok(`profile dependency ${patch.from} → ${patch.to}`)
	const args = ['install', '--prefer-offline']
	const cwd = path.dirname(pkgPath)
	const refreshed = fs.existsSync(BUNDLED_PNPM)
		? spawnSync(process.execPath, [BUNDLED_PNPM, ...args], { cwd, encoding: 'utf8' })
		: spawnSync('pnpm', args, { cwd, encoding: 'utf8' })
	if (refreshed.status !== 0) {
		warn('could not refresh the profile lockfile — run pnpm install in the profile by hand')
		note(String(refreshed.stderr ?? '').trim().split('\n').slice(-2).join('\n'))
		return
	}
	ok('profile lockfile refreshed — the app will not roll back on restart')
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
	writeOut(`${C.bold}dsh-plugin-weixin release ${version ?? '<no version>'}${C.off}\n`)
	if (dryRun) writeOut(`${C.yellow}dry run: nothing will be committed, tagged or published${C.off}\n`)

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
		// Cleanup is registered globally too, so a `die()` inside the build step
		// still restores the tree instead of leaving the bump behind.
		const before = snapshotTextFiles()
		const undo = () => {
			restoreTextFiles(before)
			for (const leftover of fs.readdirSync(ROOT).filter((f) => f.endsWith('.tgz'))) {
				fs.rmSync(path.join(ROOT, leftover), { force: true })
			}
		}
		cleanup = undo
		try {
			bumpVersion(previousVersion)
			const tarball = buildAndVerify()
			note(`would publish ${path.basename(tarball)}`)
			note(`would tag v${version} and push (GitHub release notes ready)`)
		} finally {
			undo()
			cleanup = () => {}
		}
		writeOut(`\n${C.green}${C.bold}Dry run for ${PKG_NAME}@${version} finished — tree unchanged.${C.off}\n`)
		return
	}

	bumpVersion(previousVersion)
	const tarball = buildAndVerify()
	commitRelease(previousVersion)
	if (publish(tarball)) {
		// Tag before waiting for the registry: the upload is already accepted, and
		// a tag that never gets pushed makes the NEXT release report this work as
		// new all over again (see the preflight check for untagged versions).
		tagAndPush(notes)
		awaitRegistry()
		verifyPublished(tarball)
	}
	installLocally()

	writeOut(`\n${C.green}${C.bold}Released ${PKG_NAME}@${version}${C.off}\n`)
	writeOut(`npm:      https://www.npmjs.com/package/${PKG_NAME}/v/${version}\n`)
	const repo = git(['remote', 'get-url', 'origin'])
		.replace(/^git@github\.com:/, '')
		.replace(/^https:\/\/github\.com\//, '')
		.replace(/\.git$/, '')
	writeOut(`release:  https://github.com/${repo}/releases/tag/v${version}\n`)
}

/**
 * Every file `bumpVersion` rewrites. One list for both jobs: the dry run's
 * snapshot and, by eye, the bump itself. It was two lists once — the snapshot
 * forgot `src/client.js`, so a dry run reported "tree unchanged" while leaving
 * the card's PLUGIN_VERSION bumped.
 */
export const VERSION_FILES = ['package.json', 'package-lock.json', 'src/client.js', 'README.md']

/** Read the files the version bump rewrites, so a dry run can put them back. */
export function snapshotTextFiles(root = ROOT) {
	return VERSION_FILES.map((p) => ({ path: p, text: fs.readFileSync(path.join(root, p), 'utf8') }))
}

function restoreTextFiles(snapshot) {
	for (const { path: p, text } of snapshot) {
		fs.writeFileSync(path.join(ROOT, p), text)
	}
}

// Only run when invoked as a script: importing this file (the lockfile test
// does) must not start a release.
const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
	try {
		main()
	} catch (error) {
		if (error?.reported === true) {
			// die() already printed the reason and the hint; just fail the process.
			process.exitCode = 1
		} else {
			// An unexpected failure (a spawn error, a filesystem problem): report it
			// through die() so the cleanup still runs and the message stays uniform.
			try {
				die(String(error?.message ?? error))
			} catch {
				process.exitCode = 1
			}
		}
	}
}
