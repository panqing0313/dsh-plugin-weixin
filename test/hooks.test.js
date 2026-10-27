import test from 'node:test'
import assert from 'node:assert/strict'

import { HOOK_POINTS, createHooks } from '../src/hooks.js'

test('a hook bus calls listeners in order and can drop one again', () => {
  const seen = []
  const hooks = createHooks()
  const off = hooks.on(HOOK_POINTS.inboundAccepted, (event) => seen.push(`a:${event.text}`))
  hooks.on(HOOK_POINTS.inboundAccepted, (event) => seen.push(`b:${event.text}`))
  hooks.emit(HOOK_POINTS.inboundAccepted, { text: 'hi' })
  off()
  hooks.emit(HOOK_POINTS.inboundAccepted, { text: 'again' })
  assert.deepEqual(seen, ['a:hi', 'b:hi', 'b:again'])
  assert.equal(hooks.listenerCount(HOOK_POINTS.inboundAccepted), 1)
})

test('a throwing listener cannot break the caller and the rest still run', () => {
  const lines = []
  const hooks = createHooks({ warn: (line) => lines.push(line) })
  hooks.on(HOOK_POINTS.outboundReady, () => { throw new Error('boom') })
  hooks.on(HOOK_POINTS.outboundReady, () => lines.push('second ran'))
  assert.doesNotThrow(() => hooks.emit(HOOK_POINTS.outboundReady, { text: 'x' }))
  assert.match(lines[0], /hook outboundReady threw: Error: boom/)
  assert.equal(lines[1], 'second ran')
})

test('an async listener is reported when it rejects, and the emit does not wait', async () => {
  const lines = []
  const hooks = createHooks({ warn: (line) => lines.push(line) })
  hooks.on(HOOK_POINTS.turnSettled, async () => { throw new Error('slow boom') })
  hooks.emit(HOOK_POINTS.turnSettled, {})
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(lines.some((line) => /hook turnSettled rejected/.test(line)))
})

test('unknown hook points and non-functions are refused at registration', () => {
  const hooks = createHooks()
  assert.throws(() => hooks.on('nope', () => {}), /unknown hook point/)
  assert.throws(() => hooks.on(HOOK_POINTS.turnSettled, 'not a function'), /needs a function/)
  assert.deepEqual(Object.keys(HOOK_POINTS).sort(), ['inboundAccepted', 'inboundRefused', 'outboundReady', 'outboundSettled', 'turnSettled'])
  assert.equal(hooks.points().length, 5)
})

test('an emit with no listeners is free', () => {
  const hooks = createHooks()
  assert.doesNotThrow(() => hooks.emit(HOOK_POINTS.inboundRefused, { reason: 'x' }))
})
