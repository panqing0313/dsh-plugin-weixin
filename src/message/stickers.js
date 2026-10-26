import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * Three packs: a base twelve, twelve "cute" additions available everywhere, and
 * one pack per character (a cat, a whale girl, a daughter) that only appears
 * while the conversation is in that mode — a cat sticker from a 御姐 would give
 * the whole thing away.
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
]

/** Every sticker on disk, whatever pack it belongs to. */
export const STICKERS = [...BASE_STICKERS, ...CUTE_STICKERS, ...MODE_STICKERS.flatMap((pack) => pack.stickers)]

const EVERYWHERE = [...BASE_STICKERS, ...CUTE_STICKERS]

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

/**
 * The stickers a conversation in this mode may send: the shared twelve plus the
 * character's own pack, when the mode has one.
 *
 * @param {string} [modeId]
 */
export function stickersForMode(modeId) {
  const extra = MODE_STICKERS.filter((pack) => pack.modes.includes(modeId)).flatMap((pack) => pack.stickers)
  return extra.length === 0 ? EVERYWHERE : [...EVERYWHERE, ...extra]
}

/** Absolute path of one sticker image. */
export function stickerPath(id) {
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
 */
export function resolveSticker(name, modeId) {
  const key = String(name ?? '').trim()
  if (key === '') return null
  const index = aliasesFor(stickersForMode(modeId))
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
 * @param {{ max?: number, modeId?: string }} [options]
 * @returns {{ text: string, stickers: string[], dropped: string[] }}
 */
export function takeStickers(text, { max = MAX_STICKERS_PER_REPLY, modeId } = {}) {
  const source = typeof text === 'string' ? text : ''
  const stickers = []
  const dropped = []
  const stripped = source.replace(MARKER_RE, (_match, rawName) => {
    const id = resolveSticker(rawName, modeId)
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
 *
 * @param {string} [modeId]
 */
export function stickerHint(modeId) {
  const names = stickersForMode(modeId).map((sticker) => sticker.caption).join('、')
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
