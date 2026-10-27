// Rich replies on a channel that has no rich text.
//
// Weixin renders exactly one kind of body: plain text (plus image/file/video
// attachments). Everything an agent writes in Markdown therefore arrives as
// flattened prose - a 40-line code block becomes 40 lines of unindented text
// that is also split across bubbles by the chunker, and a table arrives as
// rows of `|`-separated cells.
//
// This module decides what to do about that, per segment:
//   - a long fenced code block is written to a file and sent as an attachment,
//     with a one-line note left where it was (the file keeps the indentation,
//     the language and the line count the text version loses);
//   - a short fenced block stays inline, because a two-line snippet reads
//     better in the bubble than as a file;
//   - a Markdown table is rendered as column-aligned text, which is the closest
//     thing to a table a fixed-width-ish chat bubble has.
//
// Descriptions and decisions stay in this file; the send path only calls
// {@link planRichContent}. Nothing here is aware of Weixin.
import fs from 'node:fs'
import path from 'node:path'

/** Files shorter than this stay in the bubble; longer ones ship as a file. */
export const DEFAULT_CODE_FILE_CHARS = 1200

/** Extensions we can name, so the reader's editor opens the snippet properly. */
const EXTENSIONS = {
  javascript: 'js', js: 'js', mjs: 'mjs', cjs: 'cjs',
  typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx',
  python: 'py', py: 'py',
  json: 'json', jsonc: 'json', yaml: 'yml', yml: 'yml', toml: 'toml',
  bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  sql: 'sql', css: 'css', scss: 'scss', html: 'html', xml: 'xml',
  go: 'go', rust: 'rs', rs: 'rs', java: 'java', kotlin: 'kt', swift: 'swift',
  ruby: 'rb', rb: 'rb', php: 'php', c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp',
  csharp: 'cs', cs: 'cs', diff: 'diff', patch: 'diff', markdown: 'md', md: 'md',
  text: 'txt', txt: 'txt', plaintext: 'txt', log: 'log', ini: 'ini', csv: 'csv',
}

/** Fence opener at line start: ``` or ~~~ with an optional info string. */
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/

/**
 * Map a fence's info string to a file extension.
 * @param {string} lang
 * @returns {string}
 */
export function extensionFor(lang) {
  const key = String(lang ?? '').trim().toLowerCase()
  return EXTENSIONS[key] ?? 'txt'
}

/**
 * Split a reply into fenced code blocks and the prose between them.
 *
 * Unterminated fences are treated as prose: a streaming reply that has not
 * finished its block must not lose the text it already wrote.
 *
 * @param {string} text
 * @returns {{ blocks: { lang: string, body: string }[], parts: ({ kind: 'text', text: string } | { kind: 'code', lang: string, body: string })[] }}
 */
export function splitFences(text) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  const lines = source.split('\n')
  const parts = []
  const blocks = []
  let prose = []
  const flushProse = () => {
    if (prose.length > 0) {
      parts.push({ kind: 'text', text: prose.join('\n') })
      prose = []
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const open = FENCE_OPEN.exec(lines[index])
    if (open === null) {
      prose.push(lines[index])
      continue
    }
    // Find the closing fence of the same character; anything else is prose.
    let close = -1
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const candidate = FENCE_OPEN.exec(lines[scan])
      if (candidate !== null && candidate[1][0] === open[1][0] && candidate[2] === '') {
        close = scan
        break
      }
    }
    if (close === -1) {
      prose.push(lines[index])
      continue
    }
    flushProse()
    const block = { kind: 'code', lang: open[2], body: lines.slice(index + 1, close).join('\n') }
    parts.push(block)
    blocks.push({ lang: block.lang, body: block.body })
    index = close
  }
  flushProse()
  return { blocks, parts }
}

/**
 * Display width of one character: CJK and full-width forms take two cells.
 * Alignment only needs to be good enough for a chat bubble.
 * @param {string} char
 * @returns {number}
 */
function charWidth(char) {
  const code = char.codePointAt(0) ?? 0
  const wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff)
  return wide ? 2 : 1
}

/**
 * Pad a string with spaces to a display width.
 * @param {string} text
 * @param {number} width
 */
function padTo(text, width) {
  let current = 0
  for (const char of text) current += charWidth(char)
  return text + ' '.repeat(Math.max(0, width - current))
}

/** A Markdown table row: starts and ends with a pipe once trimmed. */
const TABLE_ROW = /^\s*\|(.+)\|\s*$/
/** The `|---|:--:|` separator row. */
const TABLE_RULE = /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/

function cellsOf(line) {
  const match = TABLE_ROW.exec(line)
  const body = match === null ? line.trim() : match[1]
  return body.split('|').map((cell) => cell.trim())
}

/**
 * Render a Markdown table as aligned text.
 *
 * The separator row is dropped and columns are padded to their widest cell, so
 * a table that survived the Markdown filter as `| a | b |` turns into
 * something a reader can actually scan in a chat bubble.
 *
 * @param {string[]} lines  The table's lines, header first.
 * @returns {string}
 */
export function tableToText(lines) {
  const rows = lines.filter((line) => !TABLE_RULE.test(line)).map(cellsOf)
  if (rows.length === 0) return ''
  const columns = Math.max(...rows.map((row) => row.length))
  const widths = new Array(columns).fill(0)
  for (const row of rows) {
    for (let column = 0; column < columns; column += 1) {
      let width = 0
      for (const char of row[column] ?? '') width += charWidth(char)
      widths[column] = Math.max(widths[column], width)
    }
  }
  return rows
    .map((row) => {
      const cells = []
      for (let column = 0; column < columns; column += 1) {
        const cell = row[column] ?? ''
        cells.push(column === columns - 1 ? cell : padTo(cell, widths[column]))
      }
      return cells.join('  ').replace(/\s+$/, '')
    })
    .join('\n')
}

/**
 * Replace every Markdown table in the text with its aligned rendering.
 *
 * A table is a run of lines that all start with `|` and contains at least one
 * rule row - that is what keeps a lone `|` in prose from being reformatted.
 *
 * @param {string} text
 * @returns {string}
 */
export function renderTables(text) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  const lines = source.split('\n')
  const output = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!TABLE_ROW.test(lines[index])) {
      output.push(lines[index])
      continue
    }
    let end = index
    while (end + 1 < lines.length && TABLE_ROW.test(lines[end + 1])) end += 1
    const run = lines.slice(index, end + 1)
    if (!run.some((line) => TABLE_RULE.test(line))) {
      output.push(lines[index])
      continue
    }
    output.push(tableToText(run))
    index = end
  }
  return output.join('\n')
}

/**
 * Decide what to send for a Markdown reply.
 *
 * @param {string} markdown  The reply as the model wrote it.
 * @param {object} [options]
 * @param {number} [options.codeFileChars]  Blocks at least this long become files.
 * @param {boolean} [options.enabled]  false leaves the text untouched.
 * @returns {{ text: string, files: { name: string, body: string }[], notes: string[] }}
 */
export function planRichContent(markdown, options = {}) {
  const source = typeof markdown === 'string' ? markdown : String(markdown ?? '')
  const enabled = options.enabled !== false
  const threshold = Number(options.codeFileChars ?? DEFAULT_CODE_FILE_CHARS)
  const withTables = enabled ? renderTables(source) : source
  if (!enabled) return { text: withTables, files: [], notes: [] }
  const { parts } = splitFences(withTables)
  const files = []
  const notes = []
  const rendered = parts.map((part) => {
    if (part.kind === 'text') return part.text
    if (part.body.length < threshold) {
      // Short snippets read better inline, but the fences themselves are noise
      // once the Markdown filter is off, so they are dropped here.
      return part.body
    }
    const name = `snippet-${files.length + 1}.${extensionFor(part.lang)}`
    files.push({ name, body: part.body })
    const lines = part.body.split('\n').length
    const note = `（代码 ${lines} 行、${part.body.length} 字，已作为文件 ${name} 发出）`
    notes.push(note)
    return note
  })
  const text = rendered.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text, files, notes }
}

/**
 * Write planned snippet files into the state directory and return their paths.
 *
 * Names carry a timestamp so two replies never overwrite each other; a write
 * failure drops that file (the inline note then says "file" for something that
 * is not there, so the caller gets `written` back and can correct the text).
 *
 * @param {{ name: string, body: string }[]} files
 * @param {string} dir  Directory to write into (created if missing).
 * @param {{ now?: number, warn?: (line: string) => void }} [options]
 * @returns {{ written: { name: string, path: string }[], failed: number }}
 */
export function writeSnippets(files, dir, options = {}) {
  const warn = options.warn ?? (() => {})
  const stamp = new Date(Number(options.now ?? Date.now())).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const written = []
  let failed = 0
  if (files.length === 0) return { written, failed }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    warn(`could not create the snippet directory: ${String(error?.message ?? error)}`)
    return { written, failed: files.length }
  }
  for (const file of files) {
    const target = path.join(dir, `${stamp}-${file.name}`)
    try {
      fs.writeFileSync(target, file.body.endsWith('\n') ? file.body : `${file.body}\n`, { mode: 0o600 })
      written.push({ name: file.name, path: target })
    } catch (error) {
      failed += 1
      warn(`could not write snippet ${file.name}: ${String(error?.message ?? error)}`)
    }
  }
  return { written, failed }
}
