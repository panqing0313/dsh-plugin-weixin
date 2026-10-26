import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The built-in sticker pack.
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
 * The art is drawn by `scripts/make-stickers.py` — see that file for why it is
 * generated instead of shipped as opaque blobs.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const STICKER_DIR = path.join(HERE, '..', '..', 'assets', 'stickers')

/** How many stickers one reply may carry: one is a beat, three is a flood. */
export const MAX_STICKERS_PER_REPLY = 2

/**
 * id (file name), caption (drawn into the image), and every name the model is
 * allowed to write in the marker. The captions double as aliases because the
 * model reads them off the prompt and copies them back verbatim.
 */
export const STICKERS = [
  { id: 'happy', caption: '开心', aliases: ['开心', '高兴', '笑', '微笑'] },
  { id: 'laugh', caption: '哈哈', aliases: ['哈哈', '大笑', '笑哭'] },
  { id: 'cry', caption: '呜呜', aliases: ['呜呜', '哭', '哭哭', '难过'] },
  { id: 'sad', caption: '委屈', aliases: ['委屈', '可怜', '求抱抱'] },
  { id: 'angry', caption: '生气', aliases: ['生气', '气', '哼', '不爽'] },
  { id: 'shy', caption: '害羞', aliases: ['害羞', '脸红', '害羞了'] },
  { id: 'speechless', caption: '无语', aliases: ['无语', '汗', '服了'] },
  { id: 'sleepy', caption: '困了', aliases: ['困了', '困', '想睡'] },
  { id: 'love', caption: '喜欢你', aliases: ['喜欢你', '喜欢', '爱心', '比心'] },
  { id: 'awesome', caption: '厉害', aliases: ['厉害', '棒', '赞', '牛'] },
  { id: 'cheer', caption: '加油', aliases: ['加油', '冲', '努力'] },
  { id: 'goodnight', caption: '晚安', aliases: ['晚安', '睡了', '睡觉啦'] },
]

const BY_ALIAS = new Map()
for (const sticker of STICKERS) {
  for (const alias of [sticker.caption, ...sticker.aliases]) BY_ALIAS.set(alias, sticker.id)
}

const MARKER_RE = /\[表情[:：]\s*([^\]\n]{1,16}?)\s*\]/g

/** Absolute path of one sticker image. */
export function stickerPath(id) {
  return path.join(STICKER_DIR, `${id}.png`)
}

/** Resolve whatever the model wrote to a catalog id, or null. */
export function resolveSticker(name) {
  const key = String(name ?? '').trim()
  if (key === '') return null
  const direct = BY_ALIAS.get(key)
  if (direct !== undefined) return direct
  // Tolerate a trailing 啊/呀/啦 and surrounding punctuation: the model is
  // imitating a person, not filling in a form.
  const trimmed = key.replace(/[啊呀啦吧嘛呢了~～!！。.]+$/u, '').trim()
  return BY_ALIAS.get(trimmed) ?? null
}

/**
 * Split sticker markers out of a reply.
 *
 * Returns the text with the markers removed and the ids in the order they
 * appeared, capped at `max`. A marker for a name that is not in the catalog is
 * dropped from the text as well (leaving `[表情:???]` in a chat bubble looks
 * like a bug) and reported in `dropped` so the caller can log it.
 *
 * @param {string} text
 * @param {{ max?: number }} [options]
 * @returns {{ text: string, stickers: string[], dropped: string[] }}
 */
export function takeStickers(text, { max = MAX_STICKERS_PER_REPLY } = {}) {
  const source = typeof text === 'string' ? text : ''
  const stickers = []
  const dropped = []
  const stripped = source.replace(MARKER_RE, (_match, rawName) => {
    const id = resolveSticker(rawName)
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
 * a new sticker needs no prompt edit.
 */
export function stickerHint() {
  const names = STICKERS.map((sticker) => sticker.caption).join('、')
  return `- 想发个表情的时候，单独写一行 [表情:名字]，插件会替你发一张表情图；可用：${names}；一次最多一张，别每句都配`
}

/** True when every catalog entry has a readable PNG on disk. */
export function stickerFilesReady() {
  return STICKERS.every((sticker) => {
    try {
      return fs.statSync(stickerPath(sticker.id)).isFile()
    } catch {
      return false
    }
  })
}
