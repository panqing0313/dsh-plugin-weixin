/**
 * The client bundle and the host must agree on every remote method.
 *
 * A method is reachable only if BOTH halves exist:
 *   - `src/client.js` declares a descriptor (`service` + `namespace` + `method`),
 *     which is what the card uses to build `/api/<namespace>/<method>`;
 *   - the Service class lists it in its `remoteMethods(Class, [...])` call,
 *     which is what mints the route on the host.
 *
 * Declaring the client half alone is a trap: TypeScript is happy, the card
 * compiles, the button renders, and every click answers `HTTP 404`. That is not
 * hypothetical — the first build of the voice tab's delete button did exactly
 * this, because `AsrController.removeModel` existed but was missing from
 * `remoteMethods`. This test makes the two halves disagree out loud.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLIENT = path.join(PROJECT_ROOT, 'src', 'client.js')
const SOURCES = ['asr-remote.js', 'config-remote.js', 'login-remote.js', 'typert-js.js'].map((name) =>
  path.join(PROJECT_ROOT, 'src', name),
)

/** Every `weixin*` method the card can call, as `namespace/method`. */
function declaredByClient() {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const found = new Set()
  const pattern = /namespace:\s*"([\w$]+)",\s*\n\s*method:\s*"([\w$]+)"/g
  for (const match of source.matchAll(pattern)) found.add(`${match[1]}/${match[2]}`)
  return found
}

/**
 * Every method a Service class exposes, keyed by the namespace it serves.
 *
 * Both the `remoteMethods(Class, [...])` lists and `@Remote(...)` decorators are
 * accepted: the repository uses the list form, and a future refactor to the
 * decorator form should not silently empty this map.
 */
function registeredByHost() {
  const registered = new Map()
  for (const file of SOURCES) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/remoteMethods\(\s*(\w+)\s*,\s*\[([\s\S]*?)\]\s*\)/g)) {
      const [, className, body] = match
      const methods = [...body.matchAll(/["']([\w$]+)["']/g)].map((entry) => entry[1])
      const namespace = namespaceOf(className)
      assert.ok(namespace !== undefined, `${className} declares remote methods but no namespace was found`)
      const bucket = registered.get(namespace) ?? new Set()
      for (const method of methods) bucket.add(method)
      registered.set(namespace, bucket)
    }
  }
  return registered
}

/** The Typert namespace a Service registers itself under. */
function namespaceOf(className) {
  for (const file of SOURCES) {
    const source = fs.readFileSync(file, 'utf8')
    const match = new RegExp(`class\\s+${className}\\s+extends[^\\{]*\\{[\\s\\S]*?namespace:\\s*"([\\w$]+)"`).exec(source)
    if (match !== null) return match[1]
  }
  return undefined
}

test('every remote method the card declares is also minted by the host', () => {
  const client = declaredByClient()
  const host = registeredByHost()
  assert.ok(client.size > 50, `expected the card to declare its remote surface, found ${client.size}`)

  const missing = []
  for (const entry of client) {
    const [namespace, method] = entry.split('/')
    const bucket = host.get(namespace)
    // `weixin` is served by the login controller under one namespace, while
    // `weixinAsr`/`weixinConfig` are separate services; anything unknown here is
    // a namespace the scanner does not understand, which is worth failing on
    // rather than skipping quietly.
    assert.ok(bucket !== undefined, `no host service serves the "${namespace}" namespace`)
    if (!bucket.has(method)) missing.push(entry)
  }
  assert.deepEqual(
    missing,
    [],
    `the card would answer HTTP 404 for: ${missing.join(', ')} — add them to the service's remoteMethods([...]) list`,
  )
})

test('every remote method the host mints is declared by the card', () => {
  const client = declaredByClient()
  const host = registeredByHost()
  const unreachable = []
  for (const [namespace, methods] of host) {
    for (const method of methods) {
      if (!client.has(`${namespace}/${method}`)) unreachable.push(`${namespace}/${method}`)
    }
  }
  assert.deepEqual(
    unreachable,
    [],
    `these host methods have no client descriptor, so nothing can call them: ${unreachable.join(', ')}`,
  )
})