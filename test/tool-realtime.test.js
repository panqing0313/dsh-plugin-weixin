/**
 * The model-facing `weixin_say` tool (issue #10). These tests drive `execute`
 * directly through a fake `defineTool`, so they do not need the host's tools
 * service — only the mapping from a model argument to the caller's `say` and
 * the shape of the verdict handed back.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  WEIXIN_SAY_TOOL_NAME,
  weixinSayDescription,
  buildWeixinSayTool,
  installWeixinSayTool,
} from '../src/tool-realtime.js'

/** The host's defineTool is an identity passthrough for these tests. */
const identityDefineTool = (options) => options

test('the tool has one required text parameter and a boolean verdict', () => {
  const tool = buildWeixinSayTool({ say: async () => ({ ok: true, text: 'x' }), defineTool: identityDefineTool })
  assert.equal(tool.name, WEIXIN_SAY_TOOL_NAME)
  assert.equal(tool.name, 'weixin_say')
  assert.equal(tool.parameters.text.required, true)
  assert.equal(tool.parameters.text.type, 'string')
  // The output schema always carries `sent`, so the model can tell whether the
  // user saw the line without guessing.
  assert.deepEqual(tool.output.schema.required, ['sent'])
  assert.equal(tool.isConcurrencySafe(), false)
})

test('the description states behaviour, not implementation', () => {
  const text = weixinSayDescription({ maxChars: 80 })
  assert.match(text, /one short sentence/)
  assert.match(text, /80/)
  assert.match(text, /rate limited/i)
  assert.ok(!text.includes('sendChunked'))
})

test('a sent line comes back with sent:true and the text as sent', async () => {
  const calls = []
  const tool = buildWeixinSayTool({
    say: async (input) => {
      calls.push(input)
      return { ok: true, text: '还在跑测试' }
    },
    defineTool: identityDefineTool,
  })
  const agent = { session: { id: 'weixin-room-x' } }
  const value = await tool.execute({ text: '还在跑测试' }, { agent })
  assert.deepEqual(value, { sent: true, text: '还在跑测试' })
  // The conversation is never taken from the model: the agent object is what
  // `say` receives, and it is the only thing that can name the conversation.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent, agent)
  assert.equal(calls[0].text, '还在跑测试')
})

test('a refused line comes back with sent:false and a reason the model can act on', async () => {
  const tool = buildWeixinSayTool({
    say: async () => ({ ok: false, reason: 'limit', message: '这个回合已经说过 3 句了' }),
    defineTool: identityDefineTool,
  })
  const value = await tool.execute({ text: '再说一句' }, { agent: {} })
  assert.equal(value.sent, false)
  assert.equal(value.reason, 'limit')
  assert.match(value.message, /3 句/)
})

test('a refusal without a message falls back to the shared refusal sentence', async () => {
  const tool = buildWeixinSayTool({ say: async () => ({ ok: false, reason: 'interval' }), defineTool: identityDefineTool })
  const value = await tool.execute({ text: 'hi' }, { agent: {} })
  assert.equal(value.sent, false)
  assert.equal(value.reason, 'interval')
  assert.match(value.message, /wait a moment/i)
})

test('the render shows what was sent, or why it was not', () => {
  const tool = buildWeixinSayTool({ say: async () => ({ ok: true }), defineTool: identityDefineTool })
  const sent = tool.output.render({}, { sent: true, text: '在查了' })
  assert.match(sent[0].text, /已发送：「在查了」/)
  const refused = tool.output.render({}, { sent: false, reason: 'quiet', message: '现在是免打扰时段' })
  assert.match(refused[0].text, /没发送：现在是免打扰时段/)
})

test('install is silent when the host tools package cannot be resolved in this repo', async () => {
  // @deepseek-ai/dsh-tools is held by the host, not this repo, so the dynamic
  // import fails here: install must warn and return undefined rather than throw.
  const warnings = []
  const agentCtx = { tools: { register: () => () => {} } }
  const dispose = await installWeixinSayTool({ agentCtx, say: async () => ({ ok: true }), warn: (line) => warnings.push(line) })
  assert.equal(dispose, undefined)
  assert.ok(warnings.some((line) => /weixin_say unavailable/.test(line)))
})

test('install is silent when the host has no tools service', async () => {
  const dispose = await installWeixinSayTool({ agentCtx: {}, say: async () => ({ ok: true }) })
  assert.equal(dispose, undefined)
})
