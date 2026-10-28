import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { DEFAULT_DOCUMENT_CHARS, docxXmlToText, extractDocumentText } from '../src/media/document.js'

/** A one-entry, stored (method 0) zip — enough to be a real OOXML package. */
function zipWith(name, content, { deflate = false } = {}) {
  const nameBuffer = Buffer.from(name, 'utf8')
  const raw = Buffer.from(content, 'utf8')
  const data = deflate ? zlib.deflateRawSync(raw) : raw
  const crc = zlib.crc32 ? zlib.crc32(raw) : 0

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(deflate ? 8 : 0, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(raw.length, 22)
  local.writeUInt16LE(nameBuffer.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(deflate ? 8 : 0, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(raw.length, 24)
  central.writeUInt16LE(nameBuffer.length, 28)
  central.writeUInt32LE(0, 42)

  const cdOffset = local.length + nameBuffer.length + data.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + nameBuffer.length, 12)
  eocd.writeUInt32LE(cdOffset, 16)

  return Buffer.concat([local, nameBuffer, data, central, nameBuffer, eocd])
}

function tempFile(name, buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-doc-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, buffer)
  return file
}

test('docx paragraphs, tabs and entities become readable text', () => {
  const xml =
    '<w:document><w:body>' +
    '<w:p><w:r><w:t>第一条：</w:t></w:r><w:r><w:t>租金 3000 元</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>第二条：</w:t></w:r><w:r><w:tab/><w:t>押一付三</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Tom &amp; Jerry &lt;条款&gt;</w:t></w:r></w:p>' +
    '</w:body></w:document>'
  const file = tempFile('lease.docx', zipWith('word/document.xml', xml))
  const result = extractDocumentText(file)
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'docx')
  assert.match(result.text, /第一条：租金 3000 元/)
  assert.match(result.text, /押一付三/)
  assert.match(result.text, /Tom & Jerry <条款>/)
  assert.equal(result.text.includes('<w:'), false)
})

test('a deflated docx entry is inflated too', () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>压缩过的正文</w:t></w:r></w:p></w:body></w:document>'
  const file = tempFile('z.docx', zipWith('word/document.xml', xml, { deflate: true }))
  assert.equal(extractDocumentText(file).text, '压缩过的正文')
})

test('long text is cut with a note, never silently', () => {
  const xml = `<w:document><w:body><w:p><w:r><w:t>${'字'.repeat(500)}</w:t></w:r></w:p></w:body></w:document>`
  const file = tempFile('long.docx', zipWith('word/document.xml', xml))
  const result = extractDocumentText(file, { maxChars: 100 })
  assert.equal(result.truncated, true)
  assert.match(result.text, /只取了前 100 字/)
  assert.equal(result.text.startsWith('字'.repeat(100)), true)
})

test('plain text documents are read as-is', () => {
  const file = tempFile('notes.md', Buffer.from('# 标题\n\n正文'))
  assert.deepEqual(extractDocumentText(file), { ok: true, text: '# 标题\n\n正文', kind: 'text', truncated: false })
})

test('pdf is reported as unsupported instead of guessed', () => {
  const file = tempFile('contract.pdf', Buffer.from('%PDF-1.7 not really'))
  assert.deepEqual(extractDocumentText(file), { ok: false, reason: 'unsupported' })
})

test('an empty document is a miss, not an empty prompt block', () => {
  const file = tempFile('blank.txt', Buffer.from('   \n\n'))
  assert.deepEqual(extractDocumentText(file), { ok: false, reason: 'empty' })
})

test('a zip without word/document.xml is refused', () => {
  const file = tempFile('other.docx', zipWith('word/styles.xml', '<x/>'))
  const result = extractDocumentText(file)
  assert.equal(result.ok, false)
  assert.match(result.reason, /word\/document\.xml/)
})

test('a non-zip file with a .docx name fails cleanly', () => {
  const file = tempFile('broken.docx', Buffer.from('not a zip at all'))
  const result = extractDocumentText(file)
  assert.equal(result.ok, false)
  assert.match(result.reason, /not a zip/)
})

test('the default limit is a constant the caller can rely on', () => {
  assert.equal(DEFAULT_DOCUMENT_CHARS, 4000)
})
