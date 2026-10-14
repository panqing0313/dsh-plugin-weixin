// Guards for "log out" (src/login-remote.js).
//
// The operator need: a bound account whose credentials are dead cannot be
// forgotten from the card, so rebinding a bot means editing files under
// ~/.dsh/weixin by hand. This is the behaviour that makes the button honest —
// it deletes the credential it claims to delete, and nothing else.
//
// Two things are deliberately NOT deleted: the operator's settings (allowlist,
// model directory) and the account's session history. Logging out is "stop
// using this account", not "erase the setup".
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WeixinLoginController } from '../src/login-remote.js'
import { configureWeixinStateDir } from '../src/state.js'

/**
 * Run `body` with the weixin state root pointed at a throwaway directory,
 * pre-seeded with one saved account.
 *
 * The vendor account store reads OPENCLAW_STATE_DIR, not this module's own
 * override, so the bridge has to be set up exactly as apply() does it — a test
 * that only sets DSH_WEIXIN_STATE_DIR sees an empty account list and reports a
 * logout bug that does not exist.
 * @param {(root: string) => Promise<void> | void} body
 */
async function withBoundAccount(body) {
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-logout-'))
  process.env.DSH_WEIXIN_STATE_DIR = root
  configureWeixinStateDir()
  const accounts = path.join(root, 'openclaw-weixin', 'accounts')
  fs.mkdirSync(accounts, { recursive: true })
  fs.writeFileSync(
    path.join(accounts, 'BOT@im.bot.json'),
    JSON.stringify({ token: 'BOT@im.bot:secret', baseUrl: 'https://ilinkai.weixin.qq.com', userId: 'me@im.wechat' }),
  )
  fs.writeFileSync(path.join(accounts, 'BOT@im.bot.sync.json'), JSON.stringify({ get_updates_buf: 'cursor' }))
  fs.writeFileSync(path.join(accounts, 'BOT@im.bot.context-tokens.json'), '{}')
  fs.writeFileSync(
    path.join(root, 'openclaw-weixin', 'accounts.json'),
    JSON.stringify(['BOT@im.bot'], null, 2),
  )
  // Operator settings live beside the credentials and must survive.
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ allowedSenders: ['me@im.wechat'] }))
  try {
    await body(root)
  } finally {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const controller = () => new WeixinLoginController(new Context(), {})

test('logout deletes the saved credential and its account files', async () => {
  await withBoundAccount(async () => {
    const c = controller()
    assert.equal((await c.status()).accounts.length, 1, 'expected one bound account to start')

    const result = await c.logout('')
    assert.deepEqual(result.removed, ['BOT@im.bot'])
    assert.equal(result.reloadRequired, true, 'a running poll loop needs a reload to notice')

    const after = await c.status()
    assert.deepEqual(after.accounts, [], 'the card must report not-logged-in once the credential is gone')
  })
})

test('logout removes the credential from disk, not just from the index', async () => {
  // status() reads the index AND each file. Removing only the index entry would
  // make the card say "not logged in" while the token file still sat on disk,
  // and a later index rebuild would resurrect the account.
  await withBoundAccount(async (root) => {
    const accounts = path.join(root, 'openclaw-weixin', 'accounts')
    await controller().logout('')

    assert.equal(fs.existsSync(path.join(accounts, 'BOT@im.bot.json')), false, 'token file must go')
    assert.equal(fs.existsSync(path.join(accounts, 'BOT@im.bot.sync.json')), false, 'sync cursor must go')
    const index = JSON.parse(fs.readFileSync(path.join(root, 'openclaw-weixin', 'accounts.json'), 'utf8'))
    assert.deepEqual(index, [], 'the index must not still name the account')
  })
})

test('logout keeps the operator settings and the account history', async () => {
  // The distinction the user chose: delete the login credential, keep the rest.
  // Wiping config.json would silently drop the allowlist, which fails closed —
  // the bot would go quiet with no error anywhere.
  await withBoundAccount(async (root) => {
    fs.mkdirSync(path.join(root, 'sessions', 'weixin-me-im-wechat'), { recursive: true })
    fs.writeFileSync(path.join(root, 'sessions', 'weixin-me-im-wechat', 'session.jsonl'), '{"turn":1}\n')

    await controller().logout('')

    assert.equal(fs.existsSync(path.join(root, 'config.json')), true, 'settings must survive a logout')
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')),
      { allowedSenders: ['me@im.wechat'] },
      'settings must survive unchanged',
    )
    assert.equal(
      fs.existsSync(path.join(root, 'sessions', 'weixin-me-im-wechat', 'session.jsonl')),
      true,
      'conversation history is not the credential and must survive',
    )
  })
})

test('logout with nothing bound is a no-op, not an error', async () => {
  // The card only shows the button when something is bound, but a second click
  // or a stale tab must not throw: the desired state is already true.
  await withBoundAccount(async () => {
    const c = controller()
    await c.logout('')
    const again = await c.logout('')
    assert.deepEqual(again.removed, [])
    assert.equal(again.reloadRequired, false)
  })
})

test('logout refuses an account it does not hold', async () => {
  // The id is caller-supplied. It must only ever select an account we already
  // have, so a typo reports nothing removed instead of reporting success.
  await withBoundAccount(async () => {
    const result = await controller().logout('../../etc/passwd')
    assert.deepEqual(result.removed, [], 'an unknown id must not report success')
    const still = await controller().status()
    assert.equal(still.accounts.length, 1, 'the real account must be untouched')
  })
})

test('logout clears a recorded session expiry', async () => {
  // The expiry flag drives the card's "log in again" notice. Once the
  // credentials are gone the notice is stale — the card already says
  // "not logged in", and keeping the flag would show both at once.
  await withBoundAccount(async () => {
    const c = controller()
    c.markSessionExpired()
    assert.equal((await c.status()).sessionExpired, true)

    await c.logout('')
    assert.equal((await c.status()).sessionExpired, false, 'a removed account cannot be "expired"')
  })
})
