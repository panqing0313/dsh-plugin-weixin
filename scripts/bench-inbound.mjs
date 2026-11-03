#!/usr/bin/env node
// Benchmark: what does one inbound message cost the plugin?
//
// Not a test, and not part of `npm test`: a benchmark you run before and after a
// change. It answers "优化什么" with numbers instead of guesses.
// Each message comes from a DISTINCT sender + conversation, so the busy-turn
// guard (one waiting turn per conversation) never fires and the measurement is
// assembly cost, not refusal cost.
//
//   npm run bench            # 100 messages
//   npm run bench -- 400     # more samples
//   node --cpu-prof --cpu-prof-dir=/tmp/prof scripts/bench-inbound.mjs 400
//
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import nodeFs from 'node:fs'
const fsyncPaths = []
const realOpenSync = nodeFs.openSync
const fdToPath = new Map()
nodeFs.openSync = (target, ...rest) => {
  const fd = realOpenSync(target, ...rest)
  if (typeof target === 'string' && target.endsWith('.tmp')) fdToPath.set(fd, target)
  return fd
}
const realFsyncSync = nodeFs.fsyncSync
nodeFs.fsyncSync = (fd) => { fsyncPaths.push((fdToPath.get(fd) ?? String(fd)).split('/').pop()); return realFsyncSync(fd) }

import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { startFakeILink } = await import(path.join(PROJECT_ROOT, 'test', 'fake-ilink.js'))
const ACCOUNT_ID = 'bot@im.bot'

const count = Number(process.argv[2] ?? 100)
const senders = Array.from({ length: count }, (_, index) => `wxid_bench_${index}`)

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-bench-'))
process.env.DSH_WEIXIN_STATE_DIR = stateRoot

const accounts = path.join(stateRoot, 'openclaw-weixin', 'accounts')
fs.mkdirSync(accounts, { recursive: true })
const cred = path.join(accounts, `${ACCOUNT_ID}.json`)
fs.writeFileSync(cred, JSON.stringify({ token: 'tok', baseUrl: 'pending' }), { mode: 0o600 })
fs.writeFileSync(path.join(stateRoot, 'openclaw-weixin', 'accounts.json'), JSON.stringify([ACCOUNT_ID]))

// A little history so the memory window and the journal are not empty.
const journal = path.join(stateRoot, 'journal-2026-11-04.jsonl')
const lines = []
for (let index = 0; index < 300; index += 1) {
  lines.push(JSON.stringify({
    at: Date.now() - index * 60_000,
    accountId: ACCOUNT_ID,
    conversationId: `wxid_bench_${index % count}@im.wxid`,
    dir: index % 2 === 0 ? 'in' : 'out',
    senderId: `wxid_bench_${index % count}`,
    text: `历史上的第 ${index} 条消息，内容长得像真人聊天，带一些细节：今天开会到七点，晚饭吃的是面。`,
  }))
}
fs.writeFileSync(journal, lines.join('\n') + '\n')

const fake = await startFakeILink()
fs.writeFileSync(cred, JSON.stringify({ token: 'tok', baseUrl: fake.baseUrl }), { mode: 0o600 })

function fakeAgents() {
  const agents = new Map()
  return {
    get: (id) => agents.get(id),
    resume: async ({ resumeSessionId }) => {
      const events = []
      let seq = 0
      const ev = (type, data) => events.push({ type, seq: seq++, time: Date.now(), data })
      const agent = {
        session: { id: resumeSessionId, snapshotEvents: () => events },
        inbox: { clear() {} },
        followup(message) {
          const text = message.content[0].text
          ev('user/message', { message })
          ev('turn/start', {})
          setTimeout(() => {
            ev('assistant/message', { stream: [{ type: 'text-chunks', texts: ['pong：我也刚到家'] }] })
            ev('turn/end', {})
          }, 5)
        },
      }
      agents.set(resumeSessionId, agent)
      return { agent, dispose: async () => {} }
    },
  }
}

const disposers = []
const warnings = []
const ctx = {
  logger: { info: () => {}, warn: (line) => warnings.push(line) },
  effect(fn) { disposers.push(fn()); return { dispose() {} } },
  get: (name) => (name === 'agents' ? fakeAgents() : undefined),
}

const plugin = await import(path.join(PROJECT_ROOT, 'src', 'index.js'))
const config = plugin.Config({
  eventPollMs: 5,
  sendIntervalMs: 1,
  humanPacing: false,
  replyDelayMaxMs: 0,
  bubbleGapMs: 0,
  allowedSenders: senders,
  accountId: ACCOUNT_ID,
  memoryEnabled: true,
  senderRatePerMinute: 10_000,
})

const startedAt = process.hrtime.bigint()
const cpuStarted = process.cpuUsage()
plugin.apply(ctx, config)

for (let index = 0; index < count; index += 1) {
  fake.deliver(`第 ${index + 1} 条：今天有点累，想早点睡`, `bench-${index}`, { from: senders[index] })
}

const deadline = Date.now() + 120_000
while (fake.outbound.length < count && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6
const cpu = process.cpuUsage(cpuStarted)
const cpuMs = (cpu.user + cpu.system) / 1000

for (const dispose of disposers) await (await dispose)?.()
await fake.close()
fs.rmSync(stateRoot, { recursive: true, force: true })

console.log(JSON.stringify({
  messages: count,
  answered: fake.outbound.length,
  wallMs: Math.round(wallMs),
  cpuMs: Math.round(cpuMs),
  perMessageWallMs: Number((wallMs / count).toFixed(2)),
  perMessageCpuMs: Number((cpuMs / count).toFixed(2)),
  cpuShare: Number((cpuMs / wallMs).toFixed(2)),
  warnings: warnings.length,
  fsyncCallsPerMessage: Number((fsyncPaths.length / count).toFixed(2)),
  fsyncByFile: Object.entries(fsyncPaths.reduce((acc, name) => { const key = name.replace(/\.\d+\.[a-z0-9]+\.tmp$/, ''); acc[key] = (acc[key] ?? 0) + 1; return acc }, {})).sort((a, b) => b[1] - a[1]).slice(0, 10),
  uniqueWarnings: [...new Set(warnings.map((line) => line.replace(/\d+/g, 'N')))].slice(0, 6),
}, null, 2))
