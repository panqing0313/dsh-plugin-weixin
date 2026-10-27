import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collect, diff } from '../bin/vendor-manifest.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the vendored package matches its recorded manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'openclaw-weixin.manifest.json'), 'utf8'))
  const current = collect()
  const { changed, added, removed } = diff(current, manifest.files)
  assert.deepEqual(changed, [], 'these vendored files were edited since the manifest was recorded; re-record or document the patch')
  assert.deepEqual(added, [], 'these vendored files appeared after the manifest was recorded')
  assert.deepEqual(removed, [], 'these vendored files disappeared after the manifest was recorded')
  assert.ok(Object.keys(current).length > 10, 'the manifest must actually cover the vendor tree')
})

test('diff reports all three kinds of drift', () => {
  const { changed, added, removed } = diff({ a: '1', b: '2', d: '4' }, { a: '1', b: 'x', c: '3' })
  assert.deepEqual(changed, ['b'])
  assert.deepEqual(added, ['d'])
  assert.deepEqual(removed, ['c'])
})
