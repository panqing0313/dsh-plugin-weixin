/**
 * Crash-safe state files.
 *
 * Every JSON file this plugin keeps is small and rewritten whole (reminders,
 * subscriptions, memory, persona, life state, proactive counters). A plain
 * `writeFileSync` truncates the file first, so a crash — or a full disk — in
 * the middle leaves a half-written document. The user-visible result is not an
 * error message but amnesia: the next read sees invalid JSON, decides the file
 * is corrupt and starts over, and the reminders / memories are simply gone.
 *
 * So: write a sibling temp file, fsync it, rename it over the target. `rename`
 * is atomic on every filesystem this runs on, which means a reader sees either
 * the old file or the new one, never a torn one.
 *
 * The second half of the contract is {@link readJsonFile} with a schema
 * version: files gain a `schemaVersion` stamp when written, and a file without
 * one is an old file that the caller's `migrate` function normalises. Absent
 * versions are treated as 0, which is exactly the pre-versioning shape.
 *
 * @module dsh-weixin/atomic
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 热路径的文本缓存。
 *
 * 每条入站消息都会重读几个小 JSON（config、accounts-registry、persona、
 * conv memory），而 `readFileSync` 的开销主要在 open/read/close 与 UTF-8 解码，
 * 不在 `JSON.parse`。缓存**文本**而不是解析后的对象：每次调用仍然 parse 出
 * 一个新对象，调用方照旧可以随意修改、写回，不存在「改到缓存里的共享对象」
 * 这种隐蔽 bug。
 *
 * 失效靠 `stat`（mtime + size + ino）：原子写的 rename 会换 inode，普通覆盖
 * 会改 mtime/size，所以下一次读必然拿到新内容。缓存上限 512 条，超出按插入
 * 顺序淘汰最旧的一条（Map 的迭代顺序就是插入顺序，读命中时重新插入以维持
 * 近似 LRU）。
 */
const TEXT_CACHE_LIMIT = 512
const textCache = new Map()

/**
 * Read a file as UTF-8 text, reusing the previous read when the file has not
 * changed. Throws the same errors `fs.statSync`/`fs.readFileSync` would.
 *
 * @param {string} file
 * @returns {string}
 */
export function readTextFileCached(file) {
  const stat = fs.statSync(file)
  const hit = textCache.get(file)
  if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size && hit.ino === stat.ino) {
    textCache.delete(file)
    textCache.set(file, hit)
    return hit.text
  }
  const text = fs.readFileSync(file, 'utf8')
  textCache.delete(file)
  textCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, text })
  if (textCache.size > TEXT_CACHE_LIMIT) {
    const oldest = textCache.keys().next().value
    textCache.delete(oldest)
  }
  return text
}

/** Drop one file (or everything) from the cache — used after a write and by tests. */
export function clearTextFileCache(file) {
  if (file === undefined) textCache.clear()
  else textCache.delete(file)
}

/**
 * Write `value` as JSON atomically.
 *
 * @param {string} file absolute path
 * @param {unknown} value anything `JSON.stringify` accepts
 * @param {{ mode?: number, warn?: (message: string) => void, indent?: string | number }} [options]
 * @returns {boolean} whether the file now holds the new value
 */
export function atomicWriteJson(file, value, options = {}) {
  const mode = options.mode ?? 0o600
  const warn = options.warn ?? (() => {})
  const indent = options.indent ?? 2
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // fsync the data before the rename: without it a crash can leave the
    // rename durable while the bytes it points at are not.
    const handle = fs.openSync(temp, 'w', mode)
    try {
      fs.writeFileSync(handle, `${JSON.stringify(value, null, indent)}\n`)
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    fs.renameSync(temp, file)
    // The rename already changes mtime/ino, so the next read would miss anyway;
    // dropping the entry keeps a same-millisecond rewrite from ever serving the
    // previous bytes.
    clearTextFileCache(file)
    return true
  } catch (error) {
    warn(`could not write ${path.basename(file)}: ${String(error?.message ?? error)}`)
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // The temp file is already useless; nothing left to do.
    }
    return false
  }
}

/**
 * Read a JSON document, migrating it from an older schema in place.
 *
 * `migrate(parsed, fromVersion)` must return the current-shape object; the
 * caller stamps `schemaVersion` so the next read takes the fast path. A file
 * that is missing, unparseable or not an object yields `fallback` (with a
 * warning for everything except "missing" — a first run is not an error).
 *
 * @template T
 * @param {string} file
 * @param {object} spec
 * @param {number} spec.version current schema version
 * @param {() => T} spec.fallback value for a missing/corrupt file
 * @param {(parsed: any, fromVersion: number) => T} [spec.migrate]
 * @param {(message: string) => void} [spec.warn]
 * @param {(migrated: T) => void} [spec.persist] called once when a migration happened
 * @returns {T}
 */
export function readJsonFile(file, spec) {
  const warn = spec.warn ?? (() => {})
  const fallback = spec.fallback
  let raw
  try {
    raw = readTextFileCached(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`could not read ${path.basename(file)}: ${String(error?.message ?? error)}`)
    return fallback()
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    warn(`${path.basename(file)} is not valid JSON; starting from a clean state`)
    return fallback()
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`${path.basename(file)} does not hold a JSON object; starting from a clean state`)
    return fallback()
  }
  const from = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 0
  const migrate = spec.migrate ?? ((value) => /** @type {T} */ (value))
  const migrated = migrate(parsed, from)
  if (from < spec.version) {
    // Stamp and persist once: the migration is idempotent, so a crash between
    // here and the write just repeats it on the next read.
    const stamped = { .../** @type {any} */ (migrated), schemaVersion: spec.version }
    spec.persist?.(stamped) ?? atomicWriteJson(file, stamped, { warn })
    return stamped
  }
  return migrated
}
