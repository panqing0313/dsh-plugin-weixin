#!/usr/bin/env node
// Fast checks that do not need the suite: every source file parses, and the
// packaging rules the release script cares about hold. This is what CI runs
// before npm test, and what a pre-commit hook should run.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      out.push(...walk(full))
    } else if (/\.(?:js|mjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'bin')), ...walk(path.join(ROOT, 'test'))]
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    problems.push(`${path.relative(ROOT, file)}: ${String(error.stderr ?? error).split('\n')[0]}`)
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const filesField = Array.isArray(pkg.files) ? pkg.files : []
for (const required of ['src', 'bin', 'vendor', 'assets']) {
  if (filesField.includes(required) !== true) problems.push(`package.json files[] is missing ${required}`)
}
if (typeof pkg.dsh?.client === 'undefined') problems.push('package.json is missing dsh.client')

process.stdout.write(`checked ${files.length} files\n`)
if (problems.length > 0) {
  for (const line of problems) process.stdout.write(`✗ ${line}\n`)
  process.exitCode = 1
} else {
  // C31: a provenance attestation is only possible from CI, so the workflow that
// does the publish has to exist for the claim to be true.
const releaseWorkflow = path.join(ROOT, '.github', 'workflows', 'release.yml')
if (fs.existsSync(releaseWorkflow)) {
	const text = fs.readFileSync(releaseWorkflow, 'utf8')
	if (!text.includes('npm publish --provenance')) problems.push('.github/workflows/release.yml does not ask for provenance')
	if (!text.includes('id-token: write')) problems.push('.github/workflows/release.yml cannot get an OIDC token (missing id-token: write)')
} else {
	console.log('· no .github/workflows/release.yml — publishes from CI are not wired up')
}

process.stdout.write('✓ every source file parses, packaging metadata intact\n')
}
