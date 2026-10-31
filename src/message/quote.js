/**
 * 引用回复（refermsg）：把「他引用的那句话」变成模型看得见的上下文。
 *
 * 微信的引用不是一条独立消息，而是挂在原消息 item 上的一个字段。最常见的形状
 * 是 `type: 49` 的 appmsg 里再套一层 `refermsg`（引用卡片/引用文本都走这里），
 * 也有直接放在 `item.refermsg` 或 `item.quote.refermsg` 的。三种都认，认不出
 * 就当没有引用 —— 这层只负责「读出来」，不负责渲染卡片。
 *
 * 引用内容是**别人写的文本**，和用户消息一样不可信：这里只做长度截断与
 * 秘密脱敏，转义交给 index.js 的 `neutralizeTags`，和其它入站文本同一条路。
 *
 * @module dsh-weixin/message/quote
 */

import { redactSecrets } from '../credentials.js'

/** 一条引用最多带多少字；再多就截断，避免把整篇文章塞进提示。 */
export const MAX_QUOTE_CHARS = 500

function clean(value) {
  if (typeof value !== 'string') return ''
  return redactSecrets(value).replace(/\s+/g, ' ').trim()
}

/**
 * 从入站 item_list 里找引用。找不到返回 undefined。
 *
 * @param {any[]} items 原始 item_list
 * @returns {{ title?: string, text: string, sender?: string } | undefined}
 */
export function parseQuote(items) {
  for (const item of Array.isArray(items) ? items : []) {
    const raw = item?.refermsg ?? item?.appmsg?.refermsg ?? item?.quote?.refermsg ?? item?.quote
    if (raw === null || typeof raw !== 'object') continue
    const text = clean(raw.content ?? raw.des ?? raw.text)
    const title = clean(raw.title)
    const sender = clean(raw.displayname ?? raw.fromusr)
    if (text === '' && title === '') continue
    const clipped = text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS)}…` : text
    return {
      ...(title === '' ? {} : { title: title.length > 120 ? `${title.slice(0, 120)}…` : title }),
      text: clipped,
      ...(sender === '' ? {} : { sender }),
    }
  }
  return undefined
}

/**
 * 拼成提示里的引用块。第一行标明「这是引用」，正文单独成段。
 *
 * @param {{ title?: string, text: string, sender?: string }} quote
 * @returns {string}
 */
export function quoteBlock(quote) {
  const head = quote.sender === undefined ? '【引用】' : `【引用 ${quote.sender}】`
  const title = quote.title === undefined ? '' : `${quote.title}\n`
  return `${head}\n${title}${quote.text}`
}
