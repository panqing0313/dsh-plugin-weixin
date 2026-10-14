#!/usr/bin/env node
/**
 * Install (or uninstall) dsh-plugin-weixin into a DSH profile.
 *
 * A DSH bundle is just a resolvable package plus two registrations, so this
 * script does exactly three things and nothing else:
 *   1. copy this package (vendored transport included) into
 *      <profile>/node_modules/dsh-weixin, plus the optional runtime dependencies
 *      (qrcode-terminal for bin/login.js, silk-wasm for SILK→WAV decoding) into
 *      <profile>/node_modules — our own node_modules is never copied, so a
 *      dependency that is only reachable from this tree has to be carried;
 *   2. append `dsh-weixin` to `dsh.profile.bundles` in the profile package.json
 *      (so the bundle's own patch layer is applied);
 *   3. append one `- insert:` row to the profile's cordis.patch.yml.
 *
 * Both optional dependencies are best-effort: a missing source or a failed copy
 * prints a note and the plugin still loads. Losing them costs convenience
 * (QR rendering, voice decoding), never correctness.
 *
 * Steps 2 and 3 are idempotent: re-running never duplicates an entry. Step 3 is
 * skipped when a row for this id already exists, so an operator who hand-tuned
 * the config keeps their version.
 *
 * Usage:
 *   node bin/install.mjs [--profile <name>] [--uninstall]
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

const PKG_NAME = 'dsh-plugin-weixin'
const ROW_ID = 'dsh-weixin'

const sourceRoot = path.resolve(import.meta.dirname, '..')
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
const COPY_ENTRIES = ['src', 'bin', 'vendor', 'package.json', 'cordis.patch.yml', 'README.md', 'THIRD-PARTY-NOTICES.md']
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
  process.stdout.write(`\n手动删除 ${patchPath} 里的 dsh-weixin 行（脚本不改你手调过的配置），然后重启 DSH。\n`)
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

// 3. Mount the plugin row.
//
// The row is ours, so an existing copy is not "the user's version": it is an
// older copy of this same file. Replacing it is what lets a corrected `disabled`
// expression or config default actually reach the profile — preserving it
// silently strands the fix. The one value that IS the user's is the allowlist,
// so it is carried across.
const patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '[]\n'
const freshRow = fs.readFileSync(path.join(sourceRoot, 'cordis.patch.yml'), 'utf8').trimEnd()

/** The values an operator owns and that an upgrade must not silently reset. */
const KEPT_KEYS = ['allowedSenders', 'allowedChats', 'cwd', 'accountId', 'enabled']

/**
 * Locate our mounted block by line, so it can be swapped without touching any
 * other bundle's rows. The block includes the file header comment this package
 * ships with: leaving a stale copy behind would accumulate one more duplicated
 * header on every upgrade.
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
  // Walk back over this package's own header comment (blank-line separated from
  // whatever precedes it).
  let start = insertAt
  while (start > 0 && lines[start - 1].trimStart().startsWith('#')) start -= 1
  if (start > 0 && lines[start - 1].trim() === '') {
    // Keep the separator blank line that belongs to the previous row.
    while (start > 0 && lines[start - 1].trim() === '' &&
           (start - 2 < 0 || lines[start - 2].trimStart().startsWith('#'))) {
      start -= 1
    }
  }
  let end = insertAt + 2
  while (end < lines.length && !/^\s*-\s*insert:\s*$/.test(lines[end])) end += 1
  // Trailing blank lines belong to the separator, not to our block.
  while (end > insertAt + 2 && lines[end - 1].trim() === '') end -= 1
  return { start, end }
}

/**
 * Read the operator-owned config values out of the currently mounted row.
 *
 * A value is captured as a whole YAML node, not a single line: `allowedSenders`
 * is naturally written as a block sequence
 *
 *   allowedSenders:
 *     - wxid_abc
 *
 * and a line-anchored `(.+)$` match finds nothing after the colon, which would
 * silently drop the allowlist on every upgrade — the one value the operator had
 * to fill in by hand, and whose loss turns the bot into a silent no-op.
 *
 * Continuation lines are the following lines indented deeper than the key, plus
 * blank lines between them. The capture stops at the next key, so the caller can
 * splice it in verbatim.
 *
 * @param {string} block one mounted row, as YAML text
 * @returns {Record<string, string>} key → raw YAML node text (may be multiline)
 */
function readKeptValues(block) {
  const lines = block.split('\n')
  const keep = {}
  for (const key of KEPT_KEYS) {
    const startAt = lines.findIndex((line) => new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`).test(line))
    if (startAt === -1) continue
    const indent = lines[startAt].match(/^[ \t]*/)[0].length
    const collected = [lines[startAt].trim()]
    for (let at = startAt + 1; at < lines.length; at += 1) {
      const line = lines[at]
      if (line.trim() === '') {
        // A blank line continues the node only if a deeper line follows it.
        const nextReal = lines.slice(at + 1).find((candidate) => candidate.trim() !== '')
        if (nextReal === undefined) break
        if (nextReal.match(/^[ \t]*/)[0].length <= indent) break
        collected.push('')
        continue
      }
      if (line.match(/^[ \t]*/)[0].length <= indent) break
      collected.push(line.trim())
    }
    keep[key] = collected.join('\n')
  }
  return keep
}

const block = findMountBlock(patch)
if (block === undefined) {
  fs.writeFileSync(patchPath, `${patch.trimEnd()}\n${freshRow}\n`)
  process.stdout.write(`appended the ${ROW_ID} row to ${patchPath}\n`)
} else {
  const lines = patch.split('\n')
  const keep = readKeptValues(lines.slice(block.start, block.end).join('\n'))
  let row = freshRow
  for (const [key, value] of Object.entries(keep)) {
    // The fresh row writes each kept key on one line; re-indent the captured
    // node's continuation lines by the same amount so a block sequence stays a
    // valid child of its key.
    const pattern = new RegExp(`^([ \\t]*)${key}:[^\\n]*$`, 'm')
    const indent = row.match(pattern)?.[1] ?? ''
    const replacement = value
      .split('\n')
      .map((line, index) => (index === 0 ? `${indent}${line}` : line === '' ? '' : `${indent}  ${line}`))
      .join('\n')
    row = row.replace(pattern, replacement)
  }
  const next = [...lines.slice(0, block.start), ...row.split('\n'), ...lines.slice(block.end)].join('\n')
  fs.writeFileSync(patchPath, next)
  const kept = Object.keys(keep)
  process.stdout.write(
    `refreshed the ${ROW_ID} row in ${patchPath}` +
      (kept.length > 0 ? ` (kept ${kept.join(', ')})` : '') +
      '\n',
  )
}

process.stdout.write(
  `\n完成。接下来：\n` +
    `  1. node ${path.join(targetDir, 'bin', 'login.js')}       # 扫码绑定微信\n` +
    `  2. 把你的微信 id 填进 ${patchPath} 里 dsh-weixin 行的 allowedSenders\n` +
    `  3. 重启 DSH\n`,
)
