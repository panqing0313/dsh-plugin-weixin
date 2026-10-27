import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_CODE_FILE_CHARS,
  extensionFor,
  planRichContent,
  renderTables,
  splitFences,
  tableToText,
  writeSnippets,
} from '../src/message/rich-content.js'

const FENCE = '```'

test('a fenced block is found, and prose around it is kept in order', () => {
  const markdown = `先看这个：\n${FENCE}js\nconst a = 1\n${FENCE}\n就这样。`
  const { blocks, parts } = splitFences(markdown)
  assert.deepEqual(blocks, [{ lang: 'js', body: 'const a = 1' }])
  assert.deepEqual(parts.map((part) => part.kind), ['text', 'code', 'text'])
  assert.equal(parts[2].text, '就这样。')
})

test('an unterminated fence stays prose, so a half-streamed reply loses nothing', () => {
  const markdown = `看这里：\n${FENCE}js\nconst a = 1`
  const { blocks, parts } = splitFences(markdown)
  assert.deepEqual(blocks, [])
  assert.equal(parts.length, 1)
  assert.match(parts[0].text, /const a = 1/)
})

test('fence language maps to an extension, unknown languages fall back to txt', () => {
  assert.equal(extensionFor('python'), 'py')
  assert.equal(extensionFor('TypeScript'), 'ts')
  assert.equal(extensionFor('bash'), 'sh')
  assert.equal(extensionFor(''), 'txt')
  assert.equal(extensionFor('brainfuck'), 'txt')
})

test('a long block becomes a file with a note in its place, a short one stays inline', () => {
  const long = 'x'.repeat(DEFAULT_CODE_FILE_CHARS)
  const markdown = `前言\n${FENCE}py\n${long}\n${FENCE}\n后记`
  const plan = planRichContent(markdown)
  assert.equal(plan.files.length, 1)
  assert.equal(plan.files[0].name, 'snippet-1.py')
  assert.ok(plan.files[0].body.includes(long))
  assert.match(plan.text, /已作为文件 snippet-1\.py 发出/)
  assert.match(plan.text, /^前言/)
  assert.match(plan.text, /后记$/)
  assert.ok(!plan.text.includes(FENCE), 'the fences are dropped from the bubble text')

  const short = planRichContent(`一段\n${FENCE}js\nconst a = 1\n${FENCE}\n完`)
  assert.deepEqual(short.files, [])
  assert.match(short.text, /const a = 1/)
})

test('rich content switched off leaves the text exactly as written', () => {
  const markdown = `| a | b |\n| --- | --- |\n| 1 | 2 |`
  const plan = planRichContent(markdown, { enabled: false })
  assert.equal(plan.text, markdown)
  assert.deepEqual(plan.files, [])
})

test('a markdown table becomes aligned text, CJK counted as two cells', () => {
  const table = ['| 名字 | 价格 |', '| --- | ---: |', '| 苹果 | 3 |', '| apple | 40 |']
  const rendered = tableToText(table)
  assert.deepEqual(rendered.split('\n').length, 3, 'the separator row is dropped')
  assert.match(rendered, /^名字\s+价格$/m)
  const lines = rendered.split('\n')
  assert.equal(lines[0].indexOf('价格'), lines[1].indexOf('3'), 'columns line up across CJK and ASCII cells')
})

test('table rendering only fires on runs that actually have a rule row', () => {
  assert.equal(renderTables('a | b\nc | d'), 'a | b\nc | d')
  const converted = renderTables('看表：\n| a | b |\n| --- | --- |\n| 1 | 22 |\n完')
  assert.match(converted, /a\s+b/)
  assert.ok(!converted.includes('| --- |'))
})

test('snippets are written under unique names, and a missing directory is created', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-'))
  const dir = path.join(root, 'nested', 'snippets')
  const { written, failed } = writeSnippets([{ name: 'snippet-1.py', body: 'print(1)' }], dir, { now: Date.UTC(2026, 9, 27, 12, 0, 0) })
  assert.equal(failed, 0)
  assert.equal(written.length, 1)
  assert.match(path.basename(written[0].path), /^20261027120000-snippet-1\.py$/)
  assert.equal(fs.readFileSync(written[0].path, 'utf8'), 'print(1)\n')
  fs.rmSync(root, { recursive: true, force: true })
})
