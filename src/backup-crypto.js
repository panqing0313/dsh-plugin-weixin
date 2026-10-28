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
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

// 备份里不该出现的东西：备份自己、进程锁、以及运行时的派生缓存。
const SKIP_DIRS = new Set(['backups', 'node_modules'])
const SKIP_FILES = new Set(['instance.lock'])

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

function walk(root, relative = '', out = []) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) && relative === '') continue
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
 */
export function sealState(stateRoot, { passphrase, outFile, warn, now = Date.now() }) {
  const files = walk(stateRoot)
  const payload = { version: SEALED_VERSION, sealedAt: new Date(now).toISOString(), files: {} }
  for (const rel of files) {
    payload.files[rel] = fs.readFileSync(path.join(stateRoot, rel)).toString('base64')
  }
  const packed = sealBuffer(Buffer.from(JSON.stringify(payload), 'utf8'), passphrase)
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
  fs.writeFileSync(outFile, packed, { mode: 0o600 })
  warn?.(`sealed ${files.length} file(s) into ${outFile}`)
  return { file: outFile, files: files.length, bytes: packed.length }
}

/**
 * 打开一个密封备份，返回里面的文件表（相对路径 → Buffer）。
 * 不写盘；写入由 {@link restoreSealed} 负责，先验证再落盘。
 *
 * @param {string} file
 * @param {{ passphrase: string }} options
 * @returns {{ version: number, sealedAt?: string, files: Map<string, Buffer> }}
 */
export function openState(file, { passphrase }) {
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
    const normalised = path.posix.normalize(rel)
    if (normalised.startsWith('..') || path.isAbsolute(normalised)) {
      throw new Error(`refusing an archive path that escapes the state root: ${rel}`)
    }
    files.set(normalised, Buffer.from(String(base64), 'base64'))
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
