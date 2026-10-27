#!/usr/bin/env node
/**
 * Move a template in and out of a checkout, without the settings card.
 *
 *   npm run pack -- export --name "毒舌陪聊" [-o file.json]
 *   npm run pack -- import file.json [--account acc]
 *
 * `--account` matters on import: subscriptions are per account, so an imported
 * schedule has to know whose it is. Without it the plugin's saved account is used.
 */
import fs from 'node:fs'
import path from 'node:path'
import { activeAccountId, stateRoot } from './lib/pack-cli-helpers.mjs'
import { exportPack, importPack, writePack } from '../src/packs.js'
import { readSavedConfig } from '../src/state.js'
import { readSubscriptions, writeSubscriptions } from '../src/message/subscriptions.js'

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { command: command?.startsWith('-') ? undefined : command, file: undefined, name: '', account: undefined, out: undefined }
  const words = command?.startsWith('-') ? argv : rest
  for (let i = 0; i < words.length; i += 1) {
    const arg = words[i]
    if (arg === '--name') options.name = words[++i] ?? ''
    else if (arg === '--account') options.account = words[++i]
    else if (arg === '--out' || arg === '-o') options.out = words[++i]
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`)
    else options.file = arg
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help || options.command === undefined) {
    process.stdout.write([
      'usage:',
      '  npm run pack -- export [--name <name>] [-o file.json]',
      '  npm run pack -- import <file.json> [--account <id>]',
      '',
      'A pack carries your persona modes, behaviour settings and subscriptions.',
      'It never carries memory, credentials, allowlists or the journal.',
    ].join('\n') + '\n')
    return 0
  }
  const root = stateRoot()
  if (options.command === 'export') {
    const accountId = options.account ?? activeAccountId()
    const pack = exportPack(root, accountId, { config: readSavedConfig(), name: options.name })
    if (pack.persona.modes.length === 0 && pack.subscriptions.length === 0) {
      process.stderr.write('nothing to export: no custom persona modes and no subscriptions\n')
      return 1
    }
    const target = options.out ?? writePack(root, pack)
    if (options.out !== undefined) fs.writeFileSync(options.out, `${JSON.stringify(pack, null, 2)}\n`, { mode: 0o600 })
    process.stdout.write(`${path.resolve(target)}\n`)
    process.stdout.write(`${pack.persona.modes.length} mode(s), ${pack.subscriptions.length} subscription(s)\n`)
    return 0
  }
  if (options.command === 'import') {
    if (options.file === undefined) throw new Error('import needs a file')
    const accountId = options.account ?? activeAccountId()
    if (accountId === '') throw new Error('no account: pass --account <id> (a subscription needs an owner)')
    const result = importPack(root, accountId, fs.readFileSync(options.file, 'utf8'), {
      scheduleSubscription: (plan) => {
        // The CLI is not the running plugin, so it writes the store the same way
        // the scheduler does and lets the next start arm the timers.
        const parsed = plan.when
        const store = readSubscriptions(root)
        const duplicate = store.items.some((item) => item.accountId === accountId && item.prompt === plan.prompt && item.time === parsed.time)
        if (duplicate) return { ok: false, reason: 'duplicate' }
        store.seq += 1
        store.items.push({ id: `s${store.seq}`, accountId, conversationId: plan.conversationId ?? accountId, prompt: plan.prompt, kind: parsed.kind, time: parsed.time, weekday: parsed.weekday, fireAt: Date.now(), createdAt: Date.now() })
        writeSubscriptions(root, store, () => {})
        return { ok: true }
      },
    })
    if (result.ok !== true) {
      process.stderr.write(`that file is not a pack: ${result.error}\n`)
      return 1
    }
    process.stdout.write(`modes added: ${result.modes.added.length}, skipped: ${result.modes.skipped.length}\n`)
    process.stdout.write(`subscriptions added: ${result.subscriptions.added.length}, skipped: ${result.subscriptions.skipped.length}\n`)
    process.stdout.write(`settings present in the pack: ${result.config.join(', ') || 'none'}\n`)
    return 0
  }
  throw new Error(`unknown command: ${options.command}`)
}

try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write(`${String(error?.message ?? error)}\n`)
  process.exitCode = 1
}
