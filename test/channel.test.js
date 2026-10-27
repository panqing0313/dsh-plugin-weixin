import test from 'node:test'
import assert from 'node:assert/strict'

import { canSendText, channelFor, createChannel } from '../src/channel.js'

function fakeTransport(overrides = {}) {
  const calls = []
  const transport = {
    accountId: 'bot1',
    cdnBaseUrl: 'https://cdn.example/c2c',
    sent: calls,
    send: async (message) => { calls.push({ kind: 'text', ...message }) },
    sendMedia: async (message) => { calls.push({ kind: 'media', ...message }) },
    setTyping: async (active, conversationId) => { calls.push({ kind: 'typing', active, conversationId }) },
    ...overrides,
  }
  return transport
}

test('a channel sends text, media and typing through the transport it wraps', async () => {
  const transport = fakeTransport()
  const channel = createChannel(transport)
  assert.equal(channel.accountId, 'bot1')
  assert.equal(channel.capabilities.text, true)
  assert.equal(channel.capabilities.media, true)
  assert.equal(channel.capabilities.voice, false, 'the server drops bot voice, so no channel may claim it')
  await channel.sendText({ conversationId: 'room', text: 'hi', contextToken: 't1' })
  await channel.sendMedia({ conversationId: 'room', filePath: '/tmp/a.png', text: '', contextToken: 't1', cdnBaseUrl: transport.cdnBaseUrl })
  await channel.setTyping(true, 'room')
  assert.deepEqual(transport.sent.map((entry) => entry.kind), ['text', 'media', 'typing'])
  assert.equal(transport.sent[0].type, 'text')
  assert.equal(transport.sent[0].text, 'hi')
  assert.equal(transport.sent[1].filePath, '/tmp/a.png')
  assert.equal(transport.sent[2].active, true)
})

test('a transport may declare capabilities that the channel then reports', () => {
  const channel = createChannel(fakeTransport({ capabilities: { voice: true, stickers: true } }))
  assert.equal(channel.capabilities.voice, true)
  assert.equal(channel.capabilities.stickers, true)
  assert.equal(channel.capabilities.text, true, 'undeclared capabilities keep the defaults')
})

test('channelFor reuses one channel per transport, and tolerates a missing transport', () => {
  const transport = fakeTransport()
  assert.equal(channelFor(transport), channelFor(transport))
  assert.notEqual(channelFor(transport), channelFor(fakeTransport()))
  assert.equal(channelFor(undefined), undefined)
  assert.equal(canSendText(undefined), false)
  assert.equal(canSendText(channelFor(transport)), true)
})

test('createChannel refuses to invent a channel without a transport', () => {
  assert.throws(() => createChannel(undefined), /needs a transport/)
  assert.throws(() => createChannel(null), /needs a transport/)
})
