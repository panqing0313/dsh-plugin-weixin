// 表情包清单（`assets/sticker-packs/*.json`）与 `bin/stickers.mjs fetch` 的守卫。
//
// 清单里只有「名字 + 出处 + sha」，图片本身不进仓库也不进 npm 包 —— 别人的画，
// 权利在原作者手里；`fetch` 是在用户自己的机器上从公开仓库现取的。这组测试盯着
// 三件事：清单结构完整、离线（`--from`）能装成、装出来的名字与别名对得上。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PACK_DIR = path.join(PROJECT_ROOT, 'assets', 'sticker-packs')
const CLI = path.join(PROJECT_ROOT, 'bin', 'stickers.mjs')

function packFiles() {
  return fs
    .readdirSync(PACK_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ id: name.slice(0, -'.json'.length), file: path.join(PACK_DIR, name) }))
}

test('every pack lists a name, a source and a forty-character sha for each sticker', () => {
  const packs = packFiles()
  assert.ok(packs.length >= 1, 'at least one pack ships in assets/sticker-packs')
  for (const { id, file } of packs) {
    const pack = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(pack.id, id, `${id}.json 的 id 要和文件名一致`)
    assert.equal(typeof pack.name, 'string')
    assert.equal(typeof pack.license, 'string', `${id} 要写清楚图片权利归谁`)
    assert.ok(Array.isArray(pack.items) && pack.items.length > 0, `${id} 要有 items`)
    const names = new Set()
    const paths = new Set()
    for (const item of pack.items) {
      assert.equal(typeof item.name, 'string')
      assert.ok(item.name.length > 0 && item.name.length <= 24, `${item.name} 太长或为空`)
      assert.equal(names.has(item.name), false, `名字重复：${item.name}`)
      names.add(item.name)
      assert.match(item.file, new RegExp(`^${item.name}\\.(png|webp|jpg|jpeg|gif)$`), '文件名要以名字开头')
      assert.match(item.source.repo, /^[\w.-]+\/[\w.-]+$/, 'source.repo 要是 owner/name')
      assert.equal(item.source.path.includes('..'), false, 'source.path 不该跳出仓库')
      assert.match(item.source.sha, /^[0-9a-f]{40}$/, 'source.sha 要是一个 git blob 的 sha')
      assert.equal(paths.has(item.source.path), false, `出处重复：${item.source.path}`)
      paths.add(item.source.path)
    }
    for (const [alias, name] of Object.entries(pack.aliases ?? {})) {
      assert.ok(alias.length > 0 && alias.length <= 24, '别名不能为空或过长')
      assert.equal(names.has(name), true, `别名 ${alias} 指向了不在清单里的 ${name}`)
      assert.notEqual(alias, name, '别名不该等于本名')
    }
  }
})

test('the shipped pack lists its stickers without shipping their pictures', () => {
  // --others 让还没提交的新清单也算进来，这样「目录里只有 json」这条规则在
  // 提交前也一样成立。
  const tracked = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'assets/sticker-packs'],
    { cwd: PROJECT_ROOT, encoding: 'utf8' },
  )
  if (tracked.status !== 0) return // 不在 git 工作树里（例如解开的 tarball）：跳过这条即可
  const files = tracked.stdout.split('\n').filter((line) => line !== '')
  assert.ok(files.length >= 1)
  for (const file of files) {
    assert.ok(file.endsWith('.json'), `清单目录里只该有 json：${file}`)
  }
})

test('fetch --list names every sticker and where it comes from', () => {
  const pack = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'bluefish.json'), 'utf8'))
  const run = spawnSync(process.execPath, [CLI, 'fetch', 'bluefish', '--list'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /蓝色大肥鱼/)
  assert.match(run.stdout, /权利归原作者/, '要在输出里说清权利归属')
  for (const item of pack.items.slice(0, 3)) {
    assert.ok(run.stdout.includes(`[表情:${item.name}]`), `--list 里要有 ${item.name}`)
  }
})

test('fetch --from installs into the user sticker folder and writes the aliases', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-pack-state-'))
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-pack-from-'))
  try {
    const pack = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'bluefish.json'), 'utf8'))
    // 只喂三张假图，够验证复制、命名、别名合并；离线也能跑。
    const first = pack.items.slice(0, 3)
    for (const item of first) {
      fs.writeFileSync(path.join(from, path.basename(item.source.path)), Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]))
    }
    const run = spawnSync(
      process.execPath,
      [CLI, 'fetch', 'bluefish', '--from', from, '--mode', 'all'],
      { encoding: 'utf8', env: { ...process.env, DSH_WEIXIN_STATE_DIR: stateRoot } },
    )
    assert.equal(run.status, 0, run.stderr)

    const targetDir = path.join(stateRoot, 'stickers', 'all')
    const landed = fs.readdirSync(targetDir).sort()
    assert.equal(landed.filter((name) => name !== 'aliases.json').length, 3)
    for (const item of first) {
      assert.ok(
        landed.some((name) => name.startsWith(item.name) && /\.(png|webp|jpg|jpeg|gif)$/.test(name)),
        `${item.name} 应该装进去了`,
      )
    }

    const aliases = JSON.parse(fs.readFileSync(path.join(targetDir, 'aliases.json'), 'utf8'))
    const names = new Set(first.map((item) => item.name))
    const mine = Object.entries(pack.aliases).filter(([, name]) => names.has(name))
    assert.ok(mine.length > 0, 'bluefish 的别名表里应该至少有一条落在这三张里')
    for (const [alias, name] of mine) {
      assert.ok(aliases[alias]?.startsWith(name), `别名 ${alias} 要指向 ${name}`)
    }

    // 再跑一次：已存在的跳过，不重复装。
    const again = spawnSync(
      process.execPath,
      [CLI, 'fetch', 'bluefish', '--from', from, '--mode', 'all'],
      { encoding: 'utf8', env: { ...process.env, DSH_WEIXIN_STATE_DIR: stateRoot } },
    )
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /跳过（已存在）/)
    assert.equal(fs.readdirSync(targetDir).filter((name) => name !== 'aliases.json').length, 3)
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
})

test('fetch refuses an unknown or unsafe pack id', () => {
  const missing = spawnSync(process.execPath, [CLI, 'fetch', 'nope'], { encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /可用的包：/)

  const unsafe = spawnSync(process.execPath, [CLI, 'fetch', '../etc/passwd'], { encoding: 'utf8' })
  assert.equal(unsafe.status, 1)
  assert.match(unsafe.stderr, /包 id 不合法/)
})