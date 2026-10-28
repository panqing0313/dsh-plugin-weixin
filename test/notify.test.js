import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_NOTIFY_PORT,
  MAX_NOTIFY_BODY,
  NOTIFY_TOKEN_FILE,
  ensureNotifyToken,
  readNotifyToken,
  createNotifyServer,
} from '../src/notify.js'

async function startServer(options = {}) {
  const sent = []
  const warnings = []
  const bridge = createNotifyServer({
    token: 'secret-token',
    send: async (text) => {
      sent.push(text)
    },
    warn: (message) => warnings.push(message),
    port: 0,
    ...options,
  })
  const port = await bridge.listen()
  assert.ok(port > 0, 'the bridge must be listening')
  return { bridge, port, sent, warnings }
}

function call(port, { method = 'POST', body = '{"text":"hi"}', token = 'secret-token', pathName = '/notify' } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token !== null) headers['x-notify-token'] = token
  return fetch(`http://127.0.0.1:${port}${pathName}`, { method, headers, body: method === 'POST' ? body : undefined })
}

test('a notification needs the token', async (t) => {
  const { bridge, port, sent } = await startServer()
  t.after(() => bridge.stop())

  const missing = await call(port, { token: null })
  assert.equal(missing.status, 401)
  const wrong = await call(port, { token: 'not-the-token' })
  assert.equal(wrong.status, 401)
  assert.deepEqual(sent, [], 'nothing may be sent without authentication')
})

test('the token can arrive as a bearer header too', async (t) => {
  const { bridge, port, sent } = await startServer()
  t.after(() => bridge.stop())

  const response = await fetch(`http://127.0.0.1:${port}/notify`, {
    method: 'POST',
    headers: { authorization: 'Bearer secret-token' },
    body: 'deploy finished',
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(sent, ['deploy finished'], 'a plain-text body is a notification too')
})

test('JSON carries the text and the response is JSON', async (t) => {
  const { bridge, port, sent } = await startServer()
  t.after(() => bridge.stop())

  const response = await call(port, { body: JSON.stringify({ text: 'backup ok' }) })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(sent, ['backup ok'])
})

test('an empty or non-POST request is refused', async (t) => {
  const { bridge, port, sent } = await startServer()
  t.after(() => bridge.stop())

  assert.equal((await call(port, { body: '   ' })).status, 400)
  assert.equal((await call(port, { method: 'GET' })).status, 404)
  assert.equal((await call(port, { pathName: '/other' })).status, 404)
  assert.deepEqual(sent, [])
})

test('an oversized body is refused before it is buffered whole', async (t) => {
  const { bridge, port, sent } = await startServer()
  t.after(() => bridge.stop())

  const response = await call(port, { body: 'x'.repeat(MAX_NOTIFY_BODY + 100) })
  assert.equal(response.status, 413)
  assert.deepEqual(sent, [])
})

test('a long text is truncated, not refused', async (t) => {
  const { bridge, port, sent } = await startServer()
  t.after(() => bridge.stop())

  const response = await call(port, { body: JSON.stringify({ text: 'a'.repeat(5000) }) })
  assert.equal(response.status, 200)
  assert.equal(sent[0].length, 4001, '4000 characters plus the ellipsis')
})

test('a send failure is reported, not thrown', async (t) => {
  const { bridge, port, warnings } = await startServer({
    send: async () => {
      throw new Error('transport down')
    },
  })
  t.after(() => bridge.stop())

  const response = await call(port)
  assert.equal(response.status, 502)
  assert.match(warnings.join('\n'), /transport down/)
})

test('the per-minute budget holds a runaway loop back', async (t) => {
  const { bridge, port } = await startServer({ ratePerMinute: 2 })
  t.after(() => bridge.stop())

  assert.equal((await call(port)).status, 200)
  assert.equal((await call(port)).status, 200)
  assert.equal((await call(port)).status, 429)
})

test('the token is generated once, persisted 0600, and reused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-token-'))
  try {
    const first = ensureNotifyToken(root)
    assert.match(first, /^[A-Za-z0-9_-]{20,}$/)
    assert.equal(ensureNotifyToken(root), first, 'a second start keeps the same token')
    assert.equal(readNotifyToken(root), first)
    const mode = fs.statSync(path.join(root, NOTIFY_TOKEN_FILE)).mode & 0o777
    assert.equal(mode, 0o600)
    assert.equal(ensureNotifyToken(root, { configured: 'from-config' }), 'from-config', 'an explicit token wins')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a busy port is a warning, not a crash', async () => {
  const first = await startServer({ port: 0 })
  const port = first.port
  const warnings = []
  const second = createNotifyServer({
    token: 'x',
    send: async () => {},
    warn: (message) => warnings.push(message),
    port,
  })
  assert.equal(await second.listen(), undefined)
  assert.match(warnings.join('\n'), /could not listen/)
  await first.bridge.stop()
})

test('stop is idempotent and the default port is documented', async () => {
  const { bridge } = await startServer()
  await bridge.stop()
  await bridge.stop()
  assert.equal(DEFAULT_NOTIFY_PORT, 47832)
})
