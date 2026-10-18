/**
 * Inbound link enrichment: when a WeChat message contains URLs, fetch each one
 * and hand the agent the readable text alongside the user's own words.
 *
 * The user experience this serves: someone pastes an article, a GitHub issue,
 * a doc page — and the agent can actually answer "这篇文章说了什么" instead of
 * replying that it cannot open links. The fetched text is folded into the
 * prompt as a quoted block, so the agent sees it as attached material, not as
 * something the user typed.
 *
 * Deliberate limits, both safety-shaped:
 *  - only http(s) is fetched — no file:, no ftp:, nothing exotic;
 *  - a hard byte cap on the body (HTML is stripped to text first, so the cap
 *    applies to what the model will actually see);
 *  - one fetch per URL, no retry loop — a slow host costs the turn its
 *    latency budget, and retrying would double it;
 *  - total failure is NOT an error: the message goes to the agent without the
 *    attachment, with a one-line note saying so. A dead link must not eat a
 *    question the user asked about something else.
 *
 * @module dsh-weixin/message/links
 */

/** Cap on the extracted text handed to the agent, per link. */
export const MAX_LINK_TEXT_CHARS = 20_000
/** Hard cap on the raw response body read, per link. */
export const MAX_LINK_BODY_BYTES = 512 * 1024

const URL_PATTERN = /https?:\/\/[^\s<>"'）】」』\]]*?(?=[。！？；，、]|[.,!?;](?:\s|$)|\s|$|[）】」』\]])/gu

/**
 * Extract the URLs a message asks about. Duplicates collapse (a link pasted
 * twice is one fetch, not two); trailing punctuation is stripped because
 * Chinese input commonly glues 。！？， onto the end of a URL.
 *
 * @param {string | undefined} text
 * @returns {string[]} unique URLs, in first-appearance order
 */
export function extractUrls(text) {
  if (typeof text !== 'string' || text === '') return []
  const found = []
  for (const raw of text.matchAll(URL_PATTERN)) {
    const url = raw[0].replace(/[。，！？；：、.,!?;:]+$/u, '')
    if (url.length > 8 && !found.includes(url)) found.push(url)
  }
  return found
}

/**
 * Fetch one URL and reduce it to agent-readable text.
 *
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, maxChars?: number }} [options]
 * @returns {Promise<{ ok: true, url: string, title?: string, text: string } | { ok: false, url: string, reason: string }>}
 */
export async function fetchLinkText(url, options = {}) {
  const doFetch = options.fetchImpl ?? fetch
  const maxChars = options.maxChars ?? MAX_LINK_TEXT_CHARS
  let response
  try {
    response = await doFetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; dsh-weixin link reader)' },
      redirect: 'follow',
    })
  } catch (error) {
    return { ok: false, url, reason: `请求失败：${String(error?.cause ?? error?.message ?? error)}` }
  }
  if (!response.ok) {
    return { ok: false, url, reason: `HTTP ${response.status}` }
  }
  const contentType = String(response.headers.get('content-type') ?? '')
  // Binary content is not readable text — an image link is reported as such
  // rather than stuffed with bytes pretending to be an article.
  if (/^(image|audio|video)\//.test(contentType)) {
    return { ok: false, url, reason: `内容是 ${contentType.split(';')[0]}，不是可读文本` }
  }
  let body
  try {
    body = await response.text()
  } catch (error) {
    return { ok: false, url, reason: `读取响应失败：${String(error?.cause ?? error?.message ?? error)}` }
  }
  if (body.length > MAX_LINK_BODY_BYTES) body = body.slice(0, MAX_LINK_BODY_BYTES)
  const isHtml = /text\/html|application\/xhtml/.test(contentType) || /^\s*<(!doctype|html)/i.test(body)
  const text = isHtml ? htmlToText(body) : body
  if (text.trim() === '') {
    return { ok: false, url, reason: '页面没有可提取的正文' }
  }
  const titleMatch = isHtml ? /<title[^>]*>([^<]*)<\/title>/i.exec(body) : undefined
  return {
    ok: true,
    url,
    ...(titleMatch?.[1]?.trim() ? { title: titleMatch[1].trim() } : {}),
    text: text.length > maxChars ? `${text.slice(0, maxChars)}…（正文超长，已截断）` : text,
  }
}

/**
 * Minimal HTML → text reduction: script/style/head out, block tags to
 * newlines, the rest of the tags off, entities decoded for the common set.
 * This is deliberately not a full DOM parser — the goal is text good enough
 * for the agent to answer questions about, not pixel-perfect layout.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|svg|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Build the prompt block for a batch of fetched links. Successful fetches
 * become quoted material; failures get one line each, so the agent can tell
 * the user WHY a link could not be read instead of silently ignoring it.
 *
 * @param {Array<{ ok: true, url: string, title?: string, text: string } | { ok: false, url: string, reason: string }>} results
 * @returns {string | undefined} undefined when there were no links at all
 */
export function describeLinkResults(results) {
  if (results.length === 0) return undefined
  const parts = []
  for (const result of results) {
    if (result.ok) {
      const head = result.title !== undefined ? `【链接内容：${result.title}】(${result.url})` : `【链接内容】(${result.url})`
      parts.push(`${head}\n以下是从该网页抓取的正文，供回答时参考：\n"""\n${result.text}\n"""`)
    } else {
      parts.push(`【链接无法读取】${result.url}：${result.reason}`)
    }
  }
  return parts.join('\n\n')
}
