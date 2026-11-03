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
//   node bin/stickers.mjs fetch <包 id> [--mode all|<模式>] [--from <目录>] [--list] [--force]
//   node bin/stickers.mjs check
//
// fetch 装的是 `assets/sticker-packs/<id>.json` 里那一套：脚本里只有「名字 +
// 出处 + sha」的清单，图片在你自己的机器上现取（`repo` 是公开仓库，`path`/`sha`
// 指向其中一个文件）。这样别人的图不会被塞进 npm 包，权利仍然归原作者。
//
// 退出码：check 有问题、或 fetch 没装成时为 1，其余 0。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PACK_DIR = path.join(PROJECT_ROOT, 'assets', 'sticker-packs')

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
  const options = { mode: 'all', as: undefined, json: false, from: undefined, force: false, list: false, limit: undefined }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--force') options.force = true
    else if (arg === '--list') options.list = true
    else if (arg === '--mode') options.mode = argv[++index]
    else if (arg === '--as') options.as = argv[++index]
    else if (arg === '--limit') options.limit = Number(argv[++index])
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length))
    else if (arg === '--from') options.from = argv[++index]
    else if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length)
    else if (arg.startsWith('--as=')) options.as = arg.slice('--as='.length)
    else if (arg.startsWith('--from=')) options.from = arg.slice('--from='.length)
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

/** 读一个表情包清单。id 只允许小写字母、数字和短横，避免拼出目录穿越。 */
function readPack(id) {
  if (typeof id !== 'string' || id === '' || /^[a-z0-9-]+$/.test(id) === false) {
    return { error: `包 id 不合法：${id ?? '(缺)'}` }
  }
  const file = path.join(PACK_DIR, `${id}.json`)
  try {
    const pack = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (pack === null || typeof pack !== 'object' || Array.isArray(pack.items) === false) {
      return { error: `${file} 里没有 items` }
    }
    return { pack, file }
  } catch (err) {
    return { error: `读不到包清单 ${file}：${err.message}` }
  }
}

/** 仓库里带清单的包 id（给「用法」和错拼时列出来）。 */
function packIds() {
  try {
    return fs
      .readdirSync(PACK_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort()
  } catch {
    return []
  }
}

/**
 * 找一个装了 Pillow 的解释器。清单里存的多半是 WebP，转成 PNG 再发最稳
 * （内置图全是 PNG），但没有 Pillow 也照装不误 —— 那就保留原格式。
 */
function pillowPython() {
  for (const candidate of ['/usr/local/bin/python3.14', '/opt/homebrew/bin/python3', 'python3']) {
    const probe = spawnSync(candidate, ['-c', 'import PIL'], { stdio: 'ignore' })
    if (probe.status === 0) return candidate
  }
  return undefined
}

function convertToPng(python, source, target) {
  const code =
    'import sys\n' +
    'from PIL import Image\n' +
    'with Image.open(sys.argv[1]) as image:\n' +
    '    image.convert("RGBA").save(sys.argv[2], "PNG", optimize=True)\n'
  return spawnSync(python, ['-c', code, source, target], { encoding: 'utf8' }).status === 0
}

async function downloadBlob(repo, sha) {
  const url = `https://api.github.com/repos/${repo}/git/blobs/${sha}`
  // 未登录的 GitHub API 每小时只给 60 次；有 token 就带上（`GITHUB_TOKEN` 或
  // `GH_TOKEN`），一整套 25 张一次装完不会卡在限额上。
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const answer = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-plugin-weixin-stickers',
      ...(typeof token === 'string' && token !== '' ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (answer.ok === false) throw new Error(`${answer.status} ${answer.statusText}`)
  const body = await answer.json()
  if (typeof body?.content !== 'string') throw new Error('响应里没有 content')
  return Buffer.from(body.content, 'base64')
}

/**
 * 装一套清单里的图：默认从公开仓库现取，`--from <目录>` 则改从本地已下好的
 * 同名文件复制（离线、或给测试用）。写进 `<数据目录>/stickers/<模式>/`，
 * 名字就是模型要写的 [表情:名字]，同义词写进同一目录的 aliases.json。
 */
async function commandFetch(root, id, options) {
  const available = packIds()
  if (id === undefined) {
    process.stderr.write(`用法：node bin/stickers.mjs fetch <包 id> [--mode all|<模式>] [--limit <张数>] [--from <目录>] [--list] [--force]\n`)
    process.stderr.write(`可用的包：${available.join('、') === '' ? '(无)' : available.join('、')}\n`)
    return 1
  }
  const { pack, error } = readPack(id)
  if (error !== undefined) {
    process.stderr.write(`${error}\n可用的包：${available.join('、') === '' ? '(无)' : available.join('、')}\n`)
    return 1
  }

  if (options.list) {
    process.stdout.write(`${pack.name}（${pack.items.length} 张）\n`)
    process.stdout.write(`  出处：${pack.homepage ?? pack.items[0]?.source?.repo ?? '(未写)'}\n`)
    process.stdout.write(`  权利：${pack.license ?? '(未写)'}\n`)
    for (const item of pack.items) {
      process.stdout.write(`  [表情:${item.name}]  ←  ${item.source?.repo}/${item.source?.path}\n`)
    }
    return 0
  }

  if (options.mode !== 'all' && knownModes().includes(options.mode) === false) {
    process.stderr.write(`未知模式 ${options.mode}；可用：all、${knownModes().join('、')}\n`)
    return 1
  }

  const targetDir = path.join(userStickerRoot(root), options.mode)
  fs.mkdirSync(targetDir, { recursive: true })
  const python = pillowPython()
  // 已经装过哪些名字（不看扩展名）：转不转 PNG 取决于这台机器有没有 Pillow，
  // 所以「装过没有」只认名字，免得同一张图被 .png 和 .webp 各装一份。
  const present = new Set()
  try {
    for (const name of fs.readdirSync(targetDir)) {
      if (name === 'aliases.json') continue
      present.add(path.basename(name, path.extname(name)))
    }
  } catch {
    // 目录刚建出来，读不到也没关系。
  }
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : undefined
  const wanted = limit === undefined ? pack.items : pack.items.slice(0, limit)
  const installed = []
  let skipped = 0
  let failed = 0

  for (const item of wanted) {
    const name = safeName(item?.name)
    const sourcePath = String(item?.source?.path ?? '')
    if (name === undefined || sourcePath === '') {
      process.stderr.write(`✗ 清单里有一项缺 name 或 source.path\n`)
      failed += 1
      continue
    }
    const extension = path.extname(sourcePath).toLowerCase()
    const outputName = python === undefined ? `${name}${extension}` : `${name}.png`
    if (present.has(name) && options.force !== true) {
      process.stdout.write(`跳过（已存在）：${name}\n`)
      skipped += 1
      continue
    }

    let raw
    if (options.from !== undefined) {
      const local = path.join(path.resolve(options.from), path.basename(sourcePath))
      if (fs.existsSync(local) === false) {
        process.stderr.write(`✗ ${name}：--from 目录里没有 ${path.basename(sourcePath)}\n`)
        failed += 1
        continue
      }
      raw = fs.readFileSync(local)
    } else {
      try {
        raw = await downloadBlob(item.source.repo, item.source.sha)
      } catch (err) {
        process.stderr.write(`✗ ${name}：取图失败 ${err.message}\n`)
        failed += 1
        continue
      }
    }

    const scratch = path.join(os.tmpdir(), `dsh-sticker-${process.pid}-${installed.length}${extension}`)
    fs.writeFileSync(scratch, raw)
    try {
      const target = path.join(targetDir, outputName)
      if (python !== undefined && convertToPng(python, scratch, target)) {
        installed.push(outputName)
        present.add(name)
        continue
      }
      const fallback = path.join(targetDir, `${name}${extension}`)
      fs.copyFileSync(scratch, fallback)
      installed.push(`${name}${extension}`)
      present.add(name)
    } finally {
      fs.rmSync(scratch, { force: true })
    }
  }

  const aliases = pack.aliases ?? {}
  const known = new Set(installed.map((file) => path.basename(file, path.extname(file))))
  const aliasFile = path.join(targetDir, 'aliases.json')
  let merged = {}
  try {
    const raw = JSON.parse(fs.readFileSync(aliasFile, 'utf8'))
    if (raw !== null && typeof raw === 'object' && Array.isArray(raw) === false) merged = raw
  } catch {
    // 没有别名文件很正常，重建一份就行。
  }
  let aliasCount = 0
  for (const [alias, name] of Object.entries(aliases)) {
    if (known.has(name) === false) continue
    const file = installed.find((entry) => path.basename(entry, path.extname(entry)) === name)
    merged[alias] = file
    aliasCount += 1
  }
  if (aliasCount > 0) fs.writeFileSync(aliasFile, `${JSON.stringify(merged, null, 2)}\n`)
  clearUserStickerCache()

  process.stdout.write(`\n装好 ${installed.length} 张 → ${targetDir}${skipped > 0 ? `（跳过 ${skipped} 张已存在的）` : ''}\n`)
  if (aliasCount > 0) process.stdout.write(`同义词 ${aliasCount} 条 → ${aliasFile}\n`)
  if (installed.length > 0) {
    process.stdout.write(`现在可以写：[表情:${known.values().next().value}]\n`)
  }
  if (python === undefined) {
    process.stdout.write('没找到装了 Pillow 的 python3，原格式直接存下了（WebP 一般也能发；想转 PNG：python3 -m pip install Pillow 后重跑）。\n')
  }
  process.stdout.write(`\n这套图来自 ${pack.homepage ?? pack.items[0]?.source?.repo}，${pack.license ?? '权利归原作者'}。\n`)
  process.stdout.write(`${pack.note ?? ''}\n`.replace(/^\n/, ''))
  // 只要装成了东西就算成功；`--from` 只喂了一部分（或网断了）也会失败几项，
  // 那种情况下退 1 会把「已经装好的」也一起说成失败。
  return installed.length === 0 && skipped === 0 && failed > 0 ? 1 : 0
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

async function main() {
  const { options, rest } = parse(process.argv.slice(2))
  const root = stateRoot()
  const command = rest.shift() ?? 'list'
  clearUserStickerCache()

  if (command === 'list') process.exitCode = commandList(root, options)
  else if (command === 'add') process.exitCode = commandAdd(root, rest[0], options)
  else if (command === 'fetch') process.exitCode = await commandFetch(root, rest[0], options)
  else if (command === 'check') process.exitCode = commandCheck(root)
  else {
    process.stderr.write('用法：node bin/stickers.mjs list|add|fetch|check [参数]\n')
    process.exitCode = 1
  }
}

await main()