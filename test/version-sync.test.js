/**
 * One version, four places.
 *
 * The card reads `PLUGIN_VERSION` from `src/client.js` and the "update check"
 * compares it with the registry; the READMEs print the published version line.
 * During the 1.4.6 / 1.4.7 releases the package.json moved while those three
 * stayed at 1.4.5, so the card showed an older version than npm was serving and
 * "published version up to date" was computed from a lie.
 *
 * `bin/release.mjs` bumps all five files, but releases published from a tag
 * (CI) skip that script, so the drift has to be caught by a test instead.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const read = (relative) => fs.readFileSync(path.join(PROJECT_ROOT, relative), 'utf8')

test('the card, both READMEs and the changelog agree with package.json', () => {
  const { version, name } = JSON.parse(read('package.json'))
  assert.match(version, /^\d+\.\d+\.\d+$/)

  const client = read('src/client.js')
  const declared = /const PLUGIN_VERSION = "([^"]+)"/.exec(client)[1]
  assert.equal(declared, version, 'the about card must show the version it is actually running')

  const lock = JSON.parse(read('package-lock.json'))
  assert.equal(lock.version, version, 'the lockfile root version follows package.json')
  assert.equal(lock.packages[''].version, version)

  const zh = /当前已发布版本：\[`([^`]+)`\]/.exec(read('README.md'))[1]
  const en = /Currently published version: \[`([^`]+)`\]/.exec(read('README.en.md'))[1]
  assert.equal(zh, `${name}@${version}`, 'README.md prints the published version')
  assert.equal(en, `${name}@${version}`, 'README.en.md prints the published version')

  const changelog = read('CHANGELOG.md')
  assert.ok(changelog.includes(`- **${version}**`), `CHANGELOG.md has an entry for ${version}`)
})
