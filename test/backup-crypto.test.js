import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openState, restoreSealed, sealBuffer, sealState, openBuffer } from '../src/backup-crypto.js'

function stateRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-seal-'))
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true })
  fs.writeFileSync(path.join(root, 'config.json'), '{"secret":"token"}')
  fs.writeFileSync(path.join(root, 'memory', 'conv.json'), '{"bond":{}}')
  fs.writeFileSync(path.join(root, 'instance.lock'), '{"pid":1}')
  fs.mkdirSync(path.join(root, 'backups', 'old'), { recursive: true })
  fs.writeFileSync(path.join(root, 'backups', 'old', 'x.json'), '{}')
  return root
}

test('a sealed file is bytes on disk, not the state in disguise', () => {
  const packed = sealBuffer(Buffer.from('hello token'), 'correct horse')
  assert.equal(packed.subarray(0, 6).toString('ascii'), 'DSHWX1')
  assert.equal(packed.includes(Buffer.from('hello token')), false)
})

test('seal → open round-trips every file', () => {
  const root = stateRoot()
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-sealed-')), 'state.enc')
  const result = sealState(root, { passphrase: 'pw', outFile: out })
  assert.equal(result.files, 2, 'config.json + memory/conv.json')
  assert.equal(fs.existsSync(out), true)

  const opened = openState(out, { passphrase: 'pw' })
  assert.equal(opened.files.get('config.json').toString(), '{"secret":"token"}')
  assert.equal(opened.files.get('memory/conv.json').toString(), '{"bond":{}}')
  assert.equal(opened.files.has('instance.lock'), false)
  assert.equal([...opened.files.keys()].some((rel) => rel.startsWith('backups/')), false)
})

test('a wrong passphrase fails before writing anything', () => {
  const root = stateRoot()
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-sealed-')), 'state.enc')
  sealState(root, { passphrase: 'pw', outFile: out })
  assert.throws(() => openState(out, { passphrase: 'nope' }), /wrong passphrase/)
})

test('a modified ciphertext is rejected, not half-restored', () => {
  const packed = sealBuffer(Buffer.from('{"a":1}'), 'pw')
  packed[packed.length - 1] ^= 0xff
  assert.throws(() => openBuffer(packed, 'pw'), /wrong passphrase|modified/)
})

test('restore writes the files back and reports the count', () => {
  const root = stateRoot()
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-sealed-')), 'state.enc')
  sealState(root, { passphrase: 'pw', outFile: out })
  const opened = openState(out, { passphrase: 'pw' })

  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-restore-'))
  const result = restoreSealed(fresh, opened.files)
  assert.equal(result.restored, 2)
  assert.equal(fs.readFileSync(path.join(fresh, 'config.json'), 'utf8'), '{"secret":"token"}')
  assert.equal(fs.readFileSync(path.join(fresh, 'memory', 'conv.json'), 'utf8'), '{"bond":{}}')
})

test('an archive path that escapes the root is refused', () => {
  const files = new Map([['../outside.txt', Buffer.from('x')]])
  assert.throws(() => restoreSealed(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-restore-')), files), /outside the state root/)
})

test('a passphrase is mandatory', () => {
  assert.throws(() => sealBuffer(Buffer.from('x'), ''), /passphrase is required/)
})

test('sealing twice produces different bytes for the same state (random salt/iv)', () => {
  const root = stateRoot()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-sealed-'))
  const a = sealState(root, { passphrase: 'pw', outFile: path.join(dir, 'a.enc') })
  const b = sealState(root, { passphrase: 'pw', outFile: path.join(dir, 'b.enc') })
  assert.notEqual(fs.readFileSync(a.file).toString('base64'), fs.readFileSync(b.file).toString('base64'))
  assert.equal(openState(a.file, { passphrase: 'pw' }).files.size, openState(b.file, { passphrase: 'pw' }).files.size)
})
