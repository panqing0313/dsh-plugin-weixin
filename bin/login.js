#!/usr/bin/env node
/**
 * `dsh-weixin login` — bind a Weixin account by scanning a QR code.
 *
 * Deliberately a local, interactive, terminal-only command:
 *  - The QR code and the bot token never leave this machine; the code is
 *    rendered in the terminal and the token is written to a 0600 file under
 *    ~/.dsh/weixin.
 *  - There is no "give me your password" path. iLink login is QR-only.
 *
 * Usage: node bin/login.js [--account <id>] [--timeout <ms>] [--force]
 * @module dsh-weixin/login
 */
import path from 'node:path'
import { configureWeixinStateDir, accountsDir, stateDir } from '../src/state.js'
import { writeQrPng } from '../src/qr-png.js'

const argv = process.argv.slice(2)
function readFlag(name) {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const hasFlag = (name) => argv.includes(`--${name}`)

async function main() {
  const stateRoot = configureWeixinStateDir()
  const { startWeixinLoginWithQr, waitForWeixinLogin, displayQRCode } =
    await import('../vendor/openclaw-weixin/auth/login-qr.js')
  const { saveWeixinAccount, registerWeixinAccountId, clearStaleAccountsForUserId } =
    await import('../vendor/openclaw-weixin/auth/accounts.js')

  const accountId = readFlag('account')?.trim()
  const timeoutMs = Number(readFlag('timeout') ?? 480_000)

  process.stdout.write(`dsh-weixin login\n`)
  process.stdout.write(`state:  ${stateRoot}\n`)
  process.stdout.write(`账号文件目录: ${accountsDir()}\n\n`)

  const started = await startWeixinLoginWithQr({
    ...(accountId === undefined ? {} : { accountId }),
    apiBaseUrl: 'https://ilinkai.weixin.qq.com',
    force: hasFlag('force'),
    verbose: true,
  })

  if (started.qrcodeUrl === undefined || started.qrcodeUrl === '') {
    process.stderr.write(`无法获取二维码: ${started.message}\n`)
    process.exitCode = 1
    return
  }

  process.stdout.write(`${started.message}\n`)
  // Terminal render first: it is the fastest path when stdout really is a
  // terminal. Then a PNG, because the half-block rendering is unscannable in a
  // GUI transcript or over a pipe — which is how this command is often run.
  await displayQRCode(started.qrcodeUrl)
  const qrPng = path.join(stateRoot, 'login-qr.png')
  const written = await writeQrPng(started.qrcodeUrl, qrPng)
  process.stdout.write(
    written === undefined
      ? `\n无法生成二维码图片（${qrPng}）；请改用上面的链接。\n`
      : `\n二维码图片: ${written}\n`,
  )
  process.stdout.write(`\n等待扫码确认（超时 ${Math.round(timeoutMs / 1000)} 秒）…\n`)

  const result = await waitForWeixinLogin({
    sessionKey: started.sessionKey,
    timeoutMs,
    verbose: true,
    apiBaseUrl: 'https://ilinkai.weixin.qq.com',
  })

  if (result.connected !== true || result.botToken === undefined) {
    process.stderr.write(`\n登录未完成: ${result.message}\n`)
    process.exitCode = 1
    return
  }

  // waitForWeixinLogin returns credentials but does NOT persist them; saving is
  // the caller's job.
  const id = result.accountId ?? accountId ?? 'default'
  saveWeixinAccount(id, {
    token: result.botToken,
    ...(result.baseUrl === undefined ? {} : { baseUrl: result.baseUrl }),
    ...(result.userId === undefined ? {} : { userId: result.userId }),
  })
  registerWeixinAccountId(id)
  // One WeChat user should not end up with several stale bot accounts.
  if (typeof result.userId === 'string' && result.userId !== '') {
    clearStaleAccountsForUserId(id, result.userId)
  }

  process.stdout.write(`\n已保存账号 ${id} → ${accountsDir()}/${id}.json (0600)\n`)
  process.stdout.write(`现在在 ${stateDir()} 之外不放任何凭据；把该账号的发送者 id 写进插件配置的 allowedSenders 后即可使用。\n`)
}

await main().catch((error) => {
  process.stderr.write(`login failed: ${String(error)}\n`)
  process.exitCode = 1
})
