import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { appendToolAudit, verifyAuditChain } from '../src/message/audit.js'

function auditFiles(root) {
  const dir = path.join(root, 'audit')
  return fs.readdirSync(dir).sort().map((name) => path.join(dir, name))
}

test('every appended line chains to the one before it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'audit-chain-'))
  try {
    appendToolAudit(root, { at: Date.UTC(2026, 9, 27, 1, 0, 0), kind: 'tool/call', tool: 'bash', args: { cmd: 'ls' }, senderId: 'wxid_a' })
    appendToolAudit(root, { at: Date.UTC(2026, 9, 27, 1, 0, 1), kind: 'tool/result', tool: 'bash', callId: 'c1', ok: true })
    appendToolAudit(root, { at: Date.UTC(2026, 9, 27, 1, 0, 2), kind: 'tool/call', tool: 'read', args: { path: '/etc/hosts' } })
    const result = verifyAuditChain(root)
    assert.equal(result.broken, null)
    assert.equal(result.chained, 3)
    assert.equal(result.unchained, 0)
    assert.equal(result.lines, 3)
    const lines = fs.readFileSync(auditFiles(root)[0], 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines[0].prev, '', 'the first line of a file starts the chain')
    assert.equal(lines[1].prev, lines[0].h)
    assert.match(lines[0].h, /^[0-9a-f]{64}$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('editing a line breaks the chain at that line', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'audit-tamper-'))
  try {
    appendToolAudit(root, { at: Date.UTC(2026, 9, 27, 2, 0, 0), kind: 'tool/call', tool: 'bash', args: { cmd: 'rm -rf /tmp/x' } })
    appendToolAudit(root, { at: Date.UTC(2026, 9, 27, 2, 0, 1), kind: 'tool/result', tool: 'bash', ok: true })
    const file = auditFiles(root)[0]
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    const first = JSON.parse(lines[0])
    first.args = '{"cmd":"echo harmless"}'
    fs.writeFileSync(file, `${JSON.stringify(first)}\n${lines[1]}\n`)
    const result = verifyAuditChain(root)
    assert.notEqual(result.broken, null, 'a rewritten line must not verify')
    assert.equal(result.broken.line, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a chain continues across days, one chain per file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'audit-days-'))
  try {
    // Day files are keyed by LOCAL date. Construct the instants locally
    // (23:00 then 01:00 the next day) so they straddle midnight in every
    // timezone — CI runs in UTC, where 15:00Z and 17:00Z are the same day.
    appendToolAudit(root, { at: new Date(2026, 9, 26, 23, 0, 0).getTime(), kind: 'tool/call', tool: 'bash' })
    appendToolAudit(root, { at: new Date(2026, 9, 27, 1, 0, 0).getTime(), kind: 'tool/call', tool: 'bash' })
    const result = verifyAuditChain(root)
    assert.equal(result.files, 2)
    assert.equal(result.broken, null)
    assert.equal(result.chained, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy lines without a hash are counted, not accused', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'audit-legacy-'))
  try {
    const dir = path.join(root, 'audit')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'audit-2026-10-20.jsonl'), `${JSON.stringify({ at: 1, kind: 'tool/call', tool: 'bash' })}\n`)
    appendToolAudit(root, { at: Date.UTC(2026, 9, 27, 3, 0, 0), kind: 'tool/call', tool: 'bash' })
    const result = verifyAuditChain(root)
    assert.equal(result.unchained, 1)
    assert.equal(result.broken, null)
    assert.equal(result.chained, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
