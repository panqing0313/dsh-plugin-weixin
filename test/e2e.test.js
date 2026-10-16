/**
 * End-to-end test of the whole inbound pipeline against a fake iLink server and
 * a fake `agents` service — everything except the real network is real code:
 * plugin entry, transport, allowlist, dedupe, bridge, session reader, chunker.
 *
 * This is the test that caught two real bugs:
 *  - an "unsupported item" notice sent without routing fields (to_user_id
 *    undefined), and a 1:1 message whose `group_id` is `""` rather than absent,
 *    which made every reply be addressed to nobody.
 * @module dsh-weixin/test/e2e
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')

/**
 * Read everything the vendored file logger wrote in this test process.
 *
 * `test/isolate-host-state.mjs` points `DSH_WEIXIN_LOG_DIR` at a throwaway
 * directory per test file, so this reads the isolated log rather than the
 * operator's real one.
 */
function readDurableLog() {
  const dir = process.env.DSH_WEIXIN_LOG_DIR
  if (!dir || !fs.existsSync(dir)) return ''
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.log'))
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n')
}

/**
 * Whether the packages that only exist *inside* a DSH host can be resolved.
 *
 * `agent-bridge.js` loads `@deepseek-ai/dsh-llm` lazily to build the user
 * message it hands to `agent.followup`, and that package is not published on the
 * public registry — it ships inside a DSH installation. On a checkout without a
 * host the plugin still loads and every other test still runs; only the tests
 * that drive a full inbound turn need this.
 *
 * @returns {Promise<boolean>}
 */
async function hostPackagesAvailable() {
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    return typeof mod.createUserMessage === 'function'
  } catch {
    return false
  }
}

/**
 * Skip reason for the full-round-trip tests, or `false` to run them.
 *
 * Spelled out once so the skip message tells a contributor exactly what to do
 * rather than looking like an unexplained red.
 */
const HOST_ONLY_SKIP =
  'needs @deepseek-ai/dsh-llm, which only exists inside a DSH installation; ' +
  'run `npm test` from a DSH profile (or link a host) to exercise this path'
const ACCOUNT_ID = 'bot1'
const ALLOWED = 'wxid_abc'

/** Minimal fake of the `agents` service: one turn producing one settled reply. */
function createFakeAgents({ reply }) {
  const agents = new Map()
  return {
    get: (id) => agents.get(id),
    resume: async ({ resumeSessionId }) => {
      let seq = 0
      const events = []
      const ev = (type, data) => events.push({ type, seq: seq++, time: Date.now(), data })
      const agent = {
        session: { id: resumeSessionId, snapshotEvents: () => events },
        inbox: { clear() {} },
        followup(message) {
          ev('user/message', { message })
          ev('turn/start', {})
          setTimeout(() => {
            ev('assistant/message', { stream: [{ type: 'text-chunks', texts: [reply, message.content[0].text] }] })
            ev('turn/end', {})
          }, 30)
        },
      }
      const handle = { agent, dispose: async () => {} }
      agents.set(resumeSessionId, agent)
      return handle
    },
  }
}

/** Fake iLink endpoint: getupdates once with a scripted batch, then empty. */
async function startFakeILink(batches) {
  const sent = []
  let poll = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      res.setHeader('content-type', 'application/json')
      if (url.pathname === '/ilink/bot/getconfig') return res.end(JSON.stringify({ ret: 0, typing_ticket: 'TT' }))
      if (url.pathname === '/ilink/bot/sendmessage') {
        sent.push(JSON.parse(body))
        return res.end(JSON.stringify({ ret: 0 }))
      }
      if (url.pathname === '/ilink/bot/sendtyping') return res.end(JSON.stringify({ ret: 0 }))
      if (url.pathname === '/ilink/bot/getupdates') {
        const msgs = batches[poll] ?? []
        poll += 1
        return res.end(JSON.stringify({ ret: 0, get_updates_buf: 'b1', longpolling_timeout_ms: 20, msgs }))
      }
      res.end(JSON.stringify({ ret: 0 }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}`, sent }
}

/** Write a saved account into a throwaway state dir and point the plugin at it. */
function seedAccount(stateRoot, baseUrl) {
  const accounts = path.join(stateRoot, 'openclaw-weixin', 'accounts')
  fs.mkdirSync(accounts, { recursive: true })
  fs.writeFileSync(path.join(accounts, `${ACCOUNT_ID}.json`), JSON.stringify({ token: 'tok', baseUrl }), { mode: 0o600 })
  fs.writeFileSync(path.join(stateRoot, 'openclaw-weixin', 'accounts.json'), JSON.stringify([ACCOUNT_ID]))
}

/**
 * Fake iLink endpoint that also serves `getuploadurl`.
 *
 * The plain {@link startFakeILink} answers every unknown route with `{ret: 0}`,
 * which carries no `upload_param` — the upload then fails before any CDN request
 * is made, and a test could not tell "the wiring is broken" from "the fake is
 * too thin". This variant returns a real upload param and records every upload
 * request, so the outbound path is observable end to end.
 */
async function startFakeILinkWithUpload(batches) {
  const sent = []
  const uploadUrls = []
  let poll = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      res.setHeader('content-type', 'application/json')
      if (url.pathname === '/ilink/bot/getconfig') return res.end(JSON.stringify({ ret: 0, typing_ticket: 'TT' }))
      if (url.pathname === '/ilink/bot/getuploadurl') {
        uploadUrls.push(JSON.parse(body))
        return res.end(JSON.stringify({ ret: 0, upload_param: 'UP-PARAM-E2E' }))
      }
      if (url.pathname === '/ilink/bot/sendmessage') {
        sent.push(JSON.parse(body))
        return res.end(JSON.stringify({ ret: 0 }))
      }
      if (url.pathname === '/ilink/bot/sendtyping') return res.end(JSON.stringify({ ret: 0 }))
      if (url.pathname === '/ilink/bot/getupdates') {
        const msgs = batches[poll] ?? []
        poll += 1
        return res.end(JSON.stringify({ ret: 0, get_updates_buf: 'b1', longpolling_timeout_ms: 20, msgs }))
      }
      res.end(JSON.stringify({ ret: 0 }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}`, sent, uploadUrls }
}

test('one Weixin round trip: allow → dedupe → agent → chunked reply', async (t) => {
  if (!(await hostPackagesAvailable())) return t.skip(HOST_ONLY_SKIP)

  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-e2e-'))
  process.env.DSH_WEIXIN_STATE_DIR = stateRoot
  try {
    const { server, baseUrl, sent } = await startFakeILink([
      [
        { message_id: 1001, from_user_id: ALLOWED, group_id: '', message_type: 1, message_state: 2, context_token: 'ct1', create_time_ms: 1, item_list: [{ type: 1, text_item: { text: 'hi' } }] },
        { message_id: 1002, from_user_id: 'wxid_stranger', group_id: '', message_type: 1, message_state: 2, context_token: 'ct2', create_time_ms: 2, item_list: [{ type: 1, text_item: { text: 'hack' } }] },
        { message_id: 1003, from_user_id: ALLOWED, group_id: '', message_type: 1, message_state: 2, context_token: 'ct3', create_time_ms: 3, item_list: [{ type: 2, image_item: {} }] },
        { message_id: 1001, from_user_id: ALLOWED, group_id: '', message_type: 1, message_state: 2, context_token: 'ct1', create_time_ms: 1, item_list: [{ type: 1, text_item: { text: 'hi' } }] },
      ],
    ])
    seedAccount(stateRoot, baseUrl)

    const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
    const config = plugin.Config({ allowedSenders: [ALLOWED], accountId: ACCOUNT_ID })

    const disposers = []
    const warnings = []
    const ctx = {
      logger: { info: () => {}, warn: (l) => warnings.push(l) },
      effect(fn) { disposers.push(fn()); return { dispose() {} } },
      get: (name) => (name === 'agents' ? createFakeAgents({ reply: 'pong: ' }) : undefined),
    }
    plugin.apply(ctx, config)

    // Wait for the reply to be produced.
    const deadline = Date.now() + 10_000
    while (sent.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    for (const d of disposers) await (await d)?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()

    const texts = sent.map((s) => s.msg.item_list[0].text_item.text)
    const targets = sent.map((s) => s.msg.to_user_id)
    const tokens = sent.map((s) => s.msg.context_token)

    // The agent's reply, and one notice for the image that had no CDN
    // reference. That image is no longer "unsupported": it is a media item
    // whose download failed, and the notice now names the reason.
    assert.equal(texts[0], 'pong: hi')
    assert.match(texts[1], /下载失败/)
    assert.match(texts[1], /no CDN reference|CDN/)

    // Regressions: every outbound message must be addressed to the sender even
    // for a 1:1 conversation (group_id: ""), and must echo the inbound token.
    for (const target of targets) assert.equal(target, ALLOWED)
    assert.equal(tokens[0], 'ct1')
    assert.equal(tokens[1], 'ct3')

    // The stranger is refused and no session or reply is produced for them.
    assert.ok(warnings.some((w) => w.includes('wxid_stranger')), `expected a refusal warning, got: ${warnings.join(' | ')}`)
    // The redelivered 1001 is not answered twice.
    assert.equal(texts.filter((t) => t === 'pong: hi').length, 1)
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
    delete process.env.DSH_WEIXIN_STATE_DIR
  }
})

test('sourceContext on: the agent prompt carries a weixin_source block; off: it does not', async (t) => {
  if (!(await hostPackagesAvailable())) return t.skip(HOST_ONLY_SKIP)

  for (const sourceContext of [true, false]) {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-e2e-'))
    process.env.DSH_WEIXIN_STATE_DIR = stateRoot
    try {
      const { server, baseUrl, sent } = await startFakeILink([
        [
          { message_id: 3001, from_user_id: ALLOWED, group_id: '', message_type: 1, message_state: 2, context_token: 'ct9', create_time_ms: 9, item_list: [{ type: 1, text_item: { text: 'who are you' } }] },
        ],
      ])
      seedAccount(stateRoot, baseUrl)

      const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
      const config = plugin.Config({ allowedSenders: [ALLOWED], accountId: ACCOUNT_ID, sourceContext })

      const disposers = []
      const warnings = []
      const ctx = {
        logger: { info: () => {}, warn: (l) => warnings.push(l) },
        effect(fn) { disposers.push(fn()); return { dispose() {} } },
        get: (name) => (name === 'agents' ? createFakeAgents({ reply: 'pong: ' }) : undefined),
      }
      plugin.apply(ctx, config)

      const deadline = Date.now() + 10_000
      while (sent.length < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      for (const d of disposers) await (await d)?.()
      await new Promise((resolve) => setTimeout(resolve, 100))
      server.close()

      assert.ok(sent.length >= 1, `expected a reply (sourceContext=${sourceContext})`)
      const prompt = sent[0].msg.item_list[0].text_item.text
      if (sourceContext) {
        assert.match(prompt, /<weixin_source channel="weixin"/)
        assert.match(prompt, new RegExp(`senderId="${ALLOWED}"`))
        assert.match(prompt, /who are you/)
      } else {
        assert.ok(!prompt.includes('weixin_source'), prompt)
        assert.equal(prompt, 'pong: who are you')
      }
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true })
      delete process.env.DSH_WEIXIN_STATE_DIR
    }
  }
})

test('an inbound image is downloaded, decrypted, saved and handed to the agent', async (t) => {
  if (!(await hostPackagesAvailable())) return t.skip(HOST_ONLY_SKIP)

  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-e2e-media-'))
  process.env.DSH_WEIXIN_STATE_DIR = stateRoot
  const { encryptAesEcb } = await import('../vendor/openclaw-weixin/cdn/aes-ecb.js')
  const crypto = await import('node:crypto')

  // A fake CDN holding one AES-ECB encrypted image, keyed the way an ImageItem
  // keys one (hex in `aeskey`).
  const plaintext = Buffer.from('\x89PNG\r\n\x1a\nThe real picture bytes'.repeat(8), 'binary')
  const key = crypto.randomBytes(16)
  const cdnRequests = []
  const cdn = http.createServer((req, res) => {
    cdnRequests.push(req.url)
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(encryptAesEcb(plaintext, key))
  })
  await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve))
  const cdnBaseUrl = `http://127.0.0.1:${cdn.address().port}/c2c`

  try {
    const { server, baseUrl, sent } = await startFakeILink([
      [
        {
          message_id: 2001,
          from_user_id: ALLOWED,
          group_id: '',
          message_type: 1,
          message_state: 2,
          context_token: 'ctm',
          create_time_ms: 5,
          item_list: [
            {
              type: 2,
              image_item: {
                aeskey: key.toString('hex'),
                media: { encrypt_query_param: 'img-param', encrypt_type: 1 },
              },
            },
            { type: 1, text_item: { text: '这是什么？' } },
          ],
        },
      ],
    ])
    seedAccount(stateRoot, baseUrl)
    // The plugin resolves the CDN from config first; point it at the fake one.
    // The saved account file carries no cdnBaseUrl, so the config value is used.
    const accounts = path.join(stateRoot, 'openclaw-weixin', 'accounts', `${ACCOUNT_ID}.json`)
    fs.writeFileSync(accounts, JSON.stringify({ token: 'tok', baseUrl, cdnBaseUrl }), { mode: 0o600 })

    const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
    const config = plugin.Config({ allowedSenders: [ALLOWED], accountId: ACCOUNT_ID, cdnBaseUrl })

    const disposers = []
    const warnings = []
    const ctx = {
      logger: { info: () => {}, warn: (l) => warnings.push(l) },
      effect(fn) { disposers.push(fn()); return { dispose() {} } },
      get: (name) => (name === 'agents' ? createFakeAgents({ reply: 'pong: ' }) : undefined),
    }
    plugin.apply(ctx, config)

    const deadline = Date.now() + 10_000
    while (sent.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    for (const d of disposers) await (await d)?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()

    assert.ok(sent.length >= 1, `expected a reply, got none (warnings: ${warnings.join(' | ')})`)
    // The fake agent echoes the prompt it received, so this is what the agent
    // was actually handed.
    const prompt = sent[0].msg.item_list[0].text_item.text
    assert.match(prompt, /pong: /)
    // The prompt names a real local file, tells the agent which tool to use,
    // and keeps the caption the sender typed.
    assert.match(prompt, /已保存到本地：\//)
    assert.match(prompt, /read_image/)
    assert.match(prompt, /这是什么？/)

    // The bytes on disk are the decrypted originals, under `DSH_WEIXIN_STATE_DIR`
    // (which IS the plugin's state root) — not the ciphertext, and not a temp
    // path the OS could sweep away mid-turn.
    const inbox = path.join(stateRoot, 'media', 'inbound')
    const files = fs.readdirSync(inbox)
    assert.equal(files.length, 1)
    assert.deepEqual(fs.readFileSync(path.join(inbox, files[0])), plaintext)
    assert.match(prompt, new RegExp(files[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    // The download went to the configured CDN with the message's query param.
    assert.equal(cdnRequests.length, 1)
    assert.match(cdnRequests[0], /encrypted_query_param=img-param/)
  } finally {
    await new Promise((resolve) => cdn.close(resolve))
    fs.rmSync(stateRoot, { recursive: true, force: true })
    delete process.env.DSH_WEIXIN_STATE_DIR
  }
})

test('a CDN root saved in the account record is used when config does not set one', async () => {
  // Regression: the schema used to default `cdnBaseUrl` to the production root,
  // which made the account-record fallback dead code — an operator who set the
  // CDN only in the account file silently had uploads and downloads aimed at
  // Tencent. Only the account record is set here; config must not carry one.
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-e2e-acctcdn-'))
  process.env.DSH_WEIXIN_STATE_DIR = stateRoot

  const key = Buffer.from('0123456789abcdef', 'utf8')
  const plaintext = Buffer.from('account-record CDN payload', 'utf8')
  const { encryptAesEcb } = await import('../vendor/openclaw-weixin/cdn/aes-ecb.js')
  const cdnRequests = []
  const cdn = http.createServer((req, res) => {
    cdnRequests.push(req.url)
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(encryptAesEcb(plaintext, key))
  })
  await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve))
  const accountCdnBaseUrl = `http://127.0.0.1:${cdn.address().port}/c2c`

  try {
    const { server, baseUrl, sent } = await startFakeILink([
      [
        {
          message_id: 4001,
          from_user_id: ALLOWED,
          group_id: '',
          message_type: 1,
          message_state: 2,
          context_token: 'ctx-acct',
          create_time_ms: 7,
          item_list: [
            {
              type: 2,
              image_item: {
                aeskey: key.toString('hex'),
                media: { encrypt_query_param: 'acct-param', encrypt_type: 1 },
              },
            },
            { type: 1, text_item: { text: '看一下' } },
          ],
        },
      ],
    ])
    seedAccount(stateRoot, baseUrl)
    // The ONLY place the CDN root is declared.
    const accounts = path.join(stateRoot, 'openclaw-weixin', 'accounts', `${ACCOUNT_ID}.json`)
    fs.writeFileSync(
      accounts,
      JSON.stringify({ token: 'tok', baseUrl, cdnBaseUrl: accountCdnBaseUrl }),
      { mode: 0o600 },
    )

    const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
    // Deliberately no cdnBaseUrl here.
    const config = plugin.Config({ allowedSenders: [ALLOWED], accountId: ACCOUNT_ID })
    assert.equal(
      config.cdnBaseUrl,
      '',
      'an unset cdnBaseUrl must stay distinguishable from a configured one',
    )

    const disposers = []
    const warnings = []
    const ctx = {
      logger: { info: () => {}, warn: (l) => warnings.push(l) },
      effect(fn) { disposers.push(fn()); return { dispose() {} } },
      get: (name) => (name === 'agents' ? createFakeAgents({ reply: 'pong: ' }) : undefined),
    }
    plugin.apply(ctx, config)

    const deadline = Date.now() + 10_000
    while (sent.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    for (const d of disposers) await (await d)?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()

    assert.ok(sent.length >= 1, `expected a reply, got none (warnings: ${warnings.join(' | ')})`)
    // The decisive assertion: the download reached the ACCOUNT's CDN, not the
    // production default. A dead fallback shows up as zero requests here.
    assert.equal(cdnRequests.length, 1, 'the account record CDN must receive the download')
    assert.match(cdnRequests[0], /encrypted_query_param=acct-param/)
  } finally {
    await new Promise((resolve) => cdn.close(resolve))
    fs.rmSync(stateRoot, { recursive: true, force: true })
    delete process.env.DSH_WEIXIN_STATE_DIR
  }
})

test('a whitespace-only cdnBaseUrl counts as unset and does not shadow the account record', async (t) => {
  if (!(await hostPackagesAvailable())) return t.skip(HOST_ONLY_SKIP)

  // Regression: `||` treats "   " as truthy, so a YAML `cdnBaseUrl:` with
  // trailing spaces would win the chain, discard a working account record, and
  // fail later as `Failed to parse URL from    /upload?...`. The account side
  // already trims (vendor .../auth/accounts.js), so config must too.
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-e2e-ws-'))
  process.env.DSH_WEIXIN_STATE_DIR = stateRoot

  const key = Buffer.from('0123456789abcdef', 'utf8')
  const plaintext = Buffer.from('whitespace CDN payload', 'utf8')
  const { encryptAesEcb } = await import('../vendor/openclaw-weixin/cdn/aes-ecb.js')
  const cdnRequests = []
  // Accepts both directions: the encrypted download blob, and the encrypted
  // upload body (which is answered with the `x-encrypted-param` header the
  // upload path needs). Buffers, never concatenated strings — see the note in
  // the outbound test below.
  const cdn = http.createServer((req, res) => {
    cdnRequests.push(req.url)
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-encrypted-param': 'DL-PARAM-WS',
      })
      res.end(encryptAesEcb(plaintext, key))
    })
  })
  await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve))
  const accountCdnBaseUrl = `http://127.0.0.1:${cdn.address().port}/c2c`

  try {
    // An allow-listed file the agent's reply can reference, so the SAME test
    // also exercises the outbound direction — that is the direction the
    // original defect surfaced in (`Failed to parse URL from    /upload?...`).
    const fileDir = path.join(stateRoot, 'work')
    fs.mkdirSync(fileDir, { recursive: true })
    const filePath = path.join(fileDir, 'note.txt')
    fs.writeFileSync(filePath, Buffer.from('whitespace outbound payload', 'utf8'))

    const { server, baseUrl, sent, uploadUrls } = await startFakeILinkWithUpload([
      [
        {
          message_id: 5001,
          from_user_id: ALLOWED,
          group_id: '',
          message_type: 1,
          message_state: 2,
          context_token: 'ctx-ws',
          create_time_ms: 8,
          item_list: [
            {
              type: 2,
              image_item: {
                aeskey: key.toString('hex'),
                media: { encrypt_query_param: 'ws-param', encrypt_type: 1 },
              },
            },
            { type: 1, text_item: { text: '看这个' } },
          ],
        },
      ],
    ])
    seedAccount(stateRoot, baseUrl)
    const accounts = path.join(stateRoot, 'openclaw-weixin', 'accounts', `${ACCOUNT_ID}.json`)
    fs.writeFileSync(
      accounts,
      JSON.stringify({ token: 'tok', baseUrl, cdnBaseUrl: accountCdnBaseUrl }),
      { mode: 0o600 },
    )

    const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
    // Whitespace, not empty: this is the shape a YAML `cdnBaseUrl: ` produces.
    const config = plugin.Config({
      allowedSenders: [ALLOWED],
      accountId: ACCOUNT_ID,
      cdnBaseUrl: '   ',
    })

    const disposers = []
    const warnings = []
    const ctx = {
      logger: { info: () => {}, warn: (l) => warnings.push(l) },
      effect(fn) { disposers.push(fn()); return { dispose() {} } },
      get: (name) =>
        name === 'agents'
          ? createFakeAgents({ reply: `pong: 附件在这里：![note](${filePath})` })
          : undefined,
    }
    plugin.apply(ctx, config)

    const deadline = Date.now() + 10_000
    // Wait for the outbound FILE item too, so the assertion below is not racing
    // the upload.
    while (!sent.some((s) => s.msg?.item_list?.[0]?.type === 4) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    for (const d of disposers) await (await d)?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()

    assert.ok(sent.length >= 1, `expected a reply, got none (warnings: ${warnings.join(' | ')})`)
    // The whitespace value must not have shadowed the account record. This test
    // drives BOTH directions, so there are legitimately two CDN requests: the
    // inbound download and the outbound upload. Assert each explicitly rather
    // than counting them together.
    const downloads = cdnRequests.filter((u) => u.startsWith('/c2c/download'))
    const uploads = cdnRequests.filter((u) => u.startsWith('/c2c/upload'))
    assert.equal(
      downloads.length,
      1,
      `whitespace config must not shadow the account CDN (saw ${JSON.stringify(cdnRequests)})`,
    )
    assert.match(downloads[0], /encrypted_query_param=ws-param/)
    assert.equal(
      uploads.length,
      1,
      `the outbound upload must reach the account CDN too (saw ${JSON.stringify(cdnRequests)})`,
    )
    // And nothing may have reported a URL parse failure.
    const replied = sent.map((m) => m.msg.item_list[0].text_item?.text).filter(Boolean).join('\n')
    assert.doesNotMatch(replied, /Failed to parse URL/, replied)
    // Outbound: the upload must also have reached the account's CDN, not failed
    // on a whitespace URL.
    assert.equal(uploadUrls.length, 1, `expected one getuploadurl, got ${uploadUrls.length}; warnings: ${warnings.join(' | ')}`)
    const fileItem = sent.find((s) => s.msg?.item_list?.[0]?.type === 4)?.msg?.item_list?.[0]?.file_item
    assert.ok(
      fileItem,
      `no FILE item was sent; sent=${JSON.stringify(sent.map((s) => s.msg?.item_list?.[0]?.type))}; warnings: ${warnings.join(' | ')}`,
    )
    assert.equal(fileItem.file_name, 'note.txt')
  } finally {
    await new Promise((resolve) => cdn.close(resolve))
    fs.rmSync(stateRoot, { recursive: true, force: true })
    delete process.env.DSH_WEIXIN_STATE_DIR
  }
})

test('an unauthorized sender never triggers a CDN download', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-e2e-deny-'))
  process.env.DSH_WEIXIN_STATE_DIR = stateRoot

  // Any request to this server means the allowlist was bypassed.
  let cdnHits = 0
  const cdn = http.createServer((req, res) => {
    cdnHits += 1
    res.writeHead(200)
    res.end(Buffer.alloc(16))
  })
  await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve))
  const cdnBaseUrl = `http://127.0.0.1:${cdn.address().port}`

  try {
    const { server, baseUrl, sent } = await startFakeILink([
      [
        {
          message_id: 3001,
          from_user_id: 'wxid_stranger',
          group_id: '',
          message_type: 1,
          message_state: 2,
          context_token: 'ctx',
          create_time_ms: 6,
          item_list: [
            {
              type: 5,
              video_item: { media: { encrypt_query_param: 'evil', aes_key: 'Zg==' } },
            },
          ],
        },
      ],
    ])
    seedAccount(stateRoot, baseUrl)
    const accounts = path.join(stateRoot, 'openclaw-weixin', 'accounts', `${ACCOUNT_ID}.json`)
    fs.writeFileSync(accounts, JSON.stringify({ token: 'tok', baseUrl, cdnBaseUrl }), { mode: 0o600 })

    const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
    const config = plugin.Config({ allowedSenders: [ALLOWED], accountId: ACCOUNT_ID, cdnBaseUrl })

    const warnings = []
    const disposers = []
    const ctx = {
      logger: { info: () => {}, warn: (l) => warnings.push(l) },
      effect(fn) { disposers.push(fn()); return { dispose() {} } },
      get: (name) => (name === 'agents' ? createFakeAgents({ reply: 'x' }) : undefined),
    }
    plugin.apply(ctx, config)

    // Give the poll loop time to receive (and refuse) the batch.
    const deadline = Date.now() + 3_000
    while (!warnings.some((w) => w.includes('wxid_stranger')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // Stop the long-poll loop before closing the server, or the transport keeps
    // retrying against a dead socket and the test process never exits.
    for (const d of disposers) await (await d)?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()

    assert.ok(warnings.some((w) => w.includes('wxid_stranger')), `expected a refusal, got: ${warnings.join(' | ')}`)
    // The refusal must ALSO reach the vendor file log: ctx.logger can drop
    // levels, and a refusal that leaves no trace turns an allowlist mismatch
    // into "the bot just ignores me" with nothing to grep afterwards.
    const logDir = process.env.DSH_WEIXIN_LOG_DIR
    assert.ok(logDir, 'expected the vendor log dir to be redirected for this test run')
    // The vendor logger names the file by the LOCAL date, not UTC — a run
    // that crosses midnight (00:00–08:00 CST) would otherwise look for
    // yesterday's file. Mirror the logger's own local date key.
    const now = new Date()
    const offsetMs = now.getTime() - now.getTimezoneOffset() * 60_000
    const day = new Date(offsetMs).toISOString().slice(0, 10)
    const logFile = path.join(logDir, `openclaw-${day}.log`)
    assert.ok(fs.existsSync(logFile), `expected a vendor log file at ${logFile}`)
    const logText = fs.readFileSync(logFile, 'utf8')
    assert.ok(
      logText.includes('refused message from wxid_stranger') && logText.includes('allowedSenders'),
      `expected the refusal line with the allowlist in the file log, got:\n${logText.slice(-2000)}`,
    )
    // This is the assertion that matters: the refusal happens before any fetch,
    // so an unauthorized sender cannot make this host talk to Tencent's CDN.
    assert.equal(cdnHits, 0)
    assert.equal(sent.length, 0)
  } finally {
    await new Promise((resolve) => cdn.close(resolve))
    fs.rmSync(stateRoot, { recursive: true, force: true })
    delete process.env.DSH_WEIXIN_STATE_DIR
  }
})

/**
 * Outbound media through the real plugin wiring.
 *
 * The media module has its own unit tests, but nothing proved that
 * `plugin.apply()` actually threads `cdnBaseUrl`/`accountId`/`token` into the
 * upload path and turns a referenced file into an IMAGE item on the wire. An
 * independent verification harness exercised exactly this and observed zero
 * upload attempts, so the integration seam — not the module — is what is
 * pinned here.
 */
test('a reply that references a local file uploads it and sends an IMAGE item', async (t) => {
  if (!(await hostPackagesAvailable())) return t.skip(HOST_ONLY_SKIP)

  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-e2e-out-'))
  process.env.DSH_WEIXIN_STATE_DIR = stateRoot
  const uploaded = []
  // Fake CDN: accepts the encrypted blob and answers with the download param.
  //
  // The body is collected as BUFFERS, never as a concatenated string: `body +=
  // chunk` stringifies each chunk through UTF-8, which mangles arbitrary binary,
  // and `Buffer.from(str, 'binary')` cannot undo it. A string-collecting fake
  // reports a truncated ciphertext and makes a correct upload look broken.
  const cdn = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      uploaded.push({ url: req.url, bytes: body, type: req.headers['content-type'] })
      res.writeHead(200, { 'x-encrypted-param': 'DL-PARAM-E2E' })
      res.end('')
    })
  })
  await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve))
  const cdnBaseUrl = `http://127.0.0.1:${cdn.address().port}`

  try {
    // The referenced file must be inside a directory the plugin allows, and the
    // session cwd is not pinned in this test, so use the plugin's own state tree
    // (always allowed) to keep the reference deterministic.
    const fileDir = path.join(stateRoot, 'work')
    fs.mkdirSync(fileDir, { recursive: true })
    const filePath = path.join(fileDir, 'report.txt')
    const payload = Buffer.from('e2e outbound attachment payload '.repeat(20), 'utf8')
    fs.writeFileSync(filePath, payload)

    const { server, baseUrl, sent, uploadUrls } = await startFakeILinkWithUpload([
      [{ message_id: 2001, from_user_id: ALLOWED, group_id: '', message_type: 1, message_state: 2, context_token: 'ct-out', create_time_ms: 1, item_list: [{ type: 1, text_item: { text: 'send it' } }] }],
    ])
    seedAccount(stateRoot, baseUrl)

    const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
    const config = plugin.Config({ allowedSenders: [ALLOWED], accountId: ACCOUNT_ID, cdnBaseUrl })

    const disposers = []
    const warnings = []
    const ctx = {
      logger: { info: () => {}, warn: (l) => warnings.push(l) },
      effect(fn) { disposers.push(fn()); return { dispose() {} } },
      get: (name) => (name === 'agents' ? createFakeAgents({ reply: `报告在这里：![报告](${filePath})` }) : undefined),
    }
    plugin.apply(ctx, config)

    const deadline = Date.now() + 10_000
    while (!sent.some((s) => s.msg?.item_list?.[0]?.type === 4) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    for (const d of disposers) await (await d)?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()

    // The upload really happened, against the CDN base URL from the config.
    assert.equal(uploadUrls.length, 1, `expected one getuploadurl, got ${uploadUrls.length}; warnings: ${warnings.join(' | ')}`)
    assert.equal(uploaded.length, 1, `expected one CDN POST, got ${uploaded.length}`)
    // The peer id must survive the send seam into BOTH requests. The seam once
    // forwarded `to` into a parameter slot named `conversationId`, so every
    // plugin-driven attachment went out with `to=undefined`: getUploadUrl lost
    // `to_user_id` (server answered `{ret:-2}`) and the sendmessage envelope
    // lost `msg.to_user_id` — yet this fake answered success to everything,
    // which is why the drop stayed invisible until it was measured in the field.
    assert.equal(uploadUrls[0].to_user_id, ALLOWED, `getuploadurl lost the peer id: ${JSON.stringify(uploadUrls[0])}`)
    const fileMsg = sent.find((s) => s.msg?.item_list?.[0]?.type === 4)?.msg
    assert.equal(fileMsg?.to_user_id, ALLOWED, `sendmessage lost the peer id: ${JSON.stringify(fileMsg?.to_user_id)}`)

    const item = sent.find((s) => s.msg?.item_list?.[0]?.type === 4)?.msg?.item_list?.[0]?.file_item
    assert.ok(item, `no FILE item was sent; sent=${JSON.stringify(sent.map((s) => s.msg?.item_list?.[0]?.type))}`)
    assert.equal(item.file_name, 'report.txt')
    // `len` is a uint64 on the wire, so it travels as a decimal STRING — that is
    // the upstream format, not a quirk to normalize away. It is the plaintext
    // length, not the padded ciphertext length.
    assert.equal(item.len, String(payload.length))
    assert.equal(item.media.encrypt_query_param, 'DL-PARAM-E2E')
    // What lands on the CDN is the AES-ECB ciphertext, not the plaintext.
    assert.ok(!uploaded[0].bytes.equals(payload), 'the CDN received the plaintext')
    assert.equal(uploaded[0].bytes.length % 16, 0, 'ciphertext must be block-aligned')

    // The reference is stripped from the caption so the user does not also see
    // the raw markdown.
    const texts = sent.filter((s) => s.msg?.item_list?.[0]?.type === 1).map((s) => s.msg.item_list[0].text_item.text)
    assert.ok(texts.some((t) => t.includes('报告在这里')), `caption missing; got ${JSON.stringify(texts)}`)
    assert.ok(!texts.some((t) => t.includes(filePath)), `the raw path leaked into the text: ${JSON.stringify(texts)}`)
  } finally {
    await new Promise((resolve) => cdn.close(resolve))
    fs.rmSync(stateRoot, { recursive: true, force: true })
    delete process.env.DSH_WEIXIN_STATE_DIR
  }
})

test('a reply naming a file RELATIVE to the agent cwd still uploads it', async (t) => {
  if (!(await hostPackagesAvailable())) return t.skip(HOST_ONLY_SKIP)

  // The regression this pins: an agent writes `![shot](desktop.png)` meaning the
  // file in ITS working directory. Resolving that against the host process cwd
  // landed outside every allowed directory, so the attachment was refused and
  // the user simply never received an image — with no error anywhere they could
  // see. The absolute-path variant above cannot catch this.
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-e2e-rel-'))
  process.env.DSH_WEIXIN_STATE_DIR = stateRoot
  const uploaded = []
  const cdn = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      uploaded.push({ url: req.url, bytes: Buffer.concat(chunks) })
      res.writeHead(200, { 'x-encrypted-param': 'DL-PARAM-REL' })
      res.end('')
    })
  })
  await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve))
  const cdnBaseUrl = `http://127.0.0.1:${cdn.address().port}`

  try {
    // The agent's own working directory, pinned through config so the test is
    // deterministic. The file lives directly in it, named the way an agent
    // names a screenshot.
    const agentCwd = path.join(stateRoot, 'agent-cwd')
    fs.mkdirSync(agentCwd, { recursive: true })
    const payload = Buffer.from('relative-reference payload '.repeat(30), 'utf8')
    fs.writeFileSync(path.join(agentCwd, 'desktop.png'), payload)

    const { server, baseUrl, sent, uploadUrls } = await startFakeILinkWithUpload([
      [{ message_id: 3001, from_user_id: ALLOWED, group_id: '', message_type: 1, message_state: 2, context_token: 'ct-rel', create_time_ms: 1, item_list: [{ type: 1, text_item: { text: 'screenshot it' } }] }],
    ])
    seedAccount(stateRoot, baseUrl)

    const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
    const config = plugin.Config({
      allowedSenders: [ALLOWED],
      accountId: ACCOUNT_ID,
      cdnBaseUrl,
      cwd: agentCwd,
    })

    const disposers = []
    const warnings = []
    const ctx = {
      logger: { info: () => {}, warn: (l) => warnings.push(l) },
      effect(fn) { disposers.push(fn()); return { dispose() {} } },
      // Exactly the shape the agent produced in the field.
      get: (name) => (name === 'agents' ? createFakeAgents({ reply: '成功了\n\n![桌面截图](desktop.png)\n\n内容如下' }) : undefined),
    }
    plugin.apply(ctx, config)

    // A `.png` must go out as an IMAGE item — `MessageItemType.IMAGE` is 2 on
    // the outbound envelope, and the item carries an `image_item` field. (The
    // absolute-path test above asserts on a FILE item, whose number is 3; the
    // two enums in api/types.js number these differently, so the item KEY is
    // the reliable discriminator.)
    const IMAGE_ITEM = 2
    const deadline = Date.now() + 10_000
    while (!sent.some((s) => s.msg?.item_list?.[0]?.type === IMAGE_ITEM) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    for (const d of disposers) await (await d)?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()

    assert.equal(uploadUrls.length, 1, `expected one getuploadurl, got ${uploadUrls.length}; warnings: ${warnings.join(' | ')}`)
    assert.equal(uploaded.length, 1, `expected one CDN POST, got ${uploaded.length}; warnings: ${warnings.join(' | ')}`)
    // Same seam regression as the absolute-path test: the peer id has to reach
    // the upload request, not vanish between deliverOutboundMedia and sendMedia.
    assert.equal(uploadUrls[0].to_user_id, ALLOWED, `getuploadurl lost the peer id: ${JSON.stringify(uploadUrls[0])}`)
    const item = sent.find((s) => s.msg?.item_list?.[0]?.type === IMAGE_ITEM)?.msg?.item_list?.[0]?.image_item
    assert.ok(item, `no IMAGE item was sent; sent=${JSON.stringify(sent.map((s) => Object.keys(s.msg?.item_list?.[0] ?? {})))}; warnings: ${warnings.join(' | ')}`)
    // An image item carries only `media` (no name/length on the wire), so the
    // proof the right bytes went is the CDN body plus the download param.
    assert.deepEqual(Object.keys(item).sort(), ['media', 'mid_size'])
    assert.equal(uploaded[0].bytes.length % 16, 0, 'ciphertext must be block-aligned')
    const raw = fs.readFileSync(path.join(agentCwd, 'desktop.png'))
    assert.equal(uploaded[0].bytes.length, Math.ceil(raw.length / 16) * 16, 'the uploaded ciphertext must match the file size')
    // The decision is on the durable record, not only on ctx.logger — a refusal
    // that leaves no trace looks identical to a detector that never matched.
    const logText = readDurableLog()
    assert.match(logText, /sent 1 outbound media file\(s\): desktop\.png/)
  } finally {
    await new Promise((resolve) => cdn.close(resolve))
    fs.rmSync(stateRoot, { recursive: true, force: true })
    delete process.env.DSH_WEIXIN_STATE_DIR
  }
})
