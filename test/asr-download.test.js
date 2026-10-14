// Guards for the ASR model download path (src/asr-remote.js).
//
// The bug these exist for: the controller hard-coded `huggingface-cli`. On
// huggingface_hub >= 1.0 that entry point is a stub which exits 1 printing
// nothing but a "no longer works, use `hf` instead" banner — so downloads
// never ran, and the settings card reported the banner as the reason, giving
// the operator a list of CLI examples instead of a diagnosis.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import nodePath from 'node:path'
import os from 'node:os'
import http from 'node:http'

const require$path = () => nodePath

const HOST = fs.readFileSync(new URL('../src/asr-remote.js', import.meta.url), 'utf8')

// Import the real module for behavioural checks. Regex-lifting functions out of
// the source produced false passes and syntax errors repeatedly, so anything
// that can be executed is executed instead of pattern-matched.
const hostModule = await import('../src/asr-remote.js')
function requireHost() {
  return hostModule
}


// The download path is plain HTTP now, so it can be exercised directly against
// a local server instead of by pattern-matching source text. These tests drive
// the real functions; the mirror they talk to is a loopback stub, so they run
// offline and cannot flake on the network.
/** A throwaway HTTP server standing in for a model endpoint. */
async function withServer(handler, run) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  try {
    return await run(endpoint)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('the file list comes from the endpoint, not from a CLI', async () => {
  const { listRepoFiles } = await import('../src/asr-remote.js')
  await withServer(
    (req, res) => {
      assert.match(req.url, /\/api\/models\/mlx-community\/whisper-tiny-mlx$/)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ siblings: [{ rfilename: 'config.json' }, { rfilename: 'weights.npz' }] }))
    },
    async (endpoint) => {
      const files = await listRepoFiles(endpoint, 'mlx-community/whisper-tiny-mlx')
      assert.deepEqual(files, ['config.json', 'weights.npz'])
    },
  )
})

test('a repo with no files is an error, not a silent success', async () => {
  // Reporting "done" on an empty listing would leave the operator with a
  // directory the runtime cannot load and no message explaining why.
  const { listRepoFiles } = await import('../src/asr-remote.js')
  await withServer(
    (req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ siblings: [] }))
    },
    async (endpoint) => {
      await assert.rejects(() => listRepoFiles(endpoint, 'x/y'), (err) => err.code === 'repo_empty')
    },
  )
})

test('an unreachable endpoint reports the HTTP status instead of hanging', async () => {
  const { listRepoFiles } = await import('../src/asr-remote.js')
  await withServer(
    (req, res) => {
      res.statusCode = 404
      res.end('nope')
    },
    async (endpoint) => {
      await assert.rejects(() => listRepoFiles(endpoint, 'x/y'), (err) => err.code === 'repo_unavailable')
    },
  )
})

test('downloadFile streams bytes to disk and reports progress', async () => {
  // Byte counts are what the card shows now; the old code scraped tqdm output,
  // so a percentage was only as good as the CLI's redraw cadence.
  const { downloadFile } = await import('../src/asr-remote.js')
  const payload = Buffer.alloc(300_000, 7)
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dsh-weixin-dl-'))
  const readings = []
  await withServer(
    (req, res) => {
      assert.match(req.url, /\/resolve\/main\/weights\.npz$/)
      res.setHeader('content-length', String(payload.length))
      res.end(payload)
    },
    async (endpoint) => {
      const written = await downloadFile(
        endpoint,
        'x/y',
        'weights.npz',
        nodePath.join(dir, 'weights.npz'),
        (w, t) => readings.push([w, t]),
        {},
      )
      assert.equal(written, payload.length)
    },
  )
  const onDisk = fs.readFileSync(nodePath.join(dir, 'weights.npz'))
  assert.equal(onDisk.length, payload.length, 'the whole file must land, not just the first chunk')
  assert.deepEqual(onDisk, payload, 'and it must be byte-identical')
  assert.ok(readings.length > 0, 'progress must be reported')
  assert.equal(readings.at(-1)[0], payload.length, 'the last reading must be the full size')
  assert.equal(readings.at(-1)[1], payload.length, 'the total must come from content-length')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a file inside a subdirectory is fetched and written at that path', async () => {
  // Repos do nest files; a naive join would either 404 or write to the root.
  const { downloadFile } = await import('../src/asr-remote.js')
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dsh-weixin-dl-'))
  await withServer(
    (req, res) => {
      assert.match(req.url, /\/resolve\/main\/sub\/deep\.json$/, 'the slash must survive encoding')
      res.end('{}')
    },
    async (endpoint) => {
      await downloadFile(endpoint, 'x/y', 'sub/deep.json', nodePath.join(dir, 'sub', 'deep.json'))
    },
  )
  assert.equal(fs.readFileSync(nodePath.join(dir, 'sub', 'deep.json'), 'utf8'), '{}')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a missing file fails loudly rather than leaving a truncated model', async () => {
  const { downloadFile } = await import('../src/asr-remote.js')
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dsh-weixin-dl-'))
  await withServer(
    (req, res) => {
      res.statusCode = 403
      res.end('denied')
    },
    async (endpoint) => {
      await assert.rejects(
        () => downloadFile(endpoint, 'x/y', 'weights.npz', nodePath.join(dir, 'weights.npz')),
        (err) => err.code === 'file_unavailable',
      )
    },
  )
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---- endpoint configuration -------------------------------------------------
// A wrong mirror setting must fail loudly: a typo here looks exactly like the
// slow download the operator was trying to fix, so silently ignoring it would
// send them chasing the network again.
import { normalizeEndpoint } from '../src/asr-remote.js'

test('an empty endpoint means "use the official site", not an empty string', () => {
  for (const value of [undefined, null, '', '   ']) {
    assert.equal(normalizeEndpoint(value), undefined, `${JSON.stringify(value)} must mean unset`)
  }
})

test('a configured endpoint is normalized and kept', () => {
  assert.equal(normalizeEndpoint('https://hf-mirror.com'), 'https://hf-mirror.com')
  // A trailing slash would produce a doubled path when the CLI appends to it.
  assert.equal(normalizeEndpoint('https://hf-mirror.com/'), 'https://hf-mirror.com')
  assert.equal(normalizeEndpoint('  https://hf-mirror.com///  '), 'https://hf-mirror.com')
  assert.equal(normalizeEndpoint('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
})

test('a malformed endpoint is rejected rather than passed to the CLI', () => {
  assert.throws(() => normalizeEndpoint('hf-mirror.com'), /完整 URL/, 'a missing scheme must be rejected')
  assert.throws(() => normalizeEndpoint('ftp://x.com'), /http\/https/, 'a non-http scheme must be rejected')
})

test('the endpoint is passed to the HTTP downloader, not to an environment variable', () => {
  // Validation is deliberately lifted above super(), so it assigns a local
  // first; assert the contract rather than the exact statement.
  assert.match(HOST, /const hfEndpoint = normalizeEndpoint\(/, 'the controller must normalize its endpoint')
  assert.match(
    HOST,
    /this\.hfEndpoint = hfEndpoint \?\? DEFAULT_ENDPOINT;/,
    'and keep the normalized value, resolving the default once instead of leaving it undefined',
  )
  assert.match(
    HOST,
    /await listRepoFiles\(this\.hfEndpoint, repoId, \{ proxy: this\.hfProxy, signal \}\)/,
    'the listing must use the configured endpoint',
  )
  assert.match(
    HOST,
    /await downloadFile\(\s*this\.hfEndpoint,/,
    'and so must each file fetch, or a mirror setting would silently do nothing',
  )
})

test('the config schema exposes hfEndpoint and the plugin passes it through', () => {
  const index = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(
    index,
    /hfEndpoint: z\s*\.string\(\)\s*\.default\('https:\/\/hf-mirror\.com'\)/,
    'the schema must default to the mainland-reachable mirror, which needs no proxy',
  )
  assert.match(index, /hfEndpoint: config\.asr\?\.hfEndpoint\?\.trim\(\) \|\| undefined/, 'the controller must receive it')
})

test('a proxy is accepted only when the CLI could actually use it', () => {
  // A proxy that silently does not apply is worse than none: the operator sees
  // a configured field, concludes the network is fine, and waits. Reject at the
  // boundary instead of handing the CLI something it ignores.
  const { normalizeProxy } = requireHost()
  assert.equal(normalizeProxy('http://127.0.0.1:7897'), 'http://127.0.0.1:7897')
  assert.equal(normalizeProxy('  https://proxy.local:8080  '), 'https://proxy.local:8080')
  assert.equal(normalizeProxy(''), undefined, 'an empty proxy means "inherit the environment"')
  assert.equal(normalizeProxy('   '), undefined)
  assert.equal(normalizeProxy(null), undefined)
  for (const bad of ['not a url', 'socks5://127.0.0.1:1080', 'ftp://x.com']) {
    assert.throws(() => normalizeProxy(bad), (err) => err.code === 'bad_proxy', `${bad} must be rejected`)
  }
})

test('the proxy is threaded through every request, not merely stored', () => {
  // Regression risk this pins down: `hfProxy` was validated and saved but the
  // download never used it, because Node's fetch ignores proxy environment
  // variables. A configured proxy that silently does not apply is worse than
  // none -- the operator sees the field filled in and waits forever.
  assert.match(HOST, /const hfProxy = normalizeProxy\(/, 'the controller must validate the proxy')
  assert.match(HOST, /this\.hfProxy = hfProxy;/, 'and keep the normalized value')
  assert.match(
    HOST,
    /const res = await httpGet\(url, \{ proxy, signal \}\)/,
    'downloadFile must hand the proxy to httpGet',
  )
  assert.match(
    HOST,
    /await downloadFile\(\s*this\.hfEndpoint,[\s\S]*?\{ proxy: this\.hfProxy, signal \}/,
    'and the controller must pass its proxy down',
  )
  // `fetch` must be gone entirely: it cannot honour a proxy here.
  assert.ok(
    !/await fetch\(/.test(HOST),
    'fetch ignores proxy settings and has no importable ProxyAgent in the packaged app',
  )
})

test('httpGet tunnels HTTPS through the proxy with CONNECT', async () => {
  // A proxy will not forward a TLS stream as a plain absolute-URI request, so
  // this must be a CONNECT tunnel; getting it wrong looks like a proxy that
  // "does not work" for exactly the secure endpoints that matter.
  const source = HOST.slice(HOST.indexOf('function httpGet('))
  const body = source.slice(0, source.indexOf('\n}\n') + 3)
  assert.match(body, /method: "CONNECT"/, 'HTTPS through a proxy needs a CONNECT tunnel')
  assert.match(body, /tlsConnect\(\{ socket, servername: target\.hostname \}/, 'the tunnel must be wrapped in TLS')
  assert.match(body, /createConnection: \(\) => socket/, 'the TLS socket must be reused for the request')
  // The tunnel socket is ALREADY TLS. Handing it to https.request would wrap
  // it a second time and the handshake dies with "Client network socket
  // disconnected before secure TLS connection was established" -- which the
  // unit tests missed and a real 71 MB download through a real proxy caught.
  assert.match(
    body,
    /tlsConnect\(\{ socket, servername: target\.hostname \}, \(\) => send\(tls, http\)\)/,
    'the TLS socket must be driven by http.request, never https.request',
  )
  assert.ok(
    !/send\(tls, https\)/.test(body),
    'https.request on an already-TLS socket double-wraps it',
  )
  // And a refused tunnel must fail loudly instead of silently going direct.
  assert.match(body, /代理拒绝连接/, 'a non-200 CONNECT must be an error')
})

test('the tunnel actually works end to end through a live proxy stub', async () => {
  // A real CONNECT server in front of a real HTTPS target would need a
  // certificate the test cannot mint, so the stub proves the plumbing instead:
  // the request must arrive at the proxy as CONNECT, with the target named.
  const seen = []
  const proxy = http.createServer()
  // CONNECT does NOT come through the request handler: it is its own event,
  // which is exactly the trap this test exists to catch in the implementation.
  proxy.on('connect', (req, socket) => {
    seen.push(req.url)
    // Refuse the tunnel, so the call fails fast; the assertion is about what
    // was sent to the proxy, not about the tunnel succeeding.
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const port = proxy.address().port
  const { listRepoFiles } = await import('../src/asr-remote.js')
  await assert.rejects(
    () => listRepoFiles('https://example.invalid', 'x/y', { proxy: `http://127.0.0.1:${port}` }),
    /代理|CONNECT|socket|ECONN/i,
  )
  proxy.close()
  assert.equal(seen.length, 1, 'the proxy must be contacted exactly once')
  assert.ok(
    seen[0].includes('example.invalid:443'),
    `the CONNECT must name the real target, got ${seen[0]}`,
  )
})

test('the proxy reaches AsrController from the plugin config', () => {
  const index = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(index, /hfProxy: config\.asr\?\.hfProxy/, 'config.asr.hfProxy must be passed through')
  assert.match(index, /hfProxy: z\s*\n\s*\.string\(\)/, 'the schema must declare hfProxy')
})

test('a bad proxy is rejected at construction, before the service registers', async () => {
  // Regression: validation used to run AFTER super(). A throw there is caught
  // by src/index.js, which only warns "ASR service unavailable" and drops the
  // controller -- so a typo in hfProxy silently removed the whole feature, and
  // the operator saw "no model available" with no hint that their config was
  // wrong. Validate first, so the real reason surfaces.
  const { Context } = await import('@deepseek-ai/cordis')
  const { AsrController } = await import('../src/asr-remote.js')

  // The validation must not need a working ctx: if it ran after super(), the
  // service would already be registered by the time it threw. Proving it
  // throws on a BARE context -- before any registration can succeed -- pins
  // the order.
  class BareContext {}

  for (const [label, options, code] of [
    ['unparseable proxy', { hfProxy: 'nope' }, 'bad_proxy'],
    ['proxy with an unusable scheme', { hfProxy: 'socks5://127.0.0.1:1080' }, 'bad_proxy'],
    ['unparseable endpoint', { hfEndpoint: 'not a url' }, 'bad_endpoint'],
  ]) {
    assert.throws(
      () => new AsrController(new BareContext(), options),
      (err) => {
        assert.equal(err.code, code, `${label}: a bare ctx means super() was never reached`)
        return true
      },
      `${label} must be rejected before the service is registered`,
    )
  }

  // And a valid one registers normally on a real context.
  const controller = new AsrController(new Context(), { hfProxy: 'http://127.0.0.1:7897' })
  assert.equal(controller.hfProxy, 'http://127.0.0.1:7897')
  // Not undefined: the endpoint is resolved at construction so the card can
  // name the route it is reporting. An undefined endpoint classified as
  // "custom" and the radio group would claim a route nobody chose.
  assert.equal(controller.hfEndpoint, 'https://hf-mirror.com')
})

test('an unparseable proxy never reaches the spawn environment', async () => {
  // The failure mode to prevent is not "an error is shown" but "a value the
  // CLI cannot use is passed along and the download silently ignores it".
  const { normalizeProxy } = await import('../src/asr-remote.js')
  for (const bad of ['nope', 'not a url', 'socks5://127.0.0.1:1080', 'ftp://x.com']) {
    assert.throws(() => normalizeProxy(bad), (err) => err.code === 'bad_proxy', `${bad} must not be accepted`)
  }
})

test('the download route survives a restart, and an explicit config still wins', async () => {
  // Losing this choice on every restart is invisible: the download keeps
  // working, just from the wrong place, and on a blocked network "wrong place"
  // means it never starts.
  const { Context } = await import('@deepseek-ai/cordis')
  const { AsrController, sourceForEndpoint } = await import('../src/asr-remote.js')

  const previous = process.env.DSH_WEIXIN_STATE_DIR
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dsh-weixin-route-'))
  process.env.DSH_WEIXIN_STATE_DIR = root
  try {
    const first = new AsrController(new Context(), {})
    // No config value: the built-in default, which is the mirror.
    assert.equal(first.hfEndpoint, 'https://hf-mirror.com')
    assert.equal(first.hfProxy, undefined)

    const after = await first.setDownloadSettings('https://huggingface.co', 'http://127.0.0.1:7897')
    assert.equal(after.endpoint, 'https://huggingface.co')
    assert.equal(after.proxy, 'http://127.0.0.1:7897')
    assert.equal(after.source, 'official')
    assert.equal(first.hfEndpoint, 'https://huggingface.co', 'the running instance must apply it too')

    // A fresh instance -- i.e. after a restart -- reads the saved route.
    const restarted = new AsrController(new Context(), {})
    assert.equal(restarted.hfEndpoint, 'https://huggingface.co')
    assert.equal(restarted.hfProxy, 'http://127.0.0.1:7897')
    assert.equal((await restarted.getDownloadSettings()).source, 'official')

    // But an explicit composition value still wins: the profile YAML is the
    // live decision, and a stale saved file must not overrule it.
    const composed = new AsrController(new Context(), { hfEndpoint: 'https://hf-mirror.com' })
    assert.equal(composed.hfEndpoint, 'https://hf-mirror.com')
  } finally {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('clearing the proxy really clears it, and saving one setting keeps the other', async () => {
  // Two ways to lose a setting by accident: a save that writes only the field
  // it was given (dropping the proxy when the source changes), and a "direct"
  // choice that leaves the old proxy in force.
  const { Context } = await import('@deepseek-ai/cordis')
  const { AsrController } = await import('../src/asr-remote.js')

  const previous = process.env.DSH_WEIXIN_STATE_DIR
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dsh-weixin-route-'))
  process.env.DSH_WEIXIN_STATE_DIR = root
  try {
    const controller = new AsrController(new Context(), {})
    await controller.setDownloadSettings('https://huggingface.co', 'http://127.0.0.1:7897')

    // The source change sends an empty proxy on purpose (see chooseSource): an
    // empty string must mean "clear", not "leave whatever was there".
    const cleared = await controller.setDownloadSettings('https://hf-mirror.com', '')
    assert.equal(cleared.proxy, '', 'an empty proxy must clear the saved one')
    assert.equal(cleared.source, 'mirror')
    assert.equal(new AsrController(new Context(), {}).hfProxy, undefined, 'and stay cleared after a restart')

    // Now set a proxy and change only the endpoint: the proxy must survive,
    // and vice versa.
    await controller.setDownloadSettings('https://huggingface.co', 'http://127.0.0.1:7897')
    const changed = await controller.setDownloadSettings('https://hf-mirror.com')
    assert.equal(changed.proxy, 'http://127.0.0.1:7897', 'the untouched field must survive')

    const reverted = await controller.getDownloadSettings()
    assert.equal(reverted.endpoint, 'https://hf-mirror.com')
    assert.equal(reverted.proxy, 'http://127.0.0.1:7897')
  } finally {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the endpoint the card labels "mirror" is the one the host actually defaults to', async () => {
  // The card hardcodes the two endpoint URLs to label the radio group. If the
  // host default ever moves, the card would claim "mirror" while downloading
  // from somewhere else -- a choice that lies about what it selected.
  const { sourceForEndpoint, MIRROR_ENDPOINT, OFFICIAL_ENDPOINT, defaultEndpoint } = await import(
    '../src/asr-remote.js'
  )
  const client = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

  assert.equal(sourceForEndpoint(MIRROR_ENDPOINT), 'mirror')
  assert.equal(sourceForEndpoint(OFFICIAL_ENDPOINT), 'official')
  assert.equal(sourceForEndpoint('https://internal.example/hf'), 'custom')
  // Trailing slashes must not change the answer: the host strips them.
  assert.equal(sourceForEndpoint(`${MIRROR_ENDPOINT}/`), 'mirror')

  const { Context } = await import('@deepseek-ai/cordis')
  const { AsrController } = await import('../src/asr-remote.js')
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dsh-weixin-route-'))
  process.env.DSH_WEIXIN_STATE_DIR = root
  try {
    assert.equal(new AsrController(new Context(), {}).hfEndpoint, MIRROR_ENDPOINT)
  } finally {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
  void defaultEndpoint

  // The URLs the card offers must match the constants the host classifies by.
  for (const endpoint of [MIRROR_ENDPOINT, OFFICIAL_ENDPOINT]) {
    assert.ok(
      client.includes(`endpoint: "${endpoint}"`),
      `the card must offer ${endpoint} so its label matches the host's own classification`,
    )
  }
})

test('the host method takes one argument per declared parameter, in order', async () => {
  // The gateway builds the call as
  //   args = descriptor.parameters.map((p) => resolveParameter(p, request.args, endpoint))
  //   implementation(...args)
  // so a descriptor declaring two parameters calls the method with two
  // POSITIONAL arguments. A method written as `setDownloadSettings(input)`
  // receives the endpoint string as `input`, every `input.x` reads undefined,
  // and the call still "succeeds" -- writing nothing, reporting nothing.
  const { Context } = await import('@deepseek-ai/cordis')
  const { AsrController } = await import('../src/asr-remote.js')

  const previous = process.env.DSH_WEIXIN_STATE_DIR
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dsh-weixin-route-'))
  process.env.DSH_WEIXIN_STATE_DIR = root
  try {
    const controller = new AsrController(new Context(), {})

    // Called exactly the way the gateway calls it: positionally, per parameter.
    const applied = await controller.setDownloadSettings('https://huggingface.co', 'http://127.0.0.1:7897')
    assert.equal(controller.hfEndpoint, 'https://huggingface.co', 'the first positional argument is the endpoint')
    assert.equal(controller.hfProxy, 'http://127.0.0.1:7897', 'the second is the proxy')
    assert.equal(applied.source, 'official')
  } finally {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the declared parameter count matches the host method signature', async () => {
  // The guard above proves the behaviour; this pins the ARITY, so a descriptor
  // that grows a third parameter while the method keeps two fails here rather
  // than at runtime with a silently-ignored argument.
  const client = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const host = fs.readFileSync(new URL('../src/asr-remote.js', import.meta.url), 'utf8')

  const declared = client.match(
    /method: "setDownloadSettings",[\s\S]*?parameters: \[([\s\S]*?)\],\n\s*result:/,
  )
  assert.ok(declared, 'setDownloadSettings must keep its descriptor')
  const wires = [...declared[1].matchAll(/wire: "(\w+)"/g)].map((m) => m[1])
  assert.deepEqual(wires, ['endpoint', 'proxy'], 'the wire fields are the argument names')

  const signature = host.match(/async setDownloadSettings\(([^)]*)\)/)
  assert.ok(signature, 'setDownloadSettings must stay an async method')
  const params = signature[1].split(',').map((s) => s.trim()).filter((s) => s && !s.includes('='))
  assert.deepEqual(
    params,
    wires,
    'the host signature must take exactly the declared parameters, positionally',
  )
})
