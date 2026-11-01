import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { EMPTY_POLL_HOLD_MS, startFakeILink } from './fake-ilink.js'

/** 直接打一条 iLink 路由，返回解析后的 JSON 与耗时。 */
async function call(baseUrl, pathname, body) {
  const started = Date.now()
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const json = await res.json()
  return { json, ms: Date.now() - started }
}

test('an empty long poll is held open instead of answered instantly', async () => {
  const fake = await startFakeILink()
  try {
    const { json, ms } = await call(fake.baseUrl, '/ilink/bot/getupdates', {})
    assert.deepEqual(json.msgs, [])
    assert.equal(json.ret, 0)
    // The instant `[]` is what turned the transport into a hot spin.
    assert.ok(ms >= EMPTY_POLL_HOLD_MS - 20, `an empty poll should be held (took ${ms}ms)`)
  } finally {
    await fake.close()
  }
})

test('a queued message is delivered once and immediately; the next poll is empty', async () => {
  const fake = await startFakeILink()
  try {
    fake.deliver('你好', 'm1', { from: 'wxid_a' })
    assert.equal(fake.pending(), 1)

    const first = await call(fake.baseUrl, '/ilink/bot/getupdates', {})
    assert.equal(first.json.msgs.length, 1)
    assert.equal(first.json.msgs[0].message_id, 'm1')
    assert.equal(first.json.msgs[0].item_list[0].text_item.text, '你好')
    assert.equal(first.json.msgs[0].from_user_id, 'wxid_a')
    assert.equal(fake.pending(), 0)
    assert.equal(fake.seen.delivered, 1)

    // Re-delivering the same id must not queue it twice: dedupe tests depend
    // on the fake not being able to replay a message behind their back.
    fake.deliver('你好', 'm1', { from: 'wxid_a' })
    assert.equal(fake.pending(), 0)

    assert.ok(first.ms <= EMPTY_POLL_HOLD_MS, 'a scripted batch is answered at once')
  } finally {
    await fake.close()
  }
})

test('group messages carry the room id, and custom item lists survive untouched', async () => {
  const fake = await startFakeILink()
  try {
    fake.deliver('打卡', 'm2', { groupId: 'room@chatroom', from: 'wxid_b' })
    fake.deliver('图片', 'm3', { itemList: [{ type: 3, image_item: { url: 'http://cdn/x.png' } }] })

    const first = await call(fake.baseUrl, '/ilink/bot/getupdates', {})
    assert.equal(first.json.msgs[0].group_id, 'room@chatroom')
    const second = await call(fake.baseUrl, '/ilink/bot/getupdates', {})
    assert.equal(second.json.msgs[0].item_list[0].type, 3)
    // No text_item means the text helper sees an empty string rather than throwing.
    assert.equal(second.json.msgs[0].item_list[0].text_item, undefined)
  } finally {
    await fake.close()
  }
})

test('sendmessage is recorded with its raw body, and text() flattens the chunks', async () => {
  const fake = await startFakeILink()
  try {
    await call(fake.baseUrl, '/ilink/bot/sendmessage', {
      msg: { to_user_id: 'u', item_list: [{ type: 1, text_item: { text: '第一段' } }] },
    })
    await call(fake.baseUrl, '/ilink/bot/sendmessage', {
      msg: { to_user_id: 'u', item_list: [{ type: 1, text_item: { text: '第二段' } }] },
    })
    assert.deepEqual(fake.texts(), ['第一段', '第二段'])
    assert.equal(fake.outbound[0].body.msg.to_user_id, 'u')
  } finally {
    await fake.close()
  }
})

test('getconfig rejects a call without ilink_user_id, like the real server', async () => {
  const fake = await startFakeILink()
  try {
    const missing = await call(fake.baseUrl, '/ilink/bot/getconfig', {})
    assert.equal(missing.json.ret, -2)
    const ok = await call(fake.baseUrl, '/ilink/bot/getconfig', { ilink_user_id: 'me@im.wechat' })
    assert.equal(ok.json.ret, 0)
    assert.equal(ok.json.typing_ticket, 'TT')
  } finally {
    await fake.close()
  }
})

test('failNext makes exactly the requested number of calls fail', async () => {
  const fake = await startFakeILink()
  try {
    fake.failNext('/ilink/bot/sendmessage', { ret: -1, errmsg: 'boom' }, 2)
    const first = await call(fake.baseUrl, '/ilink/bot/sendmessage', { msg: { item_list: [] } })
    assert.equal(first.json.ret, -1)
    const second = await call(fake.baseUrl, '/ilink/bot/sendmessage', { msg: { item_list: [] } })
    assert.equal(second.json.ret, -1)
    const third = await call(fake.baseUrl, '/ilink/bot/sendmessage', { msg: { item_list: [] } })
    assert.equal(third.json.ret, 0)
    // A failed response is still a response the client made: only the two
    // forced failures were recorded as sent? No — the fake records only the
    // ones it answered normally, so a test can tell the two apart.
    assert.equal(fake.outbound.length, 1)
  } finally {
    await fake.close()
  }
})

test('the upload variant serves getuploadurl and records each request', async () => {
  const fake = await startFakeILink({ upload: true })
  try {
    const { json } = await call(fake.baseUrl, '/ilink/bot/getuploadurl', { filekey: 'k' })
    assert.equal(json.upload_param, 'UP-PARAM-FAKE')
    assert.equal(fake.seen.uploads.length, 1)
    assert.equal(fake.seen.uploads[0].filekey, 'k')
  } finally {
    await fake.close()
  }
})

test('close really releases the port', async () => {
  const fake = await startFakeILink()
  const { port } = fake.server.address()
  await fake.close()
  await assert.rejects(() => call(`http://127.0.0.1:${port}`, '/ilink/bot/getupdates', {}))
})

test('unknown routes answer ret 0 so a thin fake cannot mask a wiring bug as an error', async () => {
  const fake = await startFakeILink()
  try {
    const { json } = await call(fake.baseUrl, '/ilink/bot/something-else', {})
    assert.equal(json.ret, 0)
  } finally {
    await fake.close()
  }
})

test('an http server close with open keep-alive sockets does not hang the suite', async () => {
  // Guards the helper's own teardown: `server.close()` alone waits for idle
  // keep-alive sockets forever on some Node versions.
  const fake = await startFakeILink()
  const agent = new http.Agent({ keepAlive: true })
  await new Promise((resolve, reject) => {
    const req = http.request(`${fake.baseUrl}/ilink/bot/sendtyping`, { method: 'POST', agent }, (res) => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
    req.end('{}')
  })
  const started = Date.now()
  await fake.close()
  assert.ok(Date.now() - started < 1_000, 'close must not wait on a keep-alive socket')
  agent.destroy()
})
