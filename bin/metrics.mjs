#!/usr/bin/env node
/**
 * Print the plugin's metrics.
 *
 * The plugin writes `<state root>/metrics.json` and `metrics.prom` every 30s while
 * it runs (a restart starts the counters over — they are process-lifetime by
 * design). This script is the read side: it never starts the plugin, never touches
 * the account, and works whether or not anything is running.
 *
 *   npm run metrics                 # Prometheus text, ready to curl into a file
 *   npm run metrics -- --format json
 *   npm run metrics -- --state /path/to/state
 */
import fs from 'node:fs'
import path from 'node:path'
import { stateDir } from '../src/state.js'
import { prometheusText } from '../src/metrics.js'

function parseArgs(argv) {
  const options = { format: 'prom', state: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--format') options.format = argv[++i] ?? 'prom'
    else if (arg === '--state') options.state = argv[++i]
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!['prom', 'json'].includes(options.format)) throw new Error(`unknown format: ${options.format} (use prom or json)`)
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('usage: npm run metrics -- [--format prom|json] [--state <dir>]\n')
    return
  }
  const root = options.state ?? stateDir()
  const file = path.join(root, 'metrics.json')
  if (!fs.existsSync(file)) {
    process.stderr.write(`no metrics yet: ${file}\n(The plugin writes it every 30s while it is running.)\n`)
    process.exitCode = 1
    return
  }
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (options.format === 'json') {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
    return
  }
  const ageSeconds = Math.round((Date.now() - Number(snapshot.writtenAt ?? 0)) / 1000)
  const text = prometheusText(snapshot, { labels: { state: 'desktop' } })
  // A scraper that cannot tell a live process from a dead one is a trap: mark it.
  process.stdout.write(`${text}# dsh_weixin_snapshot_age_seconds ${ageSeconds}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${String(error?.message ?? error)}\n`)
  process.exitCode = 1
}
