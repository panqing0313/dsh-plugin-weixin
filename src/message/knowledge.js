/**
 * 知识库：把一堆文件变成能被检索的事实，回答时说出它出自哪一份。
 *
 * 为什么和 recall（消息流水检索）分开：
 * - 流水是「我们说过什么」，按天分片、按需增量索引，答不出来是常态；
 * - 知识库是「我明确交给它的资料」（合同、手册、家里的事项、公司制度），
 *   一次建索引、改动才重建，回答里必须能指回文件名 —— 用户拿它当凭据用。
 *
 * 实现上刻意复用已有的三块，不引新依赖：
 * - 正文抽取：`src/media/document.js` 的 `extractDocumentTextAsync`（pdf/docx/txt）
 *   与 `src/message/links.js` 的 `htmlToText`（.html/.htm）；
 * - 分词：`src/message/recall.js` 的 `tokenize`（中文 bigram、英文整词）；
 * - 打分：同一套 BM25 参数（K1=1.2, B=0.75），只是语料换成一堆段落块。
 *
 * 索引落在 `<stateRoot>/knowledge/<账号>/index.json`，每块记 `file`、`section`
 * （最近的 # 标题）、`text`、`terms` 与 `len`。索引是纯派生数据：坏了就重建，
 * 绝不向调用方抛错。
 *
 * @module dsh-weixin/message/knowledge
 */

import fs from 'node:fs'
import path from 'node:path'
import { extractDocumentTextAsync } from '../media/document.js'
import { htmlToText } from './links.js'
import { tokenize } from './recall.js'

export const KNOWLEDGE_INDEX_VERSION = 1
/** 一段大约多少字：太小检索碎、太大一注就吃掉半个上下文。 */
export const CHUNK_CHARS = 400
/** 相邻块的文字重叠，避免一句话正好被切断。 */
export const CHUNK_OVERLAP = 60
/** 一次最多注入几块。 */
export const DEFAULT_KNOWLEDGE_HITS = 3
/** 单份文件最多读多少字，防止一份巨长的东西把索引撑爆。 */
export const MAX_SOURCE_CHARS = 200_000
/** 支持导入的扩展名。 */
export const KNOWLEDGE_EXTENSIONS = Object.freeze(['.md', '.markdown', '.txt', '.text', '.html', '.htm', '.pdf', '.docx'])

const K1 = 1.2
const B = 0.75

function safeName(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9@._-]/g, '_').slice(0, 120) || '_'
}

/** 某个账号的知识库目录。 */
export function knowledgeDir(stateRoot, accountId) {
  return path.join(stateRoot, 'knowledge', safeName(accountId))
}

/** 索引文件路径（放在知识库目录内，跟资料放在一起，备份时一起走）。 */
export function knowledgeIndexPath(stateRoot, accountId) {
  return path.join(knowledgeDir(stateRoot, accountId), 'index.json')
}

/**
 * 把一个文件的内容抽成纯文本。抽不出来（扫描件 PDF、不认识的格式）时返回
 * `{ ok: false, reason }`，由调用方跳过并 warn，不让一个坏文件阻塞整个知识库。
 *
 * @param {string} filePath
 * @param {{ maxChars?: number }} [options]
 * @returns {Promise<{ ok: true, text: string, truncated: boolean } | { ok: false, reason: string }>}
 */
export async function readKnowledgeSource(filePath, { maxChars = MAX_SOURCE_CHARS } = {}) {
  const ext = path.extname(filePath).toLowerCase()
  if (!KNOWLEDGE_EXTENSIONS.includes(ext)) return { ok: false, reason: `unsupported extension ${ext || '(none)'}` }
  try {
    if (ext === '.html' || ext === '.htm') {
      const html = fs.readFileSync(filePath, 'utf8')
      const text = htmlToText(html)
      const truncated = text.length > maxChars
      return { ok: true, text: truncated ? text.slice(0, maxChars) : text, truncated }
    }
    const extracted = await extractDocumentTextAsync(filePath, { maxChars })
    if (extracted?.ok !== true) return { ok: false, reason: extracted?.reason ?? 'could not extract text' }
    return { ok: true, text: extracted.text, truncated: extracted.truncated === true }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

function splitLongBlock(block, chunkChars, overlap) {
  /** @type {string[]} */
  const pieces = []
  let start = 0
  while (start < block.length) {
    const end = Math.min(block.length, start + chunkChars)
    pieces.push(block.slice(start, end))
    if (end >= block.length) break
    // 重叠：下一块从上一块的末尾再走一点，句子被切断时检索仍能命中。
    start = Math.max(start + 1, end - overlap)
  }
  return pieces
}

/**
 * 把一份长文本切成带标题上下文的块。
 *
 * 标题的跟踪是这里的重点：`# 退货政策` 下面的第 3 段，注入时应该能说
 * 「来自《售后手册》· 退货政策」，而不是只说「来自《售后手册》」。
 *
 * @param {string} text
 * @param {{ chunkChars?: number, overlap?: number }} [options]
 * @returns {Array<{ section: string, text: string }>}
 */
export function chunkKnowledgeText(text, { chunkChars = CHUNK_CHARS, overlap = CHUNK_OVERLAP } = {}) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  if (source === '') return []
  const paragraphs = source.split(/\n{2,}/)
  /** @type {Array<{ section: string, text: string }>} */
  const chunks = []
  let section = ''
  let buffer = ''

  const flush = () => {
    const body = buffer.trim()
    if (body !== '') {
      // 单个段落本身就可能超过一块（邮件正文、一整段条文），必须先按长度
      // 拆开；否则「切块」对这类文件等于没切，一次注入吃掉整个上下文。
      if (body.length > chunkChars) {
        for (const piece of splitLongBlock(body, chunkChars, overlap)) {
          chunks.push({ section, text: piece.trim() })
        }
      } else {
        chunks.push({ section, text: body })
      }
    }
    buffer = ''
  }

  for (const raw of paragraphs) {
    const para = raw.trim()
    if (para === '') continue
    const heading = /^#{1,6}\s+(.+)$/.exec(para)
    if (heading !== null) {
      // 标题自己单独成段：先结束上一块，再更新当前小节名。
      flush()
      section = heading[1].trim()
      continue
    }
    if (buffer !== '' && buffer.length + para.length + 1 > chunkChars) {
      flush()
      // 重叠：把上一块的末尾带进下一块，句子被切断时检索仍能命中。
      if (overlap > 0 && chunks.length > 0) {
        const prev = chunks[chunks.length - 1].text
        buffer = prev.slice(Math.max(0, prev.length - overlap))
      }
    }
    buffer = buffer === '' ? para : `${buffer}\n${para}`
  }
  flush()
  return chunks
}

function emptyIndex() {
  return { version: KNOWLEDGE_INDEX_VERSION, files: {}, chunks: [] }
}

/**
 * 读索引。损坏、版本不符、文件不存在 —— 一律当作空索引，由 `buildKnowledgeIndex`
 * 重建。
 *
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ warn?: (line: string) => void }} [options]
 */
export function readKnowledgeIndex(stateRoot, accountId, { warn } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(knowledgeIndexPath(stateRoot, accountId), 'utf8'))
    if (parsed?.version !== KNOWLEDGE_INDEX_VERSION || !Array.isArray(parsed?.chunks) || typeof parsed.files !== 'object') {
      return emptyIndex()
    }
    return parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try { warn?.(`knowledge index unreadable, rebuilding: ${String(error?.message ?? error)}`) } catch { /* never throw */ }
    }
    return emptyIndex()
  }
}

/**
 * 目录里所有可导入的文件（不递归子目录 —— 一层目录已经够用，递归会让「我不小心
 * 把整个下载文件夹指过来」变成灾难）。
 *
 * @param {string} dir
 * @returns {string[]} 绝对路径，按文件名排序
 */
export function listKnowledgeSources(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => KNOWLEDGE_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    .filter((name) => {
      try {
        return fs.statSync(path.join(dir, name)).isFile()
      } catch {
        return false
      }
    })
    .sort()
    .map((name) => path.join(dir, name))
}

/**
 * 建（或重建）某个账号的知识库索引。
 *
 * 增量策略故意保守：只有「文件集合变了」或「某文件 mtime/size 变了」才重建那一份，
 * 其余文件原样保留。知识库一般只有几十份文件，重建一次的代价可以忽略，而做更细的
 * 增量（按块）只会让「改了文件但索引没跟上」的 bug 更难查。
 *
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ warn?: (line: string) => void, chunkChars?: number, overlap?: number, maxChars?: number }} [options]
 * @returns {Promise<{ files: number, chunks: number, skipped: Array<{ file: string, reason: string }> }>}
 */
export async function buildKnowledgeIndex(stateRoot, accountId, {
  warn, chunkChars = CHUNK_CHARS, overlap = CHUNK_OVERLAP, maxChars = MAX_SOURCE_CHARS,
} = {}) {
  const dir = knowledgeDir(stateRoot, accountId)
  const previous = readKnowledgeIndex(stateRoot, accountId, { warn })
  const sources = listKnowledgeSources(dir)
  const next = emptyIndex()
  const skipped = []

  for (const filePath of sources) {
    const file = path.basename(filePath)
    let stat
    try {
      stat = fs.statSync(filePath)
    } catch (error) {
      skipped.push({ file, reason: String(error?.message ?? error) })
      continue
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`
    const cached = previous.files?.[file]
    if (cached !== undefined && cached.stamp === stamp && Array.isArray(cached.chunks)) {
      // 没改过：把这批块原样搬过来，省掉一次正文抽取（PDF 抽取最贵）。
      next.files[file] = cached
      for (const chunk of cached.chunks) next.chunks.push(chunk)
      continue
    }
    const source = await readKnowledgeSource(filePath, { maxChars })
    if (source.ok !== true) {
      skipped.push({ file, reason: source.reason })
      try { warn?.(`knowledge file skipped: ${file} (${source.reason})`) } catch { /* never throw */ }
      continue
    }
    const pieces = chunkKnowledgeText(source.text, { chunkChars, overlap })
    if (pieces.length === 0) {
      skipped.push({ file, reason: 'no readable text' })
      continue
    }
    const chunks = pieces.map((piece, index) => {
      const terms = tokenize(piece.text)
      // 词表存进索引而不是每次检索重算：知识库可能上千块，重算 tokenize 是
      // 一次检索里最贵的一步，存下来让它变成「读文件」而不是「再切一遍」。
      return { file, section: piece.section, index, text: piece.text, terms, len: terms.length }
    })
    next.files[file] = { stamp, chunks }
    for (const chunk of chunks) next.chunks.push(chunk)
  }

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(knowledgeIndexPath(stateRoot, accountId), JSON.stringify(next))
  } catch (error) {
    try { warn?.(`knowledge index write failed: ${String(error?.message ?? error)}`) } catch { /* never throw */ }
  }
  return { files: sources.length, chunks: next.chunks.length, skipped }
}

/**
 * 检索知识库。返回按 BM25 分数降序的前 `limit` 块：
 * `{ file, section, index, text, score }`。
 *
 * `minScore` 的默认值有意不设（0），门槛交给调用方按 `matched` 判断 —— 知识库
 * 只有几份文件时，"命中一个词"往往就够了，但在大知识库里明显不够，这个判断应该
 * 在接线处做。
 *
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {string} query
 * @param {{ limit?: number, minScore?: number, warn?: (line: string) => void }} [options]
 * @returns {Array<{ file: string, section: string, index: number, text: string, score: number, matched: number }>}
 */
export function searchKnowledge(stateRoot, accountId, query, { limit = DEFAULT_KNOWLEDGE_HITS, minScore = 0, warn } = {}) {
  const index = readKnowledgeIndex(stateRoot, accountId, { warn })
  const chunks = Array.isArray(index.chunks) ? index.chunks : []
  if (chunks.length === 0) return []
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0) return []

  const total = chunks.length
  const avgLen = chunks.reduce((sum, chunk) => sum + (chunk.len || tokenize(chunk.text).length || 1), 0) / total
  /** @type {Map<number, { chunk: any, score: number, matched: number }>} */
  const scored = new Map()

  // 倒排：term → 命中块编号列表。块数量小，逐块 tokenize 也就几毫秒，
  // 但一旦知识库有几百块，倒排能把「一次检索」从线性变成按词查找。
  const postings = new Map()
  chunks.forEach((chunk, position) => {
    const chunkTerms = Array.isArray(chunk.terms) ? chunk.terms : tokenize(chunk.text)
    for (const term of new Set(chunkTerms)) {
      if (!postings.has(term)) postings.set(term, [])
      postings.get(term).push(position)
    }
  })

  for (const term of terms) {
    const hitPositions = postings.get(term)
    if (hitPositions === undefined) continue
    const df = hitPositions.length
    const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
    for (const position of hitPositions) {
      const chunk = chunks[position]
      const chunkTerms = Array.isArray(chunk.terms) ? chunk.terms : tokenize(chunk.text)
      const freq = chunkTerms.filter((value) => value === term).length
      const norm = 1 - B + B * ((chunk.len || chunkTerms.length || 1) / avgLen)
      const prev = scored.get(position) ?? { chunk, score: 0, matched: 0 }
      prev.score += idf * ((freq * (K1 + 1)) / (freq + K1 * norm))
      prev.matched += 1
      scored.set(position, prev)
    }
  }

  return [...scored.values()]
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score || a.chunk.file.localeCompare(b.chunk.file))
    .slice(0, limit)
    .map((entry) => ({
      file: entry.chunk.file,
      section: entry.chunk.section ?? '',
      index: entry.chunk.index ?? 0,
      text: entry.chunk.text,
      score: entry.score,
      matched: entry.matched,
    }))
}

/**
 * 该不该为这条消息检索知识库。比 `shouldRecall` 更容易触发：
 * 知识库是用户主动交过来的资料，问到时不给反而是失职；但仍然要求
 * 至少两个词面命中，避免每个「嗯」「好的」都去查一遍。
 *
 * @param {Array<{ matched?: number, score?: number }>} hits
 */
export function shouldSearchKnowledge(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return false
  const best = hits[0]
  return (best.matched ?? 0) >= 2 || (best.score ?? 0) >= 4
}

/**
 * 拼注入用的块。每条都带「来自《文件》· 小节」，并明确要求回答时说清出处 ——
 * 这是知识库和「模型瞎编」之间唯一的区别。
 *
 * @param {Array<{ file: string, section?: string, text: string }>} hits
 */
export function describeKnowledgeHits(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return ''
  const lines = hits.map((hit) => {
    const where = hit.section ? `《${hit.file}》· ${hit.section}` : `《${hit.file}》`
    return `【${where}】\n${hit.text}`
  })
  return [
    '<weixin_knowledge>',
    '以下是从用户交给你的资料里检索到的原文，和当前问题相关。回答时优先依据这里的内容，并说清来自哪份文件；如果资料里没有答案，就直接说资料里没写，不要编。',
    ...lines,
    '</weixin_knowledge>',
  ].join('\n\n')
}

/**
 * 知识库目录里有什么、索引是新的还是旧的 —— 设置卡与 `/diag` 用这一句。
 *
 * @param {string} stateRoot
 * @param {string} accountId
 */
export function describeKnowledgeState(stateRoot, accountId) {
  const dir = knowledgeDir(stateRoot, accountId)
  const sources = listKnowledgeSources(dir)
  if (sources.length === 0) {
    return `知识库还是空的（把文件放进 ${dir} 就会自动收进来）。`
  }
  const index = readKnowledgeIndex(stateRoot, accountId)
  const chunks = Array.isArray(index.chunks) ? index.chunks.length : 0
  return `知识库有 ${sources.length} 份文件，切成 ${chunks} 段可供检索（目录：${dir}）。`
}
