import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createSendCommands } from '../src/message/send-file.js'
import { parseSessionCommand } from '../src/sessions.js'

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-send-'))
}

function commandsFor(root, extra = {}) {
  const sent = []
  return {
    sent,
    commands: createSendCommands({
      conversationId: 'wxid_peer',
      mediaDirs: [root],
      warn: () => {},
      sendMedia: async (params) => {
        sent.push(params)
      },
      ...extra,
    }),
  }
}

test('/send is a session command with a required path', () => {
  assert.deepEqual(parseSessionCommand('/send out/report.pdf'), { command: 'send', arg: 'out/report.pdf' })
  assert.deepEqual(parseSessionCommand('/send'), { command: 'send', arg: '' })
})

test('a file inside an allowed directory is sent, with the peer id', async () => {
  const root = workspace()
  fs.writeFileSync(path.join(root, 'note.txt'), 'hello')
  const { commands, sent } = commandsFor(root)

  const reply = await commands.send('note.txt')
  assert.match(reply, /已发送：note\.txt/)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].filePath, fs.realpathSync(path.join(root, 'note.txt')))
  assert.equal(sent[0].conversationId, 'wxid_peer')
})

test('an absolute path inside an allowed directory also works', async () => {
  const root = workspace()
  const file = path.join(root, 'abs.txt')
  fs.writeFileSync(file, 'x')
  const { commands, sent } = commandsFor(root)
  assert.match(await commands.send(file), /已发送：abs\.txt/)
  assert.equal(sent.length, 1)
})

test('a path outside the allowed directories is refused before any send', async () => {
  const root = workspace()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-outside-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope')
  const { commands, sent } = commandsFor(root)

  const reply = await commands.send(path.join(outside, 'secret.txt'))
  assert.match(reply, /发不了/)
  assert.match(reply, /outside/)
  assert.equal(sent.length, 0)
})

test('a .. escape is refused', async () => {
  const root = workspace()
  const { commands, sent } = commandsFor(root)
  assert.match(await commands.send('../etc/passwd'), /发不了/)
  assert.equal(sent.length, 0)
})

test('a missing file is reported, not sent', async () => {
  const root = workspace()
  const { commands, sent } = commandsFor(root)
  assert.match(await commands.send('ghost.txt'), /找不到这个文件/)
  assert.equal(sent.length, 0)
})

test('the size cap is enforced', async () => {
  const root = workspace()
  fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(2048))
  const { commands, sent } = commandsFor(root, { maxBytes: 1024 })
  assert.match(await commands.send('big.bin'), /文件太大/)
  assert.equal(sent.length, 0)
})

test('empty argument teaches the boundary instead of guessing', async () => {
  const root = workspace()
  const { commands, sent } = commandsFor(root)
  assert.match(await commands.send(''), /用法：\/send/)
  assert.equal(sent.length, 0)
})

test('a failed upload is reported and the file is kept', async () => {
  const root = workspace()
  const file = path.join(root, 'fail.txt')
  fs.writeFileSync(file, 'x')
  const commands = createSendCommands({
    conversationId: 'wxid_peer',
    mediaDirs: [root],
    warn: () => {},
    sendMedia: async () => {
      throw new Error('upload down')
    },
  })
  assert.match(await commands.send('fail.txt'), /发送失败/)
  assert.equal(fs.existsSync(file), true)
})

test('help names /send so it is discoverable', async () => {
  const { buildCommandsHelp } = await import('../src/sessions.js')
  assert.match(buildCommandsHelp(), /\/send/)
})
