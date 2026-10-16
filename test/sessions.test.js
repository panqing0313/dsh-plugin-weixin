/**
 * Unit tests for session lines: several agent sessions under one Weixin
 * conversation, `/new`-`/list`-`/use` routing, and the invariant that the FIRST
 * line of a conversation keeps its historical deterministic id.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// The state root is read by src/state.js at call time, so pointing it at a
// private directory before importing keeps these tests off the operator's real
// ~/.dsh/weixin/sessions.json.
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-lines-'))
process.env.DSH_WEIXIN_STATE_DIR = stateRoot

const {
  SessionLines,
  baseSessionIdFor,
  newSessionIdFor,
  parseSessionCommand,
  runSessionCommand,
  titleFrom,
  readLines,
  writeLines,
  linesFile,
  LIST_LIMIT,
} = await import('../src/sessions.js')
const { sessionIdFor } = await import('../src/agent-bridge.js')

test.after(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

/** A fresh store, with the state root emptied so tests never share lines. */
function freshLines() {
  fs.rmSync(linesFile(), { force: true })
  return new SessionLines()
}

test('the first line of a conversation keeps the historical deterministic id', () => {
  // This is the load-bearing compatibility guarantee: every session created
  // before session lines existed is named weixin-<slug>, so if this id ever
  // changes, an existing conversation silently starts from an empty context.
  const conversationId = 'o9cq804qN9Kjha_YsRWQwG8hWo3I@im.wechat'
  const lines = freshLines()
  assert.equal(lines.active(conversationId), 'weixin-o9cq804qN9Kjha-YsRWQwG8hWo3I-im-wechat')
  assert.equal(baseSessionIdFor(conversationId), sessionIdFor(conversationId))
})

test('a conversation with no recorded lines has exactly one, and reading it writes nothing', () => {
  const lines = freshLines()
  assert.equal(lines.list('room-1').length, 1)
  // Receiving a message must not create state: an allowlist gate may still
  // refuse it, and a conversation that was only ever refused should leave no
  // trace on disk.
  assert.equal(fs.existsSync(linesFile()), false, 'listing must not persist anything')
})

test('/new adds a line, makes it active, and leaves the previous one intact', () => {
  const lines = freshLines()
  const conversationId = 'room-2'
  const first = lines.active(conversationId)

  const reply = runSessionCommand(lines, conversationId, '/new')
  const second = lines.active(conversationId)

  assert.match(reply, /第 2 条会话/)
  assert.notEqual(second, first, 'a new line must not reuse the first line id')
  // Parallel retention: the earlier line is still listed, so switching back
  // returns to its existing context instead of a new session.
  assert.deepEqual(
    lines.list(conversationId).map((line) => line.sessionId),
    [first, second],
  )
})

test('a new line is not pre-titled, so its first real message can name it', () => {
  const lines = freshLines()
  const conversationId = 'room-3'
  runSessionCommand(lines, conversationId, '/new')
  const newLine = lines.active(conversationId)

  // A placeholder title here would count as "already titled" and the user
  // would stare at "(无标题)" forever.
  assert.equal(lines.list(conversationId).find((line) => line.sessionId === newLine)?.title, undefined)
  lines.title(conversationId, newLine, '把这段翻译成英文')
  assert.equal(lines.list(conversationId).find((line) => line.sessionId === newLine)?.title, '把这段翻译成英文')
})

test('the first message titles a line, and later messages never rename it', () => {
  const lines = freshLines()
  const conversationId = 'room-4'
  const first = lines.active(conversationId)
  lines.title(conversationId, first, '帮我看看构建报错')
  lines.title(conversationId, first, '另一件完全不同的事')

  const rendered = runSessionCommand(lines, conversationId, '/list')
  assert.match(rendered, /帮我看看构建报错/)
  assert.doesNotMatch(rendered, /另一件完全不同的事/, 'a title must not change under the user')
})

test('titleFrom collapses whitespace, truncates, and never splits an emoji', () => {
  assert.equal(titleFrom('  hello \n  world  '), 'hello world')
  assert.equal(titleFrom(''), '(无标题)')
  assert.equal(titleFrom('   '), '(无标题)')
  assert.equal(titleFrom('abcd', 3), 'abc…')
  // Counted by code point: cutting a surrogate pair would render a replacement
  // character in the WeChat message.
  assert.equal(titleFrom('😀😀😀😀', 3), '😀😀😀…')
  assert.equal(titleFrom('😀😀', 3), '😀😀')
})

test('/use switches back to an earlier line by its 1-based list position', () => {
  const lines = freshLines()
  const conversationId = 'room-5'
  const first = lines.active(conversationId)
  runSessionCommand(lines, conversationId, '/new')

  const reply = runSessionCommand(lines, conversationId, '/use 1')
  assert.match(reply, /第 1 条会话/)
  assert.equal(lines.active(conversationId), first)
})

test('/use reports an out-of-range index instead of clamping to a real line', () => {
  const lines = freshLines()
  const conversationId = 'room-6'
  const first = lines.active(conversationId)

  const reply = runSessionCommand(lines, conversationId, '/use 9')
  assert.match(reply, /没有第 9 条会话/)
  // Silently switching to some other line would move the user's context
  // without them asking, which is worse than an error message.
  assert.equal(lines.active(conversationId), first)
})

test('a bare /use answers with usage plus the list', () => {
  const lines = freshLines()
  const reply = runSessionCommand(lines, 'room-7', '/use')
  assert.match(reply, /用法：\/use <序号>/)
  assert.match(reply, /共 1 条会话/)
})

test('/list marks the active line and never hides any line from the reply header', () => {
  const lines = freshLines()
  const conversationId = 'room-8'
  lines.active(conversationId)
  runSessionCommand(lines, conversationId, '/new')
  runSessionCommand(lines, conversationId, '/new')

  const rendered = runSessionCommand(lines, conversationId, '/list')
  assert.match(rendered, /共 3 条会话，当前使用第 3 条/)
  assert.match(rendered, /▶ 3\./)
})

test('/list caps the rendered rows but says how many are hidden', () => {
  const lines = freshLines()
  const conversationId = 'room-9'
  lines.active(conversationId)
  for (let index = 0; index < LIST_LIMIT + 4; index += 1) {
    runSessionCommand(lines, conversationId, '/new')
  }

  // 1 existing line + LIST_LIMIT + 4 created ones, of which LIST_LIMIT render.
  const total = LIST_LIMIT + 5
  const hidden = total - LIST_LIMIT
  const rendered = runSessionCommand(lines, conversationId, '/list')
  assert.match(rendered, new RegExp(`共 ${total} 条会话`))
  // The cap must not renumber: /use takes the position in the FULL list.
  assert.match(rendered, new RegExp(`▶ ${total}\\.`))
  assert.match(rendered, new RegExp(`更早的 ${hidden} 条仍在`))
  // The hidden head must not be rendered as if it were the tail.
  assert.doesNotMatch(rendered, /^ {2}1\. /m)
  assert.match(rendered, new RegExp(`^ {2}${hidden + 1}\\. `, 'm'))
})

test('an out-of-range /use after the cap still addresses the full list', () => {
  const lines = freshLines()
  const conversationId = 'room-10'
  const first = lines.active(conversationId)
  for (let index = 0; index < LIST_LIMIT + 2; index += 1) {
    runSessionCommand(lines, conversationId, '/new')
  }
  // Line 1 is beyond the rendered window but still switchable by number.
  const reply = runSessionCommand(lines, conversationId, '/use 1')
  assert.match(reply, /已切换到第 1 条会话/)
  assert.equal(lines.active(conversationId), first)
})

test('commands are recognized only as the whole message', () => {
  assert.deepEqual(parseSessionCommand('/new'), { command: 'new' })
  assert.deepEqual(parseSessionCommand('  /NEW  '), { command: 'new' })
  assert.deepEqual(parseSessionCommand('/list'), { command: 'list' })
  assert.deepEqual(parseSessionCommand('/sessions'), { command: 'list' })
  assert.deepEqual(parseSessionCommand('/use 3'), { command: 'use', index: 3 })
  assert.deepEqual(parseSessionCommand('/use'), { command: 'use', index: undefined })

  // The user is talking to an agent about their code, so a sentence that
  // merely mentions a command is a message, not a command. `/steer` must keep
  // flowing to the agent, and a malformed /use must not be treated as one.
  for (const text of ['', '你好', '看看 /new 这个命令', '/newx', '/use abc', '/steer 用中文回答', '帮我 /list 一下谢谢', '/useful']) {
    assert.equal(parseSessionCommand(text), undefined, `${JSON.stringify(text)} must not parse as a command`)
  }
})

test('a non-command message returns undefined so the agent path continues', () => {
  const lines = freshLines()
  for (const text of ['你好', '/steer 用中文回答', '看看 /new 这个命令']) {
    assert.equal(runSessionCommand(lines, 'room-11', text), undefined)
  }
  // Nothing was created by those messages.
  assert.equal(lines.list('room-11').length, 1)
})

test('lines survive a restart, including which line is active', () => {
  const conversationId = 'room-12'
  const lines = freshLines()
  const first = lines.active(conversationId)
  lines.title(conversationId, first, '第一个话题')
  runSessionCommand(lines, conversationId, '/new')
  const second = lines.active(conversationId)
  lines.title(conversationId, second, '第二个话题')
  runSessionCommand(lines, conversationId, '/use 1')

  const reloaded = new SessionLines()
  assert.equal(reloaded.active(conversationId), first)
  assert.deepEqual(
    reloaded.list(conversationId).map((line) => line.title),
    ['第一个话题', '第二个话题'],
  )
})

test('the persisted file keeps the historical id byte-identical', () => {
  const conversationId = 'o9cq804qN9Kjha_YsRWQwG8hWo3I@im.wechat'
  const lines = freshLines()
  lines.active(conversationId)
  lines.title(conversationId, baseSessionIdFor(conversationId), 'hello')

  const onDisk = JSON.parse(fs.readFileSync(linesFile(), 'utf8'))
  assert.equal(onDisk[conversationId].lines[0].sessionId, 'weixin-o9cq804qN9Kjha-YsRWQwG8hWo3I-im-wechat')
  assert.equal(onDisk[conversationId].active, baseSessionIdFor(conversationId))
})

test('two lines created in the same millisecond still get distinct ids', () => {
  const conversationId = 'room-13'
  const ids = new Set()
  for (let index = 0; index < 200; index += 1) {
    ids.add(newSessionIdFor(conversationId, 1_700_000_000_000))
  }
  assert.equal(ids.size, 200, 'collisions would make two topics share one session')
  for (const id of ids) {
    assert.notEqual(id, baseSessionIdFor(conversationId))
    assert.match(id, /^weixin-room-13--/)
  }
})

test('a conversation id with no alphanumerics still yields a usable session id', () => {
  assert.equal(baseSessionIdFor('@#$%'), 'weixin-default')
  assert.equal(baseSessionIdFor(''), 'weixin-default')
  assert.equal(baseSessionIdFor(undefined), 'weixin-default')
})

test('a malformed or unreadable store degrades to one line instead of failing', () => {
  freshLines()
  fs.mkdirSync(path.dirname(linesFile()), { recursive: true })
  fs.writeFileSync(linesFile(), '{ this is not json')
  const broken = new SessionLines()
  assert.equal(broken.active('room-14'), 'weixin-room-14')

  fs.writeFileSync(linesFile(), '[]')
  const wrongShape = new SessionLines()
  assert.equal(wrongShape.active('room-15'), 'weixin-room-15')

  fs.rmSync(linesFile(), { force: true })
  const missing = new SessionLines()
  assert.equal(missing.active('room-16'), 'weixin-room-16')
})

test('an active id that is not in the list falls back to the first line', () => {
  // Hand-edited or partially written state must not make attach() create a
  // brand-new empty session under a stale name.
  freshLines()
  const conversationId = 'room-17'
  writeLines({
    [conversationId]: {
      lines: [{ sessionId: baseSessionIdFor(conversationId), title: 'only' }],
      active: 'weixin-room-17--does-not-exist',
    },
  })
  const lines = new SessionLines()
  assert.equal(lines.active(conversationId), baseSessionIdFor(conversationId))
  assert.equal(readLines()[conversationId].active, 'weixin-room-17--does-not-exist', 'reading must not repair silently')
})

test('an empty line list falls back to the historical id', () => {
  freshLines()
  writeLines({ 'room-18': { lines: [], active: 'weixin-room-18' } })
  const lines = new SessionLines()
  assert.equal(lines.active('room-18'), 'weixin-room-18')
})

test('writeLines reports failure instead of throwing when the state root is unwritable', () => {
  freshLines()
  const blocker = path.join(stateRoot, 'blocked')
  fs.writeFileSync(blocker, 'not a directory')
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = path.join(blocker, 'nested')
  try {
    assert.equal(writeLines({ a: { lines: [], active: 'x' } }), false)
    // The in-memory index must still work for this process even though it could
    // not be persisted: refusing to reply would be a far worse trade.
    const lines = new SessionLines()
    assert.equal(lines.create('room-19').startsWith('weixin-room-19--'), true)
  } finally {
    process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(blocker, { force: true })
  }
})

test('a failed persist is reported through the injected warning sink', () => {
  const warnings = []
  const blocker = path.join(stateRoot, 'blocked-2')
  fs.writeFileSync(blocker, 'not a directory')
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = path.join(blocker, 'nested')
  try {
    const lines = new SessionLines({ warn: (message) => warnings.push(message) })
    const created = lines.create('room-20')
    assert.equal(warnings.length, 1, 'the owner must learn its index is not durable')
    assert.match(warnings[0], /could not persist/)
    // The line is still usable for this process.
    assert.equal(lines.active('room-20'), created)
  } finally {
    process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(blocker, { force: true })
  }
})

test('malformed on-disk state warns rather than crashing the plugin load', async () => {
  freshLines()
  fs.mkdirSync(path.dirname(linesFile()), { recursive: true })
  fs.writeFileSync(linesFile(), '{ nope')
  // process.emitWarning delivers on a later tick, so the listener has to
  // outlive the synchronous call that raises it.
  const warned = new Promise((resolve) => {
    process.once('warning', (warning) => resolve(String(warning?.message ?? warning)))
  })
  const lines = new SessionLines()
  assert.equal(lines.active('room-21'), 'weixin-room-21', 'a broken index must not break the plugin')
  assert.match(await warned, /ignoring malformed/)
})
