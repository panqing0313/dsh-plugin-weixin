import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { extractVideoFrames, planSampleTimes, probeDurationSeconds } from '../src/media/video-frames.js'
import { describeInboundMedia } from '../src/media/inbound.js'

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('sample times start past the first frame and stay inside the clip', () => {
  assert.deepEqual(planSampleTimes(0), [])
  assert.deepEqual(planSampleTimes(-3), [])
  const three = planSampleTimes(10)
  assert.equal(three.length, 3)
  assert.ok(three[0] > 0.5, 'the first frame is often black')
  assert.ok(three.every((at) => at < 10))
  assert.deepEqual(planSampleTimes(10), planSampleTimes(10), 'deterministic')
  assert.equal(planSampleTimes(2, 1).length, 1)
  assert.ok(planSampleTimes(1).every((at) => at < 1))
})

test('a clip that does not exist reports an error instead of throwing', () => {
  if (!hasFfmpeg) return
  const out = extractVideoFrames('/nonexistent/does-not-exist.mp4')
  assert.deepEqual(out.frames, [])
  assert.equal(typeof out.error, 'string')
  assert.ok(probeDurationSeconds('/nonexistent/does-not-exist.mp4').error)
})

test('frames come out as PNGs in order, and the duration is read', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-'))
  const clip = path.join(dir, 'clip.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=10', '-pix_fmt', 'yuv420p', clip])
  const result = extractVideoFrames(clip, { count: 2 })
  assert.equal(result.frames.length, 2)
  assert.ok(Math.abs(result.durationSeconds - 4) < 0.5, `duration ~4s, got ${result.durationSeconds}`)
  for (const frame of result.frames) {
    assert.deepEqual(fs.readFileSync(frame.path).subarray(0, 8), PNG_MAGIC)
    assert.match(path.basename(frame.path), /-frame-\d\.png$/)
  }
  assert.ok(result.frames[0].atSeconds < result.frames[1].atSeconds)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the note handed to the agent names the frames and says what to do with them', () => {
  const withFrames = describeInboundMedia([
    {
      ok: true,
      kind: 'video',
      path: '/tmp/clip.mp4',
      name: 'clip.mp4',
      bytes: 2048,
      durationSeconds: 4,
      frames: [{ path: '/tmp/clip-frame-1.png', atSeconds: 0.4 }, { path: '/tmp/clip-frame-2.png', atSeconds: 3.6 }],
    },
  ])
  assert.match(withFrames, /时长 4\.0 秒/)
  assert.match(withFrames, /0\.4s：\/tmp\/clip-frame-1\.png/)
  assert.match(withFrames, /read_image/)

  const withoutFrames = describeInboundMedia([
    { ok: true, kind: 'video', path: '/tmp/clip.mp4', name: 'clip.mp4', bytes: 2048, framesError: 'ffmpeg unavailable' },
  ])
  assert.match(withoutFrames, /抽帧失败：ffmpeg unavailable/)
  assert.match(withoutFrames, /无法直接读取内容/)
})
