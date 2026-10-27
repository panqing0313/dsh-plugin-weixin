import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ROUTE_PURPOSES, describeRoute, routeFor, sideRouteFor } from '../src/model-route.js'

test('nothing configured means the host default, not an empty model', () => {
  for (const purpose of ROUTE_PURPOSES) {
    assert.equal(routeFor(purpose, {}), undefined)
    assert.equal(routeFor(purpose, { chatProvider: '', chatModel: '' }), undefined)
  }
  assert.equal(routeFor('chat', undefined), undefined)
})

test('half a pair is not a route', () => {
  assert.equal(routeFor('chat', { chatProvider: 'zai' }), undefined)
  assert.equal(routeFor('chat', { chatModel: 'glm-5.3-flash' }), undefined)
  assert.deepEqual(routeFor('chat', { chatProvider: 'zai', chatModel: 'glm-5.3-flash' }), {
    provider: 'zai',
    model: 'glm-5.3-flash',
  })
  // Whitespace-only halves are the same as empty ones.
  assert.equal(routeFor('chat', { chatProvider: '   ', chatModel: 'glm' }), undefined)
})

test('each purpose reads its own keys, and an unknown purpose reads none', () => {
  const config = {
    chatProvider: 'a', chatModel: 'a-1',
    sideProvider: 'b', sideModel: 'b-1',
    memoryProvider: 'c', memoryModel: 'c-1',
  }
  assert.deepEqual(routeFor('chat', config), { provider: 'a', model: 'a-1' })
  assert.deepEqual(routeFor('side', config), { provider: 'b', model: 'b-1' })
  assert.deepEqual(routeFor('memory', config), { provider: 'c', model: 'c-1' })
  assert.equal(routeFor('summary', config), undefined)
})

test('the side route falls back to the memory route, so one cheap model covers the background', () => {
  assert.equal(sideRouteFor({}), undefined)
  assert.deepEqual(sideRouteFor({ memoryProvider: 'c', memoryModel: 'c-1' }), { provider: 'c', model: 'c-1' })
  // An explicit side route wins over the memory one.
  assert.deepEqual(
    sideRouteFor({ sideProvider: 'b', sideModel: 'b-1', memoryProvider: 'c', memoryModel: 'c-1' }),
    { provider: 'b', model: 'b-1' },
  )
  // Half a side pair does not shadow a complete memory pair.
  assert.deepEqual(
    sideRouteFor({ sideProvider: 'b', memoryProvider: 'c', memoryModel: 'c-1' }),
    { provider: 'c', model: 'c-1' },
  )
})

test('a route reads well in a log line', () => {
  assert.equal(describeRoute(undefined), '会话默认')
  assert.equal(describeRoute({ provider: 'zai', model: 'glm' }), 'zai/glm')
  assert.equal(describeRoute(undefined, '托管默认'), '托管默认')
})
