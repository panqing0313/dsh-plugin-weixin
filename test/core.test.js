/**
 * Unit tests for the pieces that do not need a live DSH host or a live iLink
 * connection: the allowlist gate, reply chunking, inbound normalization and
 * session-log reading.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isAllowedSender, denialReason } from '../src/security/allowlist.js'
import { chunkText } from '../src/message/chunker.js'
import { normalizeInbound } from '../src/transport/ilink.js'
import { readAssistantReply, streamText, describePending } from '../src/session-reader.js'
import { sessionIdFor } from '../src/agent-bridge.js'
import { SessionLines } from '../src/sessions.js'
import { MessageDeduper } from '../src/message/dedupe.js'
import { accountsDir, ensureSessionsDir, sessionsDir, configFile, readSavedConfig, withSavedConfig } from '../src/state.js'

test('allowlist denies everyone when no sender is configured', () => {
  assert.equal(isAllowedSender({ allowedSenders: [] }, 'wxid_abc'), false)
  assert.match(denialReason({ allowedSenders: [] }, 'wxid_abc'), /no sender allowlist/)
})

test('allowlist admits only listed senders, and only listed chats when set', () => {
  const config = { allowedSenders: ['wxid_abc'], allowedChats: ['room_1'] }
  assert.equal(isAllowedSender(config, 'wxid_abc', 'room_1'), true)
  assert.equal(isAllowedSender(config, 'wxid_abc', 'room_2'), false)
  assert.equal(isAllowedSender(config, 'wxid_other', 'room_1'), false)
})

test('chunkText splits on line boundaries and never exceeds the limit', () => {
  const text = 'aaaa\nbbbb\ncccc'
  const chunks = chunkText(text, 10)
  assert.deepEqual(chunks, ['aaaa\nbbbb\n', 'cccc'])
  for (const chunk of chunks) assert.ok(chunk.length <= 10)
})

test('chunkText hard-splits text with no break opportunity', () => {
  assert.deepEqual(chunkText('abcdefghij', 4), ['abcd', 'efgh', 'ij'])
  assert.deepEqual(chunkText('', 4), [])
  assert.deepEqual(chunkText('hi', 4), ['hi'])
})

test('normalizeInbound drops bot echoes and maps a text message', () => {
  assert.equal(normalizeInbound({ message_type: 2, item_list: [{ type: 1, text_item: { text: 'x' } }] }), null)

  const mapped = normalizeInbound({
    message_id: 12345,
    from_user_id: 'wxid_abc',
    group_id: 'room_1',
    message_type: 1,
    message_state: 2,
    context_token: 'tok',
    create_time_ms: 1000,
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
  })
  assert.deepEqual(mapped, {
    id: '12345',
    senderId: 'wxid_abc',
    conversationId: 'room_1',
    type: 'text',
    text: 'hello',
    contextToken: 'tok',
    timestamp: 1000,
  })
})

test('normalizeInbound falls back to the sender when group_id is blank', () => {
  // A 1:1 message carries group_id: "" — not an absent field — and the reply
  // must still be addressed to the sender.
  const mapped = normalizeInbound({
    from_user_id: 'wxid_abc',
    group_id: '',
    message_type: 1,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: 'hi' } }],
  })
  assert.equal(mapped.conversationId, 'wxid_abc')
})

test('normalizeInbound reports truly unknown item kinds instead of failing', () => {
  // Media types (IMAGE/VOICE/FILE/VIDEO) are normalized into download
  // descriptors — see the media tests below. TOOL_CALL_* and anything the
  // protocol may add later keep the old one-line notice, so an unrecognized
  // item is never silently dropped.
  const mapped = normalizeInbound({
    from_user_id: 'wxid_abc',
    message_type: 1,
    message_state: 0,
    item_list: [{ type: 99 }],
  })
  assert.equal(mapped.unsupported, 'item type 99')
  // Routing fields must survive so a "not supported" notice can be sent back.
  assert.equal(mapped.conversationId, 'wxid_abc')
  assert.equal(mapped.senderId, 'wxid_abc')
})

test('normalizeInbound reports a message with no items at all', () => {
  const mapped = normalizeInbound({ from_user_id: 'wxid_abc', message_type: 1, message_state: 0 })
  assert.equal(mapped.unsupported, 'no items')
})

test('normalizeInbound parses an IMAGE item into a download descriptor', () => {
  // Field shape per upstream ImageItem: the CDN reference lives under
  // `image_item.media`, and an image carries its key hex-encoded in
  // `image_item.aeskey` rather than base64 in `media.aes_key`.
  const mapped = normalizeInbound({
    from_user_id: 'wxid_abc',
    message_type: 1,
    message_state: 0,
    item_list: [
      {
        type: 2,
        image_item: {
          aeskey: '00112233445566778899aabbccddeeff',
          media: {
            encrypt_query_param: 'img-param',
            aes_key: 'aW1nLWtleQ==',
            encrypt_type: 1,
          },
          mid_size: 4096,
        },
      },
    ],
  })
  assert.equal(mapped.unsupported, undefined)
  assert.equal(mapped.type, 'image')
  assert.equal(mapped.media.length, 1)
  const [image] = mapped.media
  assert.equal(image.kind, 'image')
  assert.equal(image.encryptQueryParam, 'img-param')
  assert.equal(image.aesKey, 'aW1nLWtleQ==')
  assert.equal(image.aesKeyHex, '00112233445566778899aabbccddeeff')
  assert.equal(image.size, 4096)
})

test('normalizeInbound keeps a photo caption alongside the media item', () => {
  // WeChat sends a photo and the caption the sender typed as two items; losing
  // the text would make the agent answer a picture with no question.
  const mapped = normalizeInbound({
    from_user_id: 'wxid_abc',
    message_type: 1,
    message_state: 0,
    item_list: [
      { type: 2, image_item: { media: { encrypt_query_param: 'p' } } },
      { type: 1, text_item: { text: '这张图里是什么？' } },
    ],
  })
  assert.equal(mapped.type, 'image')
  assert.equal(mapped.text, '这张图里是什么？')
  assert.equal(mapped.media.length, 1)
})

test('normalizeInbound parses FILE, VOICE and VIDEO items with their real field shapes', () => {
  const mapped = normalizeInbound({
    from_user_id: 'wxid_abc',
    message_type: 1,
    message_state: 0,
    item_list: [
      { type: 4, file_item: { file_name: '报告.pdf', len: 1234, media: { encrypt_query_param: 'f', aes_key: 'Zg==' } } },
      { type: 3, voice_item: { media: { encrypt_query_param: 'v', aes_key: 'dg==' } } },
      { type: 5, video_item: { video_size: 999, media: { encrypt_query_param: 'vd', aes_key: 'dmlk' } } },
    ],
  })
  assert.equal(mapped.type, 'media')
  assert.deepEqual(
    mapped.media.map((m) => m.kind),
    ['file', 'voice', 'video'],
  )
  const byKind = Object.fromEntries(mapped.media.map((m) => [m.kind, m]))
  // The sender-supplied file name is carried through as metadata, but it is
  // never used as a path — src/media/inbound.js reduces it to a basename.
  assert.equal(byKind.file.fileName, '报告.pdf')
  assert.equal(byKind.file.size, 1234)
  assert.equal(byKind.voice.encryptQueryParam, 'v')
  assert.equal(byKind.video.size, 999)
})

test('normalizeInbound still returns plain text when a message is text only', () => {
  const mapped = normalizeInbound({
    from_user_id: 'wxid_abc',
    message_type: 1,
    message_state: 0,
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
  })
  assert.equal(mapped.type, 'text')
  assert.equal(mapped.text, 'hello')
  assert.equal(mapped.media, undefined)
})

test('streamText reassembles both chunk shapes and ignores reasoning', () => {
  assert.equal(
    streamText([
      { type: 'text-chunks', texts: ['a', 'b'] },
      { type: 'reasoning-chunks', texts: ['secret'] },
      { type: 'chunk', chunk: { type: 'text-delta', text: 'c' } },
      { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'nope' } },
    ]),
    'abc',
  )
})

test('readAssistantReply reads the settled reply and ignores earlier turns', () => {
  const events = [
    { type: 'user/message', seq: 0, time: 1, data: {} },
    { type: 'assistant/message', seq: 1, time: 2, data: { stream: [{ type: 'text-chunks', texts: ['old'] }] } },
    { type: 'assistant/message', seq: 2, time: 3, data: { stream: [{ type: 'text-chunks', texts: ['new'] }] } },
  ]
  const all = readAssistantReply({ events })
  assert.equal(all.text, 'new')
  assert.equal(all.settledSeq, 2)

  // afterSeq = 1 must skip the earlier settled reply.
  const skipped = readAssistantReply({ events, afterSeq: 1 })
  assert.equal(skipped.text, 'new')
  const none = readAssistantReply({ events: events.slice(0, 2), afterSeq: 1 })
  assert.equal(none.text, '')
})

test('readAssistantReply tracks in-flight tool calls', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: {} },
    { type: 'tool/call', seq: 1, time: 2, data: { callId: 'c1', name: 'bash' } },
    { type: 'tool/call', seq: 2, time: 3, data: { callId: 'c2', name: 'read' } },
    { type: 'tool/result', seq: 3, time: 4, data: { message: { source: { callId: 'c1' } } } },
  ]
  const reply = readAssistantReply({ events })
  assert.deepEqual(reply.pendingTools, ['read'])
  assert.equal(reply.sawTurnBoundary, true)
  assert.equal(describePending(reply.pendingTools), 'running: read (0s)')
  assert.equal(describePending([]), 'thinking… (0s)')
  assert.equal(describePending(['bash'], 12_000), 'running: bash (12s)')
  assert.equal(describePending(['bash'], 125_000), 'running: bash (2m05s)')
  assert.notEqual(describePending(['bash'], 1_000), describePending(['bash'], 2_000), 'the elapsed clock moves the line')
})

test('describePending reflects tool changes for streaming progress', () => {
  // A2: the bridge re-announces a CHANGED tool set. The note itself must
  // differ when the pending set changes, or no amount of re-sending in
  // #awaitReply can make the stream visible.
  assert.notEqual(describePending(['bash']), describePending(['bash', 'read']))
  assert.notEqual(describePending(['bash']), describePending(['read']))
})

test('sessionIdFor is stable and filesystem-safe', () => {
  assert.equal(sessionIdFor('wxid_abc'), 'weixin-wxid-abc')
  assert.equal(sessionIdFor('room/1@chat'), 'weixin-room-1-chat')
  assert.equal(sessionIdFor('!!!'), 'weixin-default')
})

test('MessageDeduper rejects redeliveries and stays bounded', () => {
  const dedupe = new MessageDeduper(2)
  assert.equal(dedupe.accept('a'), true)
  assert.equal(dedupe.accept('a'), false)
  assert.equal(dedupe.accept('b'), true)
  assert.equal(dedupe.accept('c'), true)
  assert.equal(dedupe.size(), 2)
  // 'a' was evicted, so it is accepted again rather than leaking memory forever.
  assert.equal(dedupe.accept('a'), true)
  // An empty id is never deduped: it cannot be recognized as a redelivery.
  assert.equal(dedupe.accept(''), true)
  assert.equal(dedupe.accept(''), true)
})

test('Weixin sessions are grouped under one directory', () => {
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-state-'))
  process.env.DSH_WEIXIN_STATE_DIR = root
  try {
    // The directory does not exist until it is asked for: a session cannot be
    // created in a missing path, so creating it is part of the contract.
    assert.equal(fs.existsSync(sessionsDir()), false)
    const created = ensureSessionsDir()
    assert.equal(created, sessionsDir())
    assert.equal(fs.statSync(created).isDirectory(), true)

    // Idempotent: every later conversation reuses the same group directory.
    assert.equal(ensureSessionsDir(), created)

    // Credentials and conversations stay in separate subtrees of the state root.
    assert.equal(path.dirname(created), root)
    assert.notEqual(accountsDir(), created)
  } finally {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a created session is filed under its workspace, and a missing registry never breaks the turn', async () => {
  const { AgentBridge } = await import('../src/agent-bridge.js')
  const attached = []
  const created = []
  const workspace = {
    id: 'ws-1',
    path: '/tmp/weixin-group',
    async attachSession(id) { attached.push(id) },
  }
  const registry = {
    calls: 0,
    async resolveByPath(p) { this.calls += 1; return p === workspace.path ? workspace : undefined },
    async create() { throw new Error('must not create an existing workspace') },
  }
  const agents = {
    get: () => undefined,
    async create({ sessionId, meta }) { created.push({ sessionId, cwd: meta.cwd }); return { agent: { inbox: { clear() {} }, session: { id: sessionId } }, dispose: async () => {} } },
  }
  const ctx = {
    get: (n) => (n === 'agents' ? agents : n === 'workspaceRegistry' ? registry : undefined),
  }
  // `lines` is injected so the bridge never reaches the on-disk session-line
  // index: this test has no state root of its own, and without this it would
  // write into the operator's real ~/.dsh/weixin/sessions.json.
  const lines = new SessionLines()
  const bridge = new AgentBridge({ ctx, cwd: workspace.path, lines })
  await bridge.attach('room-1')

  // The created session adopts the registry's own path, so the cwd the header
  // stores is exactly what attachSession will re-validate.
  assert.deepEqual(created, [{ sessionId: 'weixin-room-1', cwd: workspace.path }])
  assert.deepEqual(attached, ['weixin-room-1'])
  // The lookup is memoized: one registry round trip per plugin generation.
  assert.equal(registry.calls, 1)

  // A deployment without the registry still runs agents; grouping is optional.
  const bare = new AgentBridge({ ctx: { get: (n) => (n === 'agents' ? agents : undefined) }, cwd: '/tmp/x', lines: new SessionLines() })
  await bare.attach('room-2')
  assert.equal(created.length, 2)
})

/**
 * Run `body` with the state root pointed at a throwaway directory.
 * @param {(root: string) => void} body
 */
function withStateRoot(body) {
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-config-'))
  process.env.DSH_WEIXIN_STATE_DIR = root
  try {
    body(root)
  } finally {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('saved settings fill in what the composition did not set', () => {
  withStateRoot((root) => {
    assert.equal(configFile(), path.join(root, 'config.json'))
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ allowedSenders: ['wxid_saved'], maxMessageLength: 900 }),
    )

    // Nothing passed in: the saved file is the whole configuration.
    assert.deepEqual(withSavedConfig({}).allowedSenders, ['wxid_saved'])
    assert.equal(withSavedConfig({}).maxMessageLength, 900)

    // An explicitly composed allowlist keeps its own rule: a non-empty list
    // wins, because an empty schema default cannot be told apart from deny-all.
    const merged = withSavedConfig({ allowedSenders: ['wxid_composed'], cwd: '/tmp/work' })
    assert.deepEqual(merged.allowedSenders, ['wxid_composed'], 'the saved file overrode an explicit value')
    assert.equal(merged.cwd, '/tmp/work', 'a key only the composition set must survive')
    assert.equal(merged.maxMessageLength, 900, 'untouched saved keys must still fill in')
  })
})

test('a saved toggle outranks the schema default the loader instantiates', () => {
  withStateRoot(() => {
    // The loader validates the composition through schemastery, so apply()
    // receives every field with its schema default already filled in.
    // `proactiveEnabled` defaults to false and the card had saved true — the
    // spread merge let the default win, so the scheduler read `disabled` on
    // every tick and never planned a message (2026-10-28).
    fs.writeFileSync(configFile(), JSON.stringify({ proactiveEnabled: true, quietHoursEnabled: true }))
    const merged = withSavedConfig({ proactiveEnabled: false, quietHoursEnabled: false })
    assert.equal(merged.proactiveEnabled, true, 'the saved proactive toggle must win over the schema default')
    assert.equal(merged.quietHoursEnabled, true)
  })
})

test('a saved false beats a schema default true, and saved numbers beat defaults', () => {
  withStateRoot(() => {
    // The other direction: `memoryEnabled` defaults to true, so switching it
    // off in the card has to stick.
    fs.writeFileSync(configFile(), JSON.stringify({ memoryEnabled: false, maxMessageLength: 900 }))
    const merged = withSavedConfig({ memoryEnabled: true, maxMessageLength: 1500 })
    assert.equal(merged.memoryEnabled, false)
    assert.equal(merged.maxMessageLength, 900)
  })
})

test('an empty composition allowlist does not erase a saved one', () => {
  withStateRoot((root) => {
    fs.writeFileSync(configFile(), JSON.stringify({ allowedSenders: ['wxid_saved'] }))
    // The schemastery schema instantiates every field, so a composition that
    // never mentions allowedSenders still arrives as []. Letting that default
    // win refused every sender while config.json looked perfectly configured.
    const merged = withSavedConfig({ allowedSenders: [] })
    assert.deepEqual(
      merged.allowedSenders,
      ['wxid_saved'],
      'the schemastery default [] must not override a non-empty saved allowlist',
    )
    // An explicitly configured non-empty list still wins.
    assert.deepEqual(withSavedConfig({ allowedSenders: ['wxid_composed'] }).allowedSenders, ['wxid_composed'])
    // And an empty saved file means deny-all even against a composition default.
    fs.writeFileSync(configFile(), JSON.stringify({}))
    assert.deepEqual(withSavedConfig({ allowedSenders: [] }).allowedSenders, [])
  })
})

test('the asr section merges one level deep so editing one field keeps the rest', () => {  withStateRoot(() => {
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ asr: { hfEndpoint: 'https://mirror.example', hfProxy: 'http://127.0.0.1:7897' } }),
    )
    // The settings card writes modelDir alone; a wholesale replace would drop
    // the endpoint and the proxy, silently un-doing the download fix.
    const merged = withSavedConfig({ asr: { modelDir: '/models' } })
    assert.equal(merged.asr.modelDir, '/models')
    assert.equal(merged.asr.hfEndpoint, 'https://mirror.example')
    assert.equal(merged.asr.hfProxy, 'http://127.0.0.1:7897')
  })
})

test('a schema default cannot outrank a saved asr value', () => {  withStateRoot(() => {
    // This is the config the host actually passes: the loader validates the
    // composition through schemastery, so every asr field is present even when
    // the composition never mentioned asr — `command: ''`, `args: []`, `env: {}`.
    // Spread-merging that over the saved section erased the operator's command
    // and left the voice bridge undefined while config.json still showed it,
    // which is the whole "voice notes arrive but say no ASR bridge is
    // configured" bug (2026-10-16).
    fs.writeFileSync(
      configFile(),
      JSON.stringify({
        asr: {
          enabled: true,
          command: '/opt/asr/python3',
          args: ['bin/asr-bridge.py'],
          env: { DSH_WEIXIN_ASR_LANGUAGE: 'zh' },
        },
      }),
    )
    const hostConfig = {
      asr: {
        enabled: true,
        command: '',
        args: [],
        timeoutMs: 60000,
        env: {},
        model: '',
        modelDir: '',
        hfProxy: '',
        hfEndpoint: 'https://hf-mirror.com',
      },
    }
    const merged = withSavedConfig(hostConfig)
    assert.equal(merged.asr.command, '/opt/asr/python3', 'the empty schema default erased the saved command')
    assert.deepEqual(merged.asr.args, ['bin/asr-bridge.py'])
    assert.deepEqual(merged.asr.env, { DSH_WEIXIN_ASR_LANGUAGE: 'zh' })
    // Fields the composition really carries still win over the saved section.
    assert.equal(merged.asr.hfEndpoint, 'https://hf-mirror.com')
  })
})

test('the saved settings page outranks the composition for asr too', () => {  withStateRoot(() => {
    // `withSavedConfig` cannot tell a schema default from a value the operator
    // wrote in the plugin YAML — both arrive as plain values — so the file the
    // settings card writes is treated as the newer statement, and only its own
    // empty form falls through to the composition.
    fs.writeFileSync(configFile(), JSON.stringify({ asr: { command: '/saved/python3', timeoutMs: 45000, enabled: true } }))
    const merged = withSavedConfig({
      asr: { command: '/composed/python3', timeoutMs: 5000, model: 'mlx-community/whisper-small-mlx' },
    })
    assert.equal(merged.asr.command, '/saved/python3', "the saved file is the operator's newer statement")
    assert.equal(merged.asr.timeoutMs, 45000)
    assert.equal(merged.asr.enabled, true)
    // A saved field that is empty falls through, so a composition value survives it.
    assert.equal(merged.asr.model, 'mlx-community/whisper-small-mlx')
  })
})

test('an operator turning asr off is not mistaken for a missing field', () => {  withStateRoot(() => {
    // `false` and `0` are real values and must survive; only a schema's own
    // empty form ('', [], {}) is treated as "not set here".
    fs.writeFileSync(configFile(), JSON.stringify({ asr: { enabled: false, command: '/opt/asr/python3', timeoutMs: 0 } }))
    const merged = withSavedConfig({
      asr: { enabled: true, command: '', args: [], timeoutMs: 60000, env: {} },
    })
    assert.equal(merged.asr.enabled, false, 'a saved false was treated as empty and replaced by the schema default')
    assert.equal(merged.asr.command, '/opt/asr/python3')
    assert.equal(merged.asr.timeoutMs, 0)
  })
})

test('a missing or malformed settings file costs preferences, never the plugin', () => {
  withStateRoot(() => {
    // Missing file.
    assert.deepEqual(readSavedConfig(), {})
    assert.deepEqual(withSavedConfig({ enabled: true }), { enabled: true })

    // Malformed JSON: the plugin must still load and reply.
    fs.writeFileSync(configFile(), '{ not json')
    assert.deepEqual(readSavedConfig(), {})

    // Valid JSON that is not an object: a list cannot carry settings.
    fs.writeFileSync(configFile(), '["wxid_abc"]')
    assert.deepEqual(readSavedConfig(), {})

    fs.writeFileSync(configFile(), 'null')
    assert.deepEqual(readSavedConfig(), {})
  })
})
