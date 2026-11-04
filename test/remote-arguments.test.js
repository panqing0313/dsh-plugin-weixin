/**
 * The client descriptor and the host method must agree on *argument names* too.
 *
 * `test/remote-surface.test.js` proves the route exists on both sides. That is
 * not enough: the gateway validates the JSON argument keys against the
 * descriptor's `wire` names before it dispatches, and it reads those expected
 * names straight out of the method's own parameter list
 * (`methodParameterNames` in `@deepseek-ai/dsh-api-gateway`). So a method whose
 * parameter is called `target` while the descriptor declares `path` fails every
 * call with:
 *
 *     typert gateway: weixinAsr/removeModel:
 *     args fields do not match the descriptor: unexpected "path"
 *
 * That is exactly how the delete button shipped twice-broken: first the route
 * was missing (404), then the argument name was wrong (arguments-invalid).
 *
 * This test parses the same two sources the gateway parses — the descriptor
 * array in `src/client.js` and the class methods in `src/*-remote.js` — and
 * compares them parameter by parameter.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLIENT = path.join(PROJECT_ROOT, 'src', 'client.js')
const SERVICE_FILES = ['asr-remote.js', 'config-remote.js', 'login-remote.js'].map((name) =>
  path.join(PROJECT_ROOT, 'src', name),
)

/**
 * `namespace/method` → the wire name of each declared argument, in order.
 *
 * Readers see one descriptor per object literal; the parameter list is on a
 * single `parameters: [...]` line, so it can be split without a JS parser.
 */
function descriptorArguments() {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const declared = new Map()
  const blocks = source.split(/id:\s*`\$\{PKG\}#/).slice(1)
  for (const block of blocks) {
    const namespace = /namespace:\s*"([\w$]+)"/.exec(block)?.[1]
    const method = /method:\s*"([\w$]+)"/.exec(block)?.[1]
    if (namespace === undefined || method === undefined) continue
    const paramLine = /parameters:\s*\[([\s\S]*?)\],\s*\n/.exec(block)?.[1] ?? ''
    const wires = [...paramLine.matchAll(/wire:\s*"([\w$]+)"/g)].map((entry) => entry[1])
    declared.set(`${namespace}/${method}`, wires)
  }
  return declared
}

/** `methodName` → the parameter identifiers of that method, in order. */
function methodParameters() {
  const found = new Map()
  for (const file of SERVICE_FILES) {
    const source = fs.readFileSync(file, 'utf8')
    // `async name(a, b) {` / `name(a) {` on a class prototype.
    for (const match of source.matchAll(/^\s{4}(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/gm)) {
      const [, name, body] = match
      const params = body
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '')
      found.set(name, params)
    }
  }
  return found
}

test('each remote argument is named the way its descriptor declares it', () => {
  const declared = descriptorArguments()
  const implemented = methodParameters()
  assert.ok(declared.size > 50, `expected the card to declare its remote surface, found ${declared.size}`)

  const mismatched = []
  const unchecked = []
  for (const [endpoint, wires] of declared) {
    const method = endpoint.split('/')[1]
    const params = implemented.get(method)
    if (params === undefined) {
      // Methods this scanner cannot see (inherited, or defined elsewhere) are
      // listed rather than silently skipped, so the gap stays visible.
      unchecked.push(endpoint)
      continue
    }
    if (params.length !== wires.length) {
      mismatched.push(`${endpoint}: descriptor has ${wires.length} arg(s) ${JSON.stringify(wires)}, method takes ${JSON.stringify(params)}`)
      continue
    }
    // Same name, same position. The gateway binds by name, so a rename here is
    // the same bug as a missing argument.
    const pairs = wires.map((wire, index) => [wire, params[index]])
    for (const [wire, param] of pairs) {
      if (wire !== param) mismatched.push(`${endpoint}: descriptor says "${wire}", method parameter is "${param}"`)
    }
  }

  assert.deepEqual(
    mismatched,
    [],
    [
      'the gateway compares argument names before dispatch, so these would fail with',
      '"args fields do not match the descriptor":',
      ...mismatched,
    ].join('\n'),
  )
  // Not an assertion on content: a reminder that the scan is complete is the
  // only thing that keeps this test honest as services move around.
  assert.ok(
    unchecked.length < declared.size / 2,
    `the scanner understood fewer than half the endpoints; unchecked: ${unchecked.slice(0, 10).join(', ')}`,
  )
})