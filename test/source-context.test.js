import { strict as assert } from 'node:assert'
import { test } from 'node:test'

process.env.DSH_WEIXIN_STATE_DIR = '/tmp/dsh-weixin-test-state'
process.env.DSH_WEIXIN_LOG_DIR = '/tmp/dsh-weixin-test-logs'
process.env.OPENCLAW_LOG_LEVEL = 'SILENT'

const { weixinSourceBlock } = await import('../src/index.js')

test('the source block is a single self-closing tag with the identity fields', () => {
  const block = weixinSourceBlock({
    senderId: 'o9cq804qN9Kjha_YsRWQwG8hWo3I@im.wechat',
    conversationId: 'o9cq804qN9Kjha_YsRWQwG8hWo3I@im.wechat',
    type: 'text',
    timestamp: 1760000000000,
  })
  assert.match(block, /^<weixin_source /)
  assert.match(block, /\/>$/)
  assert.match(block, /channel="weixin"/)
  assert.match(block, /senderId="o9cq804qN9Kjha_YsRWQwG8hWo3I@im\.wechat"/)
  assert.match(block, /kind="text"/)
  assert.match(block, /timestamp="2025-10-09T08:53:20\.000Z"/)
  // One line: cheap to strip downstream.
  assert.equal(block.split('\n').length, 1)
})

test('missing optional fields do not become the string "undefined"', () => {
  const block = weixinSourceBlock({})
  assert.ok(!block.includes('undefined'), block)
  assert.match(block, /senderId=""/)
})
