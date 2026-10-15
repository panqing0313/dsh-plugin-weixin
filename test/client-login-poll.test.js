// Behavioural guards for the settings card's login poll loop (src/client.js).
//
// The failure these tests exist for: pressing "扫码登录微信" put a QR code on the
// card, the operator scanned it, the phone said the bot was bound — and the card
// stayed on the QR page forever, ending at 未登录. The poll loop was started with
// `setInterval(() => poll(sessionKey), 1000)`, and `sessionKey` there is the
// render's state variable: the render that runs `start()` still has it as null
// (setSessionKey only schedules the next render), so every tick called
// `poll(null)`. The host answered `no_login`, and the loop's bare `catch {}`
// threw that away, so nothing was ever reported and the card never moved. On top
// of that the endpoint long-polls for ~30s, so a 1s interval stacked ~30 requests
// at once.
//
// Those bugs are invisible to a source-text assertion and to the existing
// noop-hook harness (which is why they survived this long), so this file renders
// the real component with a small hook runtime and drives it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT_PATH = new URL('../src/client.js', import.meta.url)

const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })

/**
 * A minimal hook runtime: enough of React's contract to render this card and let
 * its state changes flow.
 *
 * The fidelity that matters for the bug:
 *  - `useState` updates the slot and re-renders, so a function that closed over
 *    an earlier render's value keeps that stale value — exactly the hazard in
 *    the poll loop.
 *  - `useCallback`/`useEffect` compare dependencies, because without that every
 *    render would look like a new effect and `refreshStatus` would re-render
 *    forever.
 *  - an effect never runs during the render that declared it, so a listener that
 *    calls a setter cannot re-enter the render pass.
 *
 * Hook slots are addressed by their call order within a pass, which is how React
 * addresses them too; the tree is rendered whole every time, so the order is
 * stable.
 */
function createHooks() {
  const slots = []
  let cursor = 0
  let pendingEffects = []
  let root = null
  let tree = null
  let renderPass = false
  let dirty = false

  const sameDeps = (a, b) =>
    a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  /** Render once and hand back the element tree. */
  const paint = () => {
    cursor = 0
    pendingEffects = []
    renderPass = true
    try {
      tree = renderTree(root)
    } finally {
      renderPass = false
    }
    return tree
  }

  /** Render, then run the effects that render scheduled, until nothing changes. */
  const flush = () => {
    for (let round = 0; round < 100; round += 1) {
      paint()
      const effects = pendingEffects
      if (effects.length === 0 && !dirty) return tree
      dirty = false
      for (const fn of effects) fn()
    }
    throw new Error('render did not settle: effects kept re-scheduling')
  }

  const requestRender = () => {
    if (renderPass) {
      dirty = true
      return
    }
    flush()
  }

  /** Call every function component in the tree, then keep the host elements. */
  const renderTree = (node) => {
    // The root is handed over as the component itself, so accept a bare function
    // as well as an element whose `type` is one.
    if (typeof node === 'function') return renderTree(node({}))
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(renderTree)
    if (typeof node.type === 'function') return renderTree(node.type(node.props ?? {}))
    // A host element is kept, but its children still have to be rendered: this is
    // what reaches LoginSection and AsrSection, which are nested inside it.
    return { ...node, children: (node.children ?? []).map(renderTree) }
  }

  const api = {
    createElement,
    useState(initial) {
      const i = cursor++
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      return [
        slot.value,
        (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (Object.is(value, slot.value)) return
          slot.value = value
          requestRender()
        },
      ]
    },
    useRef(initial) {
      const i = cursor++
      if (!slots[i]) slots[i] = { current: initial }
      return slots[i]
    },
    useCallback(fn, deps) {
      const i = cursor++
      const slot = slots[i]
      if (!slot || !sameDeps(slot.deps, deps)) slots[i] = { fn, deps }
      return slots[i].fn
    },
    useEffect(fn, deps) {
      const i = cursor++
      const slot = slots[i]
      const changed = !slot || !sameDeps(slot.deps, deps)
      slots[i] = { deps }
      if (changed) pendingEffects.push(fn)
    },
  }

  return {
    api,
    flush,
    /** Install the component under test; call `flush()` afterwards to paint it. */
    setRoot(component) {
      root = component
    },
  }
}

/** Walk a rendered tree and visit every element, parents before children. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** Every string rendered anywhere in the tree, joined for whole-card assertions. */
function textOf(node) {
  const parts = []
  walk(node, (element) => {
    for (const child of element.children ?? []) {
      if (typeof child === 'string') parts.push(child)
    }
  })
  return parts.join(' ')
}

/** Find the first button whose label contains `text`. */
function findButtonOrNull(tree, text) {
  let found = null
  walk(tree, (node) => {
    if (found || node.type !== 'button') return
    const label = (node.children ?? []).filter((c) => typeof c === 'string').join('')
    if (label.includes(text)) found = node
  })
  return found
}

/** Find the first button whose label contains `text`. */
function findButton(tree, text) {
  const found = findButtonOrNull(tree, text)
  assert.ok(found, `no button labelled "${text}" in the rendered card`)
  return found
}

/** The host half this card talks to, with the poll sequence scripted. */
function fakeHost(script = []) {
  const calls = { poll: [], startLogin: 0, status: 0, cancel: 0, accounts: [] }
  const host = {
    namespace: 'weixin',
    async startLogin() {
      calls.startLogin += 1
      return {
        qrcodeUrl: 'https://liteapp.weixin.qq.com/q/X',
        qrDataUrl: undefined,
        sessionKey: 'session-1',
        status: 'wait',
      }
    },
    async poll(sessionKey) {
      calls.poll.push(sessionKey)
      const next = script.shift()
      if (next instanceof Error) throw next
      return next ?? { status: 'wait' }
    },
    async status() {
      calls.status += 1
      return { accounts: calls.accounts, stateDir: '/tmp', pendingLogin: true, sessionExpired: false }
    },
    async cancel() {
      calls.cancel += 1
    },
    async logout() {
      return { removed: [], reloadRequired: false }
    },
  }
  const asr = {
    namespace: 'weixinAsr',
    listModels: async () => ({ models: [], modelDir: '' }),
    getDownloadSettings: async () => ({}),
  }
  return { weixin: host, weixinAsr: asr, calls }
}

/**
 * Load src/client.js under a working hook runtime and a controlled clock, apply
 * it, and render the settings card it registers.
 */
async function mountCard(remote) {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  const hooks = createHooks()
  const timers = []
  let nextTimerId = 1
  let registration

  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registration = r } } },
    AbortController,
    console,
    // The card schedules the next poll with setTimeout, so the clock is ours and
    // no test depends on real elapsed time.
    setTimeout: (fn, ms) => {
      const id = nextTimerId++
      timers.push({ id, fn, ms })
      return id
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id)
      if (i >= 0) timers.splice(i, 1)
    },
    // The endpoint holds each request open for ~30s. A fixed interval cannot
    // express that, so its use is a failure rather than a detail of the clock.
    setInterval: () => assert.fail('the poll loop must not use setInterval: the endpoint long-polls'),
    clearInterval: () => {},
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.ok(registration, 'client.js must register itself with __ModuleLoader__.load')

  const seats = []
  // Cordis resolves a service named `remote.weixin` both as `ctx["remote.weixin"]`
  // and as `ctx.remote.weixin`, and the card reads the dotted form. Model both, so
  // a namespace the harness forgot to publish is a visible error rather than a
  // silent `undefined` the component would swallow.
  const ctx = {
    remote: {
      $mount: async () => async () => {},
      weixin: remote.weixin,
      weixinAsr: remote.weixinAsr,
      directoryPicker: { namespace: 'directoryPicker', pick: async () => null },
    },
    slots: {
      inject: (_name, register) => { register() },
      register: (meta, component) => { seats.push({ meta, component }); return () => {} },
    },
    locale: { current: { language: 'zh' } },
    'remote.directoryPicker': { namespace: 'directoryPicker', pick: async () => null },
  }
  ctx['remote.weixin'] = remote.weixin
  ctx['remote.weixinAsr'] = remote.weixinAsr
  ctx.inject = (deps, callback) => {
    const sub = {}
    for (const dep of deps) {
      assert.ok(ctx[dep] !== undefined, `injected service "${dep}" is not available`)
      sub[dep] = ctx[dep]
    }
    // The sub-context is what the card is handed, so it needs the same nested
    // `remote` container.
    sub.remote = ctx.remote
    const value = callback(sub)
    return { dispose: async () => {}, then: (fn) => Promise.resolve(value).then(fn) }
  }

  const require = (spec) => {
    if (spec === 'react') return hooks.api
    if (spec === 'react/jsx-runtime') return { jsx: createElement, jsxs: createElement }
    throw new Error(`client.js required an unseeded module: ${spec}`)
  }
  await (await registration.factory(require).apply(ctx))

  // Two seats since the settings.section registration: the bundle page and
  // the shell Settings nav share one component. The bundle page is seat 0.
  assert.equal(seats.length, 2, 'the card must register the bundle page and the settings.section entry')
  hooks.setRoot(seats[0].component)
  hooks.flush()

  return {
    ctx,
    calls: null,
    timers,
    /** Re-render and return the current tree. */
    render: () => hooks.flush(),
    /** Click a button by its label, then let the resulting work settle. */
    async click(text) {
      const button = findButton(hooks.flush(), text)
      await button.props.onClick()
      hooks.flush()
    },
    /** Run the timers the poll loop scheduled, one at a time, until it stops. */
    async drain(rounds = 40) {
      for (let i = 0; i < rounds; i += 1) {
        const timer = timers.shift()
        if (!timer) return
        await timer.fn()
        hooks.flush()
      }
      assert.fail('the poll loop never stopped scheduling: it should end at a terminal status')
    },
    /**
     * Run `count` scheduled polls, then stop. For the cases that deliberately do
     * not reach a terminal status, where `drain` would (correctly) keep waiting.
     */
    async pump(count) {
      for (let i = 0; i < count; i += 1) {
        const timer = timers.shift()
        if (!timer) return
        await timer.fn()
        hooks.flush()
      }
    },
  }
}

test('the poll loop polls the session it just started, not the null it started with', async () => {
  const host = fakeHost([{ status: 'wait' }, { status: 'wait' }])
  const card = await mountCard(host)

  await card.click('扫码登录微信')
  // Two waiting polls: this case is about which session is named, not about
  // reaching a terminal status.
  await card.pump(2)

  assert.equal(host.calls.startLogin, 1)
  // The regression: every call was `poll(null)`, which the host rejects with
  // no_login, so the scan could never be observed.
  assert.deepEqual(host.calls.poll, ['session-1', 'session-1'])
})

test('one long poll runs at a time, and the loop stops at a terminal status', async () => {
  const host = fakeHost([
    { status: 'wait' },
    { status: 'scaned' },
    { status: 'confirmed', accountId: 'BOT@im.bot' },
  ])
  let inFlight = 0
  let maxInFlight = 0
  const inner = host.weixin.poll.bind(host.weixin)
  host.weixin.poll = async (key) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      return await inner(key)
    } finally {
      inFlight -= 1
    }
  }

  const card = await mountCard(host)
  await card.click('扫码登录微信')
  await card.drain()

  assert.equal(
    maxInFlight,
    1,
    'the next poll must wait for the previous one: the endpoint holds each open for ~30s',
  )
  assert.equal(host.calls.poll.length, 3)
  assert.equal(card.timers.length, 0, 'a confirmed login must stop the loop')
  // The card must land on "bound" with the account named, not sit on the QR page.
  const text = textOf(card.render())
  assert.ok(text.includes('已绑定账号'), `card should report the bound account, got: ${text}`)
})

test('a login the host no longer holds is reported instead of being swallowed', async () => {
  const host = fakeHost([Object.assign(new Error('没有进行中的登录，请重新扫码'), { code: 'no_login' })])
  const card = await mountCard(host)

  await card.click('扫码登录微信')
  await card.drain()

  // The regression: `catch {}` with the comment "transient poll failure: keep
  // going" discarded this, so the operator saw a QR code that never changed.
  const text = textOf(card.render())
  assert.ok(text.includes('本次登录已失效'), `a dead session must be surfaced, got: ${text}`)
  assert.equal(card.timers.length, 0, 'a dead session must stop the loop rather than poll forever')
})

test('a refused re-scan explains the phone-side unbind instead of looking like a failure', async () => {
  const host = fakeHost([
    {
      status: 'alreadyBound',
      message: '服务器仍认为该机器人绑定在本机，但本地凭证已被退出登录删除。请先在手机微信里解除该机器人的绑定，然后重新扫码。',
    },
  ])
  const card = await mountCard(host)

  await card.click('扫码登录微信')
  await card.drain()

  const text = textOf(card.render())
  assert.ok(
    text.includes('请先在手机微信里解除该机器人的绑定'),
    `expected the phone-side instruction, got: ${text}`,
  )
  assert.equal(card.timers.length, 0)
})

test('a transient poll failure keeps the loop alive', async () => {
  // Anything that is not a forgotten session is transient: a wire hiccup must not
  // end a login the operator is halfway through.
  const host = fakeHost([new Error('socket hang up'), { status: 'wait' }])
  const card = await mountCard(host)

  await card.click('扫码登录微信')
  // The error is followed by another scheduled poll, so pump rather than drain.
  await card.pump(2)

  assert.equal(host.calls.poll.length, 2, 'the loop must continue past a transient error')
  assert.equal(card.timers.length, 1, 'a transient error must schedule the next poll')
})
