/**
 * 入站文档的正文抽取。
 *
 * 用户把一份文档发进来，模型只拿到一个文件路径 —— 没有文件系统工具的回合
 * 就只能回「我收到了一个文件」。这里在入站时把**纯文本**抽出来拼进提示：
 * 聊天里问「这份合同第三条写了什么」，模型看到的是正文，不是路径。
 *
 * 零依赖是硬约束（插件只带 schemastery 与 qrcode-terminal）：`.docx` 本质
 * 是一个 zip，`word/document.xml` 里是要的文字，用 node:zlib 解开即可；
 * `.pdf` 的字体子集与对象流没有库解不干净，明确不支持而不是假装支持。
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

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.xml', '.yaml', '.yml'])
const DOCX_EXTENSIONS = new Set(['.docx'])

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
    const trimmed = text.trim()
    if (trimmed === '') return { ok: false, reason: 'empty' }
    if (trimmed.length <= maxChars) return { ok: true, text: trimmed, kind, truncated: false }
    return {
      ok: true,
      text: `${trimmed.slice(0, maxChars)}\n\n（文档较长，只取了前 ${maxChars} 字）`,
      kind,
      truncated: true,
    }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}
