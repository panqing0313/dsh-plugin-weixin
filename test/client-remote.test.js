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
    // The browser always has this; the test sandbox must too, or the chooser's
    // Remote path would be exercised as "environment missing".
    AbortController,
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
    locale: { getSnapshot: () => ({ active: 'zh', locales: ['zh', 'en'], revision: 0 }) },
  }
  // The shell mounts this Remote itself (the web client's platform-neutral
  // assembly calls $mount for the workspace controller), so it is present
  // before any bundle activates. Modelling it is what lets a test tell a
  // genuinely absent chooser from one this plugin failed to declare.
  if (hooks.directoryPicker !== false) {
    ctx['remote.directoryPicker'] = {
      namespace: 'directoryPicker',
      pick: hooks.pick ?? (async () => null),
    }
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
        'weixin/allowlist',
        'weixin/cancel',
        'weixin/donateQr',
        'weixin/journal',
        'weixin/journalExport',
        'weixin/label',
        'weixin/logout',
        'weixin/memoryConvClear',
        'weixin/memoryEventAdd',
        'weixin/memoryEventDone',
        'weixin/memoryEventRemove',
        'weixin/memoryFactAdd',
        'weixin/memoryFactRemove',
        'weixin/memoryProfileSave',
        'weixin/pause',
        'weixin/personaAccountDefaultSet',
        'weixin/personaDefaultSet',
        'weixin/personaModeRemove',
        'weixin/personaModeSave',
        'weixin/personaOverrideClear',
        'weixin/personaOverview',
        'weixin/poll',
        'weixin/remindCancel',
        'weixin/reminders',
        'weixin/removeSession',
        'weixin/resume',
        'weixin/sessions',
        'weixin/startLogin',
        'weixin/stats',
        'weixin/status',
        'weixin/submitVerifyCode',
        'weixin/useSession',
        'weixinAsr/downloadModel',
        'weixinAsr/downloadStatus',
        'weixinAsr/getDownloadSettings',
        'weixinAsr/listModels',
        'weixinAsr/setDownloadSettings',
        'weixinAsr/setModelDir',
        'weixinConfig/list',
        'weixinConfig/reset',
        'weixinConfig/save',
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
  // Five seats: the same card in two homes (the plugin bundle page and the
  // shell Settings nav entry), the left sidebar's panel row plus the page it
  // opens (both addressed by the SAME id — a row whose id has no page throws
  // on click), and the session row mark on sidebar.session.row.leading.
  assert.equal(ctx.seats.length, 5)
  const seat = (name) => {
    const found = ctx.seats.find((entry) => entry.meta.name === name)
    assert.ok(found, `no seat registered for ${name}`)
    return found
  }
  const bundlePage = seat('plugins.bundle.config')
  // The seat key is the package name the settings owner dispatches on.
  assert.equal(bundlePage.meta.key, 'dsh-plugin-weixin')
  assert.equal(seat('settings.section').meta.id, 'dsh-plugin-weixin-settings')
  // The panel row and its page are one feature: the row's id is the page's
  // key, and the exported constant is what both carry.
  const panelRow = seat('sidebar.panellist')
  assert.equal(panelRow.meta.id, mod.PANEL_ID)
  assert.equal(seat('main').meta.key, mod.PANEL_ID)
  assert.equal(typeof panelRow.meta.label, 'function', 'the row label is a locale thunk')
  assert.equal(panelRow.meta.label(), '微信')
  assert.equal(seat('sidebar.session.row.leading').meta.id, 'dsh-plugin-weixin-row-mark')
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

test('the directory chooser unwraps its Remote result and survives its absence', async () => {
  // The shell mounts `directoryPicker` (namespace of the workspace controller)
  // and it resolves to the same {ok, value} envelope as everything else — the
  // chosen path, or null when the operator cancels. It also belongs to another
  // bundle, so a minimal profile may not have it at all.
  //
  // The distinction this test now pins is the one that hid the bug: an operator
  // who cancels and an environment with no chooser are different outcomes. The
  // earlier version returned a bare null for both, so a working chooser that
  // this plugin had merely failed to declare was reported to the user as absent.
  const registration = loadClientModule()
  const mod = registration.factory(fakeRequire)

  // 1. The ordinary path: a string path inside the envelope.
  let calledWith = 'not called'
  const restored = await mod.pickDirectory({
    remote: {
      directoryPicker: {
        pick: async (...args) => {
          calledWith = args
          return { ok: true, value: '/Users/someone/models' }
        },
      },
    },
  })
  // The module is evaluated in a separate VM realm, so an object it returns has
  // that realm's Object.prototype and strict deepEqual would reject it for being
  // a different prototype even when every field matches. Compare own fields.
  const plain = (value) => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(restored), { ok: true, path: '/Users/someone/models' })
  assert.deepEqual(
    calledWith,
    [],
    'pick() declares parameters: [] — the signal is a cancellation option, not a positional argument',
  )

  // 2. Cancelling is a normal outcome, and must be reported as a cancellation
  //    rather than as a missing chooser.
  assert.deepEqual(
    plain(await mod.pickDirectory({
      remote: { directoryPicker: { pick: async () => ({ ok: true, value: null }) } },
    })),
    { ok: false, reason: 'cancelled' },
  )

  // 3. A rejected Remote whose error is a cancellation is also a cancellation;
  //    the carrier signals both withdrawal and dismissal through the envelope.
  assert.deepEqual(
    plain(await mod.pickDirectory({
      remote: {
        directoryPicker: { pick: async () => ({ ok: false, error: { code: 'cancelled' } }) },
      },
    })),
    { ok: false, reason: 'cancelled' },
  )

  // 4. A rejection that is NOT a cancellation falls through to the bridge, and
  //    with no bridge present that is an unavailable chooser — never a silent
  //    success.
  assert.deepEqual(
    plain(await mod.pickDirectory({
      remote: { directoryPicker: { pick: async () => ({ ok: false, error: new Error('boom') }) } },
    })),
    { ok: false, reason: 'unavailable' },
  )

  // 5. A profile whose shell mounts no chooser at all.
  assert.deepEqual(plain(await mod.pickDirectory({ remote: {} })), { ok: false, reason: 'unavailable' })

  // 6. An empty string is "nothing chosen", never a directory.
  assert.deepEqual(
    plain(await mod.pickDirectory({
      remote: { directoryPicker: { pick: async () => ({ ok: true, value: '' }) } },
    })),
    { ok: false, reason: 'cancelled' },
  )
})

test('the card declares the services it reads, including ones it does not own', () => {
  // This is the bug that made "浏览…" do nothing useful in the Web GUI: every
  // namespace is its own Cordis service, and reading an undeclared one yields
  // `undefined` instead of throwing. `remote.directoryPicker` belongs to the
  // shell rather than to this plugin, so it was easy to reach for it without
  // declaring it — and the card then concluded, silently and wrongly, that the
  // environment had no chooser.
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')

  const injectCall = source.match(/ctx\.inject\(\s*\[([^\]]*)\]/)
  assert.ok(injectCall, 'apply() must declare its dependencies with ctx.inject([...])')
  const declared = [...injectCall[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])

  // Every `ctx.remote.<namespace>` the source reads must be declared. `$mount`
  // is a method on the container itself rather than a namespace service, so it
  // is excluded; everything else has to appear in the inject list.
  const read = new Set(
    [...source.matchAll(/ctx\.remote\??\.([A-Za-z_$][\w$]*)/g)]
      .map((m) => m[1])
      .filter((name) => !name.startsWith('$')),
  )
  for (const namespace of read) {
    assert.ok(
      declared.includes(`remote.${namespace}`),
      `the card reads ctx.remote.${namespace} but ctx.inject does not declare "remote.${namespace}"`,
    )
  }

  // And the namespace that caused the failure must stay declared, because the
  // shell mounts it and there is no other way to reach it.
  assert.ok(
    declared.includes('remote.directoryPicker'),
    'the host chooser is unreachable unless remote.directoryPicker is declared',
  )
})

test('the card styles itself with host tokens, not hardcoded colors', () => {
  // The card renders inside the app shell, which has both light and dark
  // themes. A literal color is correct in exactly one of them, and the earlier
  // version leaned on `opacity` for hierarchy — which in a dark theme produces
  // mud instead of a readable secondary tone.
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')

  // `opacity` on a disabled control is legitimate; using it as a text tone is not.
  const opacityUses = [...source.matchAll(/opacity: ([0-9.]+)/g)]
  for (const match of opacityUses) {
    const at = match.index
    const window = source.slice(Math.max(0, at - 120), at + 40)
    assert.ok(
      /disabled|buttonStyleFor/.test(window),
      `opacity ${match[1]} is used as a text tone, not for a disabled state`,
    )
  }

  // Named colors and hex literals must not appear as text/background styles.
  for (const bad of ['crimson', '#d4380d', 'color: "red"']) {
    assert.ok(!source.includes(bad), `hardcoded color ${bad} breaks the other theme`)
  }

  // Every token the vocabulary names must actually be a resolved alias, and the
  // text tones must come from the label scale rather than raw values.
  assert.match(source, /var\(--dsw-alias-label-primary/, 'primary text must use the label token')
  assert.match(source, /var\(--dsw-alias-label-secondary/, 'secondary text must use the label token')
  assert.match(source, /var\(--dsw-alias-border-l2/, 'borders must use the border token')
  assert.match(source, /var\(--dsw-alias-state-success-primary/, 'the ok state must use the state token')
})

test('every host remote method has a client descriptor, and vice versa', async () => {
  // The two halves declare the same surface in two places that cannot see each
  // other: the host lists method names in `remoteMethods(...)`, and the browser
  // hand-writes a descriptor per method for `$mount` to validate. Nothing at
  // runtime compares them. A method the host exposes but the client never
  // declares is simply unreachable from the card, and a client descriptor with
  // no host method fails only when the user clicks it. Both were live risks for
  // `logout`, which had to be added to both lists in one commit.
  const registration = loadClientModule()
  const mod = registration.factory(fakeRequire)
  let mounted
  const ctx = fakeCtx({ onMount: (c) => { mounted = c } })
  await mod.apply(ctx)

  const hostSource = fs.readFileSync(new URL('../src/login-remote.js', import.meta.url), 'utf8')
  const hostMethods = new Set(
    [...hostSource.matchAll(/remoteMethods\(\s*\w+\s*,\s*\[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1])),
  )
  assert.ok(hostMethods.size > 0, 'expected the host to declare remote methods')

  const clientMethods = new Set(
    mounted.descriptors.filter((d) => d.namespace === 'weixin').map((d) => d.method),
  )
  assert.deepEqual(
    [...clientMethods].sort(),
    [...hostMethods].sort(),
    'the weixin namespace must expose exactly the methods the host declares',
  )
  for (const descriptor of mounted.descriptors.filter((d) => d.namespace === 'weixin')) {
    assert.equal(
      descriptor.service,
      'weixinLoginController',
      `${descriptor.id} must target the login controller`,
    )
  }
})

test('every state the card renders matches what the host actually reports', () => {
  // The card briefly rendered a `status === "downloading"` branch and a
  // `progress` percentage. The host reports only running/done/failed/idle and no
  // percentage, so that branch was dead code and the progress figure would have
  // been invented. Pin the vocabulary to the host's.
  const client = fs.readFileSync(CLIENT_PATH, 'utf8')
  // CLIENT_PATH is a URL, so resolve the host half as a sibling URL.
  const host = fs.readFileSync(new URL('../src/asr-remote.js', import.meta.url), 'utf8')
  const hostStatuses = new Set([...host.matchAll(/status: "(\w+)"/g)].map((m) => m[1]))
  assert.ok(hostStatuses.size > 0, 'expected the host to report statuses')

  const dlBranches = [...client.matchAll(/dlStatus\.status === "(\w+)"/g)].map((m) => m[1])
  assert.ok(dlBranches.length > 0, 'expected the card to render download status')
  for (const status of dlBranches) {
    assert.ok(
      hostStatuses.has(status),
      `the card renders dlStatus "${status}", which the host never reports (host: ${[...hostStatuses].join(', ')})`,
    )
  }
  // The card may now show a percentage, but ONLY one the host measured: it is
  // parsed from the CLI's own tqdm output. The original guard banned a progress
  // figure outright because the host reported none; the risk it protected
  // against is unchanged — rendering a number nobody measured.
  //
  // `hostReads` used to be scraped with /rec\.(\w+)\s*=/ , which matched NOTHING
  // in this file -- the host builds its records as object literals passed to
  // `this.downloads.set`. So the allowlist below compared every rendered field
  // against an empty set, and any field not named in `synthetic` was skipped
  // without being checked at all. That is how `dlStatus.files` came to be read
  // as an object while the host was sending a string, rendering a literal
  // "undefined/undefined" in the card. Scrape the object literals instead, and
  // require every rendered field to be one of them.
  const hostFields = new Set()
  for (const call of host.matchAll(/this\.downloads\.set\(repoId,\s*\{([\s\S]*?)\n\s*\}\)/g)) {
    // `[^}]*` is wrong here: these records contain template literals like
    // `${files.length}/...`, whose closing brace would end the match early and
    // hide every field after it. Line-anchored matching reads the whole literal.
    for (const key of call[1].matchAll(/^\s*(\w+):/gm)) hostFields.add(key[1])
  }
  assert.ok(hostFields.size > 0, 'expected the host to report download fields')
  const rendered = [...client.matchAll(/dlStatus\.(\w+)/g)].map((m) => m[1])
  assert.ok(rendered.length > 0, 'expected the card to render download fields')
  for (const field of rendered) {
    assert.ok(
      hostFields.has(field),
      `the card renders dlStatus.${field}, which the host never reports (host: ${[...hostFields].join(', ')})`,
    )
  }
  // And the shape of a field must agree too, not just its name: `files` is a
  // "done/total" string, and reading `.done`/`.total` off it yields the two
  // "undefined"s this test exists to prevent.
  assert.match(
    client,
    /typeof dlStatus\.files === "string"/,
    'dlStatus.files must be read as the string the host sends',
  )
  assert.ok(
    !/dlStatus\.files\.\w/.test(client),
    'dlStatus.files must not be read as an object',
  )
  const synthetic = new Set(['progress', 'eta', 'speed', 'rate', 'bytesPerSecond'])
  for (const field of rendered) {
    if (!synthetic.has(field)) continue
    assert.ok(
      hostReads.has(field),
      `the card renders dlStatus.${field}, which the host never measures`,
    )
  }
  // A bar must be conditional on a measured value. Matching the condition
  // anywhere is not enough — it has to actually wrap the bar, or the check
  // passes while an unconditional bar renders a number nobody measured.
  // Find the bar's USE, not the style definition, then require the measured
  // percentage to be what conditions it.
  const first = client.indexOf('progressTrackStyle')
  const track = client.indexOf('progressTrackStyle', first + 1)
  assert.ok(track !== -1, 'expected the progress bar to be rendered somewhere')
  const guard = client.lastIndexOf('typeof dlStatus.percent === "number"', track)
  assert.ok(
    guard !== -1 && track - guard < 200,
    'the progress bar must be gated directly on a measured percentage',
  )
  // And the label must not claim a percentage it does not have.
  assert.match(
    client,
    /typeof dlStatus\.percent === "number"\s*\n?\s*\? t\(/,
    'the percentage label must be conditional too',
  )
})

test('the model directory field offers the host chooser and says so when absent', () => {
  // A wrong model directory only surfaces much later as "no model available",
  // and typing an absolute path by hand is the likeliest way to get one. The
  // card must therefore expose the host's own chooser, and must explain itself
  // when the profile provides none.
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  assert.match(source, /onClick: browseDir/, 'the directory field needs a browse button')
  assert.match(source, /await pickDirectory\(ctx\)/, 'browseDir must use the host chooser')
  assert.match(
    source,
    /No directory chooser is available here; type the path instead\./,
    'a missing chooser must be explained, not silently ignored',
  )
  // The chooser belongs to another bundle, so both fallbacks must exist.
  assert.match(source, /ctx\.remote\?\.directoryPicker/, 'the mounted Remote is the primary path')
  assert.match(source, /__DSH_DIRECTORY_PICKER__/, 'the Electron bridge is the fallback')
  // Selecting a directory fills the field; only "Set directory" writes it, so a
  // cancelled dialog can never persist an empty value.
  assert.match(source, /setDirInput\(picked\.path\)/, 'the chosen path must reach the input')
  // A cancelled dialog and a missing chooser are different outcomes: only the
  // second one is worth a message, and the guard is what keeps them apart.
  assert.match(
    source,
    /picked\.reason === PICK_UNAVAILABLE/,
    'only an absent chooser may be reported as absent',
  )
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
  // `undefined` used to be an accepted outcome here ("no encoder on this
  // machine"), which is exactly how a broken-image icon on Windows shipped with
  // a green suite: this assertion returned true and the next three never ran.
  // The encoder no longer touches anything outside node:zlib and a declared
  // dependency, so a real image is required on every platform.
  assert.notEqual(url, undefined, 'the encoder must not depend on the machine having python or qrcode')
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

test('clearing the proxy sends the empty value, not the stale one', () => {
  // `saveProxy` closes over the `proxyInput` of the render that created it and
  // no re-render happens in between, so `setProxyInput(""); saveProxy()` wrote
  // the OLD proxy back — clicking "直连" silently kept the proxy it was meant
  // to remove. Nothing errored, nothing was logged, and the proxy stayed.
  // T4 moved to a staged bar: the write is `saveDownloadSettings`, which must
  // pass the empty string for "direct" explicitly (same stale-state class of
  // bug, one level up).
  const client = fs.readFileSync(CLIENT_PATH, 'utf8')

  const save = client.match(/const saveProxy = async \(value\) => \{[\s\S]*?\n\t\t\t\};/)
  const bulk = client.match(/const saveDownloadSettings = async \(\) => \{[\s\S]*?\n\t\t\t\};/)
  assert.ok(save, 'saveProxy must stay a findable handler')
  assert.ok(bulk, 'saveDownloadSettings must stay a findable handler')

  assert.match(save[0], /async \(value\)/, 'saveProxy must take the value to save')
  assert.match(
    save[0],
    /setDownloadSettings\(undefined, next\)/,
    'it must send that value, not read the render-time state',
  )
  assert.match(
    save[0],
    /String\(value \?\? proxyInput\)/,
    'an omitted value may still fall back to the input, so the Save button works',
  )
  // "direct" means "clear the proxy": the empty value must be sent explicitly.
  assert.match(bulk[0], /proxyMode === "direct" \? "" : String\(proxyInput\)\.trim\(\)/,
    'the bulk save must clear the proxy with "" — never a bare variable read')
  // The staged bar writes both halves in one call, not two racing writes.
  assert.match(bulk[0], /setDownloadSettings\(endpoint, proxy\)/,
    'the bulk save must send endpoint and proxy together')
  // The radios must NOT write on click anymore: a click only stages.
  assert.doesNotMatch(
    client,
    /onChange: \(\) => (chooseSource|chooseProxyMode)\(choice\.id\)/,
    'a radio click must not call a saving handler directly',
  )
  assert.doesNotMatch(
    client,
    /setProxyInput\(""\);\s*\n\s*saveProxy\(""\)/,
    'the old instant-clear path must stay dead',
  )

  // And the Save button must not hand the click event to `saveProxy` as the
  // value: an event stringifies to "[object Object]" and would be rejected as
  // an unusable proxy.
  assert.match(
    client,
    /onClick: \(\) => saveProxy\(proxyInput\)/,
    'the Save button must wrap the handler so it receives the input, not the event',
  )
})

test('the log out button is offered only when bound, and stays non-primary', () => {
  // Two ways this button can hurt the operator:
  //   - Showing it with nothing bound makes a destructive action reachable in a
  //     state where it can only report "nothing removed".
  //   - Making it the primary button puts "delete my credentials" where "scan
  //     to log in" belongs, one mis-click from the action the card exists for.
  const client = fs.readFileSync(CLIENT_PATH, 'utf8')

  const handler = client.match(/const leaveAccount = async \(\) => \{[\s\S]*?\n\t\t\t\};/)
  assert.ok(handler, 'leaveAccount must stay a findable handler')
  assert.match(handler[0], /ctx\.remote\.weixin\.logout\(/, 'it must call the host logout')
  assert.match(handler[0], /globalThis\.confirm/, 'a destructive action must ask first')
  // Cancelling the prompt must not proceed.
  assert.match(handler[0], /if \(ok === false\) return/, 'a declined confirmation must stop')
  // The empty string means "whatever is bound"; the host decides which account.
  assert.match(handler[0], /\.logout\(""\)/, 'it must not guess an account id')

  // The button itself: present only under `bound`, and styled as a plain button
  // rather than the primary one.
  const button = client.match(/onClick: leaveAccount,[\s\S]{0,120}?buttonStyleFor\(loggingOut\)/)
  assert.ok(button, 'the logout button must use buttonStyleFor(), not primaryButtonStyle')
  assert.doesNotMatch(button[0], /primaryButtonStyle/, 'logout must never be the primary action')

  // Guarded by `bound` in the same conditional the login button uses.
  assert.match(client, /bound\s*\n?\s*\?\s*createElement\("button", \{\s*\n\s*onClick: leaveAccount,/)
})

test('the account editors are inline rows, never window.prompt', () => {
  // The desktop shell is an Electron renderer, and Electron does not
  // implement window.prompt: it returns undefined, so a prompt-based
  // rename/allowlist editor silently did nothing — the button "worked",
  // the handler returned at `typeof next !== "string"`, no error anywhere.
  // The editors must therefore be inline rows committed by a button.
  const client = fs.readFileSync(CLIENT_PATH, 'utf8')

  assert.doesNotMatch(client, /globalThis\.prompt/, 'window.prompt is unusable in Electron; the editors must be inline rows')

  const rename = client.match(/const renameAccount = \(account\) => \{[\s\S]*?\n\t\t\t\};/)
  assert.ok(rename, 'renameAccount must stay a findable handler')
  assert.match(rename[0], /setEditing\(\{ accountId: account\.accountId, kind: "label"/, 'rename must open the inline editor, not a modal')

  const allowlist = client.match(/const editAllowlist = \(account\) => \{[\s\S]*?\n\t\t\t\};/)
  assert.ok(allowlist, 'editAllowlist must stay a findable handler')
  assert.match(allowlist[0], /setEditing\(\{ accountId: account\.accountId, kind: "allowlist"/, 'allowlist must open the inline editor, not a modal')

  const submit = client.match(/const submitEditing = async \(\) => \{[\s\S]*?\n\t\t\t\};/)
  assert.ok(submit, 'submitEditing must exist as the commit path')
  assert.match(submit[0], /ctx\.remote\.weixin\.label\(accountId, draft\)/, 'the label path must send the draft')
  assert.match(submit[0], /ctx\.remote\.weixin\.allowlist\(accountId, draft, ""\)/, 'the allowlist path must send the draft and an empty chat list')
  assert.match(submit[0], /setEditing\(null\)/, 'a successful commit must close the editor')
})
