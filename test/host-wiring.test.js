/**
 * Regression tests for how the plugin mounts its settings services.
 *
 * The bug these pin down shipped, and the suite did not catch it, because the
 * harness for `test/inbound-loop-start.test.js` was a plain object with a
 * `plugin()` that simply recorded whatever it was handed. The real Cordis
 * context rejects that same value:
 *
 *   Error: invalid plugin, expect function or object with an "apply" method,
 *   received object
 *
 * The plugin wraps the mount in a try/catch, so the throw was swallowed and
 * `loginController` became `undefined`. Everything downstream then looked fine —
 * the poll loop started, the card rendered, a scan completed and wrote a
 * credential — but nothing was left to hear "the login finished", so the inbound
 * loop never moved to the new credential and WeChat kept saying it could not
 * reach openclaw.
 *
 * The lesson is in the harness, not the assertion: a stub standing in for the
 * host has to reproduce what the host *rejects*, or a swallowed error stays
 * invisible. So these tests use a REAL Cordis context and apply the plugin the
 * way the host does.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const ALLOWED = 'wxid_abc'

const roots = []
const previousStateDir = process.env.DSH_WEIXIN_STATE_DIR

test.after(() => {
  if (previousStateDir === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
  else process.env.DSH_WEIXIN_STATE_DIR = previousStateDir
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

/** A throwaway state root, so nothing here can touch the operator's account. */
function withStateRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-wiring-'))
  roots.push(root)
  process.env.DSH_WEIXIN_STATE_DIR = root
  return root
}

/**
 * Apply the plugin to a real Cordis context and collect what it logged.
 *
 * The built-in `LoggerService` never writes to stdout, so its exporter is the
 * only way to read the plugin's own lines — which is exactly the channel the
 * operator has for diagnosing this, and the channel the swallowed error went to.
 */
async function applyOnRealCordis(body) {
  withStateRoot()
  const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
  const ctx = new Context()
  const lines = []
  // `exporter` is disposed with the fiber, and it is the sink Cordis hands every
  // structured message to; reading it back is how a test sees `ctx.logger`.
  //
  // `levels.default: 4` is not decoration. An exporter without an explicit level
  // falls back to `this.level ?? 1`, and the filter is `threshold < level`, so
  // the default DROPS warn (2) and debug (3) — which is precisely where both
  // swallowed-error lines live. Without this the assertions below would pass
  // against the broken code.
  ctx.logger.exporter({
    levels: { default: 4 },
    export: (message) => lines.push(String(message.args?.[0] ?? '')),
  })

  const fiber = ctx.plugin({
    name: 'dsh-weixin-test-host',
    apply: (c) => plugin.apply(c, plugin.Config({ allowedSenders: [ALLOWED] })),
  })
  // `plugin()` applies synchronously, but the services are registered on their
  // own fibers and settle a tick later.
  await new Promise((resolve) => setTimeout(resolve, 200))
  try {
    await body({ ctx, lines })
  } finally {
    await fiber.dispose()
  }
}

test('both settings services survive being mounted on a real Cordis context', async () => {
  await applyOnRealCordis(async ({ ctx, lines }) => {
    assert.ok(
      ctx.get('weixinLoginController') !== undefined,
      'the login service must be reachable: a completed scan has to be able to report itself',
    )
    assert.ok(
      ctx.get('asrController') !== undefined,
      'the ASR service must be reachable: the voice-model card is driven through it',
    )

    // The swallowed throw is the whole failure mode, so its warning line is the
    // signal that must never appear again.
    for (const warning of ['settings login service unavailable', 'settings ASR service unavailable']) {
      assert.ok(
        !lines.some((line) => line.includes(warning)),
        `the host reported "${warning}", which means the service was dropped and its wiring never happened`,
      )
    }
  })
})

test('a mounted login service carries the callback the host wires to it', async () => {
  await applyOnRealCordis(async ({ ctx }) => {
    const controller = ctx.get('weixinLoginController')
    assert.equal(
      typeof controller.onAccountBound,
      'function',
      'without this hook the poll loop is never told that a credential has appeared',
    )
  })
})

test('the plugin unloads cleanly, leaving no service behind', async () => {
  // Dropping `ctx.plugin(instance)` must not trade a swallowed error for a leak:
  // a controller that outlives its plugin would keep answering the settings card.
  await applyOnRealCordis(async () => {})
  // `applyOnRealCordis` disposed the fiber before returning; a fresh context
  // cannot see a service it never mounted, so the check is on the same tree.
  const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
  const ctx = new Context()
  const fiber = ctx.plugin({ name: 'unload-host', apply: (c) => plugin.apply(c, plugin.Config({ allowedSenders: [ALLOWED] })) })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.ok(ctx.get('weixinLoginController') !== undefined, 'sanity: it mounts first')
  await fiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(
    ctx.get('weixinLoginController'),
    undefined,
    'the service is scoped to the plugin fiber and must go away with it',
  )
  fs.rmSync(process.env.DSH_WEIXIN_STATE_DIR, { recursive: true, force: true })
})
