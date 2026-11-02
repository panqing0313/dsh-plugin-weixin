import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { quickstartLines } from '../src/onboarding.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(ROOT, 'bin', 'onboard.mjs')

/**
 * Run the script against a throwaway state directory.
 *
 * `execFileSync` throws on a non-zero exit, which is exactly what the script's
 * "you still have steps left" exit code means — so callers get both.
 */
function run(stateDir) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, DSH_WEIXIN_STATE_DIR: stateDir },
      encoding: 'utf8',
    })
    return { stdout, code: 0 }
  } catch (error) {
    return { stdout: String(error.stdout ?? ''), code: error.status }
  }
}

test('a fresh install prints the checklist, the reason, and exits non-zero', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-onboard-'))
  try {
    const { stdout, code } = run(stateDir)
    assert.equal(code, 1, 'an unconfigured install must not claim to be ready')
    assert.match(stdout, /微信BOT 上手清单/)
    assert.match(stdout, /□ 登录一个微信账号/)
    assert.match(stdout, /下一步：登录一个微信账号/)
    // The commands are the same ones the docs show, from one source.
    for (const line of quickstartLines()) {
      assert.ok(stdout.includes(line.command), `missing quickstart command: ${line.command}`)
    }
    // It only reads: a fresh run must not invent config.
    assert.equal(fs.existsSync(path.join(stateDir, 'config.json')), false)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('once an account and an allowlist exist, the script exits zero and stops nagging', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-onboard-'))
  try {
    fs.mkdirSync(path.join(stateDir, 'openclaw-weixin'), { recursive: true })
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ allowedSenders: ['wxid_abc'], accountId: 'bot1@im.bot' }),
    )
    fs.mkdirSync(path.join(stateDir, 'openclaw-weixin', 'accounts'), { recursive: true })
    fs.writeFileSync(
      path.join(stateDir, 'openclaw-weixin', 'accounts', 'bot1@im.bot.json'),
      JSON.stringify({ token: 'tok', baseUrl: 'http://127.0.0.1:1' }),
    )
    fs.writeFileSync(
      // The registry sits at the state root; only the credentials are under
      // `openclaw-weixin/`. Both paths come from the host's own helpers.
      path.join(stateDir, 'accounts-registry.json'),
      JSON.stringify({ 'bot1@im.bot': { label: '小号' } }),
    )
    const { stdout, code } = run(stateDir)
    // The host-version step follows whatever DSH is installed on this machine:
    // present and tested locally, absent on a bare CI runner. Assert the two
    // required steps this test actually controls, not the host's luck.
    assert.equal(code, 0, `everything required is done\n${stdout}`)
    assert.match(stdout, /✓ 登录一个微信账号/)
    assert.match(stdout, /✓ 告诉它「谁能让它干活」/)
    assert.ok(!stdout.includes('最快的三条命令'), 'no quickstart banner once it is ready')
    // The knowledge directory for the account is created so the user has
    // somewhere to drop files (this is the script's only write).
    assert.ok(fs.existsSync(path.join(stateDir, 'knowledge', 'bot1@im.bot')))
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})
