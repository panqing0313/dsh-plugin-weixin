import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  DEFAULT_DOCUMENT_CHARS,
  PDF_LOAD_HINT,
  docxXmlToText,
  extractDocumentText,
  extractDocumentTextAsync,
  extractPdfText,
} from '../src/media/document.js'

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

test('the sync path still refuses pdf; the async path names the missing package', async () => {
  const file = tempFile('contract.pdf', Buffer.from('%PDF-1.7 not really'))
  assert.deepEqual(extractDocumentText(file), { ok: false, reason: 'unsupported' })
  // The default loader is a dynamic import; in a checkout without the optional
  // peer it fails and the caller gets one readable line, not a crash.
  const result = await extractPdfText(file, {
    loadPdf: async () => {
      throw new Error('Cannot find package pdfjs-dist')
    },
  })
  assert.deepEqual(result, { ok: false, reason: PDF_LOAD_HINT })
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

/** A fake pdfjs module: enough of the API `extractPdfText` touches. */
function fakePdfjs(pages) {
  return {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: async (number) => ({
          getTextContent: async () => ({ items: pages[number - 1] }),
        }),
        destroy: async () => {},
      }),
    }),
  }
}

test('pdf text is assembled page by page, with line breaks kept', async () => {
  const file = tempFile('lease.pdf', Buffer.from('%PDF-1.7 fake'))
  const loadPdf = async () =>
    fakePdfjs([
      [{ str: '第一页', hasEOL: true }, { str: '租金 3000 元' }],
      [{ str: '第二页' }],
    ])
  const result = await extractPdfText(file, { loadPdf })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'pdf')
  assert.equal(result.truncated, false)
  assert.match(result.text, /第一页/)
  assert.match(result.text, /租金 3000 元/)
  assert.match(result.text, /第二页/)
  assert.match(result.text, /第一页[\s\S]*第二页/)
})

test('a long pdf is cut with the same note as other documents', async () => {
  const file = tempFile('long.pdf', Buffer.from('%PDF-1.7 fake'))
  const loadPdf = async () => fakePdfjs([[{ str: '字'.repeat(500) }]])
  const result = await extractPdfText(file, { loadPdf, maxChars: 100 })
  assert.equal(result.truncated, true)
  assert.match(result.text, /只取了前 100 字/)
})

test('a pdf with no extractable text is a miss, not an empty prompt block', async () => {
  const file = tempFile('scan.pdf', Buffer.from('%PDF-1.7 fake'))
  const loadPdf = async () => fakePdfjs([[{ str: '   ' }]])
  assert.deepEqual(await extractPdfText(file, { loadPdf }), { ok: false, reason: 'empty' })
})

test('a parser error is reported, not thrown at the inbound loop', async () => {
  const file = tempFile('broken.pdf', Buffer.from('%PDF-1.7 fake'))
  const loadPdf = async () => ({
    getDocument: () => ({ promise: Promise.reject(new Error('Invalid PDF structure')) }),
  })
  const result = await extractPdfText(file, { loadPdf })
  assert.deepEqual(result, { ok: false, reason: 'Invalid PDF structure' })
})

test('the async entry routes non-pdf documents to the sync extractor', async () => {
  const file = tempFile('notes.txt', Buffer.from('正文'))
  assert.deepEqual(await extractDocumentTextAsync(file), extractDocumentText(file))
})

/** Assemble a minimal, valid single-page PDF with a standard Type1 font. */
function minimalPdf(text) {
  const content = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

let pdfjsInstalled = true
try {
  await import('pdfjs-dist/legacy/build/pdf.mjs')
} catch {
  pdfjsInstalled = false
}

test(
  'a real pdf is parsed when pdfjs-dist is installed',
  { skip: pdfjsInstalled ? false : 'pdfjs-dist is an optional peer and is not installed here' },
  async () => {
    const file = tempFile('real.pdf', minimalPdf('Hello PDF'))
    const result = await extractPdfText(file)
    assert.equal(result.ok, true, result.ok ? '' : result.reason)
    assert.equal(result.kind, 'pdf')
    assert.match(result.text, /Hello PDF/)
  },
)
