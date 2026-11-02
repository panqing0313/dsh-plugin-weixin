#!/usr/bin/env node
// Onboard: 新装之后的「照做就行」清单。
//
// 为什么要有这个脚本：`doctor.mjs` 回答的是「哪里坏了」，而新用户问的是
// 「我现在该做什么」。两者不能共用一套输出——前者按「最可能出错的东西」排序，
// 后者必须按「先做什么」排序，而且没做的不该显示成红的。
//
// 这个脚本**只读**：它不改配置、不写状态、不登录。唯一的副作用是把自己必须存在
// 的目录建出来（知识库与备份目录），这样用户下一步就有地方放文件。
//
// 退出码：0 就算「能用了」（前三项必须项都完成），1 表示还有事没做——这样它也能
// 放进 CI 或安装脚本里当门槛用。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { detectHostVersion, hostStatus } from '../src/host-compat.js'
import { listKnowledgeSources } from '../src/message/knowledge.js'
import { buildOnboardingChecklist, describeNextStep, quickstartLines } from '../src/onboarding.js'
import { allowlistForAccount, readRegistry } from '../src/account-registry.js'
import { accountsDir, readSavedConfig } from '../src/state.js'

/** 与插件、doctor 用同一套数据目录约定。 */
function stateRoot() {
  const env = process.env.DSH_WEIXIN_STATE_DIR
  if (typeof env === 'string' && env !== '') return env
  return path.join(os.homedir(), '.dsh', 'weixin')
}

function readConfig() {
  try {
    return readSavedConfig() ?? {}
  } catch {
    return {}
  }
}

function accounts() {
  try {
    // The registry is keyed by accountId (not a list), so its keys are the
    // accounts. Both reads take the config so an account-level allowlist counts
    // too: someone who only configured per-account should not be told forever
    // that they have not configured anything.
    const registry = readRegistry()
    const config = readConfig()
    return Object.keys(registry).map((accountId) => ({
      accountId,
      allowedSenders: allowlistForAccount(accountId, config).allowedSenders,
    }))
  } catch {
    return []
  }
}

function knowledgeCount(root, accountIds) {
  let total = 0
  for (const id of accountIds) {
    try {
      total += listKnowledgeSources(path.join(root, 'knowledge', id)).length
    } catch {
      // 目录不存在就是 0 份文件。
    }
  }
  return total
}

/**
 * `| head` 会让管道提前关闭。一个状态脚本不应该因为读者先走而抛 EPIPE。
 */
function guardStdout() {
  process.stdout.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(process.exitCode ?? 0)
    throw error
  })
}

function main() {
  guardStdout()
  const root = stateRoot()
  const config = readConfig()
  const list = accounts()
  // `DSH_HOST_PLIST` lets a test (and an unusual install) point at the app it
  // actually has; an explicitly empty value means "do not claim a host".
  const plistFromEnv = process.env.DSH_HOST_PLIST
  const hostVersion =
    typeof plistFromEnv === 'string'
      ? detectHostVersion(plistFromEnv === '' ? { plistPath: '/nonexistent/Info.plist' } : { plistPath: plistFromEnv })
      : detectHostVersion()
  // 注册表里的账号只是「这台机器记得的账号」，真正的凭据在
  // `openclaw-weixin/accounts/<id>.json`。注册表是元数据，删掉凭据不会删它，
  // 所以「登录过」必须看凭据文件，否则一个删了账号的人会看到「已完成」。
  // The credential path comes from the host's own helper instead of being
  // re-derived here: a second copy of "where do accounts live" is how the two
  // drift apart (the first draft of this script guessed the wrong directory and
  // reported a logged-in account as missing).
  const loggedIn = new Set(list.map((account) => account.accountId).filter((id) => {
    try {
      return fs.statSync(path.join(accountsDir(), `${id}.json`)).isFile()
    } catch {
      return false
    }
  }))

  // 建目录：用户看完清单的第一件事就是「把文件放哪」，所以要有个现成的路径可复制。
  for (const id of loggedIn) {
    try {
      fs.mkdirSync(path.join(root, 'knowledge', id), { recursive: true })
    } catch {
      // 建不出来不影响清单本身，后面的提示里会说出问题。
    }
  }

  const checklist = buildOnboardingChecklist({
    accounts: list.filter((account) => loggedIn.has(account.accountId)),
    accountCount: loggedIn.size,
    hostVersion,
    hostTested: hostStatus(hostVersion).status === 'tested',
    allowedSenders: Array.isArray(config.allowedSenders) ? config.allowedSenders : [],
    personaDefaultMode: typeof config.personaDefaultMode === 'string' && config.personaDefaultMode !== '' && config.personaDefaultMode !== 'default',
    proactiveEnabled: config.proactiveEnabled === true,
    knowledgeEnabled: config.knowledgeEnabled !== false,
    knowledgeFiles: knowledgeCount(root, [...loggedIn]),
    backupEnabled: config.backupEnabled === true,
  })

  // On a machine with no DSH installed at all (a bare CI runner, a fresh Linux
  // box), the host step cannot be verified — that is not a reason to refuse to
  // say the rest is ready. The checklist already renders it as a note; this flag
  // only decides whether a spare explanation line is worth printing.
  const hostNote = checklist.steps.find((step) => step.id === 'host')
  const noHostToCheck = hostNote !== undefined && hostNote.state !== 'done'

  const icon = { done: '✓', todo: '□', blocked: '—', note: '·' }
  // 终端里中文占两列：按显示宽度算，否则说明那一列会参差不齐。
  const columns = (text) => [...text].reduce((sum, ch) => sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0)
  const width = Math.max(...checklist.steps.map((step) => columns(step.title)))

  process.stdout.write(`微信BOT 上手清单  数据目录：${root}\n\n`)
  for (const step of checklist.steps) {
    // An unverifiable host is a note, not an unfinished task: showing □ next to
    // "2/7 步已就绪、没有必须做的了" reads like a bug.
    const mark = step.id === 'host' && noHostToCheck ? icon.note : icon[step.state]
    process.stdout.write(`${mark} ${step.title}${' '.repeat(width - columns(step.title))}  ${step.detail}\n`)
    if (step.state === 'todo' || step.state === 'blocked') {
      process.stdout.write(`  ${' '.repeat(width + 2)}  ${step.why}\n`)
    }
  }
  process.stdout.write(`\n${checklist.done}/${checklist.total} 步已就绪。${describeNextStep(checklist)}\n`)

  if (checklist.complete !== true) {
    process.stdout.write('\n最快的三条命令：\n')
    for (const line of quickstartLines()) {
      process.stdout.write(`  $ ${line.command}\n    ${line.note}\n`)
    }
  }

  if (noHostToCheck) {
    process.stdout.write('\n没有检测到 DSH 宿主：这一步等你装上 DSH 再回来跑一次就行，其余照上面做。\n')
  }

  // Exit 0 exactly when the required steps are done. The host is a note either
  // way (see src/onboarding.js), so it never holds the exit code hostage.
  process.exitCode = checklist.complete ? 0 : 1
}

main()
