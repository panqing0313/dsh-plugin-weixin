import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CHUNK_CHARS,
  chunkKnowledgeText,
  describeKnowledgeHits,
  describeKnowledgeState,
  knowledgeDir,
  listKnowledgeSources,
  readKnowledgeSource,
  searchKnowledge,
  shouldSearchKnowledge,
  buildKnowledgeIndex,
} from '../src/message/knowledge.js'

function tmpStateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-knowledge-'))
}

function writeSource(stateRoot, accountId, name, body) {
  const dir = knowledgeDir(stateRoot, accountId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), body)
}

test('the directory lists only readable extensions, one level deep', () => {
  const stateRoot = tmpStateRoot()
  try {
    const dir = knowledgeDir(stateRoot, 'bot1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.md'), '# 标题\n正文')
    fs.writeFileSync(path.join(dir, 'b.txt'), '纯文本')
    fs.writeFileSync(path.join(dir, 'c.json'), '{}')
    fs.mkdirSync(path.join(dir, 'nested'))
    fs.writeFileSync(path.join(dir, 'nested', 'd.md'), '不该被看到')

    const names = listKnowledgeSources(dir).map((file) => path.basename(file))
    assert.deepEqual(names, ['a.md', 'b.txt'], 'json and the subdirectory are excluded')
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('a missing directory is an empty knowledge base, not an error', () => {
  const stateRoot = tmpStateRoot()
  try {
    assert.deepEqual(listKnowledgeSources(knowledgeDir(stateRoot, 'nobody')), [])
    assert.match(describeKnowledgeState(stateRoot, 'nobody'), /还是空的/)
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('chunks carry the heading they fall under, so an answer can say where it came from', () => {
  const text = [
    '# 退货政策',
    '',
    '七天无理由退货。',
    '',
    '# 发票',
    '',
    '发票在收货后三十天内可以索取。',
  ].join('\n')
  const chunks = chunkKnowledgeText(text)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].section, '退货政策')
  assert.match(chunks[0].text, /七天无理由/)
  assert.equal(chunks[1].section, '发票')
  assert.match(chunks[1].text, /三十天/)
})

test('a long paragraph is split near the chunk size, with overlap so a cut sentence still matches', () => {
  const sentence = '这是一句话。'
  const long = sentence.repeat(Math.ceil((CHUNK_CHARS * 2.5) / sentence.length))
  const chunks = chunkKnowledgeText(long, { chunkChars: 120, overlap: 30 })
  assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`)
  for (const chunk of chunks) assert.ok(chunk.text.length <= 200, 'no chunk runs away')
  // The tail of one chunk should reappear at the head of the next.
  const firstTail = chunks[0].text.slice(-10)
  assert.ok(chunks[1].text.startsWith(firstTail) || chunks[1].text.includes(firstTail.slice(0, 4)))
})

test('an empty or whitespace-only file yields no chunks', () => {
  assert.deepEqual(chunkKnowledgeText('   \n\n  '), [])
  assert.deepEqual(chunkKnowledgeText(''), [])
})

test('html is reduced to text, unsupported extensions are refused with a reason', async () => {
  const stateRoot = tmpStateRoot()
  try {
    const dir = knowledgeDir(stateRoot, 'bot1')
    fs.mkdirSync(dir, { recursive: true })
    const htmlFile = path.join(dir, 'page.html')
    fs.writeFileSync(htmlFile, '<html><body><h1>说明</h1><p>这一段是正文。</p><script>alert(1)</script></body></html>')
    const html = await readKnowledgeSource(htmlFile)
    assert.equal(html.ok, true)
    assert.match(html.text, /这一段是正文/)
    assert.equal(html.text.includes('alert'), false, 'script bodies are stripped')

    const binFile = path.join(dir, 'blob.json')
    fs.writeFileSync(binFile, '{}')
    const refused = await readKnowledgeSource(binFile)
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /unsupported extension/)
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('building the index counts files and chunks, and skips what it cannot read', async () => {
  const stateRoot = tmpStateRoot()
  try {
    writeSource(stateRoot, 'bot1', 'policy.md', '# 退货\n\n七天无理由。')
    writeSource(stateRoot, 'bot1', 'notes.txt', '记一件小事。')
    writeSource(stateRoot, 'bot1', 'broken.json', '{}')

    const result = await buildKnowledgeIndex(stateRoot, 'bot1')
    assert.equal(result.files, 2, 'broken.json is not a source at all')
    assert.ok(result.chunks >= 2)
    assert.deepEqual(result.skipped, [])
    assert.match(describeKnowledgeState(stateRoot, 'bot1'), /2 份文件/)
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('search finds the right file and reports which one it was', async () => {
  const stateRoot = tmpStateRoot()
  try {
    writeSource(stateRoot, 'bot1', 'after-sale.md', '# 退货政策\n\n七天无理由退货，退货运费由卖家承担。')
    writeSource(stateRoot, 'bot1', 'invoice.md', '# 发票\n\n发票在收货后三十天内可以索取。')
    await buildKnowledgeIndex(stateRoot, 'bot1')

    const hits = searchKnowledge(stateRoot, 'bot1', '退货要谁出运费')
    assert.ok(hits.length >= 1)
    assert.equal(hits[0].file, 'after-sale.md')
    assert.equal(hits[0].section, '退货政策')
    assert.match(hits[0].text, /运费/)

    const invoice = searchKnowledge(stateRoot, 'bot1', '发票什么时候能开')
    assert.equal(invoice[0].file, 'invoice.md')
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('an unrelated question does not pretend to find anything', async () => {
  const stateRoot = tmpStateRoot()
  try {
    writeSource(stateRoot, 'bot1', 'invoice.md', '# 发票\n\n发票在收货后三十天内可以索取。')
    await buildKnowledgeIndex(stateRoot, 'bot1')
    const hits = searchKnowledge(stateRoot, 'bot1', '今天天气怎么样')
    assert.ok(hits.length === 0 || shouldSearchKnowledge(hits) === false)
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('a file changed on disk is re-indexed on the next build; an untouched one is reused', async () => {
  const stateRoot = tmpStateRoot()
  try {
    writeSource(stateRoot, 'bot1', 'a.md', '# 甲\n\n苹果香蕉橘子。')
    writeSource(stateRoot, 'bot1', 'b.md', '# 乙\n\n另一份。')
    await buildKnowledgeIndex(stateRoot, 'bot1')
    assert.equal(searchKnowledge(stateRoot, 'bot1', '苹果香蕉橘子')[0]?.file, 'a.md')

    // Rewrite a.md with new text whose mtime is guaranteed to move. The two
    // versions share no bigram, so a stale chunk cannot be matched by accident
    // (bigram tokenisation means 「第一版内容」 still hits 「第二版内容」 via 版内/内容).
    const fileA = path.join(knowledgeDir(stateRoot, 'bot1'), 'a.md')
    fs.writeFileSync(fileA, '# 甲\n\n轮船飞机火车。')
    const later = new Date(Date.now() + 5_000)
    fs.utimesSync(fileA, later, later)

    const second = await buildKnowledgeIndex(stateRoot, 'bot1')
    assert.equal(second.files, 2)
    assert.equal(searchKnowledge(stateRoot, 'bot1', '轮船飞机火车')[0]?.file, 'a.md')
    assert.equal(searchKnowledge(stateRoot, 'bot1', '苹果香蕉橘子').length, 0, 'the stale chunk is gone')
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('a corrupt index file is treated as empty rather than throwing', async () => {
  const stateRoot = tmpStateRoot()
  try {
    writeSource(stateRoot, 'bot1', 'a.md', '# 甲\n\n内容。')
    await buildKnowledgeIndex(stateRoot, 'bot1')
    const indexPath = path.join(knowledgeDir(stateRoot, 'bot1'), 'index.json')
    fs.writeFileSync(indexPath, '{ this is not json')

    const warnings = []
    assert.deepEqual(searchKnowledge(stateRoot, 'bot1', '内容', { warn: (line) => warnings.push(line) }), [])
    assert.ok(warnings.some((line) => /unreadable/.test(line)))

    // And a rebuild recovers.
    await buildKnowledgeIndex(stateRoot, 'bot1')
    assert.ok(searchKnowledge(stateRoot, 'bot1', '内容').length >= 1)
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('the injected block names the file and tells the model not to invent', async () => {
  const stateRoot = tmpStateRoot()
  try {
    writeSource(stateRoot, 'bot1', 'policy.md', '# 退货政策\n\n七天无理由退货。')
    await buildKnowledgeIndex(stateRoot, 'bot1')
    const hits = searchKnowledge(stateRoot, 'bot1', '退货政策')
    const block = describeKnowledgeHits(hits)
    assert.match(block, /<weixin_knowledge>/)
    assert.match(block, /《policy\.md》· 退货政策/)
    assert.match(block, /不要编/)
    assert.equal(describeKnowledgeHits([]), '')
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('the gating rule requires more than a single stray word', () => {
  assert.equal(shouldSearchKnowledge([]), false)
  assert.equal(shouldSearchKnowledge([{ matched: 1, score: 2 }]), false)
  assert.equal(shouldSearchKnowledge([{ matched: 2, score: 1.5 }]), true)
  assert.equal(shouldSearchKnowledge([{ matched: 1, score: 5 }]), true)
})

test('searching an empty knowledge base is silent', () => {
  const stateRoot = tmpStateRoot()
  try {
    assert.deepEqual(searchKnowledge(stateRoot, 'bot1', '任何问题'), [])
    assert.equal(describeKnowledgeState(stateRoot, 'bot1').includes('还是空的'), true)
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})
