#!/usr/bin/env node
// Vendor drift check (E32).
//
// vendor/openclaw-weixin is a copy of the published @tencent-weixin/openclaw-weixin
// package. Nothing stopped a hand edit from sneaking in, and nothing noticed when
// the vendored copy no longer matched what the tarball said it was — which makes
// "we patched one call site" impossible to audit later.
//
// `--write` records the current hashes; the default mode compares and prints
// every file that appeared, vanished or changed. It is deliberately a plain file
// so a reviewer sees the diff.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = path.join(ROOT, 'vendor', 'openclaw-weixin')
const MANIFEST = path.join(ROOT, 'vendor', 'openclaw-weixin.manifest.json')

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function collect() {
  if (fs.existsSync(VENDOR) !== true) return {}
  const files = {}
  for (const file of walk(VENDOR).sort()) {
    files[path.relative(VENDOR, file).split(path.sep).join('/')] = hash(file)
  }
  return files
}

export function diff(current, recorded) {
  const changed = []
  const added = []
  const removed = []
  for (const [name, digest] of Object.entries(current)) {
    if (recorded[name] === undefined) added.push(name)
    else if (recorded[name] !== digest) changed.push(name)
  }
  for (const name of Object.keys(recorded)) {
    if (current[name] === undefined) removed.push(name)
  }
  return { changed, added, removed }
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) } catch { return undefined }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const current = collect()
  const count = Object.keys(current).length
  if (process.argv.includes('--write')) {
    const pkg = JSON.parse(fs.readFileSync(path.join(VENDOR, 'package.json'), 'utf8'))
    fs.writeFileSync(MANIFEST, `${JSON.stringify({ name: pkg.name, version: pkg.version, files: current }, null, 2)}\n`, 'utf8')
    process.stdout.write(`recorded ${count} files from ${pkg.name}@${pkg.version}\n`)
    process.exit(0)
  }
  const manifest = readManifest()
  if (manifest === undefined) {
    process.stdout.write('no manifest yet — run `node bin/vendor-manifest.mjs --write`\n')
    process.exitCode = 1
  } else {
    const { changed, added, removed } = diff(current, manifest.files)
    if (changed.length + added.length + removed.length === 0) {
      process.stdout.write(`✓ vendor/ matches the manifest (${count} files, ${manifest.name}@${manifest.version})\n`)
    } else {
      for (const name of changed) process.stdout.write(`~ ${name}\n`)
      for (const name of added) process.stdout.write(`+ ${name}\n`)
      for (const name of removed) process.stdout.write(`- ${name}\n`)
      process.stdout.write(`\nvendor/ drifted from ${manifest.name}@${manifest.version}. Either re-vendor and re-record, or document the patch in docs/progress.md.\n`)
      process.exitCode = 1
    }
  }
}
