import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { atomicWriteJson, clearTextFileCache, readJsonFile, readTextFileCached } from '../src/atomic.js'

function tempFile(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-cache-'))
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}

const spec = { version: 1, fallback: () => ({}) }

test('a second read of an unchanged file does not touch the disk again', () => {
  clearTextFileCache()
  const file = tempFile({ schemaVersion: 1, hello: 'world' })
  const read = mock.method(fs, 'readFileSync')
  try {
    assert.deepEqual(readJsonFile(file, spec), { schemaVersion: 1, hello: 'world' })
    assert.equal(read.mock.callCount(), 1, 'first read hits the file')
    assert.deepEqual(readJsonFile(file, spec), { schemaVersion: 1, hello: 'world' })
    assert.equal(read.mock.callCount(), 1, 'the second read is served from the text cache')
  } finally {
    read.mock.restore()
  }
})

test('a write through the atomic path is visible on the very next read', () => {
  clearTextFileCache()
  const file = tempFile({ schemaVersion: 1, n: 1 })
  assert.equal(readJsonFile(file, spec).n, 1)
  atomicWriteJson(file, { schemaVersion: 1, n: 2 })
  assert.equal(readJsonFile(file, spec).n, 2, 'invalidation is not left to mtime resolution')
})

test('an outside rewrite with a different size is picked up', () => {
  clearTextFileCache()
  const file = tempFile({ schemaVersion: 1, text: 'short' })
  assert.equal(readJsonFile(file, spec).text, 'short')
  fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, text: 'a much longer value' })}\n`)
  assert.equal(readJsonFile(file, spec).text, 'a much longer value')
})

test('each read returns its own object, so a caller may mutate it safely', () => {
  clearTextFileCache()
  const file = tempFile({ schemaVersion: 1, list: ['a'] })
  const first = readJsonFile(file, spec)
  first.list.push('b')
  const second = readJsonFile(file, spec)
  assert.deepEqual(second.list, ['a'], 'the cache stores text, never a shared parsed object')
})

test('clearing one entry forces the next read back to the disk', () => {
  clearTextFileCache()
  const file = tempFile({ schemaVersion: 1 })
  readTextFileCached(file)
  const read = mock.method(fs, 'readFileSync')
  try {
    readTextFileCached(file)
    assert.equal(read.mock.callCount(), 0)
    clearTextFileCache(file)
    readTextFileCached(file)
    assert.equal(read.mock.callCount(), 1)
  } finally {
    read.mock.restore()
  }
})

test('a missing file still falls back, and is not cached as empty', () => {
  clearTextFileCache()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-cache-'))
  const file = path.join(dir, 'nope.json')
  assert.deepEqual(readJsonFile(file, { version: 1, fallback: () => ({ fallback: true }) }), { fallback: true })
  fs.writeFileSync(file, '{"schemaVersion":1,"now":true}\n')
  assert.deepEqual(readJsonFile(file, spec), { schemaVersion: 1, now: true })
})
