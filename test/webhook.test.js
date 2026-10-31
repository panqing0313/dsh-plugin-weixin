import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { createWebhookSender } from '../src/webhook.js'

function recorder(response = { ok: true, status: 200 }) {
  const calls = []
  const fetchImpl = (url, options) => {
    calls.push({ url, options })
    return Promise.resolve(response)
  }
  return { calls, fetchImpl }
}

test('a blank or non-http URL means no sender', () => {
  assert.equal(createWebhookSender({ url: '' }), undefined)
  assert.equal(createWebhookSender({ url: '   ' }), undefined)
  assert.equal(createWebhookSender({ url: 'ftp://example.com/hook' }), undefined)
  assert.equal(createWebhookSender({ url: 'not a url' }), undefined)
})

test('the event is a JSON POST with an ISO timestamp and the payload', async () => {
  const { calls, fetchImpl } = recorder()
  const sender = createWebhookSender({ url: 'https://example.com/hook', fetchImpl })
  assert.equal(await sender.send('message.received', { conversationId: 'c1', text: 'hi' }), true)
  assert.equal(calls.length, 1)
  const body = JSON.parse(calls[0].options.body)
  assert.equal(body.event, 'message.received')
  assert.equal(body.conversationId, 'c1')
  assert.equal(body.text, 'hi')
  assert.match(body.at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers['content-type'], 'application/json')
  assert.equal('x-weixin-signature' in calls[0].options.headers, false)
  assert.ok(calls[0].options.signal !== undefined)
})

test('a secret signs the exact body with HMAC-SHA256', async () => {
  const { calls, fetchImpl } = recorder()
  const sender = createWebhookSender({ url: 'http://127.0.0.1:9000/hook', secret: 'top', fetchImpl })
  await sender.send('reply.settled', { sent: true })
  const expected = `sha256=${crypto.createHmac('sha256', 'top').update(calls[0].options.body).digest('hex')}`
  assert.equal(calls[0].options.headers['x-weixin-signature'], expected)
})

test('a non-2xx answer warns and reports failure, without throwing', async () => {
  const lines = []
  const { fetchImpl } = recorder({ ok: false, status: 500 })
  const sender = createWebhookSender({ url: 'https://example.com/hook', fetchImpl, warn: (line) => lines.push(line) })
  assert.equal(await sender.send('message.received'), false)
  assert.match(lines[0], /answered 500/)
})

test('a network error warns and reports failure, without throwing', async () => {
  const lines = []
  const sender = createWebhookSender({
    url: 'https://example.com/hook',
    warn: (line) => lines.push(line),
    fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
  })
  assert.equal(await sender.send('message.received'), false)
  assert.match(lines[0], /failed: ECONNREFUSED/)
})
