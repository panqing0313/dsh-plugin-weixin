/**
 * The Sessions tab in the settings card.
 *
 * `src/client.js` is a host module, so it only ever runs inside the loader with
 * a `react` binding. The stub react most tests use has a no-op `useState`, which
 * cannot show a list that arrives from an await — every render would look like
 * the first. This file reuses the working hook runtime from
 * client-login-poll.test.js: real slots, dep-compared effects, and a flush()
 * that settles the tree, so the async load and the switch button are actually
 * exercised rather than merely spelled.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.join(HERE, '..', 'src', 'client.js')

/** Minimal stand-in for the host's element factory. */
function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
  return { type, props: props ?? {}, children: flat }
}

/**
 * The hook runtime. Same contract as the one in client-login-poll.test.js:
 * slots are addressed by call order, effects run after the render that declared
 * them, and a setter schedules another pass.
 */
function createHooks() {
  let segments = new Map()
  const componentStack = []
  let pendingEffects = []
  let root = null
  let tree = null
  let renderPass = false
  let dirty = false

  const sameDeps = (a, b) =>
    a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  const paint = () => {
    // Slot segments are keyed by component and PERSIST across passes: React
    // gives every component instance its own hook list, so switching the
    // card's tab must not shift the slots the next component reads, and a
    // fresh map each pass would make every effect look like a first run and
    // re-schedule itself forever.
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

  // Effects may start async work (the sessions load is an await), so settling
  // means: run the effects, let their promises resolve, and render again until
  // neither the tree nor the microtask queue has anything left to do.
  const flush = async () => {
    for (let round = 0; round < 100; round += 1) {
      paint()
      const effects = pendingEffects
      if (effects.length === 0 && !dirty) {
        // Drain continuations scheduled by earlier effects before deciding the
        // tree is final: a resolved fetch calls setState outside this pass.
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
    // Called from a setter, which cannot await. Marking the tree dirty is
    // enough: the caller's next `await flush()` performs the render.
    dirty = true
    scheduled = scheduled.then(() => settleIfIdle())
  }

  let scheduled = Promise.resolve()
  const settleIfIdle = async () => {
    if (renderPass) return
    await flush()
  }

  const renderTree = (node) => {
    // A bare component function is normalised into an element so it goes
    // through the same segment-owning branch as a nested component; calling it
    // directly would leave it with no slot segment at all.
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
      if (!segment.slots[i]) {
        segment.slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = segment.slots[i]
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
    useEffect(fn, deps) {
      const segment = current()
      const i = segment.cursor++
      const slot = segment.slots[i]
      const changed = !slot || !sameDeps(slot.deps, deps)
      segment.slots[i] = { deps }
      if (changed) pendingEffects.push(fn)
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

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function textOf(node) {
  const parts = []
  walk(node, (element) => {
    for (const child of element.children ?? []) {
      if (typeof child === 'string') parts.push(child)
    }
  })
  return parts.join(' ')
}

function findButtonOrNull(tree, text) {
  let found = null
  walk(tree, (node) => {
    if (found || node.type !== 'button') return
    const label = (node.children ?? []).filter((c) => typeof c === 'string').join('')
    if (label.includes(text)) found = node
  })
  return found
}

/** Read the rows the list rendered, as the operator would see them. */
function rows(tree) {
  const seen = []
  walk(tree, (node) => {
    if (typeof node.type !== 'string') return
    for (const child of node.children ?? []) {
      if (typeof child === 'string' && /^\d+\.\s/.test(child)) seen.push(child)
    }
  })
  return seen
}

/** Two conversations, the first with a live line and an older one. */
function twoConversations() {
  return {
    conversations: [
      {
        conversationId: 'wxid_abc',
        active: 'weixin-wxid_abc--live',
        lines: [
          { sessionId: 'weixin-wxid_abc--live', title: '构建报错排查' },
          { sessionId: 'weixin-wxid_abc--old', title: '翻译一段文字' },
        ],
      },
      {
        conversationId: 'wxid_def',
        active: 'weixin-wxid_def',
        lines: [{ sessionId: 'weixin-wxid_def', title: '' }],
      },
    ],
  }
}

/** The host half this card talks to, with every call recorded. */
function fakeRemote(script = {}) {
  const calls = { sessions: 0, useSession: [] }
  const remote = {
    weixin: {
      namespace: 'weixin',
      // Bare host values: the real carrier wraps them, and `callRemote`
      // unwraps, so a fake that returned `{ok:true,...}` would be read as an
      // envelope and stripped.
      async sessions() {
        calls.sessions += 1
        if (script.sessionsError) throw new Error(script.sessionsError)
        return script.sessions ?? twoConversations()
      },
      async useSession(conversationId, index) {
        calls.useSession.push([conversationId, index])
        if (script.useError) return { switched: false, error: script.useError }
        return { switched: true, sessionId: 'x' }
      },
      // Not used by this tab, but the card mounts the account tab too.
      async startLogin() {
        return { status: 'wait', sessionKey: 's', qrcodeUrl: '' }
      },
      async poll() {
        return { status: 'wait' }
      },
      async status() {
        return { accounts: [], stateDir: '/tmp', pendingLogin: false, sessionExpired: false }
      },
      async cancel() {},
      async logout() {
        return { removed: [], reloadRequired: false }
      },
    },
    weixinConfig: {
      namespace: 'weixinConfig',
      list: async () => ({ groups: [], configFile: '/tmp/config.json' }),
      save: async () => ({ groups: [] }),
      reset: async () => ({ groups: [] }),
    },
    weixinAsr: {
      namespace: 'weixinAsr',
      listModels: async () => ({ models: [], modelDir: '' }),
      getDownloadSettings: async () => ({}),
    },
    directoryPicker: { namespace: 'directoryPicker', pick: async () => null },
  }
  return { remote, calls }
}

/** Load src/client.js under the working hook runtime and render the card. */
async function mountCard(host) {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  const hooks = createHooks()
  let registration
  const registrations = new Map()

  const ctx = {
    remote: { ...host.remote, $mount: async () => async () => {} },
    logger: { info() {}, warn() {}, error() {} },
    slots: {
      inject: (_point, cb) => {
        cb()
        return { dispose: async () => {} }
      },
      register: (options, component) => {
        // `register(options, Component)` — the component is the second
        // argument. Registrations are kept BY SLOT NAME: the plugin now
        // occupies more than one seat (the settings card on
        // plugins.bundle.config, plus the session row mark on
        // sidebar.session.row.leading), so "keep the last component" would
        // hand this file the row mark instead of the card it is about.
        if (component) registrations.set(options.name, { options, component })
        return { dispose: async () => {} }
      },
    },
    locale: { getSnapshot: () => ({ active: 'zh', locales: ['zh', 'en'], revision: 0 }) },
  }
  // `src/client.js` declares its dependencies by dotted service name, and a
  // context resolves those as literal keys, so the namespaces have to be
  // reachable both ways: `ctx["remote.weixin"]` for the declaration and
  // `ctx.remote.weixin` for the calls the card makes.
  ctx['remote.weixin'] = host.remote.weixin
  ctx['remote.weixinAsr'] = host.remote.weixinAsr
  ctx['remote.weixinConfig'] = host.remote.weixinConfig
  ctx['remote.directoryPicker'] = host.remote.directoryPicker
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

  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registration = r } } } }
  vm.createContext(sandbox)
  new vm.Script(source, { filename: CLIENT_PATH }).runInContext(sandbox)

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
  // The card is a lazy chunk now, so the fake require needs the one method the
  // real loader hands factories: `async(relativeChunk)` runs the sibling script
  // in the same window and returns its exports.
  require.async = async (spec) => {
    const file = String(spec).replace(/^\.\//, '')
    let found = chunkRegistrations.get(file)
    if (found === undefined) {
      const chunkSource = fs.readFileSync(path.join(path.dirname(CLIENT_PATH), file), 'utf8')
      new vm.Script(chunkSource, { filename: file }).runInContext(sandbox)
      found = chunkRegistrations.get(file)
    }
    if (found === undefined) throw new Error(`chunk ${file} did not register with __ModuleLoader__.load`)
    return found.factory(require)
  }

  await registration.factory(require).apply(ctx)

  hooks.setRoot(registrations.get('plugins.bundle.config').component)
  await await hooks.flush()
  return { hooks, calls: host.calls }
}

/**
 * Click the tab whose label contains `text` and let the card settle.
 *
 * The setter schedules a render, and the runtime runs it synchronously when we
 * are not already inside a pass — so the click must be followed by a flush
 * before the newly selected panel exists in the tree.
 */
async function openTab(hooks, text) {
  const tab = findButtonOrNull(await hooks.flush(), text)
  assert.ok(tab, `no tab labelled "${text}"`)
  tab.props.onClick()
  return await hooks.flush()
}

test('the settings card offers a sessions tab', async () => {
  const { remote } = fakeRemote()
  const { hooks } = await mountCard({ remote })
  const tree = await openTab(hooks, '会话')
  // Opening the tab runs its effect; flush again so the async load lands.
  const loaded = await hooks.flush()
  assert.match(textOf(loaded), /构建报错排查/, 'the title of a line must be shown')
})

test('a line shows its title, and an untitled line says so', async () => {
  const { remote } = fakeRemote()
  const { hooks } = await mountCard({ remote })
  await openTab(hooks, '会话')
  const tree = await await hooks.flush()
  assert.match(textOf(tree), /构建报错排查/)
  assert.match(textOf(tree), /翻译一段文字/)
  assert.match(textOf(tree), /（尚无对话）/, 'a line with no messages must not render as blank')
})

test('the active line is marked, and only it', async () => {
  const { remote } = fakeRemote()
  const { hooks } = await mountCard({ remote })
  await openTab(hooks, '会话')
  const tree = await await hooks.flush()
  const marks = []
  walk(tree, (node) => {
    for (const child of node.children ?? []) {
      if (child === '▶') marks.push(child)
    }
  })
  // One active line per conversation, and there are two conversations.
  assert.equal(marks.length, 2, `expected one ▶ per conversation, saw ${marks.length}`)
  assert.match(textOf(tree), /使用中/)
})

test('the active line cannot be switched to (no button), older lines can', async () => {
  const { remote } = fakeRemote()
  const { hooks } = await mountCard({ remote })
  await openTab(hooks, '会话')
  const tree = await await hooks.flush()
  const useButtons = []
  walk(tree, (node) => {
    if (node.type !== 'button') return
    const label = (node.children ?? []).filter((c) => typeof c === 'string').join('')
    if (label.includes('切换')) useButtons.push(label)
  })
  // Two conversations, one active line each => the two older lines are switchable.
  assert.equal(useButtons.length, 1, 'only the non-active line in conversation 1 is switchable')
})

test('switching posts the conversation and index, then reloads', async () => {
  const { remote, calls } = fakeRemote()
  const { hooks } = await mountCard({ remote })
  await openTab(hooks, '会话')
  await hooks.flush()
  const button = findButtonOrNull(await hooks.flush(), '切换')
  assert.ok(button, 'the older line must offer a switch button')
  await button.props.onClick()
  await hooks.flush()
  assert.deepEqual(calls.useSession, [['wxid_abc', 1]])
  assert.ok(calls.sessions >= 2, 'the list must be re-read after switching')
})

test('a failed switch is reported instead of silently ignored', async () => {
  const { remote } = fakeRemote({ useError: '没有第 9 条会话。' })
  const { hooks } = await mountCard({ remote })
  await openTab(hooks, '会话')
  await hooks.flush()
  const button = findButtonOrNull(await hooks.flush(), '切换')
  await button.props.onClick()
  const tree = await await hooks.flush()
  assert.match(textOf(tree), /没有第 9 条会话/, 'the host error must reach the operator')
})

test('an unreadable store shows the error, not an empty list', async () => {
  const { remote } = fakeRemote({ sessionsError: 'state directory is not writable' })
  const { hooks } = await mountCard({ remote })
  await openTab(hooks, '会话')
  const tree = await await hooks.flush()
  assert.match(textOf(tree), /state directory is not writable/)
})

test('no conversation yet reads as an instruction, not as an error', async () => {
  const { remote } = fakeRemote({ sessions: { conversations: [] } })
  const { hooks } = await mountCard({ remote })
  await openTab(hooks, '会话')
  const tree = await await hooks.flush()
  assert.match(textOf(tree), /还没有会话/)
  assert.doesNotMatch(textOf(tree), /⚠/)
})
