// Shared by every suite that drives a real AgentBridge.
//
// `src/agent-bridge.js` imports `@deepseek-ai/dsh-llm` (to build the user
// message) and `@deepseek-ai/dsh-agent` (for `installModelSelection`). Both are
// optional peers: `npm ci` on a plain checkout — what CI does — installs
// neither. Driving a bridge then throws MODULE_NOT_FOUND, and the unhandled
// rejection it leaves behind keeps the test process alive, so the run hangs
// instead of reporting. That is what happened on CI for six hours.
//
// Skipping keeps a checkout without a host runnable, the same contract
// `test/e2e.test.js` and `test/markdown.test.js` already keep for their
// host-only cases.
import test from 'node:test'

const HOST_ONLY_SKIP =
  'needs @deepseek-ai/dsh-llm and @deepseek-ai/dsh-agent, which only exist ' +
  'inside a DSH installation; run `npm test` from a DSH profile (or link a host) ' +
  'to exercise the turn paths'

const available = await (async () => {
  try {
    const [llm, agent] = await Promise.all([
      import('@deepseek-ai/dsh-llm'),
      import('@deepseek-ai/dsh-agent'),
    ])
    return typeof llm.createUserMessage === 'function' && agent !== null
  } catch {
    return false
  }
})()

export const hostOnlySkip = available ? false : HOST_ONLY_SKIP

/** `test()` when a host is present, otherwise the same test, skipped. */
export const hostTest = available
  ? test
  : (name, fn) => test(name, { skip: HOST_ONLY_SKIP }, fn)
