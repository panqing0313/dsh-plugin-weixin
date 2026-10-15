/**
 * Behavioural guards for the two defects behind "the phone says bound, but
 * WeChat still says it cannot reach openclaw".
 *
 * Both are about the loop that actually receives messages, not about the login:
 *
 *  1. `resolveAccount()` ran once, when the plugin loaded. On a fresh install
 *     that is *before* the operator scans — there is no credential on disk yet —
 *     so the effect returned early and nothing ever started the inbound
 *     `getUpdates` loop. The phone showed the bot as bound, the settings card
 *     showed it as bound, and WeChat still reported "暂时无法连接 openclaw"
 *     because nothing on this host was polling. The fix is the
 *     `onAccountBound` hook: a completed login brings the loop up for the
 *     credential that now exists.
 *
 *  2. The transport sent `ilink_user_id: ''` to `getConfig`, which answers
 *     `{ret:-2,"ilink_user_id required"}`. `getConfig` does not treat a non-zero
 *     `ret` as an error and the caller only looked for a missing
 *     `typing_ticket`, so the failure was invisible: no typing ticket, and no
 *     fallback context token for replies that arrive without one.
 *
 * Everything here runs against a fake iLink server and a throwaway state root;
 * no network and no real credential is ever touched (see `withStateRoot`).
 * @module dsh-weixin/test/inbound-loop-start
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const ACCOUNT_ID = 'bot1'
const ALLOWED = 'wxid_abc'
const OPERATOR = 'me@im.wechat'

// The vendored logger resolves its directory when it is first imported — and
// src/index.js pulls it in — so it has to be redirected before that import, or
// these tests would append their trace to the operator's real log.
const LOG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-loop-logs-'))
const previousLogDir = process.env.DSH_WEIXIN_LOG_DIR
process.env.DSH_WEIXIN_LOG_DIR = LOG_ROOT

const roots = []

after(() => {
  if (previousLogDir === undefined) delete process.env.DSH_WEIXIN_LOG_DIR
  else process.env.DSH_WEIXIN_LOG_DIR = previousLogDir
  fs.rmSync(LOG_ROOT, { recursive: true, force: true })
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

/**
 * Stop a fake server without waiting for its idle keep-alive sockets.
 *
 * `server.close()` only stops accepting new connections; a socket the client
 * parked after its last reply keeps the callback pending for the whole
 * keep-alive window, which made the re-bind test sit for three seconds after
 * its assertions had already passed.
 */
function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  })
}

/** Poll `check` until it is true, or fail with `what` after `timeoutMs`. */
async function waitFor(check, what, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** Let the already-scheduled work run, so a *lack* of activity can be asserted. */
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A fake iLink endpoint that records what the plugin actually asked for.
 *
 * `getconfig` mirrors the real server: the typing ticket is only handed out when
 * the request carries an `ilink_user_id`. The response is delayed a little so a
 * transport that was stopped mid-poll leaves an observable closed socket rather
 * than a request that quietly completed.
 */
async function startFakeILink() {
  const seen = { getupdates: 0, getconfigBodies: [], sendtypingBodies: [], aborted: 0 }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      res.setHeader('content-type', 'application/json')
      if (url.pathname === '/ilink/bot/getconfig') {
        const parsed = body ? JSON.parse(body) : {}
        seen.getconfigBodies.push(parsed)
        if (!parsed.ilink_user_id) return res.end(JSON.stringify({ ret: -2, errmsg: 'ilink_user_id required' }))
        return res.end(JSON.stringify({ ret: 0, typing_ticket: 'TT' }))
      }
      if (url.pathname === '/ilink/bot/sendtyping') {
        seen.sendtypingBodies.push(JSON.parse(body))
        return res.end(JSON.stringify({ ret: 0 }))
      }
      if (url.pathname === '/ilink/bot/getupdates') {
        seen.getupdates += 1
        res.on('close', () => { if (!res.writableEnded) seen.aborted += 1 })
        setTimeout(() => {
          if (res.writableEnded || res.destroyed) return
          res.end(JSON.stringify({ ret: 0, get_updates_buf: 'buf', longpolling_timeout_ms: 50, msgs: [] }))
        }, 50)
        return
      }
      res.end(JSON.stringify({ ret: 0 }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}`, seen }
}

/**
 * Point the plugin at a throwaway state root.
 *
 * The vendored account store reads OPENCLAW_STATE_DIR, which `apply()` sets from
 * this module's own override, so the setup has to be identical — and the result
 * is verified, because the last time this was assumed the suite deleted the
 * operator's real account (see test/logout.test.js).
 */
function withStateRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-loop-'))
  roots.push(root)
  process.env.DSH_WEIXIN_STATE_DIR = root
  return root
}

/** Write a saved account, as a completed login would. */
function seedAccount(root, { accountId = ACCOUNT_ID, token = 'tok-1', baseUrl }) {
  const accounts = path.join(root, 'openclaw-weixin', 'accounts')
  fs.mkdirSync(accounts, { recursive: true })
  fs.writeFileSync(path.join(accounts, `${accountId}.json`), JSON.stringify({ token, baseUrl, userId: OPERATOR }), { mode: 0o600 })
  fs.writeFileSync(path.join(root, 'openclaw-weixin', 'accounts.json'), JSON.stringify([accountId]))
}

/**
 * The fake host the plugin is applied to.
 *
 * Two details are load-bearing, because both are places where the real host
 * silently disabled the wiring this file exists to protect:
 *
 *  - `reflect.provide` is how a Cordis `Service` registers itself in its own
 *    constructor. That is the whole registration, so this harness records the
 *    instances there and never treats `plugin()` as the mount point.
 *  - `plugin()` must reject what the real one rejects. Cordis accepts only a
 *    function or an object with `apply`, so handing it a service instance throws
 *    "invalid plugin ... received object". This harness used to just record the
 *    instance, which is exactly why the shipped bug survived the suite: the
 *    plugin wrapped that call in a try/catch, swallowed the throw, and dropped
 *    the login controller on the floor.
 */
function makeCtx() {
  const disposers = []
  const lines = []
  const plugins = []
  const provided = []
  const ctx = {
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    effect(fn) {
      disposers.push(fn())
      return { dispose() {} }
    },
    reflect: {
      provide(name, self) {
        provided.push({ name, self })
        return () => {}
      },
    },
    plugin(instance) {
      if (typeof instance !== 'function' && typeof instance?.apply !== 'function') {
        throw new Error(`invalid plugin, expect function or object with an "apply" method, received ${typeof instance}`)
      }
      plugins.push(instance)
      return instance
    },
    get: (name) => (name === 'agents' ? { get: () => undefined, resume: async () => ({ agent: {}, dispose: async () => {} }) } : undefined),
  }
  return { ctx, disposers, lines, plugins, provided }
}

/** The mounted login service; identified by what it does, not by its name. */
function loginService(provided) {
  return provided.find((entry) => typeof entry.self?.startLogin === 'function')?.self
}

/**
 * Apply the plugin against a fake host and a throwaway state root, run `body`,
 * then dispose the plugin exactly as the host would.
 * @param {(helpers: {root: string, lines: string[], provided: object[], server: object}) => Promise<void>} body
 */
async function withPlugin(body) {
  const root = withStateRoot()
  const previousStateDir = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = root
  const { server, baseUrl, seen } = await startFakeILink()
  const { ctx, disposers, lines, plugins, provided } = makeCtx()
  const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
  try {
    plugin.apply(ctx, plugin.Config({ allowedSenders: [ALLOWED] }))
    await body({ root, lines, plugins, provided, seen, baseUrl })
  } finally {
    for (const disposer of disposers) await (await disposer)?.()
    await closeServer(server)
    if (previousStateDir === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previousStateDir
  }
}

test('a credential saved after load starts the inbound loop without a reload', async () => {
  await withPlugin(async ({ root, lines, provided, seen, baseUrl }) => {
    // The fresh-install state: the plugin loads before the operator scans.
    await settle()
    assert.equal(seen.getupdates, 0, 'with no credential on disk nothing may poll — there is no token to poll with')
    assert.ok(
      lines.some((line) => /no Weixin account is saved/.test(line)),
      'the reason must be in the log, not just implied by silence',
    )
    assert.ok(
      !lines.some((line) => /settings login service unavailable/.test(line)),
      'mounting the login service must not fail — that warning means the instance was dropped and its hook never wired',
    )

    const controller = loginService(provided)
    assert.ok(controller, 'the login service must be mounted, or a finished scan has nothing to report to')

    // The operator scans; the credential lands on disk.
    seedAccount(root, { baseUrl })
    controller.onAccountBound()
    await waitFor(() => seen.getupdates > 0, 'the inbound loop to start after the login')
    assert.ok(
      lines.some((line) => line.includes(`listening as account ${ACCOUNT_ID}`)),
      'the operator must be able to see that listening started',
    )
  })
})

test('a re-bind moves the running loop to the new credential', async () => {
  await withPlugin(async ({ root, lines, provided, seen, baseUrl }) => {
    seedAccount(root, { baseUrl })
    await waitFor(() => seen.getupdates > 0, 'the loop to start for the credential present at load')

    // The operator logs out and scans again: the account record now points at a
    // different iLink host, which is what a redirect during a scan produces.
    const second = await startFakeILink()
    try {
      seedAccount(root, { baseUrl: second.baseUrl, token: 'tok-2' })
      loginService(provided).onAccountBound()
      await waitFor(() => second.seen.getupdates > 0, 'the loop to come up on the new credential')

      const settled = seen.getupdates
      await settle()
      assert.equal(
        seen.getupdates,
        settled,
        'the transport for the replaced credential must be stopped: two live long-polls on one credential split the inbound queue',
      )
      assert.equal(
        lines.filter((line) => line.includes(`listening as account ${ACCOUNT_ID}`)).length,
        2,
        'the swap must be reported once for each credential',
      )
    } finally {
      await closeServer(second.server)
    }
  })
})

test('the same credential twice does not blink the connection', async () => {
  await withPlugin(async ({ root, lines, provided, seen, baseUrl }) => {
    seedAccount(root, { baseUrl })
    await waitFor(() => seen.getupdates > 0, 'the loop to start')
    const before = seen.getupdates

    // A re-scan that lands on the same credential is the common case when the
    // server hands back what it already gave out.
    loginService(provided).onAccountBound()
    await settle()

    assert.ok(
      lines.some((line) => /is already being listened to/.test(line)),
      'a redundant restart must be recognised, not performed',
    )
    assert.equal(
      lines.filter((line) => line.includes(`listening as account ${ACCOUNT_ID}`)).length,
      1,
      'the loop must not be torn down and rebuilt for a credential it already holds',
    )
    assert.ok(seen.getupdates > before, 'and the original loop must still be polling')
  })
})

test('the transport carries the operator id, so getConfig returns a typing ticket', async () => {
  const root = withStateRoot()
  const previousStateDir = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = root
  const { server, baseUrl, seen } = await startFakeILink()
  try {
    const { ILinkTransport } = await import('../src/transport/ilink.js')

    // The regression: an empty id made the server answer
    // {ret:-2,"ilink_user_id required"}, which getConfig does not raise on, so
    // the failure was silent and the ticket was simply never set.
    const blind = new ILinkTransport({ accountId: ACCOUNT_ID, baseUrl, token: 'tok', log() {}, errLog() {} })
    await blind.refreshConfig()
    assert.equal(seen.getconfigBodies.length, 0, 'an account with no operator id must not ask for a ticket it cannot be given')
    await blind.setTyping(true, OPERATOR)
    assert.equal(seen.sendtypingBodies.length, 0, 'with no ticket there is nothing to send')

    const transport = new ILinkTransport({ accountId: ACCOUNT_ID, baseUrl, token: 'tok', userId: OPERATOR, log() {}, errLog() {} })
    await transport.refreshConfig()
    assert.equal(seen.getconfigBodies.at(-1).ilink_user_id, OPERATOR, 'the id has to travel with the request')

    // The ticket doubles as the fallback context token for replies that arrive
    // without one, so a missing ticket is not only a missing typing indicator.
    await transport.setTyping(true, OPERATOR)
    assert.equal(seen.sendtypingBodies.at(-1).typing_ticket, 'TT')
    await transport.setTyping(false, OPERATOR)
    assert.equal(seen.sendtypingBodies.at(-1).ilink_user_id, OPERATOR)
  } finally {
    await closeServer(server)
    if (previousStateDir === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previousStateDir
  }
})
