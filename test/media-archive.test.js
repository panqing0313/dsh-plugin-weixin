import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createMediaCommands,
  formatMediaList,
  humanBytes,
  humanTime,
  listInboundMedia,
  mediaKind,
  MAX_MEDIA_LIMIT,
  resolveArchivePath,
} from '../src/message/media-archive.js'

function archive() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-media-'))
  fs.writeFileSync(path.join(dir, 'a.png'), Buffer.alloc(2048))
  fs.writeFileSync(path.join(dir, 'b-voice.silk'), Buffer.alloc(10))
  fs.writeFileSync(path.join(dir, 'report.pdf'), Buffer.alloc(1024 * 1024 * 2))
  fs.mkdirSync(path.join(dir, 'sub'))
  // Pin the times instead of trusting the filesystem's clock: a CI runner
  // writes all three in the same tick, and the listing must be numbered the
  // same everywhere (the resend test below addresses item 1 by number).
  const at = (day) => new Date(2026, 9, day, 9, 0)
  fs.utimesSync(path.join(dir, 'a.png'), at(20), at(20))
  fs.utimesSync(path.join(dir, 'b-voice.silk'), at(29), at(29))
  fs.utimesSync(path.join(dir, 'report.pdf'), at(31), at(31))
  return dir
}

test('the kind comes from the extension, and unknown extensions stay a file', () => {
  assert.equal(mediaKind('shot.PNG'), 'image')
  assert.equal(mediaKind('clip.mp4'), 'video')
  assert.equal(mediaKind('voice.silk'), 'voice')
  assert.equal(mediaKind('a.pdf'), 'document')
  assert.equal(mediaKind('mystery'), 'file')
})

test('time and size read like a phone message list', () => {
  const now = new Date(2026, 9, 31, 15, 0).getTime()
  assert.equal(humanTime(new Date(2026, 9, 31, 9, 5).getTime(), { now }), '今天 09:05')
  assert.equal(humanTime(new Date(2026, 9, 30, 22, 40).getTime(), { now }), '昨天 22:40')
  assert.equal(humanTime(new Date(2026, 9, 28, 9, 12).getTime(), { now }), '10-28 09:12')
  assert.equal(humanBytes(512), '512 B')
  assert.equal(humanBytes(2048), '2.0 KB')
  assert.equal(humanBytes(2 * 1024 * 1024), '2.0 MB')
})

test('the archive lists files newest first, skips directories, and caps the count', () => {
  const dir = archive()
  const items = listInboundMedia(dir)
  assert.deepEqual(items.map((item) => item.name), ['report.pdf', 'b-voice.silk', 'a.png'])
  assert.equal(items[0].kind, 'document')
  assert.equal(items[1].kind, 'voice')
  assert.equal(listInboundMedia(dir, { limit: 2 }).length, 2)
  assert.ok(listInboundMedia(dir, { limit: 999 }).length <= MAX_MEDIA_LIMIT, 'the listing itself caps')
  assert.deepEqual(listInboundMedia(path.join(dir, 'missing')), [], 'a missing archive is empty, not an error')
})

test('the list text is numbered so resend can address one', () => {
  const text = formatMediaList([
    { name: 'report.pdf', bytes: 2 * 1024 * 1024, at: new Date(2026, 9, 31, 9, 0).getTime(), kind: 'document' },
  ], { now: new Date(2026, 9, 31, 15, 0).getTime() })
  assert.match(text, /最近的媒体（1 件）/)
  assert.match(text, /1\. 今天 09:00 · document · 2\.0 MB · report\.pdf/)
  assert.match(text, /\/media resend <序号>/)
  assert.match(formatMediaList([]), /媒体归档里还没有东西/)
})

test('a resend only ever resolves inside the archive directory', () => {
  const dir = archive()
  const items = listInboundMedia(dir)
  const target = items.find((item) => item.name === 'report.pdf')
  const resolved = resolveArchivePath(dir, String(items.indexOf(target) + 1), items)
  assert.equal(resolved, fs.realpathSync(target.path))
  assert.equal(resolveArchivePath(dir, '0', items), undefined)
  assert.equal(resolveArchivePath(dir, '99', items), undefined)
  assert.equal(resolveArchivePath(dir, 'abc', items), undefined)
})

test('files written in the same tick are still numbered the same way', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-media-tie-'))
  for (const name of ['z.png', 'm.png', 'a.png']) fs.writeFileSync(path.join(dir, name), Buffer.alloc(4))
  const at = new Date(2026, 9, 31, 9, 0).getTime()
  for (const name of ['z.png', 'm.png', 'a.png']) fs.utimesSync(path.join(dir, name), at, at)
  const names = () => listInboundMedia(dir).map((item) => item.name)
  assert.deepEqual(names(), ['a.png', 'm.png', 'z.png'], 'a shared mtime falls back to the name, not readdir order')
  assert.deepEqual(names(), listInboundMedia(dir).map((item) => item.name), 'and it is stable across calls')
})

test('the command lists, resends through the given sender, and reports a bad index', async () => {
  const dir = archive()
  const sent = []
  const commands = createMediaCommands({
    dir,
    conversationId: 'wxid_a',
    contextToken: 'tok',
    sendMedia: async (params) => { sent.push(params) },
    now: () => new Date(2026, 9, 31, 15, 0).getTime(),
  })
  assert.match(await commands.media(''), /最近的媒体（3 件）/)
  assert.equal(sent.length, 0, 'listing never sends anything')

  const resent = await commands.media('resend 1')
  assert.match(resent, /已重发：/)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].conversationId, 'wxid_a')
  assert.equal(sent[0].contextToken, 'tok')
  assert.equal(path.basename(sent[0].filePath), 'report.pdf')

  assert.match(await commands.media('resend 99'), /没有第 99 件/)
  assert.match(await commands.media('乱七八糟'), /用法：\/media/)
})

test('a failing send keeps the file and says so', async () => {
  const dir = archive()
  const commands = createMediaCommands({
    dir,
    conversationId: 'wxid_a',
    sendMedia: async () => { throw new Error('cdn refused') },
  })
  const reply = await commands.media('resend 2')
  assert.match(reply, /重发失败：cdn refused/)
  assert.match(reply, /文件还在/)
  assert.equal(fs.existsSync(path.join(dir, 'b-voice.silk')), true)
})
