// Behavioural guards for the QR login state machine (src/login-remote.js).
//
// The failure these tests exist for: after "log out" the operator scanned again,
// the phone said the bot was bound, and the card still showed 未登录 and never
// recovered. The server answers a re-scan of a bot it still considers bound with
// `binded_redirect` and refuses to hand out a credential. Dropping the local
// token (which is all "log out" can do — there is no unbind endpoint) does not
// unbind the bot, so the server keeps refusing. The card used to report that as
// a hard failure with "请先在手机上解除绑定" and, worse, the whole login flow
// wrote nothing to the log, so a scan that went nowhere left no trace at all.
//
// These tests drive the real controller with a stubbed fetch: no network, and no
// real state root is ever touched (see `withStateRoot`).
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'

// The vendored logger resolves its log directory when it is first imported, so
// it has to be redirected BEFORE src/login-remote.js pulls it in. Otherwise these
// tests would append their login trace to the operator's real log, next to the
// credentials they must never touch.
const LOG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-login-logs-'))
const previousLogDir = process.env.DSH_WEIXIN_LOG_DIR
const previousLogLevel = process.env.OPENCLAW_LOG_LEVEL
process.env.DSH_WEIXIN_LOG_DIR = LOG_ROOT
// INFO alone would miss the per-poll line that makes a scan visible.
process.env.OPENCLAW_LOG_LEVEL = 'DEBUG'

// `startLogin()` renders the QR code through a temp PNG, and `node --test` runs
// this file in its own process alongside the others. Pointing TMPDIR at a private
// directory keeps that file out of the shared one, where another test asserts on
// the `dsh-weixin-qr-` prefix by counting entries — a count that a concurrent
// process can change under it. `os.tmpdir()` re-reads TMPDIR on every call, so
// setting it here (before any call) is enough.
const previousTmpDir = process.env.TMPDIR
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-login-tmp-'))
process.env.TMPDIR = TMP_ROOT

const { WeixinLoginController } = await import('../src/login-remote.js')
const { configureWeixinStateDir } = await import('../src/state.js')
const { resolveStateDir: vendorStateDir } = await import('../vendor/openclaw-weixin/storage/state-dir.js')

after(() => {
  if (previousLogDir === undefined) delete process.env.DSH_WEIXIN_LOG_DIR
  else process.env.DSH_WEIXIN_LOG_DIR = previousLogDir
  if (previousLogLevel === undefined) delete process.env.OPENCLAW_LOG_LEVEL
  else process.env.OPENCLAW_LOG_LEVEL = previousLogLevel
  if (previousTmpDir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmpDir
  fs.rmSync(LOG_ROOT, { recursive: true, force: true })
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

/** One JSON reply, shaped like the fetch Response the vendored api helpers read. */
function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

/**
 * Run `body` with the weixin state root pointed at a throwaway directory.
 *
 * `openclaw-weixin/accounts.json` holds the account index; an empty index means
 * "nothing is bound", which is the state a log out leaves behind and the state
 * every test here starts from.
 *
 * The vendor account store reads OPENCLAW_STATE_DIR, not this module's own
 * override, so the bridge has to be set up exactly as apply() does it — and the
 * resolved path is then verified, because the last time this was assumed the
 * suite deleted the operator's real account (see test/logout.test.js).
 * @param {(root: string) => Promise<void> | void} body
 */
async function withStateRoot(body) {
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-login-'))
  process.env.DSH_WEIXIN_STATE_DIR = root
  configureWeixinStateDir()
  guardStateRoot(root)
  fs.mkdirSync(path.join(root, 'openclaw-weixin', 'accounts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'openclaw-weixin', 'accounts.json'), JSON.stringify([], null, 2))
  try {
    await body(root)
  } finally {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    configureWeixinStateDir()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Fail loudly unless the vendored account store resolves inside `expected`.
 * @param {string} expected
 */
function guardStateRoot(expected) {
  const resolved = vendorStateDir()
  assert.equal(
    resolved,
    expected,
    'refusing to run against the real state root: the vendored account store resolves to ' +
      `${resolved}, not the throwaway root ${expected}.`,
  )
  const real = path.join(os.homedir(), '.dsh', 'weixin')
  assert.ok(
    resolved !== real && !resolved.startsWith(`${real}${path.sep}`),
    `refusing to run against the operator's real state: ${resolved}`,
  )
}

/**
 * Answer the two iLink endpoints the login flow uses, from a script of status
 * replies. `script` is consumed one entry per status request.
 * @param {Array<object | (() => object)>} script
 */
function stubServer(script) {
  const seen = { qr: 0, status: 0, statusUrls: [] }
  const previous = globalThis.fetch
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.includes('/ilink/bot/get_bot_qrcode')) {
      seen.qr += 1
      return jsonResponse({
        qrcode: `QR-${seen.qr}`,
        qrcode_img_content: `https://liteapp.weixin.qq.com/q/QR-${seen.qr}?bot_type=3`,
        ret: 0,
      })
    }
    if (text.includes('/ilink/bot/get_qrcode_status')) {
      seen.statusUrls.push(text)
      const entry = script.shift()
      if (entry === undefined) throw new Error('stub server ran out of scripted status replies')
      return jsonResponse(typeof entry === 'function' ? entry() : entry)
    }
    throw new Error(`unexpected request in login test: ${text}`)
  }
  return {
    seen,
    restore: () => { globalThis.fetch = previous },
  }
}

const controller = () => new WeixinLoginController(new Context(), {})

/**
 * Run `body` with a controller on a throwaway state root, then cancel every
 * session the body started.
 *
 * The active-login map is module state, and startLogin() deliberately reuses a
 * fresh session instead of asking the server for a new code. Without the
 * cleanup, one test's session would be handed to the next test, which would see
 * fewer QR fetches than it scripted and pass or fail for the wrong reason.
 * @param {(helpers: { c: WeixinLoginController, start: () => Promise<string>, root: string }) => Promise<void>} body
 */
async function withLogin(body) {
  await withStateRoot(async (root) => {
    const c = controller()
    const keys = []
    const start = async () => {
      const started = await c.startLogin()
      assert.equal(typeof started.sessionKey, 'string')
      assert.ok(started.sessionKey.length > 0, 'startLogin must return a session key to poll with')
      keys.push(started.sessionKey)
      return started.sessionKey
    }
    try {
      await body({ c, start, root })
    } finally {
      for (const key of keys) await c.cancel(key).catch(() => {})
    }
  })
}

/** Every log line written since the process started, as one string. */
function readLoginLog() {
  if (!fs.existsSync(LOG_ROOT)) return ''
  return fs
    .readdirSync(LOG_ROOT)
    .filter((name) => name.startsWith('openclaw-') && name.endsWith('.log'))
    .map((name) => fs.readFileSync(path.join(LOG_ROOT, name), 'utf8'))
    .join('\n')
}

test('a re-scan of a bot the server still considers bound is its own outcome, not a failure', async () => {
  const server = stubServer([{ ret: 0, status: 'binded_redirect' }])
  try {
    await withLogin(async ({ c, start }) => {
      const key = await start()
      const result = await c.poll(key)
      // The regression: this used to be {status:"failed"} with "该账号已连接过，
      // 请先在手机上解除绑定" — reported as a dead end even though the operator
      // had just been told by the phone that the bot was bound.
      assert.equal(result.status, 'alreadyBound')
      // The way out is on the phone, and only there: this host cannot unbind a
      // bot the server no longer serves it a token for. The message has to say
      // so, because that is the only action available to the operator.
      assert.match(result.message, /手机微信/)
      assert.match(result.message, /绑定/)
      // It must not be mistaken for a successful bind: no credential was handed
      // out, so claiming "bound" would be a lie the next status() would expose.
      assert.equal((await c.status()).accounts.length, 0)
    })
  } finally {
    server.restore()
  }
})

test('a scan the server refuses is recorded in the log', async () => {
  const server = stubServer([{ ret: 0, status: 'binded_redirect' }])
  let log = ''
  try {
    await withLogin(async ({ c, start }) => {
      const key = await start()
      await c.poll(key)
    })
  } finally {
    server.restore()
    log = readLoginLog()
  }
  // The login flow used to be completely silent, which is why "the phone says
  // bound but the card says 未登录" could not be diagnosed from the machine.
  //
  // Asserting on this plugin's own line, not merely on the word: the vendored
  // api helper also logs raw response bodies at DEBUG, so a bare /binded_redirect/
  // would pass even with the plugin's logging removed — it would be testing the
  // vendor, not this code.
  assert.match(log, /weixin login: server refused a new credential/, 'the refused scan must leave a trace in the log')
  // The trace names the session and, crucially, how many accounts this host
  // still holds: "refused although nothing is bound here" is the state that
  // needs the phone, and it is the first thing to check when the card is wrong.
  assert.match(log, /localAccounts=0/)
})

test('a confirmed scan saves the credential and is visible to status()', async () => {
  const server = stubServer([
    {
      ret: 0,
      status: 'confirmed',
      ilink_bot_id: 'BOT@im.bot',
      bot_token: 'BOT@im.bot:token',
      baseurl: 'https://ilinkai.weixin.qq.com',
      ilink_user_id: 'me@im.wechat',
    },
  ])
  try {
    await withLogin(async ({ c, start }) => {
      // An expiry recorded by an earlier session must not outlive a login that
      // just produced a working credential.
      c.markSessionExpired()
      const key = await start()
      const result = await c.poll(key)
      assert.equal(result.status, 'confirmed')
      assert.equal(result.accountId, 'BOT@im.bot')
      assert.equal(result.userId, 'me@im.wechat')

      const status = await c.status()
      assert.deepEqual(
        status.accounts.map((a) => a.accountId),
        ['BOT@im.bot'],
      )
      assert.equal(status.accounts[0].userId, 'me@im.wechat')
      assert.equal(status.sessionExpired, false, 'a fresh login clears the expiry flag')
    })
  } finally {
    server.restore()
  }
})

test('the bound check is answered from the saved credential alone, without the server', async () => {
  const server = stubServer([])
  try {
    await withLogin(async ({ c }) => {
      // status() must not make a request: the card calls it on every mount, and
      // the QR endpoints are the only ones that should ever be polled.
      const status = await c.status()
      assert.deepEqual(status.accounts, [])
      assert.equal(server.seen.qr, 0, 'status() must not ask the server anything')
      assert.equal(server.seen.status, 0)
      assert.equal(status.pendingLogin, false)
    })
  } finally {
    server.restore()
  }
})

test('polling a session the host no longer holds fails with the no_login code', async () => {
  const server = stubServer([])
  try {
    await withLogin(async ({ c }) => {
      await assert.rejects(
        () => c.poll('a-session-that-was-never-started'),
        (error) => {
          // The card keys its "this login is over, scan again" branch off the
          // code, so the code is part of the contract, not just the message.
          assert.equal(error.code, 'no_login')
          return true
        },
      )
    })
  } finally {
    server.restore()
  }
})

test('a long-poll timeout keeps waiting instead of failing the login', async () => {
  const server = stubServer([{ ret: 0, status: 'wait' }, { ret: 0, status: 'wait' }])
  try {
    await withLogin(async ({ c, start }) => {
      // What the server does for an unscanned code: hold the request open, then
      // answer "wait". A hiccup on the wire must not be readable as a failure.
      const key = await start()
      assert.equal((await c.poll(key)).status, 'wait')
      assert.equal((await c.poll(key)).status, 'wait')
    })
  } finally {
    server.restore()
  }
})

test('an expired QR code is replaced, and the refresh budget is finite', async () => {
  const server = stubServer([
    { ret: 0, status: 'expired' },
    { ret: 0, status: 'expired' },
    { ret: 0, status: 'expired' },
    { ret: 0, status: 'expired' },
  ])
  try {
    await withLogin(async ({ c, start }) => {
      const key = await start()
      const first = await c.poll(key)
      assert.equal(first.status, 'refreshed')
      assert.equal(server.seen.qr, 2, 'a refresh must fetch a new code, keeping the same session')

      // The budget exists so a dead code cannot be refreshed forever.
      let last = first
      for (let i = 0; i < 6 && last.status === 'refreshed'; i += 1) last = await c.poll(key)
      assert.equal(last.status, 'failed')
      assert.match(last.message, /二维码/)
    })
  } finally {
    server.restore()
  }
})
