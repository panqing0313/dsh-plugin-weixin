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
 *  - no private, loopback, link-local or cloud-metadata address is fetched,
 *    and redirects are followed by hand so every hop is checked again: a public
 *    host that 302s to 169.254.169.254 is the classic SSRF shape, and the
 *    default `redirect: 'follow'` would walk right into it;
 *  - each request has its own deadline and the whole enrichment has a budget,
 *    because the user is waiting on a chat reply;
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
/** Per-request deadline. A host that accepts and then stalls costs this much. */
export const LINK_TIMEOUT_MS = 8_000
/** Redirects followed per URL. Three is already generous for a chat link. */
export const MAX_REDIRECTS = 3
/** Cached fetch results, so a link pasted twice in a minute is fetched once. */
export const LINK_CACHE_TTL_MS = 5 * 60_000
export const LINK_CACHE_MAX_ENTRIES = 64

/**
 * True for addresses a chat link must never reach: loopback, RFC1918, CGNAT,
 * link-local (which includes 169.254.169.254 — every cloud metadata service),
 * multicast, IPv6 unique-local and link-local, and the usual localhost names.
 *
 * @param {string} hostname
 */
export function isPrivateHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata' || host === 'metadata.google.internal') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true
    return false
  }
  if (host.includes(':')) {
    // IPv6 literal: ::1, fc00::/7 (unique local), fe80::/10 (link local),
    // and v4-mapped forms (::ffff:127.0.0.1) all have to be refused.
    if (host === '::1' || host === '::') return true
    if (/^(fc|fd)/.test(host)) return true
    if (/^fe[89ab]/.test(host)) return true
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host)
    if (mapped !== null) return isPrivateHost(mapped[1])
    return false
  }
  return false
}

/**
 * Validate one hop. Returns a human reason when the URL must not be fetched.
 *
 * @param {string} raw
 * @returns {{ url: string } | { reason: string }}
 */
export function checkFetchableUrl(raw) {
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return { reason: '不是一个合法链接' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { reason: `只抓 http/https，不抓 ${parsed.protocol.replace(':', '')}` }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { reason: '链接里带账号密码，不抓' }
  }
  if (isPrivateHost(parsed.hostname)) {
    return { reason: '指向本机或内网地址，不抓' }
  }
  return { url: parsed.toString() }
}

/**
 * Resolve a hostname and refuse if it lands on a private address. Closes the
 * "public name, private A record" case; a DNS re-bind between this lookup and
 * the request is still possible, which is why the connection is not the only
 * gate (the fetch runs with redirects off and a deadline).
 *
 * @param {string} hostname
 * @param {(hostname: string) => Promise<Array<{ address: string }>>} lookupImpl
 */
async function resolvesToPrivate(hostname, lookupImpl) {
  try {
    const addresses = await lookupImpl(hostname)
    return addresses.some((entry) => isPrivateHost(entry.address))
  } catch {
    // A name that does not resolve is a fetch failure the caller reports; it is
    // not a private address.
    return false
  }
}

/** @type {Map<string, { at: number, result: any }>} */
const cache = new Map()

/** Drop cached results. Exposed for tests. */
export function clearLinkCache() {
  cache.clear()
}

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
  const timeoutMs = options.timeoutMs ?? LINK_TIMEOUT_MS
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
  const lookupImpl = options.lookupImpl ?? defaultLookup
  const cacheTtlMs = options.cacheTtlMs ?? LINK_CACHE_TTL_MS
  const now = options.now ?? (() => Date.now())

  // A caller-supplied fetch is a test seam: caching its answers would make
  // every test after the first see the previous test's body.
  const cacheable = cacheTtlMs > 0 && options.fetchImpl === undefined
  if (cacheable) {
    const hit = cache.get(url)
    if (hit !== undefined && hit.at + cacheTtlMs > now()) return hit.result
  }

  const result = await fetchLinkTextUncached(url, { doFetch, maxChars, timeoutMs, maxRedirects, lookupImpl })
  if (cacheable) {
    cache.set(url, { at: now(), result })
    if (cache.size > LINK_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value)
  }
  return result
}

/** @param {string} hostname */
async function defaultLookup(hostname) {
  const { lookup } = await import('node:dns/promises')
  return lookup(hostname, { all: true })
}

async function fetchLinkTextUncached(url, { doFetch, maxChars, timeoutMs, maxRedirects, lookupImpl }) {
  // The deadline covers the whole URL, not each hop: with three redirects, a
  // per-hop timeout would let one link hold the turn for half a minute.
  const deadlineAt = Date.now() + timeoutMs
  let current = url
  let response
  for (let hop = 0; ; hop += 1) {
    const checked = checkFetchableUrl(current)
    if ('reason' in checked) return { ok: false, url, reason: checked.reason }
    if (await resolvesToPrivate(new URL(checked.url).hostname, lookupImpl)) {
      return { ok: false, url, reason: '链接解析到内网地址，不抓' }
    }
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) return { ok: false, url, reason: `请求超时（${timeoutMs}ms）` }
    try {
      response = await doFetch(checked.url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; dsh-weixin link reader)' },
        // Redirects are followed by hand: `follow` would let a public host walk
        // the request into 169.254.169.254 (or any internal service) and the
        // policy above would never see the hop.
        redirect: 'manual',
        signal: AbortSignal.timeout(remaining),
      })
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      return { ok: false, url, reason: timedOut ? `请求超时（${timeoutMs}ms）` : `请求失败：${String(error?.cause ?? error?.message ?? error)}` }
    }
    if (response.status < 300 || response.status >= 400) break
    const location = response.headers.get('location')
    if (location === null || location === '') return { ok: false, url, reason: `HTTP ${response.status}，但没有 Location` }
    if (hop >= maxRedirects) return { ok: false, url, reason: `重定向超过 ${maxRedirects} 次` }
    // Drain the body so the socket can be reused; a redirect body is ignored.
    try { await response.text() } catch { /* ignored on purpose */ }
    current = new URL(location, checked.url).toString()
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
