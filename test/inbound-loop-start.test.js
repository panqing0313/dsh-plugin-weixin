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
 * Stop a fake server without waiting out its keep-alive window.
 *
 * `server.close()` only stops accepting new connections; it still waits for
 * live sockets, and the client parks its connections until the keep-alive
 * window expires. That cost three seconds of teardown in two tests, after
 * their assertions had already passed. `closeAllConnections()` is the only
 * deterministic way to release them: `closeIdleConnections()` misses a socket
 * whose long-poll is still in flight at that instant, and the response only
 * lands afterwards — by which time nothing is left to reap it. Reaping on a
 * timer instead worked, but only sometimes: which test stalled varied between
 * runs.
 *
 * Destroying sockets this bluntly is safe only because this runs *after* the
 * plugin is disposed (see withPlugin), so the transport has stopped and is no
 * longer mid-request. Earlier, when the re-bind test closed its second server
 * from inside the test body while the transport was still polling it, undici
 * failed its own `writeH1` with `Error: setTypeOfService EINVAL` (`node:net` →
 * `Socket.setTypeOfService`) on the destroyed socket. That surfaced as "A
 * resource generated asynchronous activity after the test ended" and turned
 * this file red roughly 1 run in 20, with nothing wrong in the code under test.
 * The ordering is the fix, not the destructiveness.
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
 *
 * Servers are closed only AFTER the plugin is disposed, and `registerServer`
 * exists so a test that starts a second server mid-body does not have to close
 * it itself. Closing one while the transport is still polling it leaves that
 * in-flight long-poll to run to completion, which cost the re-bind test three
 * seconds of teardown after its assertions had already passed.
 *
 * @param {(helpers: {root: string, lines: string[], provided: object[], seen: object, baseUrl: string, registerServer: (server: object) => void}) => Promise<void>} body
 */
async function withPlugin(body) {
  const root = withStateRoot()
  const previousStateDir = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = root
  const { server, baseUrl, seen } = await startFakeILink()
  const servers = [server]
  const { ctx, disposers, lines, plugins, provided } = makeCtx()
  const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
  try {
    plugin.apply(ctx, plugin.Config({ allowedSenders: [ALLOWED] }))
    await body({
      root,
      lines,
      plugins,
      provided,
      seen,
      baseUrl,
      registerServer: (extra) => servers.push(extra),
    })
  } finally {
    for (const disposer of disposers) await (await disposer)?.()
    for (const target of servers.reverse()) await closeServer(target)
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
  await withPlugin(async ({ root, lines, provided, seen, baseUrl, registerServer }) => {
    seedAccount(root, { baseUrl })
    await waitFor(() => seen.getupdates > 0, 'the loop to start for the credential present at load')

    // The operator logs out and scans again: the account record now points at a
    // different iLink host, which is what a redirect during a scan produces.
    // Registered rather than closed here: the transport keeps long-polling it
    // until the plugin is disposed at the end of withPlugin.
    const second = await startFakeILink()
    registerServer(second.server)
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

test('two saved accounts are both listened to, on their own servers', async () => {
  await withPlugin(async ({ root, lines, provided, seen, baseUrl, registerServer }) => {
    // Account 1 was seeded before load and is already polling when account 2
    // appears. The second account gets its own fake server, so "both are being
    // served" is observable per account, not just as a global request count.
    seedAccount(root, { baseUrl })
    await waitFor(() => seen.getupdates > 0, 'the first account loop to start')

    const second = await startFakeILink()
    registerServer(second.server)
    seedAccount(root, { accountId: 'bot2', token: 'tok-2', baseUrl: second.baseUrl })
    seedAccount(root, { baseUrl }) // reseed so accounts.json lists both, in order

    // A login completing on the card reports the account it bound; only that
    // account's loop may be (re-)armed.
    loginService(provided).onAccountBound('bot2')

    await waitFor(() => second.seen.getupdates > 0, 'the second account loop to start')
    assert.ok(
      lines.some((line) => line.includes('listening as account bot2')),
      'the second account must be reported as listening',
    )
    const firstBefore = seen.getupdates
    await settle()
    assert.ok(seen.getupdates > firstBefore, 'the first account must keep polling after the second came up')
    assert.ok(
      !lines.some((line) => /could not start the loop/.test(line)),
      'one account coming up must not be reported as a failure',
    )
  })
})

test('a completed login re-arms only the account that bound', async () => {
  await withPlugin(async ({ root, lines, provided, seen, baseUrl, registerServer }) => {
    seedAccount(root, { baseUrl })
    await waitFor(() => seen.getupdates > 0, 'the first account loop to start')

    const second = await startFakeILink()
    registerServer(second.server)
    seedAccount(root, { accountId: 'bot2', token: 'tok-2', baseUrl: second.baseUrl })
    seedAccount(root, { baseUrl })

    loginService(provided).onAccountBound('bot2')
    await waitFor(() => second.seen.getupdates > 0, 'the second account loop to start')

    // The regression this pins: a bare onAccountBound() (no account) would
    // resolve *every* saved account and tear bot1's live transport down and
    // back up — a blink the operator experiences as the bot going unreachable.
    const firstBefore = seen.getupdates
    const secondBefore = second.seen.getupdates
    await settle(300)
    assert.ok(seen.getupdates > firstBefore, 'bot1 must still be polling')
    assert.ok(second.seen.getupdates > secondBefore, 'bot2 must still be polling')
    assert.equal(
      lines.filter((line) => line.includes('listening as account bot1')).length,
      1,
      'bot1 must not be torn down and rebuilt by a login that did not touch it',
    )
  })
})

test('pausing an account stops its polling now, without touching other accounts', async () => {
  await withPlugin(async ({ root, lines, provided, seen, baseUrl, registerServer }) => {
    seedAccount(root, { baseUrl })
    const second = await startFakeILink()
    registerServer(second.server)
    seedAccount(root, { accountId: 'bot2', token: 'tok-2', baseUrl: second.baseUrl })

    // seedAccount writes a single-entry index, so bring bot2 up the way a
    // completed login would — same path, same code under test.
    await waitFor(() => seen.getupdates > 0, 'bot1 to start polling')
    loginService(provided).onAccountBound('bot2')
    await waitFor(() => second.seen.getupdates > 0, 'bot2 to start polling')

    const { setAccountPaused } = await import(path.join(PROJECT_ROOT, 'src', 'account-registry.js'))
    setAccountPaused('bot1', true)
    loginService(provided).onAccountControlChange('bot1')
    await waitFor(
      () => lines.some((line) => line.includes(`account ${ACCOUNT_ID} paused; its inbound loop is stopped`)),
      'the pause to be reported',
    )
    const firstBefore = seen.getupdates
    const secondBefore = second.seen.getupdates
    await settle(300)
    assert.equal(seen.getupdates, firstBefore, 'a paused account must stop polling immediately')
    assert.ok(second.seen.getupdates > secondBefore, 'pausing bot1 must not touch bot2')
  })
})

test('a paused account gets no loop on bring-up; resuming brings it back without a reload', async () => {
  await withPlugin(async ({ root, lines, provided, seen, baseUrl }) => {
    const { setAccountPaused } = await import(path.join(PROJECT_ROOT, 'src', 'account-registry.js'))
    seedAccount(root, { baseUrl })
    setAccountPaused(ACCOUNT_ID, true)

    // The plugin applied before the account existed; re-arm through the same
    // bring-up path a load takes, and resolveAccounts must see the paused
    // flag and refuse — deliberately, and loudly enough to tell apart from a
    // broken loop.
    loginService(provided).onAccountBound(ACCOUNT_ID)
    await waitFor(
      () => lines.some((line) => line.includes(`account "${ACCOUNT_ID}" is paused; not starting its loop`)),
      'the deliberate silence to be distinguishable from breakage in the log',
    )
    await settle()
    assert.equal(seen.getupdates, 0, 'a paused account must not poll')

    setAccountPaused(ACCOUNT_ID, false)
    loginService(provided).onAccountControlChange(ACCOUNT_ID)
    await waitFor(() => seen.getupdates > 0, 'resuming to bring the loop back')
    assert.ok(
      lines.some((line) => line.includes(`listening as account ${ACCOUNT_ID}`)),
      'the resume must be reported like any other bring-up',
    )
  })
})

/**
 * A fake iLink endpoint that hands out queued inbound messages, then polls
 * empty — the minimal shape for proving what the allowlist does to a real
 * message travelling the real dispatch path (normalizeInbound → handler).
 *
 * Messages are queued explicitly by the test rather than regenerated on every
 * poll. Regenerating them stopped being harmless once the transport stopped
 * awaiting a turn inside its poll loop: the loop now goes straight back to
 * polling, so a server that answers every poll with a fresh message grows a
 * turn queue (16k entries in one measurement) that never drains, and the
 * dispose that waits for it never returns.
 */
async function startQueuedMessageServer() {
  const seen = { getupdates: 0 }
  const queue = []
  let counter = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      res.setHeader('content-type', 'application/json')
      if (url.pathname === '/ilink/bot/getconfig') {
        const parsed = body ? JSON.parse(body) : {}
        if (!parsed.ilink_user_id) return res.end(JSON.stringify({ ret: -2, errmsg: 'ilink_user_id required' }))
        return res.end(JSON.stringify({ ret: 0, typing_ticket: 'TT' }))
      }
      if (url.pathname === '/ilink/bot/getupdates') {
        seen.getupdates += 1
        // Answered after a beat, like a long poll that had nothing to report:
        // without it the loop spins as fast as the socket allows (thousands of
        // polls per second) and every push/poll assertion becomes a coin flip.
        const msgs = queue.splice(0, queue.length)
        setTimeout(() => {
          // A poll that dies before its body lands must not swallow the
          // message: the transport being replaced can still have one request in
          // flight, and losing a message there is what made this test depend on
          // which transport happened to ask first. A real server would hand the
          // message to whoever polls next.
          if (res.writableEnded || res.destroyed) {
            queue.unshift(...msgs)
            return
          }
          // The client's own deadline for a round is the `longpolling_timeout_ms`
          // the server last advertised, so this pause has to stay well inside
          // it: answering at the deadline made every round time out client-side,
          // and the message in that body was never seen.
          res.end(JSON.stringify({ ret: 0, get_updates_buf: 'buf', longpolling_timeout_ms: 200, msgs }))
        }, 10)
        return
      }
      res.end(JSON.stringify({ ret: 0 }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    seen,
    /** Queue one inbound text message from the globally allowed sender. */
    push() {
      counter += 1
      queue.push({
        message_id: `mid-${counter}`,
        message_state: 0,
        from_user_id: ALLOWED,
        group_id: '',
        context_token: 'ctx-1',
        item_list: [{ type: 1, text_item: { text: 'hello' } }],
      })
      return counter
    },
  }
}

test('an account-level allowlist override narrows only that account', async () => {
  await withPlugin(async ({ root, lines, provided, seen, baseUrl, registerServer }) => {
    const { setAccountAllowlist } = await import(path.join(PROJECT_ROOT, 'src', 'account-registry.js'))

    seedAccount(root, { baseUrl })
    await waitFor(() => seen.getupdates > 0, 'bot1 to start polling')

    // Both accounts get a server of their own: the refusal and the acceptance
    // both have to be observable per account, so the message has to actually
    // arrive at each. Redirecting an account's record at a new fake server is
    // the same shape a re-bind produces.
    const first = await startQueuedMessageServer()
    const second = await startQueuedMessageServer()
    registerServer(first.server)
    registerServer(second.server)
    seedAccount(root, { baseUrl: first.baseUrl, token: 'tok-1b' })
    seedAccount(root, { accountId: 'bot2', token: 'tok-2', baseUrl: second.baseUrl })
    seedAccount(root, { baseUrl: first.baseUrl, token: 'tok-1b' })
    loginService(provided).onAccountControlChange(ACCOUNT_ID)
    await waitFor(() => first.seen.getupdates > 0, 'bot1 to come up on its own server')
    loginService(provided).onAccountBound('bot2')
    await waitFor(() => second.seen.getupdates > 0, 'bot2 to come up on its own server')

    // bot1's override omits the globally-allowed sender entirely. The message is
    // queued only after the re-arm, so it is judged by the override and not by
    // whatever the effective list was when the loop came up.
    setAccountAllowlist('bot1', ['someone-else'], undefined)
    const listening = () => lines.filter((line) => line.includes(`listening as account ${ACCOUNT_ID}`)).length
    const listeningBefore = listening()
    loginService(provided).onAccountControlChange(ACCOUNT_ID)
    // Wait for the RE-ARMED transport, not merely for a poll: the replaced one
    // may still have a request in flight, and a message it grabs was judged by
    // whatever allowlist was in effect before the override was written — that
    // race made this test fail about one run in three.
    await waitFor(() => listening() > listeningBefore, 'bot1 to be re-armed on the new allowlist')
    first.push()
    await waitFor(
      () => lines.some((line) => line.includes(`refused message from ${ALLOWED}`)),
      'bot1 to refuse the globally-allowed sender by override',
    )
    await settle(300)
    // The warn line (what reaches the host log) carries the denial reason; the
    // full effective list goes to the vendor file log, redirected here to a
    // private directory — read it back to prove the override (not the global
    // list) ruled.
    assert.ok(
      lines.some((line) => line.includes(`refused message from ${ALLOWED}`) && line.includes('is not on the allowlist')),
      'the refusal must be reported with the reason',
    )
    // The vendor logger knows its own resolved path (MAIN_LOG_DIR is captured
    // at module load, after this file set DSH_WEIXIN_LOG_DIR) — never rebuild
    // the path here: the file name uses the LOCAL date, which differs from
    // toISOString() under a UTC+8 offset.
    const { logger: vendorLogger } = await import('../vendor/openclaw-weixin/util/logger.js')
    const fileLogText = fs.readFileSync(vendorLogger.getLogFilePath(), 'utf8')
    // JSON-line encoding escapes the inner quotes, so match the escaped shape
    // the file actually holds: allowedSenders=[\"someone-else\"].
    assert.ok(
      fileLogText.includes('allowedSenders=[' + JSON.stringify('someone-else').slice(1, -1).replace(/"/g, '\\"') + ']')
        || fileLogText.includes('\\"someone-else\\"'),
      'the file log must show the EFFECTIVE list, so the operator can see exactly what ruled',
    )

    // The same sender reaches bot2, whose effective list is still the global one:
    // the message must be accepted (handled, not refused) and polling must go on.
    const pollsBefore = second.seen.getupdates
    second.push()
    await waitFor(() => second.seen.getupdates > pollsBefore + 1, 'bot2 to keep polling after its message was accepted')
    assert.ok(
      !lines.some((line) => line.includes('refused message') && line.includes('bot2')),
      'the override on bot1 must not reach bot2',
    )
  })
})
