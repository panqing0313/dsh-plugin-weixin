/**
 * Behavioural regression for the inbound long-poll hang of 2026-10-16.
 *
 * The phone showed "暂无法连接 openclaw" while the transport looked healthy:
 * one ESTABLISHED TLS connection to iLink, no error in the log, `sync.json`
 * frozen for 11 minutes. Two independent defects, same root:
 *
 * The vendor's request timeout (`setTimeout` → `controller.abort()`) is
 * CLEARED the moment response HEADERS arrive; the subsequent `res.text()` —
 * the body read — has no deadline of its own. A server that sends headers and
 * then stalls the body leaves a request pending forever. That hung
 *
 *   1. `getUpdates` — the poll loop waited on one dead request with no log
 *      line and no retry, because nothing "failed";
 *   2. `notifyStart` — `start()` awaits it BEFORE arming the loop, so the
 *      whole transport was dead from the first stalled round on: no poll, no
 *      watchdog, nothing.
 *
 * The fix is a hard outer bound in `ILinkTransport` for both: `start()` races
 * `notifyStart` against a deadline, and `#loop` aborts a poll round that
 * exceeds `longPollTimeoutMs * 2 + 10s`, logs one line, counts the round as a
 * failure and retries with the existing backoff.
 *
 * Two subtleties the test pins down, both measured against the vendor source:
 *
 *  - `getUpdates` CATCHES `AbortError` and returns an empty `{ret:0}` — it
 *    treats a long-poll timeout and an external abort as the same normal exit.
 *    So the watchdog's abort surfaces as a *normal return with an aborted
 *    signal*, not as a thrown error. The loop must notice the aborted signal
 *    after a successful-looking poll and keep going; a `while
 *    (!signal.aborted)` guard alone would silently END the loop there — the
 *    exact frozen state this fix exists for.
 *
 *  - `stop()` aborts the same controller. The loop distinguishes the two by
 *    `running`: stop() flips it to false before aborting, so an abort seen
 *    while `running` is still true can only be the watchdog.
 *
 * The stall is reproduced with an HTTP server that sends a chunked response
 * WITHOUT the terminating chunk: undici resolves `fetch()` at the headers
 * (so the vendor's own timer is cleared) and `res.text()` then never
 * resolves — the exact production shape. (A plain headers-only response is
 * NOT sufficient: undici treats it as a zero-length body and completes
 * immediately, which is why earlier attempts at this test silently tested
 * nothing.) A short `longPollTimeoutMs` (100ms) keeps the watchdog deadline at
 * ~10.2s; the test allows ~35s, bounded well below node --test's default
 * timeout.
 * @module dsh-weixin/test/transport-watchdog
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

const ACCOUNT_ID = 'watchdogbot'
const WATCHDOG_DEADLINE_MS = 10_200 // longPollTimeoutMs(100) * 2 + 10s

const LOG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-watchdog-logs-'))
const previousLogDir = process.env.DSH_WEIXIN_LOG_DIR
process.env.DSH_WEIXIN_LOG_DIR = LOG_ROOT

const roots = []

after(() => {
  if (previousLogDir === undefined) delete process.env.DSH_WEIXIN_LOG_DIR
  else process.env.DSH_WEIXIN_LOG_DIR = previousLogDir
  fs.rmSync(LOG_ROOT, { recursive: true, force: true })
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  })
}

/**
 * The production stall: chunked response, some body, NO terminating chunk.
 * `fetch()` resolves at the headers, `res.text()` never resolves.
 */
function stalledServer() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' })
    res.write('{"ret":0')
    // Deliberately never res.end().
  })
}

async function withStateRoot(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-watchdog-state-'))
  roots.push(root)
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = root
  try {
    return await run(root)
  } finally {
    if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
    else process.env.DSH_WEIXIN_STATE_DIR = previous
  }
}

test('a stalled notifyStart cannot block start(), a stalled poll is aborted by the watchdog, and the loop keeps polling', async () => {
  await withStateRoot(async () => {
    const lines = []
    const log = (line) => lines.push(line)
    const stalled = stalledServer()
    try {
      let stalledRequests = 0
      stalled.on('request', () => { stalledRequests += 1 })
      await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve))
      const stallUrl = `http://127.0.0.1:${stalled.address().port}`

      const { ILinkTransport } = await import('../src/transport/ilink.js')
      const transport = new ILinkTransport({
        accountId: ACCOUNT_ID,
        baseUrl: stallUrl,
        token: 'watchdog-test-token',
        userId: 'operator@im.wechat',
        longPollTimeoutMs: 100,
        log,
        errLog: log,
      })

      // start() must RETURN even though notifyStart hangs forever against the
      // stalled server (it used to await it unboundedly).
      const startedAt = Date.now()
      await transport.start(async () => {})
      const startMs = Date.now() - startedAt
      assert.ok(
        startMs >= WATCHDOG_DEADLINE_MS - 500 && startMs < WATCHDOG_DEADLINE_MS + 5_000,
        `start() must return at the notifyStart deadline (~${WATCHDOG_DEADLINE_MS}ms), took ${startMs}ms`,
      )
      assert.ok(
        lines.some((l) => l.includes('notifyStart did not answer within')),
        `start() must log the skipped notification; got: ${JSON.stringify(lines)}`,
      )

      // The poll watchdog fires within its deadline and names the stall.
      const pollDeadline = startedAt + WATCHDOG_DEADLINE_MS + 15_000
      while (!lines.some((l) => l.includes('watchdog: one poll round exceeded')) && Date.now() < pollDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      assert.ok(
        lines.some((l) => l.includes('watchdog: one poll round exceeded')),
        `the watchdog must log the stalled round; got: ${JSON.stringify(lines)}`,
      )
      assert.ok(
        lines.some((l) => l.includes('headers arrived, body never did')),
        'the log line must say what kind of stall this was',
      )

      // The loop must still be alive and polling: a further stalled request
      // arrives after the first watchdog round (it retried rather than
      // silently ending, which is what the pre-fix loop would have done —
      // the vendor returns a normal `{ret:0}` with an aborted signal, and a
      // `while (!signal.aborted)` guard alone would have exited there).
      const requestsAtFirstWatchdog = stalledRequests
      const retryDeadline = Date.now() + 30_000
      while (stalledRequests <= requestsAtFirstWatchdog && Date.now() < retryDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      assert.ok(
        stalledRequests > requestsAtFirstWatchdog,
        `the loop must keep polling after a watchdog round (saw ${stalledRequests} stalled requests)`,
      )

      await transport.stop()
      assert.equal(transport.running, false, 'stop() must still stop the loop cleanly')
    } finally {
      await closeServer(stalled)
    }
  })
})
