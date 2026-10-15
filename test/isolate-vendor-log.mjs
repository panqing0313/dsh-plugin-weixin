// Runs in EVERY `node --test` child process, before any test file is loaded
// (wired up by the `test` script's `--import` flag).
//
// Why it has to exist: the vendored logger resolves its directory once, when
// `vendor/openclaw-weixin/util/logger.js` is first imported, and defaults to
// `~/.dsh/weixin/logs/openclaw-YYYY-MM-DD.log` — the log the operator reads when
// a WeChat message goes unanswered. Only two test files redirected it, so every
// other file appended its own traffic to that real log. Measured before this
// file existed: one full suite run added ~8 KB, and `test/e2e.test.js` alone
// added ~5 KB of `getUpdates` lines pointing at `http://127.0.0.1:<port>`.
//
// That is not merely untidy. While diagnosing "the bot is bound but WeChat says
// it cannot reach openclaw", grepping the operator's log for `getupdates`
// returned 277 hits — all of them test traffic, none of it real. The evidence
// pointed the wrong way, and only the loopback port numbers gave it away.
//
// Redirecting here rather than in each test file means a new test cannot
// reintroduce the leak by forgetting to opt in. A test that wants to inspect the
// log still can: it sets DSH_WEIXIN_LOG_DIR itself and reads it back, exactly as
// `test/login-remote.test.js` and `test/inbound-loop-start.test.js` already do.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// One directory per test process, so concurrent files cannot read each other's
// entries either. DSH_WEIXIN_LOG_DIR is an absolute path, so pointing TMPDIR at
// the same place first keeps everything under one removable root.
const LOG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-test-logs-'))
process.env.DSH_WEIXIN_LOG_DIR = LOG_ROOT

// The logger creates this lazily on its first write; creating it now means a
// test can list it without racing the write that might not have happened yet.
fs.mkdirSync(LOG_ROOT, { recursive: true })

process.on('exit', () => {
  try {
    fs.rmSync(LOG_ROOT, { recursive: true, force: true })
  } catch {
    // Best effort: a leftover temp directory must never fail a test run.
  }
})
