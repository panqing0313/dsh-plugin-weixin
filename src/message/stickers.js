import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { stateDir } from '../state.js'

/**
 * The built-in sticker packs.
 *
 * Why pictures and not stickers: the iLink protocol has no sticker message
 * type. `vendor/openclaw-weixin/api/types.js` enumerates TEXT / IMAGE / VOICE /
 * FILE / VIDEO (plus two tool-call types) and nothing else — there is no
 * `emoji_item`, so the tappable, animated stickers WeChat itself sends cannot
 * be produced by a bot at all. An image bubble is the closest thing that
 * actually arrives, which is what this module feeds.
 *
 * The model never sees a file path. It writes a marker (`[表情:开心]`) where a
 * person would drop a sticker, and the reply pipeline swaps that marker for the
 * matching PNG and sends it as its own image message. Keeping the catalog in
 * one place means the prompt, the marker parser and the files cannot drift.
 *
 * Three layers:
 *   - a shared pack everyone can use (base twelve + twelve "cute" ones);
 *   - one pack per character mode (女友 / 男友 / 朋友 / 贾维斯 / 猫娘 …), which
 *     only appears while the conversation is in that mode — a cat sticker from
 *     a 御姐 would give the whole thing away;
 *   - whatever the user drops into `<state>/stickers/` (see below).
 *
 * The art is drawn by `scripts/make-stickers.py` — see that file for why it is
 * generated instead of shipped as opaque blobs.
 *
 * Custom packs: `<state>/stickers/all/*.png` (available in every mode) and
 * `<state>/stickers/<modeId>/*.png` (only in that mode). The file name is the
 * name the model writes in the marker, so `老板.png` is `[表情:老板]`; an
 * optional `aliases.json` in the same folder (`{"发红包": "老板.png"}`) adds
 * more names for the same file. Real photos work fine here — a dropped-in JPEG
 * is just a PNG away, and `node bin/stickers.mjs add` does the conversion-less
 * copy for you.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const STICKER_DIR = path.join(HERE, '..', '..', 'assets', 'stickers')

/** How many stickers one reply may carry: one is a beat, three is a flood. */
export const MAX_STICKERS_PER_REPLY = 2

/** Marker prefix for a user-supplied file; keeps them apart from catalog ids. */
const USER_PREFIX = 'user:'

/** The folder someone can drop their own pictures into. */
export function userStickerRoot(root = stateDir()) {
  return path.join(root, 'stickers')
}

/**
 * id (file name), caption (drawn into the image), and every name the model is
 * allowed to write in the marker. The captions double as aliases because the
 * model reads them off the prompt and copies them back verbatim.
 */
export const BASE_STICKERS = [
  { id: 'happy', caption: '开心', aliases: ['开心', '高兴', '笑', '微笑'] },
  { id: 'laugh', caption: '哈哈', aliases: ['哈哈', '大笑', '笑哭'] },
  { id: 'cry', caption: '呜呜', aliases: ['呜呜', '哭', '哭哭', '难过'] },
  { id: 'sad', caption: '委屈', aliases: ['委屈', '可怜', '求抱抱'] },
  { id: 'angry', caption: '生气', aliases: ['生气', '气', '哼', '不爽'] },
  { id: 'shy', caption: '害羞', aliases: ['害羞', '脸红', '害羞了'] },
  { id: 'speechless', caption: '无语', aliases: ['无语', '汗', '服了'] },
  { id: 'sleepy', caption: '困了', aliases: ['困了', '困', '想睡'] },
  { id: 'love', caption: '喜欢你', aliases: ['喜欢你', '喜欢', '爱心'] },
  { id: 'awesome', caption: '厉害', aliases: ['厉害', '棒', '赞', '牛'] },
  { id: 'cheer', caption: '加油', aliases: ['加油', '冲', '努力'] },
  { id: 'goodnight', caption: '晚安', aliases: ['晚安', '睡了', '睡觉啦'] },
]

export const CUTE_STICKERS = [
  { id: 'expect', caption: '期待', aliases: ['期待', '等不及', '盼望'] },
  { id: 'giggle', caption: '偷笑', aliases: ['偷笑', '窃喜', '嘿嘿'] },
  { id: 'cover', caption: '捂脸', aliases: ['捂脸', '没脸见人', '捂眼睛'] },
  { id: 'hug', caption: '抱抱', aliases: ['抱抱', '抱一下', '要抱抱'] },
  { id: 'cheer_up', caption: '打气', aliases: ['打气', '撑住', '你可以的'] },
  { id: 'confetti', caption: '撒花', aliases: ['撒花', '庆祝', '恭喜'] },
  { id: 'melon', caption: '吃瓜', aliases: ['吃瓜', '看戏', '好奇'] },
  { id: 'clap', caption: '鼓掌', aliases: ['鼓掌', '拍手', '好耶'] },
  { id: 'nod', caption: '点头', aliases: ['点头', '同意', '嗯嗯'] },
  { id: 'shake', caption: '摇头', aliases: ['摇头', '不要', '不行'] },
  { id: 'shock', caption: '大惊', aliases: ['大惊', '吃惊', '震惊', '惊讶'] },
  { id: 'heart_hands', caption: '比心', aliases: ['比心', '笔芯', '爱你哦'] },
]

/** Free for every mode: the shared two packs. */
export const SHARED_STICKERS = [...BASE_STICKERS, ...CUTE_STICKERS]

/** Packs that only show up while the conversation is in the given mode. */
export const MODE_STICKERS = [
  {
    modes: ['neko'],
    stickers: [
      { id: 'meow', caption: '喵', aliases: ['喵', '喵喵', '喵呜'] },
      { id: 'paw', caption: '舔爪', aliases: ['舔爪', '爪子', '舔舔'] },
      { id: 'fluff', caption: '炸毛', aliases: ['炸毛', '炸了', '毛都竖了'] },
      { id: 'nuzzle', caption: '蹭蹭', aliases: ['蹭蹭', '贴贴', '蹭一下'] },
    ],
  },
  {
    modes: ['whale-girl'],
    stickers: [
      { id: 'burble', caption: '咕噜噜', aliases: ['咕噜噜', '咕噜', '呜噜噜'] },
      { id: 'spout', caption: '喷水', aliases: ['喷水', '喷一下', '吐泡泡'] },
      { id: 'tail', caption: '摆尾', aliases: ['摆尾', '甩尾巴', '摇尾巴'] },
      { id: 'peek', caption: '探头', aliases: ['探头', '冒出头', '偷看'] },
    ],
  },
  {
    modes: ['daughter'],
    stickers: [
      { id: 'actcute', caption: '撒娇', aliases: ['撒娇', '求表扬', '要抱抱嘛'] },
      { id: 'headpat', caption: '摸摸头', aliases: ['摸摸头', '要摸头', '拍拍'] },
      { id: 'proud', caption: '得意', aliases: ['得意', '骄傲', '求夸'] },
      { id: 'weepy', caption: '委屈哭', aliases: ['委屈哭', '想哭', '呜呜呜'] },
    ],
  },
  {
    modes: ['girlfriend'],
    stickers: [
      { id: 'gf_embrace', caption: '抱紧你', aliases: ['抱紧你', '抱住你', '抱紧'] },
      { id: 'gf_kiss', caption: '亲一下', aliases: ['亲一下', '亲亲', '啵'] },
      { id: 'gf_pout', caption: '撅嘴', aliases: ['撅嘴', '嘟嘴', '不高兴'] },
      { id: 'gf_wait', caption: '等你', aliases: ['等你', '等你回来', '等你回家'] },
    ],
  },
  {
    modes: ['boyfriend'],
    stickers: [
      { id: 'bf_headpat', caption: '摸你头', aliases: ['摸你头', '摸摸你', '揉揉头'] },
      { id: 'bf_carry', caption: '抱起你', aliases: ['抱起你', '公主抱', '抱起来'] },
      { id: 'bf_protect', caption: '护着你', aliases: ['护着你', '保护你', '挡一下'] },
      { id: 'bf_coffee', caption: '递咖啡', aliases: ['递咖啡', '咖啡', '给你咖啡'] },
    ],
  },
  {
    modes: ['friend'],
    stickers: [
      { id: 'fr_wave', caption: '挥手', aliases: ['挥手', '打招呼', '嗨'] },
      { id: 'fr_tea', caption: '递奶茶', aliases: ['递奶茶', '奶茶', '请你喝'] },
      { id: 'fr_highfive', caption: '击掌', aliases: ['击掌', '拍手', 'high five'] },
      { id: 'fr_listen', caption: '听你说', aliases: ['听你说', '我在听', '说吧'] },
    ],
  },
  {
    modes: ['jarvis'],
    stickers: [
      { id: 'jv_scan', caption: '扫描', aliases: ['扫描', '扫描分析', '检测'] },
      { id: 'jv_report', caption: '递报告', aliases: ['递报告', '报告', '汇报'] },
      { id: 'jv_hologram', caption: '投影', aliases: ['投影', '全息', '投影屏'] },
      { id: 'jv_alert', caption: '警报', aliases: ['警报', '警告', '提醒你'] },
    ],
  },
  {
    modes: ['oneesan'],
    stickers: [
      { id: 'os_headpat', caption: '摸头杀', aliases: ['摸头杀', '揉你头', '拍拍你'] },
      { id: 'os_smile', caption: '微笑', aliases: ['微笑', '温柔笑', '浅笑'] },
      { id: 'os_toast', caption: '举杯', aliases: ['举杯', '干杯', '碰杯'] },
      { id: 'os_scold', caption: '轻拍', aliases: ['轻拍', '拍你一下', '敲你'] },
    ],
  },
  {
    modes: ['big-sister'],
    stickers: [
      { id: 'bs_hug', caption: '抱抱你', aliases: ['抱抱你', '抱住你', '抱一下'] },
      { id: 'bs_hair', caption: '理头发', aliases: ['理头发', '顺头发', '别头发'] },
      { id: 'bs_advice', caption: '讲道理', aliases: ['讲道理', '说说你', '开导'] },
      { id: 'bs_lead', caption: '牵着走', aliases: ['牵着走', '拉着你', '跟我来'] },
    ],
  },
  {
    modes: ['warm-guy'],
    stickers: [
      { id: 'wg_coat', caption: '披外套', aliases: ['披外套', '外套', '给你披上'] },
      { id: 'wg_umbrella', caption: '撑伞', aliases: ['撑伞', '打伞', '伞给你'] },
      { id: 'wg_steady', caption: '扶住你', aliases: ['扶住你', '接住你', '稳住'] },
      { id: 'wg_lunch', caption: '带饭', aliases: ['带饭', '给你带饭', '便当'] },
    ],
  },
  {
    modes: ['tsundere'],
    stickers: [
      { id: 'ts_hmph', caption: '哼', aliases: ['哼', '别过头', '才不是'] },
      { id: 'ts_blush', caption: '嘴硬脸红', aliases: ['嘴硬脸红', '脸红嘴硬', '才没有'] },
      { id: 'ts_gift', caption: '扔给你', aliases: ['扔给你', '丢给你', '拿去'] },
      { id: 'ts_wait', caption: '偷偷等', aliases: ['偷偷等', '偷偷等你', '才没等'] },
    ],
  },
]

/** Every built-in sticker on disk, whatever pack it belongs to. */
export const STICKERS = [...SHARED_STICKERS, ...MODE_STICKERS.flatMap((pack) => pack.stickers)]

const aliasIndex = new Map()
function aliasesFor(stickers) {
  const key = stickers.map((sticker) => sticker.id).join(',')
  let index = aliasIndex.get(key)
  if (index === undefined) {
    index = new Map()
    for (const sticker of stickers) {
      for (const alias of [sticker.caption, ...sticker.aliases]) index.set(alias, sticker.id)
    }
    aliasIndex.set(key, index)
  }
  return index
}

/* ------------------------------------------------------------------ user packs */

/** Folder → its `aliases.json` (alias → file name in that folder). */
function readAliasFile(dir, warn) {
  const map = new Map()
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'aliases.json'), 'utf8'))
    if (raw !== null && typeof raw === 'object' && Array.isArray(raw) === false) {
      for (const [alias, file] of Object.entries(raw)) {
        if (typeof file === 'string' && file !== '') map.set(alias, file)
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' && warn !== undefined) {
      warn(`could not read ${path.join(dir, 'aliases.json')}: ${String(error?.message ?? error)}`)
    }
  }
  return map
}

/** Extensions the iLink image bubble accepts (`mediaKind` calls these image). */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']

function sniff(head) {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true
  if (head.length >= 6 && head.subarray(0, 4).toString('latin1') === 'GIF8') return true
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return true
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) return true
  return false
}

/** True for files whose extension and first bytes say "this is an image". */
export function looksLikeImage(file) {
  try {
    if (IMAGE_EXTENSIONS.includes(path.extname(file).toLowerCase()) === false) return false
    const head = Buffer.alloc(12)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, head, 0, 12, 0)
    } finally {
      fs.closeSync(fd)
    }
    return sniff(head)
  } catch {
    return false
  }
}

function entriesInFolder(root, folder, mode, warn) {
  const dir = path.join(root, folder)
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }
  const aliasFile = readAliasFile(dir, warn)
  const byFile = new Map()
  for (const [alias, file] of aliasFile) {
    const list = byFile.get(file) ?? []
    list.push(alias)
    byFile.set(file, list)
  }
  const entries = []
  for (const file of files.sort()) {
    if (looksLikeImage(path.join(dir, file)) === false) continue
    const stem = path.basename(file, path.extname(file))
    if (file.includes(':') || file.includes('/') || stem === '') continue
    entries.push({
      id: `${USER_PREFIX}${mode}:${file}`,
      caption: stem,
      aliases: [stem, ...(byFile.get(file) ?? [])],
      file: path.join(dir, file),
      mode,
      user: true,
    })
  }
  return entries
}

const userCache = new Map()

/**
 * The user's own folders, read from disk with a stat-based cache (the directories
 * change when someone drops a file in, not per message).
 */
function userPacks(root = stateDir(), { warn } = {}) {
  const folder = userStickerRoot(root)
  const names = ['all', ...new Set(MODE_STICKERS.flatMap((pack) => pack.modes))]
  let stamp = ''
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(folder, name))
      stamp += `${name}:${stat.mtimeMs}:${stat.size}|`
    } catch {
      stamp += `${name}:-|`
    }
  }
  const cached = userCache.get(folder)
  if (cached !== undefined && cached.stamp === stamp) return cached.byMode

  const byMode = new Map()
  for (const name of names) {
    byMode.set(name, entriesInFolder(folder, name, name, warn))
  }
  userCache.set(folder, { stamp, byMode })
  return byMode
}

/** Forget the cached listing (used by tests and by the `stickers` CLI). */
export function clearUserStickerCache() {
  userCache.clear()
}

/** Every sticker the user dropped in, as one line each (the CLI and `/diag`). */
export function listUserStickerFiles(root = stateDir()) {
  const lines = []
  for (const [mode, entries] of userPacks(root, {})) {
    for (const entry of entries) {
      lines.push(`[表情:${entry.caption}]  ${mode === 'all' ? '全部模式' : mode}  ${entry.file}`)
    }
  }
  return lines
}

/**
 * The stickers a conversation in this mode may send: the shared twelve plus the
 * character's own pack, plus anything the user dropped in `<state>/stickers/`.
 *
 * Your own pictures win. As soon as that folder has anything in it, the built-in
 * cast steps aside instead of competing with it — whoever installs a set means
 * it, and a marker resolving to built-in art they rejected is the one outcome
 * they would call a bug. `keepBuiltins: true` keeps both (yours first, so your
 * names still win a collision).
 *
 * @param {string} [modeId]
 * @param {{ stateRoot?: string, warn?: (line: string) => void, keepBuiltins?: boolean }} [options]
 */
export function stickersForMode(modeId, { stateRoot, warn, keepBuiltins = false } = {}) {
  const extra = MODE_STICKERS.filter((pack) => pack.modes.includes(modeId)).flatMap((pack) => pack.stickers)
  const mine = extra.length === 0 ? SHARED_STICKERS : [...SHARED_STICKERS, ...extra]
  const packs = userPacks(stateRoot, { warn })
  const custom = [...(packs.get('all') ?? [])]
  if (modeId !== undefined && modeId !== '') custom.push(...(packs.get(modeId) ?? []))
  if (custom.length > 0 && keepBuiltins !== true) return custom
  return [...custom, ...mine]
}

/** Absolute path of one sticker image (built-in id or `user:<mode>:<file>` id). */
export function stickerPath(id, root = stateDir()) {
  if (String(id).startsWith(USER_PREFIX)) {
    const rest = String(id).slice(USER_PREFIX.length)
    const split = rest.indexOf(':')
    if (split <= 0) return path.join(userStickerRoot(root), 'missing')
    return path.join(userStickerRoot(root), rest.slice(0, split), rest.slice(split + 1))
  }
  return path.join(STICKER_DIR, `${id}.png`)
}

/**
 * Resolve whatever the model wrote to a catalog id, or null.
 *
 * A character pack is only resolvable in its own mode, so a 猫娘 marker written
 * by the 御姐 comes back null and is reported as dropped instead of quietly
 * sending cat art from the wrong character.
 *
 * @param {string} name
 * @param {string} [modeId]
 * @param {{ stateRoot?: string, warn?: (line: string) => void, keepBuiltins?: boolean }} [options]
 */
export function resolveSticker(name, modeId, { stateRoot, warn, keepBuiltins = false } = {}) {
  const key = String(name ?? '').trim()
  if (key === '') return null
  const index = aliasesFor(stickersForMode(modeId, { stateRoot, warn, keepBuiltins }))
  const direct = index.get(key)
  if (direct !== undefined) return direct
  // Tolerate a trailing 啊/呀/啦 and surrounding punctuation: the model is
  // imitating a person, not filling in a form.
  const trimmed = key.replace(/[啊呀啦吧嘛呢了~～!！。.]+$/u, '').trim()
  return index.get(trimmed) ?? null
}

const MARKER_RE = /\[表情[:：]\s*([^\]\n]{1,16}?)\s*\]/g

/**
 * Split sticker markers out of a reply.
 *
 * Returns the text with the markers removed and the ids in the order they
 * appeared, capped at `max`. A marker for a name that is not in the catalog is
 * dropped from the text as well (leaving `[表情:???]` in a chat bubble looks
 * like a bug) and reported in `dropped` so the caller can log it.
 *
 * @param {string} text
 * @param {{ max?: number, modeId?: string, stateRoot?: string, warn?: (line: string) => void, keepBuiltins?: boolean }} [options]
 * @returns {{ text: string, stickers: string[], dropped: string[] }}
 */
export function takeStickers(text, { max = MAX_STICKERS_PER_REPLY, modeId, stateRoot, warn, keepBuiltins = false } = {}) {
  const source = typeof text === 'string' ? text : ''
  const stickers = []
  const dropped = []
  const stripped = source.replace(MARKER_RE, (_match, rawName) => {
    const id = resolveSticker(rawName, modeId, { stateRoot, warn, keepBuiltins })
    if (id === null) {
      dropped.push(String(rawName))
      return ''
    }
    if (stickers.length >= max) {
      dropped.push(String(rawName))
      return ''
    }
    if (!stickers.includes(id)) stickers.push(id)
    return ''
  })
  // Removing a marker can leave a blank line behind ("晚安\n[表情:晚安]"),
  // and a bubble that is entirely whitespace must not be sent at all.
  const cleaned = stripped
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: cleaned, stickers, dropped }
}

/**
 * The prompt line that teaches the model the markers. Built from the catalog so
 * a new sticker needs no prompt edit, and from the user's folders so a dropped
 * file is usable in the same reply that learns about it.
 *
 * @param {string} [modeId]
 * @param {{ stateRoot?: string, warn?: (line: string) => void }} [options]
 */
export function stickerHint(modeId, { stateRoot, warn, keepBuiltins = false } = {}) {
  const names = stickersForMode(modeId, { stateRoot, warn, keepBuiltins }).map((sticker) => sticker.caption)
  return `- 想发个表情的时候，单独写一行 [表情:名字]，插件会替你发一张表情图；可用：${[...new Set(names)].join('、')}；一次最多一张，别每句都配`
}

/** True when every built-in catalog entry has a readable PNG on disk. */
export function stickerFilesReady(root = stateDir()) {
  return STICKERS.every((sticker) => {
    try {
      return fs.statSync(stickerPath(sticker.id, root)).isFile()
    } catch {
      return false
    }
  })
}