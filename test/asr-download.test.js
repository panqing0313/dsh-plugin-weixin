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
  assert.match(HOST, /this\.hfEndpoint = hfEndpoint;/, 'and keep the normalized value')
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
  assert.equal(controller.hfEndpoint, undefined)
})

test('an unparseable proxy never reaches the spawn environment', async () => {
  // The failure mode to prevent is not "an error is shown" but "a value the
  // CLI cannot use is passed along and the download silently ignores it".
  const { normalizeProxy } = await import('../src/asr-remote.js')
  for (const bad of ['nope', 'not a url', 'socks5://127.0.0.1:1080', 'ftp://x.com']) {
    assert.throws(() => normalizeProxy(bad), (err) => err.code === 'bad_proxy', `${bad} must not be accepted`)
  }
})
