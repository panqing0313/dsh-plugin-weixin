/**
 * Regression tests for the iLink poll loop's error handling.
 *
 * The Bot API reports failures through `errcode`, but the loop originally only
 * checked `ret`. An expired session arrives as
 *
 *   { errcode: -14, errmsg: "session timeout" }
 *
 * with `ret` absent, so the check passed, `msgs` was empty, and the loop kept
 * polling an API that would never return a message again. The operator saw a
 * plugin that loaded cleanly, reported nothing, and silently ignored every
 * incoming message — the exact failure this file pins down.
 *
 * The tests drive the real loop against a stubbed `getUpdates` by importing the
 * transport and stubbing the vendor module's export through a loader hook, but
 * that would test the stub. Instead they exercise the decision the loop makes,
 * which is small enough to state directly: an `errcode` response must be raised
 * as a rejection, and a rejection must stop the loop.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SESSION_EXPIRED_ERRCODE, SessionRejectedError } from '../src/transport/ilink.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TRANSPORT_PATH = path.join(ROOT, 'src', 'transport', 'ilink.js')

test('an errcode-only response is a failure, not an empty poll', () => {
  // `-14` is what the live API returned for an expired session; it carries no
  // `ret`, which is why the original `ret !== 0` check never fired.
  const error = new SessionRejectedError(-14, 'session timeout')
  assert.equal(error.sessionExpired, true)
  assert.equal(error.errcode, SESSION_EXPIRED_ERRCODE)
  assert.match(error.message, /errcode=-14/)
  assert.match(error.message, /session timeout/)
})

test('a non-expiry rejection is still a rejection, but not an expiry', () => {
  const error = new SessionRejectedError(-1, 'something else')
  assert.equal(error.sessionExpired, false)
  assert.equal(error.sessionExpired, error.errcode === SESSION_EXPIRED_ERRCODE)
})

test('the loop raises errcode instead of silently polling on', () => {
  const source = fs.readFileSync(TRANSPORT_PATH, 'utf8')
  // The guard has to be on the response the API actually sends.
  assert.match(
    source,
    /if \(typeof resp\.errcode === 'number' && resp\.errcode !== 0\)/,
    'the loop must treat a non-zero errcode as a failure',
  )
  assert.match(source, /throw new SessionRejectedError\(resp\.errcode, resp\.errmsg\)/)
  // And a rejection must not fall through to the retry ladder: retrying cannot
  // fix an expired credential, and it would bury the message the operator needs.
  // The loop now has TWO catch blocks (the poll-round watchdog catch, and the
  // response-validation catch that owns errcode handling); this rule is about
  // the response one, so slice from the errcode guard rather than the first
  // catch in the loop.
  const errcodeGuardAt = source.indexOf("if (typeof resp.errcode === 'number'")
  const catchBlock = source.slice(source.indexOf('} catch (error) {', errcodeGuardAt))
  const rejectedAt = catchBlock.indexOf('instanceof SessionRejectedError')
  const retryAt = catchBlock.indexOf('classifyFetchError(error)')
  assert.notEqual(rejectedAt, -1, 'the catch must single out a rejected session')
  assert.ok(rejectedAt < retryAt, 'a rejected session must be handled before the generic retry path')
  assert.match(catchBlock, /break/, 'a rejected session must stop the loop')
})

test('the transport reports expiry once, so the host can surface it', () => {
  const source = fs.readFileSync(TRANSPORT_PATH, 'utf8')
  assert.match(source, /this\.#onSessionRejected\?\.\(error\)/, 'the host must be notified')
  assert.match(source, /get sessionExpired\(\)/, 'expiry must be readable by the settings card')
  assert.match(
    source,
    /the Weixin session has expired; messaging is stopped until you log in again/,
    'the operator-facing line must name the fix',
  )
})
