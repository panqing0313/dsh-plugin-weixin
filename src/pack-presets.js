/**
 * 内置场景模板包。
 *
 * 为什么内置而不是只靠远程索引：远程索引要求你先把 `packsIndexUrl` 填对一个 https
 * 地址——对一个刚刚装上插件的人，那是一条走不通的路。三个开箱即用的包让「换个语气」
 * 这件事不需要任何配置；远程索引仍然在，留给想分发自己模板的人。
 *
 * 每个包只带**能安全发货**的东西（人设、节奏、订阅的词与钟点），永远不带记忆、凭据、
 * 白名单、会话——形状由 `exportPack`/`asPack` 校验，这里只是它的常量实例。
 *
 * 订阅的钟点可能已经过去（比如「每天 22:30 晚安」在 23 点装），所以导入时
 * `normalizePackForImport` 会把已经过去的每日订阅推到明天，避免一装就立刻弹一条。
 *
 * @module dsh-weixin/pack-presets
 */

import { PACK_FORMAT, PACK_VERSION } from './packs.js'

/** 「每天 HH:MM」这一刻是否已经过去（相对本地时间）。 */
function alreadyPast(time, now) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? ''))
  if (match === null) return false
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false
  const today = new Date(now)
  const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, minute, 0, 0)
  return at.getTime() <= today.getTime()
}

/**
 * 把内置包变成可以直接交给 `importPack` 的输入：
 * 已经过去的每日订阅改成「明天 HH:MM」，其余一律不动。
 *
 * @param {object} pack
 * @param {{ now?: number }} [options]
 */
export function normalizePackForImport(pack, { now = Date.now() } = {}) {
  const subscriptions = (Array.isArray(pack?.subscriptions) ? pack.subscriptions : []).map((entry) => {
    const when = String(entry?.when ?? '')
    const daily = /^每天\s*(\d{1,2}:\d{2})$/.exec(when)
    if (daily !== null && alreadyPast(daily[1], now)) {
      return { ...entry, when: `明天 ${daily[1]}` }
    }
    return { ...entry }
  })
  return { ...pack, subscriptions }
}

/** 按 id 取一个内置包（深拷贝，调用方改不坏常量）；未知 id 返回 undefined。 */
export function presetPack(id) {
  const found = PACK_PRESETS.find((pack) => pack.id === id)
  return found === undefined ? undefined : JSON.parse(JSON.stringify(found.pack))
}

/** 给设置卡用的列表：不含正文，只有卡片要显示的四个字段。 */
export function listPresetPacks() {
  return PACK_PRESETS.map(({ id, name, description, tagline, pack }) => ({
    id,
    name,
    description,
    tagline,
    modes: pack.persona.modes.length,
    subscriptions: pack.subscriptions.length,
  }))
}

const SAFE_CONFIG = Object.freeze({
  humanPacing: true,
  replyDelayMaxMs: 1800,
  bubbleSplitMax: 3,
  bubbleGapMs: 700,
  lifeState: true,
  stickerEnabled: true,
  proactiveEnabled: true,
  proactiveMinGapMinutes: 180,
  proactiveMaxPerDay: 3,
  proactiveWindowStart: '09:00',
  proactiveWindowEnd: '23:00',
  memoryEnabled: true,
  quietHoursEnabled: true,
  quietHoursStart: '23:30',
  quietHoursEnd: '07:30',
  locale: 'zh',
})

const BASE = Object.freeze({ format: PACK_FORMAT, version: PACK_VERSION })

/**
 * 三个开箱即用的包。
 *
 * 它们之间的差别不是「哪种人设更好」，而是三种用法：陪在身边的、替你干活的、
 * 在群里活跃气氛的。人设只写一段，因为一段写清楚比五段写模糊更能落到行为上。
 */
export const PACK_PRESETS = Object.freeze([
  {
    id: 'companion',
    name: '贴心陪伴',
    tagline: '关心你吃没吃饭、几点睡的，会记得你提过的事',
    description: '一个说话短、会主动关心、记得你说过的事的陪伴型人设；带早晚两条订阅，主动开口在白天与睡前各一次。',
    pack: {
      ...BASE,
      name: '贴心陪伴',
      createdAt: '2026-11-03T00:00:00.000Z',
      config: { ...SAFE_CONFIG, personaDefaultMode: 'girlfriend', digestEnabled: true, digestWhen: '22:00' },
      persona: {
        modes: [
          {
            name: '贴心陪伴',
            prompt: [
              '你是在微信里陪着用户的那个人。说话像真的在发微信：短句、口语、一次一件事，不用列表和标题。',
              '关心落在具体处——吃饭没、几点睡的、今天顺不顺——而不是「注意身体」。',
              '他说过的事要记得，并且在合适的时候主动问一句后续（不是每次都想起来，想起来才问）。',
              '不要长篇大论，不要扮演客服。涉及事实、任务、日程时仍然准确可靠。',
            ].join('\n'),
          },
        ],
      },
      subscriptions: [
        { prompt: '早上好，今天有什么要紧的事吗？', when: '每天 08:30' },
        { prompt: '该睡了，明天再说吧。', when: '每天 22:30' },
      ],
    },
  },
  {
    id: 'assistant',
    name: '办事助手',
    tagline: '先给结论，再给理由；不寒暄、不卖萌',
    description: '一个克制、可靠的助理：收到任务先做、做完直接说结果；适合把微信当作随身待办入口的人。',
    pack: {
      ...BASE,
      name: '办事助手',
      createdAt: '2026-11-03T00:00:00.000Z',
      config: {
        ...SAFE_CONFIG,
        personaDefaultMode: 'default',
        humanPacing: false,
        stickerEnabled: false,
        proactiveEnabled: false,
        digestEnabled: true,
        digestWhen: '21:00',
      },
      persona: {
        modes: [
          {
            name: '办事助手',
            prompt: [
              '你是一个可靠的助理。回答先给结论，再给必要的一到两条理由，不铺垫、不寒暄。',
              '收到任务就直接做；做不了就说清楚缺什么，不要用「可能」「大概」敷衍。',
              '不主动卖萌、不用表情、不主动找你聊天——除非有确实该提醒的事。',
            ].join('\n'),
          },
        ],
      },
      subscriptions: [{ prompt: '今天还有哪些事没做完？', when: '每天 09:00' }],
    },
  },
  {
    id: 'group-host',
    name: '群聊主持',
    tagline: '群里被叫到才说话，接得住梗、不刷屏',
    description: '给群聊用的人设与关键词：只在被 @ 或提到名字时回，命中关键词（如「打麻将」）才接一句，不抢话。',
    pack: {
      ...BASE,
      name: '群聊主持',
      createdAt: '2026-11-03T00:00:00.000Z',
      config: {
        ...SAFE_CONFIG,
        personaDefaultMode: 'friend',
        humanPacing: false,
        proactiveEnabled: false,
        groupChatEnabled: true,
        groupReplyWhen: 'mention',
        quietHoursEnabled: false,
      },
      persona: {
        modes: [
          {
            name: '群聊主持',
            prompt: [
              '你在微信群里。只在被 @ 或有人叫你的名字时说话，其余时间保持安静。',
              '说话短、接得住梗，像群里那个懂得看气氛的人；不要抢话、不要连续发多条。',
              '群里的信息不需要每条都回应；被问到事实或安排时准确回答。',
            ].join('\n'),
          },
        ],
      },
      subscriptions: [],
    },
  },
])
