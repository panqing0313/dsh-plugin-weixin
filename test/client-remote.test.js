/**
 * Tests for the browser half: the generated Remote descriptor table and the
 * QR login helper.
 *
 * The descriptor table is loaded exactly the way the DSH web boot loads it —
 * through `window.__ModuleLoader__.load({id, factory})` — because the failures
 * this file guards against are only visible in the shape of that registration:
 * a `wire` field that does not match its parameter name throws inside
 * `apply()` during boot, which surfaces to the user as
 * `web boot: 1 entry did not activate` with no useful detail.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { qrDataUrl } from '../src/qr-png.js'

const CLIENT_PATH = new URL('../src/client.js', import.meta.url)

/** Wire names must be usable as an RPC argument key and as an object property. */
const WIRE_RE = /^[A-Za-z0-9_$.-]+$/

/**
 * Load src/client.js under a minimal ModuleLoader shim and return its factory.
 * @returns {(require: (spec: string) => unknown) => { apply: Function, inject: string[] }}
 */
function loadClientModule() {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registration = r } } },
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.ok(registration, 'client.js must register itself with __ModuleLoader__.load')
  return registration
}

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children }
}

/** The two modules the platform seeds for every client bundle. */
function fakeRequire(spec) {
  if (spec === 'react') {
    return {
      createElement,
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useRef: (initial) => ({ current: initial }),
      useCallback: (fn) => fn,
      useEffect: () => {},
    }
  }
  if (spec === 'react/jsx-runtime') return { jsx: createElement, jsxs: createElement }
  throw new Error(`client.js required an unseeded module: ${spec}`)
}

/** Emulate the typert descriptor validation that runs during $mount. */
function validateContribution(contribution) {
  assert.equal(typeof contribution.package, 'string')
  const methods = new Set()
  for (const descriptor of contribution.descriptors) {
    const endpoint = `${descriptor.namespace}/${descriptor.method}`
    assert.equal(methods.has(endpoint), false, `duplicate method ${endpoint}`)
    methods.add(endpoint)

    const wires = new Set()
    for (const parameter of descriptor.parameters) {
      assert.match(parameter.name, WIRE_RE, `bad parameter name in ${descriptor.id}`)
      assert.match(parameter.wire, WIRE_RE, `bad wire field in ${descriptor.id}`)
      // The original crash: two parameters sharing one wire name.
      assert.equal(
        wires.has(parameter.wire),
        false,
        `invocation "${descriptor.id}" repeats wire field "${parameter.wire}"`,
      )
      wires.add(parameter.wire)
      assert.equal(typeof parameter.codec?.create, 'function', `no codec in ${descriptor.id}`)
      assert.equal(parameter.codec?.mode, 'strict', `non-strict codec in ${descriptor.id}`)
    }
    assert.equal(descriptor.result?.mode, 'strict')
  }
  return methods
}

/**
 * Build a ctx that behaves like the real client one for the parts apply() uses.
 * @param {{ onMount?: (c: object) => void }} [hooks]
 */
function fakeCtx(hooks = {}) {
  const seats = []
  const ctx = {
    remote: {
      $mount: async (contribution) => {
        validateContribution(contribution)
        hooks.onMount?.(contribution)
        // The real $mount registers one Cordis service per namespace, named
        // `remote.<namespace>`. Modelling that here is what makes a missing
        // "remote.weixin" in inject observable: the namespace simply is not a
        // property of the context yet.
        for (const namespace of new Set(contribution.descriptors.map((d) => d.namespace))) {
          ctx[`remote.${namespace}`] = { namespace }
        }
        return async () => {
          for (const namespace of new Set(contribution.descriptors.map((d) => d.namespace))) {
            delete ctx[`remote.${namespace}`]
          }
        }
      },
    },
    slots: {
      inject: (_name, register) => { register() },
      register: (meta, component) => { seats.push({ meta, component }); return () => {} },
    },
    locale: { current: { language: 'zh' } },
  }
  // Cordis' ctx.inject(deps, callback) returns a Fiber (thenable with dispose);
  // model that, since apply() disposes it on both the happy and error paths.
  // A dependency that is not present is a hard error, exactly like the real
  // `cannot get property "..." without inject` guard.
  ctx.inject = (deps, callback) => {
    const sub = {}
    for (const dep of deps) {
      assert.ok(
        ctx[dep] !== undefined,
        `injected service "${dep}" is not available — declare it in inject`,
      )
      sub[dep] = ctx[dep]
    }
    const value = callback(sub)
    return { dispose: async () => {}, then: (fn) => Promise.resolve(value).then(fn) }
  }
  ctx.seats = seats
  return ctx
}

test('the client bundle registers under its package id and exposes apply/inject', () => {
  const registration = loadClientModule()
  assert.equal(registration.id, 'dsh-plugin-weixin')
  const mod = registration.factory(fakeRequire)
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual([...mod.inject].sort(), ['locale', 'remote', 'slots'])
})

test('the entry inject must not wait for the namespaces it creates itself', () => {
  // `remote.weixin` is installed by apply() -> ctx.remote.$mount(). Naming it in
  // the entry inject makes Cordis wait for a service that only appears once the
  // entry itself starts, so the boot audit reports
  // `pending (waiting for services: remote.weixin, remote.weixinAsr)` and the
  // plugin never activates. The namespaces belong on the inner ctx.inject,
  // which runs after $mount. The official voice-input bundle follows the same
  // rule: entry inject has "remote" but not "remote.speech".
  const registration = loadClientModule()
  const mod = registration.factory(fakeRequire)
  for (const dep of mod.inject) {
    assert.ok(
      !dep.startsWith('remote.'),
      `entry inject must not name the namespace "${dep}"; declare it on the inner ctx.inject`,
    )
  }
  // The namespaces still have to be declared somewhere, or the UI's
  // ctx.remote.weixin.* reads throw. Assert the inner inject carries them.
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  const inner = source.match(/ctx\.inject\(\s*\[([^\]]*)\]/)
  assert.ok(inner, 'apply() must call ctx.inject([...], registerUi)')
  const innerDeps = [...inner[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  for (const namespace of ['remote.weixin', 'remote.weixinAsr']) {
    assert.ok(
      innerDeps.includes(namespace),
      `inner ctx.inject must declare "${namespace}" (found: ${innerDeps.join(', ')})`,
    )
  }
})

test('every Remote descriptor has a unique wire field matching its parameter name', () => {
  const registration = loadClientModule()
  const mod = registration.factory(fakeRequire)
  let mounted
  const ctx = fakeCtx({ onMount: (c) => { mounted = c } })

  return mod.apply(ctx).then(async (dispose) => {
    assert.ok(mounted, 'apply() must mount a Remote contribution')
    const methods = validateContribution(mounted)
    // The wire field is the RPC argument key, so it must equal the name the
    // host-side method signature exposes — anything else silently misroutes
    // arguments. This is what caught `wire: "json"` on two parameters.
    for (const descriptor of mounted.descriptors) {
      for (const parameter of descriptor.parameters) {
        assert.equal(parameter.wire, parameter.name, `${descriptor.id}: wire must equal name`)
      }
    }
    assert.deepEqual(
      [...methods].sort(),
      [
        'weixin/cancel',
        'weixin/poll',
        'weixin/startLogin',
        'weixin/status',
        'weixin/submitVerifyCode',
        'weixinAsr/downloadModel',
        'weixinAsr/downloadStatus',
        'weixinAsr/listModels',
        'weixinAsr/setModelDir',
      ],
    )
    await dispose()
  })
})

test('apply() registers the settings card and disposes cleanly', async () => {
  const registration = loadClientModule()
  const mod = registration.factory(fakeRequire)
  const ctx = fakeCtx()
  const dispose = await mod.apply(ctx)
  assert.equal(ctx.seats.length, 1)
  assert.equal(ctx.seats[0].meta.name, 'plugins.bundle.config')
  // The seat key is the package name the settings owner dispatches on.
  assert.equal(ctx.seats[0].meta.key, 'dsh-plugin-weixin')
  await dispose()
})

test('every Remote call that reads a host field goes through the envelope', () => {
  // A Remote invocation resolves to {ok, value}, not to the bare host value.
  // Reading `r.qrcodeUrl` off the envelope is always undefined, which renders
  // as a permanent "loading" placeholder with no error anywhere. Each
  // data-returning call must therefore be unwrapped; a fire-and-forget call
  // (`cancel`) is the only case where discarding the result is correct.
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  const wrapped = (text) => text.includes('callRemote(')
  const calls = [...source.matchAll(/ctx\.remote\.(weixin|weixinAsr)\.(\w+)\(/g)]
  assert.ok(calls.length > 0, 'expected the card to call Remote methods')
  // A wrapped call appears as `callRemote(() => ctx.remote.ns.method(` — the
  // `callRemote(` sits in the same expression, so match on a window before it.
  for (const match of calls) {
    const at = match.index
    const window = source.slice(Math.max(0, at - 40), at + match[0].length)
    const method = match[2]
    // `cancel` is fire-and-forget: its result is intentionally discarded.
    const readsResult = method !== 'cancel'
    if (readsResult) {
      assert.ok(
        window.includes('callRemote('),
        `ctx.remote.${method}() must be wrapped in callRemote(...) to unwrap the {ok, value} envelope`,
      )
    } else {
      assert.ok(
        !window.includes('callRemote('),
        `ctx.remote.${method}() discards its result; wrapping it would be misleading`,
      )
    }
  }
  // Both the success and failure branches of the envelope have to be handled.
  assert.match(source, /if \(!result\.ok\) throw/, 'unwrap() must surface the failure branch')
  assert.match(source, /return result\.value/, 'unwrap() must return the success value')
})

test('a descriptor table that repeats a wire field is rejected, as the runtime does', () => {
  // Guards the validator itself: if this stopped throwing, the test above would
  // pass even with the original bug reintroduced.
  assert.throws(
    () => validateContribution({
      package: 'p',
      descriptors: [{
        id: 'p#ns/m',
        namespace: 'ns',
        method: 'm',
        parameters: [
          { name: 'a', wire: 'json', codec: { mode: 'strict', create: () => {} } },
          { name: 'b', wire: 'json', codec: { mode: 'strict', create: () => {} } },
        ],
        result: { mode: 'strict' },
      }],
    }),
    /repeats wire field "json"/,
  )
})

test('qrDataUrl renders a scannable PNG, and the link stays the fallback', async () => {
  const url = await qrDataUrl('https://liteapp.weixin.qq.com/q/abc?qrcode=deadbeef&bot_type=3')
  if (url === undefined) {
    // No encoder on this machine is a supported outcome: the UI then shows the
    // clickable link instead of an image, which is why the field is optional.
    assert.ok(true)
    return
  }
  assert.ok(url.startsWith('data:image/png;base64,'), 'must be a PNG data URL')
  const bytes = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
  // PNG magic number, so the <img> actually decodes rather than showing a
  // broken image (the original bug: the login URL was used as an img src).
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.ok(bytes.length > 100, 'a QR PNG is not a few bytes')
})

test('qrDataUrl leaves no temporary files behind', async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('dsh-weixin-qr-')).length
  await qrDataUrl('https://liteapp.weixin.qq.com/q/cleanup?bot_type=3')
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('dsh-weixin-qr-')).length
  assert.equal(after, before, 'the temp PNG must be removed even on success')
  void path
})
