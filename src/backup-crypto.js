/**
 * 加密的状态备份：把一个账号的整个状态目录封成**一个**文件，只有口令能打开。
 *
 * 现有的 `createBackup` 是「目录对目录」的快速回滚（方便、但不设防），适合
 * 本机升级前自救。这个模块解决的是另一类场景：把状态交给别人、放到网盘、
 * 或者跨机器带走 —— 里面的 `config.json` 有 token、journal 有聊天原文，
 * 不能以明文离开这台机器。
 *
 * 形式刻意简单：`{ version, files: { "rel/path": "<base64>" } }` 的 JSON，
 * 用 scrypt 派生密钥 + AES-256-GCM 整体加密，文件头是 `DSHWX1`。没有 tar
 * 依赖，也不做增量 —— 备份是一次性的快照，读回来要能逐字节还原。
 *
 * @module dsh-weixin/backup-crypto
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SEALED_MAGIC = 'DSHWX1'
export const SEALED_VERSION = 1
// 第二个文件头：逐文件流式封包。`DSHWX1` 那种「整体 JSON」的写法会把每个文件
// 都 base64 进一个对象再 stringify，文件一大就撞上 V8 的单字符串上限（512 MB）
// —— 导出一个 1 GB 的状态目录必然报
// `Cannot create a string longer than 0x1fffffe8 characters`。新格式不再把任何
// 东西拼成一个大字符串：明文字节分块送进同一个 GCM 流，每个文件写进一条记录。
export const SEALED_STREAM_MAGIC = 'DSHWX2'
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
/** 一次读多少；加密器按块吃，内存里不会同时有一整个文件。 */
const READ_CHUNK_BYTES = 1 << 20

// 备份里不该出现的东西：备份自己、进程锁、以及运行时的派生缓存。
// `asr-models`（本机 923 MB）是下载下来的语音模型，`logs`（80 MB）是运行日志 ——
// 换机时都不该跟着走：前者能重新下载，后者没有迁移价值，而它们正是「导出直接
// 撞上限」的主因。
const SKIP_DIRS = new Set(['backups', 'node_modules', 'asr-models', 'logs'])
const SKIP_FILES = new Set(['instance.lock'])
// 媒体是迁移包里唯一可能上几十 MB 的东西（入站图片、语音、出站附件都在
// `media/` 下），而换机时大多数人只要「记忆与配置，不要旧照片」。所以它可以
// 被单独排除；其余目录一律跟着走 —— 一个能少装东西的开关，比一个能少装记忆
// 的开关安全得多。
const MEDIA_DIR = 'media'

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, KEY_BYTES)
}

/** @param {Buffer} plain @param {string} passphrase @returns {Buffer} */
export function sealBuffer(plain, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('a passphrase is required')
  }
  const salt = crypto.randomBytes(SALT_BYTES)
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from(SEALED_MAGIC, 'ascii'), salt, iv, tag, ciphertext])
}

/** @param {Buffer} packed @param {string} passphrase @returns {Buffer} */
export function openBuffer(packed, passphrase) {
  const header = Buffer.byteLength(SEALED_MAGIC, 'ascii')
  if (packed.length < header + SALT_BYTES + IV_BYTES + TAG_BYTES || packed.subarray(0, header).toString('ascii') !== SEALED_MAGIC) {
    throw new Error('not a sealed backup')
  }
  const salt = packed.subarray(header, header + SALT_BYTES)
  const iv = packed.subarray(header + SALT_BYTES, header + SALT_BYTES + IV_BYTES)
  const tag = packed.subarray(header + SALT_BYTES + IV_BYTES, header + SALT_BYTES + IV_BYTES + TAG_BYTES)
  const ciphertext = packed.subarray(header + SALT_BYTES + IV_BYTES + TAG_BYTES)
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new Error('wrong passphrase (or the file was modified)')
  }
}

function walk(root, relative = '', out = [], fromMedia = true) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) && relative === '') continue
      if (fromMedia === false && entry.name === MEDIA_DIR && relative === '') continue
      walk(root, rel, out)
    } else if (entry.isFile()) {
      if (relative === '' && SKIP_FILES.has(entry.name)) continue
      out.push(rel)
    }
  }
  return out
}

/**
 * @param {string} stateRoot
 * @param {{ passphrase: string, outFile: string, warn?: (line: string) => void, now?: number }} options
 * @returns {{ file: string, files: number, bytes: number }}
 *
 * 流式写盘：文件头 + 分块喂进同一个 GCM 流 + 每文件一条 `{ rel, size, offset }`
 * 记录 + 尾部 `{ records, end, tag }`。任何一步失败都会把半成品删掉，不留一个
 * 打不开的 `.enc` 让人以为备份成功。
 */
export function sealState(stateRoot, { passphrase, outFile, warn, now = Date.now(), includeMedia = true }) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('a passphrase is required')
  }
  const files = walk(stateRoot, '', [], includeMedia !== false)
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
  const salt = crypto.randomBytes(SALT_BYTES)
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)

  const handle = fs.openSync(outFile, 'w', 0o600)
  let sealed
  try {
    const put = (buffer) => {
      const out = cipher.update(buffer)
      if (out.length > 0) fs.writeSync(handle, out)
    }
    fs.writeSync(handle, Buffer.from(SEALED_STREAM_MAGIC, 'ascii'))
    fs.writeSync(handle, salt)
    fs.writeSync(handle, iv)
    put(Buffer.from(JSON.stringify({ version: SEALED_VERSION, sealedAt: new Date(now).toISOString() }), 'utf8'))
    put(Buffer.from('\n', 'utf8'))

    let offset = 0
    for (const rel of files) {
      const absolute = path.join(stateRoot, rel)
      const size = fs.statSync(absolute).size
      put(Buffer.from(JSON.stringify({ rel, size, offset }), 'utf8'))
      put(Buffer.from('\n', 'utf8'))
      // 一个 1 GB 的文件不能 readFileSync：按块读、按块加密，内存里始终只有
      // READ_CHUNK_BYTES。写完后 offset 必须正好等于 size，否则包自相矛盾。
      const fd = fs.openSync(absolute, 'r')
      try {
        const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
        let written = 0
        while (written < size) {
          const read = fs.readSync(fd, buffer, 0, Math.min(READ_CHUNK_BYTES, size - written), written)
          if (read <= 0) break
          put(buffer.subarray(0, read))
          written += read
        }
        if (written !== size) throw new Error(`${rel} changed while it was being sealed`)
        offset += written
      } finally {
        fs.closeSync(fd)
      }
    }

    put(Buffer.from(JSON.stringify({ records: files.length, end: offset }), 'utf8'))
    put(Buffer.from('\n', 'utf8'))
    const tail = cipher.final()
    if (tail.length > 0) fs.writeSync(handle, tail)
    fs.writeSync(handle, cipher.getAuthTag())
    sealed = fs.fstatSync(handle).size
  } catch (error) {
    try {
      fs.closeSync(handle)
    } catch {
      // 已经关掉就算了；下面只为删掉半成品。
    }
    try {
      fs.rmSync(outFile, { force: true })
    } catch {
      // 删不掉也不能盖住真正的错误。
    }
    throw error
  }
  fs.closeSync(handle)
  warn?.(`sealed ${files.length} file(s) into ${outFile}`)
  return { file: outFile, files: files.length, bytes: sealed }
}

function safeRelative(rel) {
  const normalised = path.posix.normalize(rel)
  if (normalised.startsWith('..') || path.isAbsolute(normalised)) {
    throw new Error(`refusing an archive path that escapes the state root: ${rel}`)
  }
  return normalised
}

/**
 * 打开一个流式封包（`DSHWX2`）。真正的重活是「把密文整段解密进内存」——
 * 一个 1 GB 的包因此需要约 1 GB 临时内存，但这已经比原来的实现好几倍：旧实现
 * 要同时持有明文、base64 与那份巨大 JSON，而 512 MB 的字符串上限是硬墙。
 *
 * 校验是严格的：每条记录的 offset 必须与已读字节数对齐，记录数必须等于尾部
 * 声明的数量，读到的字节总数必须等于尾部声明的总长 —— 包被改过就抛错。
 */
function openStream(file, passphrase) {
  const packed = fs.readFileSync(file)
  const header = Buffer.byteLength(SEALED_STREAM_MAGIC, 'ascii')
  if (packed.length < header + SALT_BYTES + IV_BYTES + TAG_BYTES + 1 || packed.subarray(0, header).toString('ascii') !== SEALED_STREAM_MAGIC) {
    throw new Error('not a sealed backup')
  }
  const salt = packed.subarray(header, header + SALT_BYTES)
  const iv = packed.subarray(header + SALT_BYTES, header + SALT_BYTES + IV_BYTES)
  const ciphertext = packed.subarray(header + SALT_BYTES + IV_BYTES, packed.length - TAG_BYTES)
  const tag = packed.subarray(packed.length - TAG_BYTES)

  let plain
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
    decipher.setAuthTag(tag)
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new Error('wrong passphrase (or the file was modified)')
  }

  // 顺序读，不按行切：文件正文里本来就可能有换行，按行切会把内容当成记录。
  // 游标读的是「记录行 + 紧随其后的 size 字节」，两者交替出现。
  const files = new Map()
  let at = 0
  const readLine = () => {
    const end = plain.indexOf(0x0a, at)
    if (end === -1) throw new Error('the sealed backup is truncated')
    const line = plain.subarray(at, end)
    at = end + 1
    return line
  }

  let meta
  try {
    meta = JSON.parse(readLine().toString('utf8'))
  } catch (error) {
    if (error?.message === 'the sealed backup is truncated') throw error
    throw new Error('the sealed backup header is not valid JSON')
  }
  if (meta?.version !== SEALED_VERSION) throw new Error('unsupported sealed backup version')

  let cursor = 0
  for (;;) {
    // 记录行与尾行长得都像 JSON，所以先把这一行读出来再判断是不是尾行。
    let line
    try {
      line = JSON.parse(readLine().toString('utf8'))
    } catch (error) {
      if (error?.message === 'the sealed backup is truncated') throw error
      // 正文之后不该出现无法解析的行；这说明包被改过或截断了。
      throw new Error('the sealed backup has a malformed record')
    }
    if (line?.records !== undefined && line?.rel === undefined) {
      if (line.records !== files.size) throw new Error('the sealed backup is incomplete')
      if (Number(line.end) !== cursor) throw new Error('the sealed backup has trailing bytes')
      if (at !== plain.length) throw new Error('the sealed backup has trailing bytes')
      return { version: meta.version, sealedAt: meta.sealedAt, files }
    }
    const rel = safeRelative(String(line?.rel ?? ''))
    const size = Number(line?.size)
    if (!Number.isInteger(size) || size < 0 || Number(line?.offset) !== cursor) {
      throw new Error(`the sealed backup has a bad record for ${rel}`)
    }
    if (at + size > plain.length) throw new Error('the sealed backup is truncated')
    files.set(rel, plain.subarray(at, at + size))
    at += size
    cursor += size
  }
}

/**
 * 打开一个密封备份，返回里面的文件表（相对路径 → Buffer）。
 * 不写盘；写入由 {@link restoreSealed} 负责，先验证再落盘。
 * 两种格式都认：`DSHWX2`（流式，当前写法）与 `DSHWX1`（整体 JSON，1.5.2 及
 * 更早写出的包必须继续能打开）。
 *
 * @param {string} file
 * @param {{ passphrase: string }} options
 * @returns {{ version: number, sealedAt?: string, files: Map<string, Buffer> }}
 */
export function openState(file, { passphrase }) {
  const head = Buffer.alloc(Buffer.byteLength(SEALED_STREAM_MAGIC, 'ascii'))
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, head, 0, head.length, 0)
  } finally {
    fs.closeSync(fd)
  }
  if (head.toString('ascii') === SEALED_STREAM_MAGIC) return openStream(file, passphrase)

  const plain = openBuffer(fs.readFileSync(file), passphrase)
  let payload
  try {
    payload = JSON.parse(plain.toString('utf8'))
  } catch {
    throw new Error('the sealed backup is not valid JSON')
  }
  if (payload?.version !== SEALED_VERSION || typeof payload.files !== 'object' || payload.files === null) {
    throw new Error('unsupported sealed backup version')
  }
  const files = new Map()
  for (const [rel, base64] of Object.entries(payload.files)) {
    files.set(safeRelative(rel), Buffer.from(String(base64), 'base64'))
  }
  return { version: payload.version, sealedAt: payload.sealedAt, files }
}

/**
 * 把 {@link openState} 的结果写回状态目录。**先全量校验，再写一个字节**：
 * 口令错了不会留下半套状态。
 *
 * @param {string} stateRoot
 * @param {Map<string, Buffer>} files
 * @param {{ warn?: (line: string) => void }} [options]
 * @returns {{ restored: number }}
 */
export function restoreSealed(stateRoot, files, { warn } = {}) {
  const planned = []
  for (const [rel, buffer] of files) {
    const target = path.resolve(stateRoot, rel)
    if (!target.startsWith(path.resolve(stateRoot) + path.sep)) {
      throw new Error(`refusing to write outside the state root: ${rel}`)
    }
    planned.push([target, buffer])
  }
  for (const [target, buffer] of planned) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temp = `${target}.restoring`
    fs.writeFileSync(temp, buffer)
    fs.renameSync(temp, target)
  }
  warn?.(`restored ${planned.length} file(s)`)
  return { restored: planned.length }
}
