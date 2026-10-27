#!/usr/bin/env node
/**
 * Install (or uninstall) dsh-plugin-weixin into a DSH profile.
 *
 * A DSH bundle is just a resolvable package plus two registrations, so this
 * script does exactly three things and nothing else:
 *   1. copy this package (vendored transport included) into
 *      <profile>/node_modules/dsh-plugin-weixin, plus the optional runtime
 *      dependencies (qrcode-terminal for bin/login.js, silk-wasm for SILK→WAV
 *      decoding) into <profile>/node_modules — our own node_modules is never
 *      copied, so a dependency that is only reachable from this tree has to be
 *      carried;
 *   2. append `dsh-plugin-weixin` to `dsh.profile.bundles` in the profile
 *      package.json, so the bundle's own patch layer — which already mounts the
 *      plugin row — is applied;
 *   3. write the operator's settings to <DSH_HOME>/weixin/config.json, and
 *      delete any `- insert:` row an earlier release of this script left in the
 *      profile's cordis.patch.yml.
 *
 * Step 3 is the correction. Writing that patch row mounts the plugin a SECOND
 * time: the bundle layer inserts the same row, DSH applies both layers, and an
 * insert with no top-level `id` appends rather than overrides. The result is two
 * loader entries for one package, each running its own long-poll loop against
 * the same WeChat account. The `disabled` guard meant to prevent it compares
 * `e.options.id` against `'dsh-weixin'`, which both rows equal, so it never
 * fires. `dsh-better-sidebar` documents the same rule for its own bundle: a
 * profile still carrying the manual mount line must drop it before switching to
 * the bundle channel "to avoid double-mounting".
 *
 * Settings therefore live beside the credentials under the plugin's state root,
 * where a reinstall cannot reach them and the loader cannot double-apply them.
 *
 * Both optional dependencies are best-effort: a missing source or a failed copy
 * prints a note and the plugin still loads. Losing them costs convenience
 * (QR rendering, voice decoding), never correctness.
 *
 * Steps 2 and 3 are idempotent: re-running never duplicates an entry and never
 * resets a setting the operator already saved.
 *
 * Usage:
 *   node bin/install.mjs [--profile <name>] [--uninstall] [--pin]
 * @module dsh-weixin/install
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const argv = process.argv.slice(2)
function readFlag(name) {
  const i = argv.indexOf(`--${name}`)
  return i === -1 || i + 1 >= argv.length ? undefined : argv[i + 1]
}
const uninstall = argv.includes('--uninstall')
// C35: copying files is enough to try the plugin once, and never enough for it
// to survive a restart — the profile's own `pnpm install` puts the published
// version back. `--pin` makes the install durable: point the profile's
// dependency at the version being copied and refresh its lockfile.
const pin = argv.includes('--pin')

const PKG_NAME = 'dsh-plugin-weixin'
const ROW_ID = 'dsh-weixin'

const sourceRoot = path.resolve(import.meta.dirname, '..')
const ownVersion = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version
const profileName = readFlag('profile') ?? process.env.DSH_PROFILE ?? 'desktop'
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profileName)

function fail(message) {
  process.stderr.write(`dsh-weixin install: ${message}\n`)
  process.exit(1)
}

if (!fs.existsSync(profileDir)) fail(`profile not found: ${profileDir}`)

const targetDir = path.join(profileDir, 'node_modules', PKG_NAME)
const profilePkgPath = path.join(profileDir, 'package.json')
const patchPath = path.join(profileDir, 'cordis.patch.yml')

/** Everything the plugin needs at runtime; dev-only files are left behind. */
// assets carries the icon the manifest's `icon` field points at; leaving it
// out made the host's metadata reader fail with ENOENT on the deployed copy.
const COPY_ENTRIES = ['src', 'bin', 'vendor', 'assets', 'package.json', 'cordis.patch.yml', 'README.md', 'THIRD-PARTY-NOTICES.md']
const IGNORE = new Set(['node_modules', '.git', 'test', 'docs', '.npmcache'])

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

// ---------------------------------------------------------------- uninstall --

if (uninstall) {
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true })
    process.stdout.write(`removed ${targetDir}\n`)
  }
  const pkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
  const bundles = pkg.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(PKG_NAME)) {
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== PKG_NAME)
    fs.writeFileSync(profilePkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    process.stdout.write(`removed ${PKG_NAME} from dsh.profile.bundles\n`)
  }
  process.stdout.write(
    `\n已卸载。凭据和设置保留在 ${path.join(dshHome, 'weixin')}（要彻底清除就删掉这个目录），然后重启 DSH。\n`,
  )
  process.exit(0)
}

// ------------------------------------------------------------------ install --

// 1. Package contents. A fresh copy every time: an old build must not shadow
//    new source, and leftovers could hide a file that was deleted upstream.
fs.rmSync(targetDir, { recursive: true, force: true })
fs.mkdirSync(path.dirname(targetDir), { recursive: true })
for (const entry of COPY_ENTRIES) {
  const src = path.join(sourceRoot, entry)
  if (!fs.existsSync(src)) fail(`missing ${src} (run this from the package root)`)
  const dst = path.join(targetDir, entry)
  if (fs.statSync(src).isDirectory()) copyTree(src, dst)
  else fs.copyFileSync(src, dst)
}
process.stdout.write(`installed package → ${targetDir}\n`)

// qrcode-terminal is only needed by bin/login.js, which dynamically imports it;
// the profile's own dependency graph does not contain it, so carry our copy over
// when the profile does not already have one.
const qrSrc = path.join(sourceRoot, 'node_modules', 'qrcode-terminal')
const qrDst = path.join(profileDir, 'node_modules', 'qrcode-terminal')
if (fs.existsSync(qrSrc) && !fs.existsSync(qrDst)) {
  copyTree(qrSrc, qrDst)
  process.stdout.write(`installed qrcode-terminal → ${qrDst}\n`)
} else if (!fs.existsSync(qrDst)) {
  process.stdout.write(
    `note: qrcode-terminal is not installed; \`node bin/login.js\` will fall back to printing the QR URL.\n` +
      `      To install it: (cd ${profileDir} && pnpm add qrcode-terminal)\n`,
  )
}

// silk-wasm is an *optional* runtime dependency of the vendored SILK transcoder,
// which reaches it by a bare `import('silk-wasm')`. That specifier is resolved
// from the vendored file's own location, so the package has to sit in an
// ancestor node_modules of <profile>/node_modules/dsh-weixin — our package's own
// node_modules is never copied (IGNORE), so without this the deployed copy
// silently degrades to raw SILK even though the development tree transcodes.
//
// Absence must stay non-fatal: mirroring qrcode-terminal, a missing source or a
// failed copy only prints a note. The transcoder already treats a failed import
// as "keep the .silk", so a profile without silk-wasm loses voice *decoding*,
// never the message.
const SILK_PACKAGE = 'silk-wasm'
const silkSrc = path.join(sourceRoot, 'node_modules', SILK_PACKAGE)
const silkDst = path.join(profileDir, 'node_modules', SILK_PACKAGE)
if (fs.existsSync(silkSrc) && !fs.existsSync(silkDst)) {
  try {
    copyTree(silkSrc, silkDst)
    process.stdout.write(`installed ${SILK_PACKAGE} → ${silkDst}\n`)
  } catch (error) {
    process.stdout.write(
      `note: could not install the optional ${SILK_PACKAGE}: ${String(error)}\n` +
        `      Voice notes will be delivered as raw .silk files.\n`,
    )
  }
} else if (!fs.existsSync(silkDst)) {
  process.stdout.write(
    `note: optional ${SILK_PACKAGE} is unavailable; voice notes will be delivered as raw .silk files.\n` +
      `      To install it: (cd ${profileDir} && pnpm add ${SILK_PACKAGE})\n`,
  )
}

// 2. Register the bundle (so its cordis.patch.yml is applied as a layer).
//
// An earlier release was published as `dsh-weixin` before the package was
// renamed to `dsh-plugin-weixin`. A profile that installed the old name still
// lists it under `dsh.profile.bundles`, and the loader will try to resolve a
// package that no longer exists — so drop the superseded entries and their
// on-disk copies. The mounted row is deliberately NOT renamed (it keeps the id
// `dsh-weixin`), so the operator's allowlist survives this migration untouched.
const SUPERSEDED_PACKAGES = ['dsh-weixin']
const pkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
const profileNode = pkg.dsh ?? (pkg.dsh = {})
const profileCfg = profileNode.profile ?? (profileNode.profile = {})
const bundles = Array.isArray(profileCfg.bundles) ? profileCfg.bundles : (profileCfg.bundles = [])
let profileChanged = false
for (const stale of SUPERSEDED_PACKAGES) {
  if (bundles.includes(stale)) {
    profileCfg.bundles = bundles.splice(bundles.indexOf(stale), 1)
    profileChanged = true
    process.stdout.write(`removed superseded ${stale} from dsh.profile.bundles\n`)
  }
  const staleDir = path.join(profileDir, 'node_modules', stale)
  if (fs.existsSync(staleDir)) {
    fs.rmSync(staleDir, { recursive: true, force: true })
    process.stdout.write(`removed the superseded ${stale} copy at ${staleDir}\n`)
  }
}
if (!bundles.includes(PKG_NAME)) {
  bundles.push(PKG_NAME)
  profileChanged = true
  process.stdout.write(`added ${PKG_NAME} to dsh.profile.bundles\n`)
} else if (!profileChanged) {
  process.stdout.write(`${PKG_NAME} already in dsh.profile.bundles\n`)
}
if (profileChanged) fs.writeFileSync(profilePkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

// 2b. The settings card's "来源信息" line prints the profile's *declared* spec,
// not the bytes this installer just copied. A `file:` tarball spec therefore
// survives every upgrade — the card keeps naming an old tarball that may not
// even exist any more, while the version next to it climbs. Do not rewrite the
// operator's dependency (that changes how their next `pnpm install` resolves);
// say exactly what to change instead.
const declared = pkg.dependencies?.[PKG_NAME]
if (typeof declared === 'string' && declared.startsWith('file:')) {
  process.stdout.write(
    `note: the profile still declares "${PKG_NAME}": "${declared}"\n` +
      `      The settings card shows that as 来源信息. Point it at the published package with\n` +
      `      "${PKG_NAME}": "^${ownVersion}" in ${profilePkgPath}\n`,
  )
}

// 3. Operator settings.
//
// These used to be written into the profile's `cordis.patch.yml` as an
// `- insert:` row. That row is the double-mount: this package is ALSO installed
// as a bundle, and a bundle's own patch layer already inserts the same row. DSH
// applies both layers, and an insert with no top-level `id` APPENDS rather than
// overrides — so the profile ends up with two loader entries for one package,
// each starting its own long-poll loop against the same WeChat account. The
// `disabled` guard that was meant to prevent this compares `e.options.id` to
// `'dsh-weixin'`, and both rows carry exactly that id, so the comparison is
// always false and the guard never fires.
//
// `dsh-better-sidebar` documents the rule for its own bundle: a profile still
// carrying the manual mount line must drop it before switching to the bundle
// channel "to avoid double-mounting (two Node halves, two sidebars)".
//
// So the settings no longer live in a loader patch at all. They live beside the
// credentials, under the plugin's state root, where a reinstall cannot reach
// them and the loader cannot double-apply them.
const settingsPath = path.join(dshHome, 'weixin', 'config.json')

/** The values an operator owns and that an upgrade must not silently reset. */
const KEPT_KEYS = ['allowedSenders', 'allowedChats', 'cwd', 'accountId', 'enabled', 'asr', 'maxMessageLength', 'markdownMode']

/**
 * Locate our mounted block in an existing profile patch, by line.
 *
 * Only used to REMOVE a row written by an earlier release of this installer.
 * The block includes the header comment this package used to ship with, because
 * leaving a stale copy behind would strand an orphan comment.
 *
 * @param {string} text
 * @returns {{start: number, end: number}|undefined} line indices, end exclusive
 */
function findMountBlock(text) {
  const lines = text.split('\n')
  const insertAt = lines.findIndex((line, index) => (
    /^\s*-\s*insert:\s*$/.test(line) && /^\s*-\s*id:\s*\S/.test(lines[index + 1] ?? '')
  ))
  if (insertAt === -1) return undefined
  if (!new RegExp(`^\\s*-\\s*id:\\s*${ROW_ID}\\s*$`).test((lines[insertAt + 1] ?? '').trimEnd())) {
    return undefined
  }
  let start = insertAt
  while (start > 0 && lines[start - 1].trimStart().startsWith('#')) start -= 1
  if (start > 0 && lines[start - 1].trim() === '') {
    while (start > 0 && lines[start - 1].trim() === '' &&
           (start - 2 < 0 || lines[start - 2].trimStart().startsWith('#'))) {
      start -= 1
    }
  }
  let end = insertAt + 2
  while (end < lines.length && !/^\s*-\s*insert:\s*$/.test(lines[end])) end += 1
  while (end > insertAt + 2 && lines[end - 1].trim() === '') end -= 1
  return { start, end }
}

/**
 * Read operator-owned values out of a mounted row, so they survive the move
 * from the patch file into the settings file.
 *
 * Values are returned as raw YAML text fragments and converted by
 * {@link parseYamlNode}: this file has no YAML dependency, and the values that
 * matter (a list of WeChat ids, a boolean, a number, a path) are simple enough
 * to read exactly.
 *
 * A nested mapping comes back as dedented `key: value` lines, so `asr:` yields
 * `hfProxy: http://...` and {@link parseYamlNode} turns it back into an object.
 *
 * @param {string} block one mounted row, as YAML text
 * @returns {Record<string, string>} key → raw YAML node text
 */
function readKeptValues(block) {
  const lines = block.split('\n')
  const keep = {}
  for (const key of KEPT_KEYS) {
    const startAt = lines.findIndex((line) => new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`).test(line))
    if (startAt === -1) continue
    const indent = lines[startAt].match(/^[ \t]*/)[0].length
    const collected = []
    // The first deeper line fixes the child indent, so a nested mapping can be
    // dedented to column zero and read as its own small document.
    let childIndent = null
    for (let at = startAt + 1; at < lines.length; at += 1) {
      const line = lines[at]
      if (line.trim() === '') {
        // A blank line continues the node only while a deeper line follows.
        const nextReal = lines.slice(at + 1).find((candidate) => candidate.trim() !== '')
        if (nextReal === undefined) break
        if (nextReal.match(/^[ \t]*/)[0].length <= indent) break
        collected.push('')
        continue
      }
      const lineIndent = line.match(/^[ \t]*/)[0].length
      if (lineIndent <= indent) break
      if (line.trim().startsWith('#')) continue
      if (childIndent === null) childIndent = lineIndent
      // Dedent to the child's own base so the fragment parses standalone; a
      // negative slice (a line shallower than the base, i.e. a nested block
      // already at its own column zero) must not eat characters.
      collected.push(lineIndent <= childIndent ? line.trimStart() : line.slice(childIndent))
    }
    const inline = lines[startAt].slice(indent).replace(new RegExp(`^${key}:[ \\t]*`), '').trim()
    keep[key] = [inline, ...collected].filter((line, index) => index === 0 || line !== '').join('\n')
  }
  return keep
}

/**
 * Convert one raw YAML node captured by {@link readKeptValues} into JSON.
 *
 * Only the shapes an operator actually writes are understood; anything else
 * returns undefined and the key is dropped rather than guessed at.
 *
 * @param {string} raw
 * @returns {unknown}
 */
function parseYamlNode(raw) {
  const text = raw.trim()
  if (text === '') return undefined
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  // Block sequence: every line is `- value`.
  if (lines.length > 0 && lines.every((line) => line.startsWith('-'))) {
    return lines.map((line) => line.replace(/^-[ \t]*/, '').replace(/^['"]|['"]$/g, ''))
  }
  // Flow sequence.
  if (text.startsWith('[') && text.endsWith(']')) {
    const body = text.slice(1, -1).trim()
    return body === '' ? [] : body.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
  }
  // Nested mapping: every line is `key: value`, which is how a captured `asr:`
  // block reads once {@link readKeptValues} dedents it. Without this the block
  // fell through to the scalar branch and became a string, and the caller then
  // dropped it for not being an object — silently losing hfProxy.
  //
  // YAML requires whitespace (or end of line) after the mapping colon, and this
  // is load-bearing rather than pedantic: `http://127.0.0.1:7897` contains a
  // colon, and a looser test reads it as the pair `http` → `//127.0.0.1:7897`.
  if (lines.length > 0 && lines.every((line) => /^[A-Za-z_][\w]*:([ \t]|$)/.test(line))) {
    const nested = {}
    for (const line of lines) {
      const at = line.indexOf(':')
      const key = line.slice(0, at).trim()
      const value = parseYamlNode(line.slice(at + 1))
      if (value !== undefined) nested[key] = value
    }
    return nested
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+$/.test(text)) return Number(text)
  return text.replace(/^['"]|['"]$/g, '')
}

// Migrate: lift the operator's values out of the old patch row, then delete it.
const patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '[]\n'
const block = findMountBlock(patch)
let migrated = {}
if (block !== undefined) {
  const lines = patch.split('\n')
  migrated = readKeptValues(lines.slice(block.start, block.end).join('\n'))
  const next = [...lines.slice(0, block.start), ...lines.slice(block.end)].join('\n')
  fs.writeFileSync(patchPath, next.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n')
  process.stdout.write(`removed the duplicate ${ROW_ID} mount row from ${patchPath}\n`)
}

// Merge: an existing settings file wins over the migrated row (it is newer), and
// a value the operator never set is simply absent, so the schema default applies.
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {}
for (const [key, raw] of Object.entries(migrated)) {
  if (Object.prototype.hasOwnProperty.call(settings, key)) continue
  const value = parseYamlNode(raw)
  if (value === undefined) continue
  if (key === 'asr' && (value === null || typeof value !== 'object')) continue
  settings[key] = value
}
fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`wrote operator settings → ${settingsPath}\n`)

if (pin) {
  const { pinProfileDependency } = await import('./lib/profile-pin.mjs')
  const outcome = pinProfileDependency({
    profile: profileName,
    version: ownVersion,
    dshHome,
    ok: (line) => process.stdout.write(`${line}\n`),
    warn: (line) => process.stderr.write(`${line}\n`),
    note: (line) => process.stdout.write(`  ${line}\n`),
  })
  if (outcome.pinned === false && outcome.reason === 'no-profile-package') {
    process.stdout.write('提示：这个 profile 没有 package.json，只能靠复制 —— 重启后会被覆盖。\n')
  }
} else {
  process.stdout.write(
    `\n提示：这次只是复制文件。profile 里的依赖仍写着已发布的版本，\n` +
      `DSH 下次启动执行 pnpm install 时会把这份副本换回那个版本。\n` +
      `要长期生效，加 --pin 重跑一次（会改 profile 的 package.json 并刷新锁文件）。\n`,
  )
}

process.stdout.write(
  `\n完成。接下来：\n` +
    `  1. node ${path.join(targetDir, 'bin', 'login.js')}       # 扫码绑定微信\n` +
    `  2. 重启 DSH\n` +
    `\n设置存在 ${settingsPath}（不在 node_modules 里，重装不会丢）。\n` +
    `允许的微信 id 写在 allowedSenders 里；空数组表示谁都不允许。\n`,
)
