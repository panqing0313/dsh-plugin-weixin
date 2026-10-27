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
  // Slots live per component instance, not in one flat list. A flat list only
  // works while the rendered tree keeps its shape: switching tabs replaces one
  // section with another, and the newcomer's second `useState` would read a
  // leftover slot from the section that just unmounted. React keys hooks per
  // instance, so this fake does too — the key is the component's position in the
  // tree plus its name, which differs whenever a different component takes the
  // spot (that is exactly the tab-switch case).
  const frames = new Map()
  let currentFrame = null
  let pendingEffects = []
  let root = null
  let tree = null
  let renderPass = false
  let dirty = false

  const frameFor = (key) => {
    let frame = frames.get(key)
    if (!frame) {
      frame = { slots: [], cursor: 0 }
      frames.set(key, frame)
    }
    return frame
  }

  /** Take the next hook slot of the component being rendered. */
  const nextSlot = () => {
    const frame = currentFrame
    const index = frame.cursor
    frame.cursor += 1
    return { frame, index }
  }

  const sameDeps = (a, b) =>
    a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  /** Render once and hand back the element tree. */
  const paint = () => {
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
  const renderTree = (node, path = 'root') => {
    // The root is handed over as the component itself, so accept a bare function
    // as well as an element whose `type` is one.
    if (typeof node === 'function') return renderComponent(node, {}, path)
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((child, index) => renderTree(child, `${path}.${index}`))
    if (typeof node.type === 'function') return renderComponent(node.type, node.props ?? {}, path)
    // A host element is kept, but its children still have to be rendered: this is
    // what reaches LoginSection and AsrSection, which are nested inside it.
    return { ...node, children: (node.children ?? []).map((child, index) => renderTree(child, `${path}.${index}`)) }
  }

  const renderComponent = (component, props, path) => {
    const previous = currentFrame
    currentFrame = frameFor(`${path}#${component.name || 'anonymous'}`)
    currentFrame.cursor = 0
    try {
      return renderTree(component(props), path)
    } finally {
      currentFrame = previous
    }
  }

  const api = {
    createElement,
    useState(initial) {
      const { frame, index } = nextSlot()
      if (!frame.slots[index]) frame.slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = frame.slots[index]
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
      const { frame, index } = nextSlot()
      if (!frame.slots[index]) frame.slots[index] = { current: initial }
      return frame.slots[index]
    },
    useCallback(fn, deps) {
      const { frame, index } = nextSlot()
      const slot = frame.slots[index]
      if (!slot || !sameDeps(slot.deps, deps)) frame.slots[index] = { fn, deps }
      return frame.slots[index].fn
    },
    useEffect(fn, deps) {
      const { frame, index } = nextSlot()
      const slot = frame.slots[index]
      const changed = !slot || !sameDeps(slot.deps, deps)
      frame.slots[index] = { deps }
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
    // The persona tab reads this on mount. The shape mirrors the real remote
    // method: modes + global/account defaults + per-conversation memory, where
    // each conversation now carries its mode and its inferred state.
    async personaOverview() {
      return {
        modes: [
          { id: 'default', name: '默认助手', prompt: '', builtin: true },
          { id: 'girlfriend', name: '女友', prompt: '温柔一点', builtin: true },
        ],
        globalDefault: '',
        accountDefault: '',
        overrides: [],
        memory: {
          facts: [],
          conversations: [{
            conversationId: 'conv-heat',
            summary: '聊过天气',
            bondLine: '我们认识第 3 天 · 聊过 12 条消息',
            modeId: 'girlfriend',
            modeName: '女友',
            life: { mood: '有点乏，回得会慢一点', activity: '在家歇着', energy: 34 },
            lifeLine: '在家歇着 · 有点乏，回得会慢一点 · 精力 34/100',
          }],
        },
      }
    },
  }
  const asr = {
    namespace: 'weixinAsr',
    listModels: async () => ({ models: [], modelDir: '' }),
    getDownloadSettings: async () => ({}),
  }
  // The options tab reads this on mount, so the card cannot be mounted without
  // it: an undeclared service makes ctx.inject fail, which fails every test in
  // this file rather than only the ones about options.
  const config = {
    namespace: 'weixinConfig',
    list: async () => ({ groups: [], configFile: '/tmp/config.json' }),
    save: async () => ({ groups: [] }),
    reset: async () => ({ groups: [] }),
  }
  return { weixin: host, weixinAsr: asr, weixinConfig: config, calls }
}

/**
 * Load src/client.js under a working hook runtime and a controlled clock, apply
 * it, and render the settings card it registers.
 */
async function mountCard(remote, options = {}) {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  const hooks = createHooks()
  const timers = []
  let nextTimerId = 1
  let registration
  // The card's background status refresh installs itself only on a page: it needs
  // `window` and `document` to notice the operator coming back to it. Those
  // listeners are recorded here so a test can fire them. Opt-in, because the
  // login-loop tests are about that loop's own clock and its own timers.
  const listeners = new Map()
  const page = options.browser
    ? {
        addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
        removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
      }
    : null

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
  if (page) {
    // A real page, as far as the card's refresh loop can tell: the same listener
    // table on both hosts, and a document whose visibility can be changed.
    sandbox.window.addEventListener = page.addEventListener
    sandbox.window.removeEventListener = page.removeEventListener
    sandbox.document = { visibilityState: 'visible', ...page }
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  // The bundle loads its settings card as a lazy chunk (src/client.card.js), so
  // the fake loader must be able to materialize one the way the real one does:
  // fetch the sibling script, let it register under `chunk`, then run its factory
  // with the same `require`.
  const chunkRegistrations = new Map()
  const loadRegistration = sandbox.window.__ModuleLoader__.load
  sandbox.window.__ModuleLoader__.load = (r) => {
    if (r !== undefined && typeof r === 'object' && typeof r.chunk === 'string') {
      chunkRegistrations.set(r.chunk, r)
      return
    }
    loadRegistration(r)
  }
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
      weixinConfig: remote.weixinConfig,
      directoryPicker: { namespace: 'directoryPicker', pick: async () => null },
    },
    slots: {
      inject: (_name, register) => { register() },
      register: (meta, component) => { seats.push({ meta, component }); return () => {} },
    },
    locale: { getSnapshot: () => ({ active: 'zh', locales: ['zh', 'en'], revision: 0 }) },
    'remote.directoryPicker': { namespace: 'directoryPicker', pick: async () => null },
  }
  ctx['remote.weixin'] = remote.weixin
  ctx['remote.weixinAsr'] = remote.weixinAsr
  ctx['remote.weixinConfig'] = remote.weixinConfig
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
  // The card is a lazy chunk now, so the fake require needs the one method the
  // real loader hands factories: `async(relativeChunk)` runs the sibling script
  // in the same window and returns its exports.
  require.async = async (spec) => {
    const file = String(spec).replace(/^\.\//, '')
    let found = chunkRegistrations.get(file)
    if (found === undefined) {
      const chunkSource = fs.readFileSync(new URL(file, CLIENT_PATH), 'utf8')
      new vm.Script(chunkSource, { filename: file }).runInContext(sandbox)
      found = chunkRegistrations.get(file)
    }
    if (found === undefined) throw new Error(`chunk ${file} did not register with __ModuleLoader__.load`)
    return found.factory(require)
  }

  await (await registration.factory(require).apply(ctx))

  // Five seats: the bundle page and the shell Settings nav share one
  // component, the left sidebar's panel row plus the page it opens are two
  // more (they are addressed by the same id), and the session row mark
  // occupies the last (sidebar.session.row.leading) on every Session row in
  // the workspace. This file is about the card, so it renders the bundle page
  // by name rather than by position — another seat must not silently change
  // what is tested.
  assert.equal(seats.length, 5, 'the card must register the bundle page, the settings.section entry, the sidebar panel row, its page, and the row mark')
  // Which seat to mount: the settings card by default, `main` for the page the
  // left sidebar opens — the two must never drift into different components.
  const seatName = options.seat ?? 'plugins.bundle.config'
  const card = seats.find((seat) => seat.meta.name === seatName)
  assert.ok(card, `the ${seatName} seat must be registered`)
  hooks.setRoot(card.component)
  hooks.flush()

  return {
    ctx,
    calls: null,
    timers,
    /** The listeners the card installed on `window`/`document` (browser mode). */
    listeners,
    /** Re-render and return the current tree. */
    render: () => hooks.flush(),
    /** Fire every listener the card installed for an event name. */
    fire(type) {
      for (const fn of listeners.get(type) ?? []) fn()
    },
    /** What `document.visibilityState` reports at the next visibilitychange. */
    setVisibility(state) {
      assert.ok(sandbox.document, 'mount the card with { browser: true } to have a document')
      sandbox.document.visibilityState = state
    },
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

test('a missing QR image is explained instead of rendered as a broken image', async () => {
  // The Windows bug, and the reason it looked like a torn-page glyph: the host
  // returned `qrDataUrl: undefined` (no encoder was reachable there) while
  // `qrcodeUrl` was a real LOGIN LINK. The card put that link into an <img src>,
  // so the browser drew its broken-image placeholder in the middle of the card
  // while the "open in browser" button underneath worked fine — which reads as
  // "the QR is broken" rather than "this machine cannot draw a QR".
  //
  // A link is never an image, so the only correct outcomes are: an <img> whose
  // src is a data URL, or no <img> at all plus an explanation. This asserts
  // both halves, because a future fallback that puts the link back in <img>
  // would restore the exact symptom.
  const host = fakeHost()
  const card = await mountCard(host)

  await card.click('扫码登录微信')
  await card.pump(1)

  const tree = card.render()
  const images = collect(tree, (node) => node.type === 'img')
  for (const img of images) {
    assert.match(
      String(img.props.src),
      /^data:image\//,
      `an <img> must carry image bytes, never the login link (saw ${img.props.src})`,
    )
  }
  // With no image the card has to say what to do; the link buttons stay usable.
  assert.ok(
    !JSON.stringify(tree).includes('lt;/'),
    'sanity: the tree is JSON-serialisable for this assertion',
  )
  const text = JSON.stringify(tree)
  assert.ok(
    !text.includes('"src":"https://liteapp.weixin.qq.com'),
    'the login link must not be used as an img src',
  )
  assert.ok(
    text.includes('二维码图片不可用') || images.length > 0,
    'either a real image is shown, or the card explains that no image is available',
  )
})

/** Depth-first collection of nodes matching `predicate`. */
function collect(node, predicate, into = []) {
  if (node === null || node === undefined || typeof node !== 'object') return into
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, into)
    return into
  }
  if (predicate(node)) into.push(node)
  for (const child of node.children ?? []) collect(child, predicate, into)
  return into
}

test('the status card refreshes itself instead of going stale while mounted', async () => {
  /** Let the card's async reads finish: the clock is fake, the promises are not. */
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  // The open item this pins (docs/progress.md, 状态卡实时性): the status read ran
  // exactly once, from the mount effect, so a login from another device — or the
  // server-side session expiring — left the card showing the old state until it
  // happened to be unmounted and mounted again. Without a timer and the two
  // return-to-the-card events, none of the assertions below can even find a
  // listener to fire: the effect installed neither.
  const host = fakeHost()
  const card = await mountCard(host, { browser: true })

  // Mounted: one read, and a timer that will read again on its own.
  assert.equal(host.calls.status, 1, 'mounting reads the status once')
  // The refresh is the only non-zero timer a freshly mounted card owns.
  const statusTimer = () => card.timers.find((t) => t.ms > 0)
  assert.ok(statusTimer(), 'a mounted card must schedule its own status refresh')
  // 15s is the documented tradeoff: a status read is cheap but not free, and the
  // settings page is often left open.
  assert.equal(statusTimer().ms, 15000, 'the refresh interval is the documented 15s')
  assert.deepEqual(
    [...card.listeners.keys()].sort(),
    ['focus', 'visibilitychange'],
    'the card must watch the moments the operator comes back to it',
  )

  await statusTimer().fn()
  await settle()
  assert.equal(host.calls.status, 2, 'the interval must re-read the status')
  assert.ok(statusTimer(), 'the refresh must keep scheduling itself')

  // Coming back to the window is exactly when a stale card gets looked at.
  card.fire('focus')
  assert.equal(host.calls.status, 3, 'regaining focus must refresh immediately')
  await settle()

  // ... and so is the tab becoming visible again. Going hidden is not a refresh
  // moment: nobody is reading the card then.
  card.setVisibility('hidden')
  card.fire('visibilitychange')
  await settle()
  assert.equal(host.calls.status, 3, 'hiding the card is not a reason to read')
  card.setVisibility('visible')
  card.fire('visibilitychange')
  assert.equal(host.calls.status, 4, 'becoming visible must refresh immediately')
  await settle()

  // Ticks must not stack. The host may hold a request open, and the point of a
  // self-scheduled read is that the next trigger cannot pile one on top.
  let release
  host.weixin.status = () => {
    host.calls.status += 1
    return new Promise((resolve) => { release = resolve })
  }
  card.fire('focus')
  assert.equal(host.calls.status, 5, 'the focus read is in flight')
  card.fire('focus')
  assert.equal(host.calls.status, 5, 'a second trigger must not start a second read')
  release({ accounts: [], stateDir: '/tmp', pendingLogin: false, sessionExpired: false })
  await settle()
  card.fire('focus')
  assert.equal(host.calls.status, 6, 'once the read settles, the next trigger reads again')
  await settle()

  // A QR login owns the card while it runs, and that loop refreshes the status
  // on every transition itself; the background tick must not race it.
  await card.click('扫码登录微信')
  const beforeLoginTick = host.calls.status
  await statusTimer().fn()
  await settle()
  assert.equal(host.calls.status, beforeLoginTick, 'no background status read while a QR login polls')
})

test('the left sidebar panel opens the same card inside the page gutter', async () => {
  // The sidebar row and the page behind it are two registrations sharing one
  // id; this asserts the page actually renders the card, because a page that
  // renders some other (or empty) component would still make the row clickable.
  const host = fakeHost([{ accounts: [], stateDir: '/tmp', pendingLogin: false, sessionExpired: false }])
  const page = await mountCard(host, { seat: 'main' })

  const tree = page.render()
  assert.equal(tree.type, 'div', 'the page is a plain host element')
  // The card was sized for a ~520px settings dialog; a full workspace pane needs
  // its own scroll and gutter or its full-bleed rows touch the frame edge.
  assert.equal(tree.props.style.overflowY, 'auto')
  assert.ok(/^\d+px/.test(tree.props.style.padding), `expected a padding gutter, got ${tree.props.style.padding}`)

  const text = textOf(tree)
  for (const label of ['微信账号', '会话', '配置项', '统计', '个性化', '关于']) {
    assert.ok(text.includes(label), `the panel page must show the card's "${label}" tab, got: ${text}`)
  }
})

test('the options form speaks the UI language, and starts folded', async () => {
  // The form used to call `t(field.label, field.labelEn)` while the locale
  // helper is `(en, zh)` — so a Chinese UI showed every group heading, field
  // label and hint in English. English text is not visibly wrong to a source
  // assertion, so this renders the form and checks the words.
  const host = fakeHost([])
  host.weixinConfig = {
    namespace: 'weixinConfig',
    list: async () => ({
      configFile: '/tmp/config.json',
      groups: [
        {
          group: '基本',
          groupEn: 'Basics',
          fields: [{
            path: 'sendIntervalMs',
            type: 'number',
            label: '发送间隔',
            labelEn: 'Send interval',
            hint: '两条消息之间至少等这么久',
            hintEn: 'Minimum gap between two messages',
            unit: '毫秒',
            unitEn: 'ms',
            value: 800,
            defaultValue: 800,
            source: 'default',
          }],
        },
        { group: '权限', groupEn: 'Access', fields: [] },
      ],
    }),
    save: async () => ({ groups: [] }),
    reset: async () => ({ groups: [] }),
  }
  const card = await mountCard(host)
  await card.click('配置项')
  await new Promise((resolve) => setImmediate(resolve))

  const folded = textOf(card.render())
  assert.ok(folded.includes('基本'), `the group heading must be Chinese, got: ${folded}`)
  assert.ok(folded.includes('权限'), 'every group heading is listed')
  assert.ok(!folded.includes('Basics'), `English headings must not leak into a Chinese UI, got: ${folded}`)
  assert.ok(!folded.includes('发送间隔'), 'groups start folded: no field is rendered until one is opened')

  // Open the first group: the field label, its unit and its hint are all Chinese.
  let groupButton = null
  walk(card.render(), (node) => {
    if (groupButton || node.type !== 'button') return
    if (textOf(node).includes('基本')) groupButton = node
  })
  assert.ok(groupButton, 'the group heading is a button the operator can open')
  await groupButton.props.onClick()
  const opened = textOf(card.render())
  assert.ok(opened.includes('发送间隔'), `the field label must be Chinese, got: ${opened}`)
  assert.ok(opened.includes('两条消息之间至少等这么久'), 'the hint is translated too')
  assert.ok(opened.includes('毫秒'), 'the unit is translated too')
  assert.ok(!opened.includes('Send interval'), 'no English label survives in a Chinese UI')
})

test('the persona tab says, per conversation, which mode is on and how she feels', async () => {
  // The user asked for exactly this: the settings card must show, per
  // conversation, the persona mode and the state the bot is in right now —
  // inferred, never typed in by hand.
  const host = fakeHost([{ accounts: [], stateDir: '/tmp', pendingLogin: false, sessionExpired: false }])
  host.calls.accounts.push({ accountId: 'BOT@im.bot', label: 'bot' })
  const card = await mountCard(host)
  await card.render()

  const tab = findButton(card.render(), '个性化')
  await tab.props.onClick()
  // The tab fetches status, then the overview, then re-renders; each flush runs
  // one round of settled effects, so give it a few.
  let text = ''
  for (let i = 0; i < 6; i += 1) text = textOf(await card.render())

  assert.match(text, /模式：女友/, text)
  assert.match(text, /精力 34\/100/, text)
  assert.match(text, /有点乏，回得会慢一点/, text)
})
