/**
 * The WeChat mark on a Session row.
 *
 * `src/client.js` is a host module: it only ever runs inside the loader with a
 * `react` binding, and the seat it occupies here
 * (`sidebar.session.row.leading`) is rendered by ui-workspace for EVERY Session
 * row — including rows this plugin never opened. So the component's contract has
 * two halves, and the second one is the easy one to get wrong:
 *
 *   1. our own Sessions (`weixin-<slug>`, and `weixin-<slug>--<stamp>` for an
 *      extra line) lead with the WeChat glyph;
 *   2. every other Session contributes NOTHING — not an empty span, not a
 *      placeholder, `null`.
 *
 * Half two is why this file exists. A prefix test that matched too much would
 * put the WeChat logo on unrelated conversations, and nothing else in the suite
 * would notice, because the seat is shared and the host would happily render
 * whatever it is handed.
 *
 * The harness is the one from client-sessions-section.test.js (real hooks,
 * dep-compared effects, a flush that settles async work), with one change: the
 * slot recorder keeps registrations BY SLOT NAME. The earlier harness kept the
 * last registration that carried a component, which silently stops being the
 * interesting one as soon as the plugin registers a second slot.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.join(HERE, '..', 'src', 'client.js')

const ROW_SEAT = 'sidebar.session.row.leading'

/** Minimal stand-in for the host's element factory. */
function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
  return { type, props: props ?? {}, children: flat }
}

/** The hook runtime: per-component slot segments that persist across passes. */
function createHooks() {
  const segments = new Map()
  const componentStack = []
  let pendingEffects = []
  let root = null
  let tree = null
  let renderPass = false
  let dirty = false
  let scheduled = Promise.resolve()

  const sameDeps = (a, b) =>
    a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  const paint = () => {
    componentStack.length = 0
    pendingEffects = []
    renderPass = true
    try {
      tree = renderTree(root)
    } finally {
      renderPass = false
    }
    return tree
  }

  const flush = async () => {
    for (let round = 0; round < 100; round += 1) {
      paint()
      const effects = pendingEffects
      if (effects.length === 0 && !dirty) {
        await Promise.resolve()
        if (!dirty && pendingEffects.length === 0) return tree
        continue
      }
      dirty = false
      for (const fn of effects) await fn()
      await Promise.resolve()
    }
    throw new Error('render did not settle: effects kept re-scheduling')
  }

  const requestRender = () => {
    dirty = true
    scheduled = scheduled.then(async () => {
      if (!renderPass) await flush()
    })
  }

  const renderTree = (node) => {
    if (typeof node === 'function') return renderTree({ type: node, props: {} })
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(renderTree)
    if (typeof node.type === 'function') {
      const name = node.type.name || 'anonymous'
      if (!segments.has(name)) segments.set(name, { slots: [], cursor: 0 })
      const segment = segments.get(name)
      segment.cursor = 0
      componentStack.push(segment)
      try {
        return renderTree(node.type(node.props ?? {}))
      } finally {
        componentStack.pop()
      }
    }
    return { ...node, children: (node.children ?? []).map(renderTree) }
  }

  const current = () => {
    const segment = componentStack[componentStack.length - 1]
    assert.ok(segment, 'a hook was called outside any component')
    return segment
  }

  const api = {
    createElement,
    useState(initial) {
      const segment = current()
      const i = segment.cursor++
      if (!segment.slots[i]) segment.slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = segment.slots[i]
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        requestRender()
      }]
    },
    useEffect(fn, deps) {
      const segment = current()
      const i = segment.cursor++
      const slot = segment.slots[i]
      const changed = !slot || !sameDeps(slot.deps, deps)
      segment.slots[i] = { deps }
      if (changed) pendingEffects.push(fn)
    },
    useRef(initial) {
      const segment = current()
      const i = segment.cursor++
      if (!segment.slots[i]) segment.slots[i] = { current: initial }
      return segment.slots[i]
    },
    useCallback(fn, deps) {
      const segment = current()
      const i = segment.cursor++
      const slot = segment.slots[i]
      if (!slot || !sameDeps(slot.deps, deps)) segment.slots[i] = { fn, deps }
      return segment.slots[i].fn
    },
    useMemo(fn, deps) {
      const segment = current()
      const i = segment.cursor++
      const slot = segment.slots[i]
      if (!slot || !sameDeps(slot.deps, deps)) segment.slots[i] = { value: fn(), deps }
      return segment.slots[i].value
    },
  }

  return {
    api,
    flush,
    setRoot(component) {
      root = component
    },
  }
}

/**
 * Boot src/client.js and return the component registered on the row seat.
 *
 * Registrations are keyed by the slot name they carry, so adding a slot to the
 * plugin cannot silently hand this test a different component than the one the
 * host would render in a Session row.
 */
async function mountRowSeat({ conversations } = {}) {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  const hooks = createHooks()
  const registrations = new Map()

  const host = {
    weixin: {
      namespace: 'weixin',
      async status() {
        return { accounts: [], stateDir: '/tmp', pendingLogin: false, sessionExpired: false }
      },
      async poll() {
        return { status: 'wait' }
      },
      async cancel() {},
      async sessions() {
        return { conversations: conversations ?? [] }
      },
    },
    weixinAsr: {
      namespace: 'weixinAsr',
      listModels: async () => ({ models: [], modelDir: '' }),
      getDownloadSettings: async () => ({}),
    },
    weixinConfig: {
      namespace: 'weixinConfig',
      list: async () => ({ groups: [], configFile: '/tmp/config.json' }),
      save: async () => ({ groups: [] }),
      reset: async () => ({ groups: [] }),
    },
    directoryPicker: { namespace: 'directoryPicker', pick: async () => null },
  }

  const ctx = {
    remote: { ...host, $mount: async () => async () => {} },
    logger: { info() {}, warn() {}, error() {} },
    slots: {
      inject: (_point, cb) => {
        cb()
        return { dispose: async () => {} }
      },
      register: (options, component) => {
        if (component) registrations.set(options.name, { options, component })
        return { dispose: async () => {} }
      },
    },
    locale: { getSnapshot: () => ({ active: 'zh', locales: ['zh', 'en'], revision: 0 }) },
  }
  // A context resolves dotted service names as literal keys, so they must be
  // reachable both ways: `ctx["remote.weixin"]` for the declaration and
  // `ctx.remote.weixin` for the calls the card makes.
  ctx['remote.weixin'] = host.weixin
  ctx['remote.weixinAsr'] = host.weixinAsr
  ctx['remote.weixinConfig'] = host.weixinConfig
  ctx['remote.directoryPicker'] = host.directoryPicker
  ctx.inject = (deps, callback) => {
    const sub = {}
    for (const dep of deps) {
      assert.ok(ctx[dep] !== undefined, `injected service "${dep}" is not available`)
      sub[dep] = ctx[dep]
    }
    sub.remote = ctx.remote
    const value = callback(sub)
    return { dispose: async () => {}, then: (fn) => Promise.resolve(value).then(fn) }
  }

  const require = (spec) => {
    if (spec === 'react') return hooks.api
    if (spec === 'react/jsx-runtime') return { jsx: createElement, jsxs: createElement }
    throw new Error(`client.js required an unseeded module: ${spec}`)
  }

  const sandbox = { console, window: { __ModuleLoader__: { load: (r) => { registration = r } } } }
  let registration
  vm.createContext(sandbox)
  new vm.Script(source, { filename: CLIENT_PATH }).runInContext(sandbox)
  await registration.factory(require).apply(ctx)

  const entry = registrations.get(ROW_SEAT)
  assert.ok(entry, `client.js must register a component on "${ROW_SEAT}"`)
  return { hooks, entry, registrations }
}

/** Render the row seat for one Session id, exactly as the host's row does. */
async function markFor(sessionId, { conversations } = {}) {
  const { hooks, entry } = await mountRowSeat({ conversations })
  // `renderSlot(seat, { sessionId })` hands the occupant the row's Session
  // identity and nothing else — no status, no title. The root is the element
  // the seat renders, so the boot flush already carries the prop.
  hooks.setRoot({ type: entry.component, props: { sessionId } })
  return { tree: await hooks.flush(), hooks }
}

/** Every string child in the tree, so the owner hint can be read back. */
function stringChildren(tree, into = []) {
  if (tree === null || tree === undefined) return into
  if (Array.isArray(tree)) {
    tree.forEach((child) => stringChildren(child, into))
    return into
  }
  // The harness createElement keeps string children on the children array
  // verbatim, so strings arrive as leaves in their own right; the object
  // guard must come after this branch, never before it.
  if (typeof tree === 'string') { into.push(tree); return into }
  if (typeof tree !== 'object') return into
  ;(tree.children ?? []).forEach((child) => stringChildren(child, into))
  return into
}

/** Every `path` element's `d`, so a glyph can be compared by shape. */
function paths(tree) {
  const found = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'path') found.push(node.props.d)
    ;(node.children ?? []).forEach(walk)
  }
  walk(tree)
  return found
}

/** Every element type in the tree, in order. */
function types(tree, into = []) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return into
  if (Array.isArray(tree)) {
    tree.forEach((child) => types(child, into))
    return into
  }
  into.push(tree.type)
  ;(tree.children ?? []).forEach((child) => types(child, into))
  return into
}

test('a Session this plugin opened leads with the WeChat mark', async () => {
  const { tree } = await markFor('weixin-o9cq804qN9Kjha-YsRWQwG8hWo3I-im-wechat')
  assert.notEqual(tree, null, 'a weixin Session must render a mark')
  const svg = types(tree).find((t) => t === 'svg')
  assert.ok(svg, 'the mark must be an svg glyph')
  assert.equal(paths(tree).length, 1, 'exactly one path draws the glyph')
})

test('an extra line of the same conversation also carries the mark', async () => {
  // A line id is the base id plus `--<stamp>`; if the test only accepted the
  // bare base id, every line after the first would lose its mark.
  const { tree } = await markFor('weixin-o9cq804qN9Kjha-YsRWQwG8hWo3I-im-wechat--mvag9l5s0vuey9')
  assert.notEqual(tree, null)
  assert.equal(paths(tree).length, 1)
})

test('the glyph is the WeChat logo and it is WeChat green', async () => {
  const { tree } = await markFor('weixin-abc-im-bot')
  const [d] = paths(tree)
  // The simple-icons WeChat path starts at the first bubble's arc and names the
  // slug in its own coordinates; asserting the opening segment plus a known
  // interior point pins the shape without copying 1220 characters into a test.
  assert.match(d, /^M8\.691 2\.188C3\.891 2\.188 0 5\.476 0 9\.53/, 'must be the simple-icons WeChat path')
  assert.ok(d.includes('M5.785 5.991'), 'the first bubble\'s eye must be present')
  assert.ok(d.includes('24 14.98'), 'the second bubble must be present')
  const svg = (function find(node) {
    if (node === null || node === undefined || typeof node !== 'object') return null
    if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null
    if (node.type === 'svg') return node
    return (node.children ?? []).map(find).find(Boolean) ?? null
  })(tree)
  assert.equal(svg.props.fill, '#07C160', 'the mark must use WeChat green, not a shell state token')
  assert.equal(svg.props["aria-hidden"], 'true', 'the seat is decorative and takes no label')
})

test('a Session from somewhere else gets nothing at all', async () => {
  // The seat is rendered for every row in the workspace. These are the ids the
  // host actually mints for its own Sessions and for a WeChat *named* session
  // that this plugin did not open.
  const foreign = [
    'session-ddac398a-e114-42a0-bd59-c913b582af8c',
    'session-a63fbb08-92c3-43e3-96e3-8143f982d594',
    'weixin',
    'x-weixin-abc',
    'my-weixin-abc',
    '',
  ]
  for (const sessionId of foreign) {
    const { tree } = await markFor(sessionId)
    assert.equal(tree, null, `"${sessionId}" must render null, saw ${JSON.stringify(tree)}`)
  }
})

test('a non-string Session id is refused rather than throwing', async () => {
  // The seat's props come from the host's row, so an undefined id is a load
  // ordering fact, not an impossibility: returning a glyph there would put the
  // WeChat logo on a row whose identity never arrived.
  for (const sessionId of [undefined, null, 42, {}, []]) {
    const { tree } = await markFor(sessionId)
    assert.equal(tree, null, `${String(sessionId)} must render null`)
  }
})

test('the mark claims the seat without shadowing the host\'s own occupant', async () => {
  const { entry } = await mountRowSeat()
  // `list` seats elect one winner per cell id, so a distinct id is what keeps
  // this mark from displacing ui-schedule's clock on a row that has both.
  assert.equal(entry.options.name, ROW_SEAT)
  assert.ok(entry.options.id && entry.options.id !== 'schedule-mark', 'must occupy its own cell')
})

test('the row shows a faint account hint for a session line the mapping knows', async () => {
  // The hint is the multi-account ownership whisper: which WeChat account a
  // session row belongs to, sourced from the same sessions() the card reads.
  // The harness flush() drains effects for real, so the owner fetch runs; the
  // re-render it schedules settles on the scheduled microtask chain, which
  // needs a macrotask yield before a second flush can paint the hint.
  const sessionId = 'weixin-room-1--abc123'
  const marked = await markFor(sessionId, {
    conversations: [{
      conversationId: 'aaaaaaaaaaaa-im-bot:room-1',
      accountId: 'aaaaaaaaaaaa@im.bot',
      accountLabel: '工作号备注名很长很长',
      active: sessionId,
      lines: [{ sessionId, title: 't', createdAt: 1 }],
    }],
  })
  for (let i=0;i<6;i++) { await new Promise(r=>setTimeout(r,5)); }
  const tree = await marked.hooks.flush()
    .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
    .then(() => marked.hooks.flush())
    const text = stringChildren(tree)
      const hint = text.find((s) => s.includes('…'))
  assert.ok(hint, `a labelled line must show the account hint, saw ${JSON.stringify(text)}`)
  // Six characters, then the ellipsis — the spec's cap.
  assert.equal(Array.from(hint).length, 7, 'six characters plus the ellipsis')
  assert.ok(hint.startsWith('工作号备注名'.slice(0, 6)), 'the label is truncated at six characters')
})

test('an unattributed session shows no hint and still shows the glyph', async () => {
  // Pre-multi-account lines have no owner the mapping knows; the hint must be
  // silent there rather than guessing — but the WeChat mark stays.
  const { tree } = await markFor('weixin-room-1--no-owner')
  const svg = types(tree).find((t) => t === 'svg')
  assert.ok(svg, 'the glyph must survive without an owner')
  assert.deepEqual(stringChildren(tree).filter((s) => s.includes('…')), [], 'no hint without attribution')
})
