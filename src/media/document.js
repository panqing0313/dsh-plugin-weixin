/**
 * 入站文档的正文抽取。
 *
 * 用户把一份文档发进来，模型只拿到一个文件路径 —— 没有文件系统工具的回合
 * 就只能回「我收到了一个文件」。这里在入站时把**纯文本**抽出来拼进提示：
 * 聊天里问「这份合同第三条写了什么」，模型看到的是正文，不是路径。
 *
 * 零依赖是默认路径（插件只带 schemastery 与 qrcode-terminal）：`.docx` 本质
 * 是一个 zip，`word/document.xml` 里是要的文字，用 node:zlib 解开即可。
 * `.pdf` 的字体子集、对象流与 ToUnicode 映射没有库解不干净 —— 所以 PDF 走
 * **可选依赖** `pdfjs-dist`：装了就把正文抽出来，没装就维持「只给路径」，
 * 不假装支持、也不把几十 MB 的解析器塞进默认安装。
 *
 * 抽出的文本和用户消息一样不可信：调用点负责转义标签、按字符数截断。
 *
 * @module dsh-weixin/media/document
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** 默认最多取这么多字符；超出部分丢弃并注明，避免一份 200 页文档吃掉上下文。 */
export const DEFAULT_DOCUMENT_CHARS = 4000

/** 没装 pdfjs-dist 时给用户看的说明（调用点把它当 reason 记日志）。 */
export const PDF_LOAD_HINT = 'pdf support needs the optional pdfjs-dist package (npm i pdfjs-dist)'

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.xml', '.yaml', '.yml'])
const DOCX_EXTENSIONS = new Set(['.docx'])
const PDF_EXTENSIONS = new Set(['.pdf'])

/** Read one entry out of a zip's central directory. Returns undefined when absent. */
function readZipEntry(buffer, wantedName) {
  // End of Central Directory: scan the last 64 KiB for its signature.
  const minEocd = 22
  const start = Math.max(0, buffer.length - 65_536 - minEocd)
  let eocd = -1
  for (let i = buffer.length - minEocd; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('not a zip archive (no central directory)')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (name === wantedName) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('broken local header')
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      const data = buffer.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return data
      if (method === 8) return zlib.inflateRawSync(data)
      throw new Error(`unsupported zip compression method ${method}`)
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  return undefined
}

/**
 * `word/document.xml` → 纯文本。
 *
 * 只做三件事：段落/换行标签变换行、制表符变 `\t`、去掉其余标签并解码
 * 五个 XML 实体。样式、批注、脚注一律不取 —— 它们是另一套结构，抓进来
 * 只会让模型把批注当正文。
 */
export function docxXmlToText(xml) {
  return xml
    .replace(/<w:tab\b[^>]*\/>/gi, '\t')
    .replace(/<\/w:p>/gi, '\n')
    .replace(/<w:br\b[^>]*\/>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 统一截断：正文太长时保留前 maxChars 字，并在结尾注明，免得模型以为文档就
 * 这么短。
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean }}
 */
function truncate(text, maxChars) {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false }
  return { text: `${trimmed.slice(0, maxChars)}\n\n（文档较长，只取了前 ${maxChars} 字）`, truncated: true }
}

/**
 * @param {string} filePath
 * @param {{ maxChars?: number }} [options]
 * @returns {{ ok: true, text: string, kind: 'docx' | 'text', truncated: boolean } | { ok: false, reason: string }}
 */
export function extractDocumentText(filePath, { maxChars = DEFAULT_DOCUMENT_CHARS } = {}) {
  const ext = path.extname(filePath).toLowerCase()
  try {
    let text
    let kind
    if (DOCX_EXTENSIONS.has(ext)) {
      const entry = readZipEntry(fs.readFileSync(filePath), 'word/document.xml')
      if (entry === undefined) return { ok: false, reason: 'not a Word document (no word/document.xml)' }
      text = docxXmlToText(entry.toString('utf8'))
      kind = 'docx'
    } else if (TEXT_EXTENSIONS.has(ext)) {
      text = fs.readFileSync(filePath, 'utf8')
      kind = 'text'
    } else {
      return { ok: false, reason: 'unsupported' }
    }
    if (text.trim() === '') return { ok: false, reason: 'empty' }
    const { text: clipped, truncated } = truncate(text, maxChars)
    return { ok: true, text: clipped, kind, truncated }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * 默认加载器：只 import，不在这里装包。`pdfjs-dist` 是可选的 peer，缺了就是
 * 一句可读的 reason，而不是把整个入站回合弄挂。
 */
export async function loadPdfjs() {
  return import('pdfjs-dist/legacy/build/pdf.mjs')
}

/**
 * 用 pdfjs-dist 抽 PDF 正文。`loadPdf` 是给测试用的接缝：不装库也能验证
 * 文本拼装、截断与错误映射。
 *
 * @param {string} filePath
 * @param {{ maxChars?: number, loadPdf?: () => Promise<unknown> }} [options]
 * @returns {Promise<{ ok: true, text: string, kind: 'pdf', truncated: boolean } | { ok: false, reason: string }>}
 */
export async function extractPdfText(filePath, { maxChars = DEFAULT_DOCUMENT_CHARS, loadPdf = loadPdfjs } = {}) {
  let pdfjs
  try {
    pdfjs = await loadPdf()
  } catch {
    return { ok: false, reason: PDF_LOAD_HINT }
  }
  let doc
  try {
    const data = new Uint8Array(fs.readFileSync(filePath))
    // 只取文字：不执行脚本、不加载系统字体，也不需要 canvas。
    doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise
    const pages = []
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number)
      const content = await page.getTextContent()
      const pieces = []
      for (const item of content.items ?? []) {
        if (typeof item.str !== 'string') continue
        pieces.push(item.str)
        if (item.hasEOL) pieces.push('\n')
      }
      pages.push(pieces.join(' ').replace(/[ \t]+\n/g, '\n'))
    }
    const text = pages.join('\n\n').replace(/[ \t]{2,}/g, ' ').trim()
    if (text === '') return { ok: false, reason: 'empty' }
    const { text: clipped, truncated } = truncate(text, maxChars)
    return { ok: true, text: clipped, kind: 'pdf', truncated }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  } finally {
    // destroy 是异步的；失败不影响已经抽到的文字。
    try {
      await doc?.destroy?.()
    } catch {
      // 解析器自己的清理失败，不改变结果。
    }
  }
}

/**
 * 入站文档的统一入口：docx/txt 同步抽，PDF 异步抽（可选依赖）。
 *
 * @param {string} filePath
 * @param {{ maxChars?: number, loadPdf?: () => Promise<unknown> }} [options]
 * @returns {Promise<{ ok: true, text: string, kind: 'docx' | 'text' | 'pdf', truncated: boolean } | { ok: false, reason: string }>}
 */
export async function extractDocumentTextAsync(filePath, options = {}) {
  if (PDF_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return extractPdfText(filePath, options)
  }
  return extractDocumentText(filePath, options)
}
