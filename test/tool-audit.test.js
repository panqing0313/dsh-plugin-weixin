/**
 * Behavioural guards for the tool audit log.
 *
 * The gap this closes: nothing on disk recorded which tool the agent ran, with
 * what arguments, or on whose behalf. `ctx.logger` is an operational stream that
 * rotates away, and the message journal only knows text in and text out — so
 * "who told it to delete that directory yesterday at 15:20" was unanswerable.
 *
 * Three properties matter and each has a test:
 *
 *  1. The file is append-only JSONL, one line per tool call and one per result,
 *     joined by `callId` — so a reader can reconstruct a turn without the
 *     writer ever rewriting history.
 *  2. The audit carries attribution (account, conversation, sender), because a
 *     tool name alone does not answer "who".
 *  3. Auditing is observation: a torn line, an unserialisable argument, or an
 *     unwritable directory degrades to a warning and never fails a turn.
 *
 * @module dsh-weixin/test/tool-audit
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// The vendored logger resolves its directory when it is first imported, so it
// must be redirected before src/agent-bridge.js loads.
const LOG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-audit-logs-'))
const previousLogDir = process.env.DSH_WEIXIN_LOG_DIR
process.env.DSH_WEIXIN_LOG_DIR = LOG_ROOT

test.after?.(() => {
  if (previousLogDir === undefined) delete process.env.DSH_WEIXIN_LOG_DIR
  else process.env.DSH_WEIXIN_LOG_DIR = previousLogDir
  fs.rmSync(LOG_ROOT, { recursive: true, force: true })
})

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-audit-'))
}

function readLines(stateRoot) {
  const dir = path.join(stateRoot, 'audit')
  const files = fs.readdirSync(dir).filter((name) => name.startsWith('audit-') && name.endsWith('.jsonl'))
  assert.equal(files.length, 1, `expected exactly one audit file, got ${files.join(', ')}`)
  return fs
    .readFileSync(path.join(dir, files[0]), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

test('a tool call lands on disk as one parseable line, newest first when read back', async () => {
  const { appendToolAudit, readToolAudit } = await import('../src/message/audit.js')
  const stateRoot = tempRoot()
  try {
    appendToolAudit(stateRoot, {
      at: Date.UTC(2026, 9, 23, 10, 0, 0),
      kind: 'tool/call',
      accountId: 'acc',
      conversationId: 'wxid_a',
      sessionId: 'weixin-wxid_a',
      senderId: 'wxid_a',
      tool: 'bash',
      callId: 'c1',
      args: { command: 'rm -rf build' },
    })
    appendToolAudit(stateRoot, {
      at: Date.UTC(2026, 9, 23, 10, 0, 2),
      kind: 'tool/result',
      accountId: 'acc',
      conversationId: 'wxid_a',
      sessionId: 'weixin-wxid_a',
      tool: 'bash',
      callId: 'c1',
      ok: true,
      durationMs: 2000,
    })

    const lines = readLines(stateRoot)
    assert.equal(lines.length, 2)
    assert.equal(lines[0].kind, 'tool/call')
    assert.equal(lines[0].tool, 'bash')
    assert.equal(lines[0].callId, 'c1')
    assert.equal(lines[0].senderId, 'wxid_a', 'the audit must say who caused the call')
    assert.deepEqual(JSON.parse(lines[0].args), { command: 'rm -rf build' })
    assert.equal(lines[0].ok, undefined, 'a call line carries no verdict')
    assert.equal(lines[1].kind, 'tool/result')
    assert.equal(lines[1].ok, true)
    assert.equal(lines[1].durationMs, 2000)

    const newestFirst = readToolAudit(stateRoot)
    assert.deepEqual(newestFirst.map((e) => e.kind), ['tool/result', 'tool/call'])
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('long arguments are truncated and unstringifiable ones still produce a line', async () => {
  const { appendToolAudit, MAX_AUDIT_ARGS_CHARS } = await import('../src/message/audit.js')
  const stateRoot = tempRoot()
  try {
    appendToolAudit(stateRoot, { kind: 'tool/call', tool: 'write', callId: 'c1', args: { body: 'x'.repeat(2000) } })
    const cyclic = { name: 'loop' }
    cyclic.self = cyclic
    appendToolAudit(stateRoot, { kind: 'tool/call', tool: 'edit', callId: 'c2', args: cyclic })

    const lines = readLines(stateRoot)
    assert.ok(lines[0].args.length <= MAX_AUDIT_ARGS_CHARS + 1, `args were not truncated: ${lines[0].args.length} chars`)
    assert.ok(lines[0].args.endsWith('…'), 'a truncated rendering is marked')
    assert.equal(lines[1].tool, 'edit')
    assert.ok(lines[1].args.length > 0, 'a cyclic argument must still be rendered, not dropped')
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('a torn tail line and a filter both behave, and an unwritable root only warns', async () => {
  const { appendToolAudit, readToolAudit } = await import('../src/message/audit.js')
  const stateRoot = tempRoot()
  try {
    appendToolAudit(stateRoot, { kind: 'tool/call', accountId: 'acc-a', conversationId: 'room-a', tool: 'read', callId: 'c1' })
    appendToolAudit(stateRoot, { kind: 'tool/call', accountId: 'acc-b', conversationId: 'room-b', tool: 'bash', callId: 'c2' })

    // Simulate a process killed mid-append: the last line has no newline and is
    // half a JSON object. The reader must skip it, not throw.
    const dir = path.join(stateRoot, 'audit')
    const file = path.join(dir, fs.readdirSync(dir)[0])
    fs.appendFileSync(file, '{"at":1,"kind":"tool/ca')

    const all = readToolAudit(stateRoot)
    assert.equal(all.length, 2, 'the torn line is skipped')
    assert.deepEqual(readToolAudit(stateRoot, { accountId: 'acc-b' }).map((e) => e.tool), ['bash'])
    assert.deepEqual(readToolAudit(stateRoot, { conversationId: 'room-a' }).map((e) => e.tool), ['read'])
    assert.equal(readToolAudit(stateRoot, { limit: 1 }).length, 1)

    // A state root that cannot hold a directory: the append must warn, not throw.
    const warnings = []
    const blocked = path.join(stateRoot, 'blocked')
    fs.writeFileSync(blocked, 'not a directory')
    appendToolAudit(blocked, { kind: 'tool/call', tool: 'bash' }, { warn: (line) => warnings.push(line) })
    assert.equal(warnings.length, 1, 'a failed append is reported once')
    assert.match(warnings[0], /tool audit append failed/)
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

/**
 * A fake agent that runs one tool then answers, the way a real turn does:
 * `tool/call` → `tool/result` → `assistant/message`.
 */
function toolAgent({ tool = 'bash', args = { command: 'echo hi' }, error, callId = 'call-1', delayMs = 60 } = {}) {
  let seq = 0
  const events = []
  const ev = (type, data) => events.push({ type, seq: seq++, time: Date.now(), data })
  return {
    events,
    agent: {
      inbox: { clear() {} },
      session: { id: 'weixin-room-audit', snapshotEvents: () => events },
      followup() {
        setTimeout(() => {
          ev('tool/call', { callId, name: tool, arguments: args })
          setTimeout(() => {
            ev('tool/result', { message: { source: { callId, ...(error === undefined ? {} : { error }) } } })
            ev('assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } })
          }, 20)
        }, 10)
      },
    },
  }
}

async function bridgeWith(fake, overrides = {}) {
  const { AgentBridge } = await import('../src/agent-bridge.js')
  const agents = {
    get: () => undefined,
    async create() {
      return { agent: fake.agent, dispose: async () => {} }
    },
  }
  const ctx = { get: (n) => (n === 'agents' ? agents : undefined) }
  const { SessionLines } = await import('../src/sessions.js')
  return new AgentBridge({
    ctx,
    cwd: '/tmp/audit-test',
    pollMs: 20,
    maxWaitMs: 3000,
    lines: new SessionLines({ warn: () => {} }),
    ...overrides,
  })
}

test('a turn reports its tool call and result once, with who caused it', async () => {
  const entries = []
  const fake = toolAgent()
  const bridge = await bridgeWith(fake, { onToolAudit: (entry) => entries.push(entry) })

  const result = await bridge.deliver({
    conversationId: 'room-audit',
    accountId: 'acc',
    text: 'list the directory',
    senderId: 'wxid_sender',
  })
  assert.equal(result.text, 'done')

  const calls = entries.filter((e) => e.kind === 'tool/call')
  const results = entries.filter((e) => e.kind === 'tool/result')
  assert.equal(calls.length, 1, 'one tool call is audited exactly once, however many polls saw it')
  assert.equal(results.length, 1)
  assert.equal(calls[0].tool, 'bash')
  assert.equal(calls[0].callId, 'call-1')
  assert.deepEqual(calls[0].args, { command: 'echo hi' })
  assert.equal(calls[0].senderId, 'wxid_sender', 'attribution survives the turn')
  assert.equal(calls[0].accountId, 'acc')
  assert.equal(calls[0].conversationId, 'room-audit')
  assert.equal(calls[0].sessionId, 'weixin-room-audit')
  assert.equal(results[0].ok, true)
  assert.equal(results[0].tool, 'bash', 'the result is paired back to the call')
  assert.equal(typeof results[0].durationMs, 'number')
})

test('a result carrying an error is audited as not ok', async () => {
  const entries = []
  const fake = toolAgent({ error: { message: 'permission denied' } })
  const bridge = await bridgeWith(fake, { onToolAudit: (entry) => entries.push(entry) })

  await bridge.deliver({ conversationId: 'room-audit', accountId: 'acc', text: 'write the file', senderId: 'wxid_sender' })

  const result = entries.find((e) => e.kind === 'tool/result')
  assert.ok(result, 'a failed result must still be audited')
  assert.equal(result.ok, false)
})

test('with no sink the bridge runs the turn and writes nothing', async () => {
  const fake = toolAgent()
  const bridge = await bridgeWith(fake)

  const result = await bridge.deliver({ conversationId: 'room-audit', accountId: 'acc', text: 'go' })
  assert.equal(result.text, 'done', 'auditing is optional, the turn is not')
})

test('the tool audit is on by default and an operator can turn it off', async () => {
  const plugin = await import('../src/index.js')
  assert.equal(plugin.Config({}).toolAudit, true, 'the audit is on unless an operator turns it off')
  assert.equal(plugin.Config({ toolAudit: false }).toolAudit, false)
})
