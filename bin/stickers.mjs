#!/usr/bin/env node
// 自己的表情包：看一眼有哪些、把一张图加进去、检查内置图还在不在。
//
// 内置的三层（公共两套 + 每个角色一套 + 画出来的半身动作图）够用，但最贴脸的
// 表情永远是自己的照片或别人画的图。这个脚本只做一件事：把一张图片放进
// `<数据目录>/stickers/<模式或 all>/`，文件名就是模型要写的名字。
//
// 用法：
//   node bin/stickers.mjs list [--mode <模式>] [--json]
//   node bin/stickers.mjs add <图片> [--mode all|<模式>] [--as <名字>]
//   node bin/stickers.mjs check
//
// 退出码：check 有问题时为 1，其余 0。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  IMAGE_EXTENSIONS,
  MODE_STICKERS,
  SHARED_STICKERS,
  STICKER_DIR,
  clearUserStickerCache,
  listUserStickerFiles,
  looksLikeImage,
  stickerPath,
  stickersForMode,
  userStickerRoot,
} from '../src/message/stickers.js'

/** 与插件、doctor、onboard 同一套数据目录约定。 */
function stateRoot() {
  const env = process.env.DSH_WEIXIN_STATE_DIR
  if (typeof env === 'string' && env !== '') return env
  return path.join(os.homedir(), '.dsh', 'weixin')
}

/** 模式名只允许目录里出现过的那些，外加 all。 */
function knownModes() {
  return [...new Set(MODE_STICKERS.flatMap((pack) => pack.modes))]
}

function parse(argv) {
  const options = { mode: 'all', as: undefined, json: false }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--mode') options.mode = argv[++index]
    else if (arg === '--as') options.as = argv[++index]
    else if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length)
    else if (arg.startsWith('--as=')) options.as = arg.slice('--as='.length)
    else rest.push(arg)
  }
  return { options, rest }
}

/** 文件名里不能有的字符：路径分隔符与冒号（冒号是 `user:` id 的分隔符）。 */
function safeName(name) {
  const cleaned = String(name).trim().replace(/[/\\:]/g, '-')
  return cleaned === '' ? undefined : cleaned
}

function commandList(root, { mode, json }) {
  const builtin = stickersForMode(mode, { stateRoot: root }).filter((entry) => entry.user !== true)
  const custom = stickersForMode(mode, { stateRoot: root }).filter((entry) => entry.user === true)
  if (json) {
    process.stdout.write(`${JSON.stringify({ mode, builtin, custom }, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`模式 ${mode} 可用的内置表情（${builtin.length} 张）：\n`)
  process.stdout.write(`  ${builtin.map((entry) => entry.caption).join('、')}\n`)
  if (custom.length === 0) {
    process.stdout.write(`\n没有自己的表情图。放进 ${userStickerRoot(root)}/${mode}/ 里，或：\n`)
    process.stdout.write(`  node bin/stickers.mjs add 我的照片.png --mode ${mode} --as 老板\n`)
  } else {
    process.stdout.write(`\n自己的表情（${custom.length} 张，来自 ${userStickerRoot(root)}）：\n`)
    for (const entry of custom) {
      const where = entry.mode === 'all' ? '全部模式' : entry.mode
      process.stdout.write(`  [表情:${entry.caption}]  ${where}  ${entry.file}\n`)
    }
  }
  return 0
}

function commandAdd(root, file, { mode, as }) {
  if (file === undefined) {
    process.stderr.write('用法：node bin/stickers.mjs add <图片> [--mode all|<模式>] [--as <名字>]\n')
    return 1
  }
  const source = path.resolve(file)
  if (fs.existsSync(source) === false || fs.statSync(source).isFile() === false) {
    process.stderr.write(`找不到文件：${source}\n`)
    return 1
  }
  if (mode !== 'all' && knownModes().includes(mode) === false) {
    process.stderr.write(`未知模式 ${mode}；可用：all、${knownModes().join('、')}\n`)
    return 1
  }
  if (looksLikeImage(source) === false) {
    process.stderr.write(
      `这个文件不像图片（支持 ${IMAGE_EXTENSIONS.join(' ')}）。\n` +
        'macOS 上可以先用 sips 转一下：sips -s format png 原图.jpg --out 新图.png\n',
    )
    return 1
  }

  const extension = path.extname(source).toLowerCase()
  const stem = safeName(as ?? path.basename(source, path.extname(source)))
  if (stem === undefined) {
    process.stderr.write('名字不能是空的。\n')
    return 1
  }
  const targetDir = path.join(userStickerRoot(root), mode)
  fs.mkdirSync(targetDir, { recursive: true })
  const target = path.join(targetDir, `${stem}${extension}`)
  if (fs.existsSync(target)) {
    process.stderr.write(`已经有一张叫 ${path.basename(target)} 的了；换个名字或先删掉它。\n`)
    return 1
  }
  fs.copyFileSync(source, target)
  clearUserStickerCache()

  const aliasFile = path.join(targetDir, 'aliases.json')
  if (as !== undefined && as !== stem) {
    let aliases = {}
    try {
      const raw = JSON.parse(fs.readFileSync(aliasFile, 'utf8'))
      if (raw !== null && typeof raw === 'object' && Array.isArray(raw) === false) aliases = raw
    } catch {
      // 没有或坏了就重建一份，反正别名只是锦上添花。
    }
    aliases[as] = `${stem}${extension}`
    fs.writeFileSync(aliasFile, `${JSON.stringify(aliases, null, 2)}\n`)
  }

  process.stdout.write(`已加入：${target}\n`)
  process.stdout.write(`现在可以让它在对话里发出来了 —— 写 [表情:${stem}]${as !== undefined ? `（别名：${as}）` : ''}\n`)
  process.stdout.write(`范围：${mode === 'all' ? '全部模式' : mode}；下一条消息就能发，不用重启。\n`)
  return 0
}

/** PNG 的 IHDR 就在固定偏移上，用来核对内置图尺寸而不依赖图像库。 */
function pngSize(file) {
  try {
    const head = Buffer.alloc(24)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, head, 0, 24, 0)
    } finally {
      fs.closeSync(fd)
    }
    if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) === false) return null
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  } catch {
    return null
  }
}

function commandCheck(root) {
  let missing = 0
  let wrongSize = 0
  for (const pack of [...SHARED_STICKERS.map(() => ({ stickers: SHARED_STICKERS })), ...MODE_STICKERS]) {
    for (const entry of pack.stickers) {
      const file = stickerPath(entry.id, root)
      if (fs.existsSync(file) === false) {
        process.stdout.write(`✗ 缺图：${entry.id} → ${file}\n`)
        missing += 1
        continue
      }
      const size = pngSize(file)
      if (size === null || size.width !== 360 || size.height !== 420) {
        process.stdout.write(`✗ 尺寸不对：${entry.id} → ${size === null ? '不是 PNG' : `${size.width}x${size.height}`}\n`)
        wrongSize += 1
      }
    }
  }
  const custom = listUserStickerFiles(root)
  process.stdout.write(`内置 ${SHARED_STICKERS.length + MODE_STICKERS.flatMap((p) => p.stickers).length} 张：缺 ${missing}、尺寸不对 ${wrongSize}\n`)
  if (custom.length === 0) {
    process.stdout.write('自己的：无\n')
  } else {
    process.stdout.write(`自己的：${custom.length} 张\n${custom.map((line) => `  ${line}`).join('\n')}\n`)
  }
  process.stdout.write(`目录：${STICKER_DIR}\n`)
  return missing + wrongSize === 0 ? 0 : 1
}

function main() {
  const { options, rest } = parse(process.argv.slice(2))
  const root = stateRoot()
  const command = rest.shift() ?? 'list'
  clearUserStickerCache()

  if (command === 'list') process.exitCode = commandList(root, options)
  else if (command === 'add') process.exitCode = commandAdd(root, rest[0], options)
  else if (command === 'check') process.exitCode = commandCheck(root)
  else {
    process.stderr.write('用法：node bin/stickers.mjs list|add|check [参数]\n')
    process.exitCode = 1
  }
}

main()