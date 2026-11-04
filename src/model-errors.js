/**
 * 模型报错的翻译。
 *
 * 用户看到的原话长这样：
 *
 *   （模型调用失败：pi-ai provider "magpie" has no configured model "auto/deepseek-v4.1-flash"）
 *
 * 这句话对写插件的人有用，对用插件的人没用：它没有说**哪一项配错了**，也没有说
 * **该怎么改**。在微信里收到这么一条，唯一能做的动作是来问开发者。
 *
 * 这个模块做三件事：
 *
 *  1. **认出来**：按已知的错误形态分类（没配模型、供应商不存在、鉴权失败、
 *     额度用完、超时、上下文太长……）；
 *  2. **说人话**：给一句「哪里错了 + 怎么改」，并保留原始错误作为第二行，
 *     因为真去排查的人需要原文；
 *  3. **永远不整段转述**：只挑一行、压到固定长度。一个把整个 stack trace
 *     贴进微信的错误处理，本身也是 bug。
 *
 * 认不出来的错误不会被藏起来 —— 归到 `unknown`，照样带上原文，只是没有建议。
 *
 * @module dsh-weixin/model-errors
 */

/** 一条提示最多多少字（按字符，中文按 1 算）。 */
export const NOTICE_MAX_CHARS = 180

/**
 * 已知形态。顺序有意义：先匹配到的赢，因为一条错误可能同时像好几种
 * （比如「上下文太长」往往也会被供应商包成 400）。
 *
 * `pattern` 匹配原始字符串（小写后），`setting` 是设置卡里的字段名，
 * `hint` 是给用户看的那一句。
 */
export const KNOWN_MODEL_ERRORS = Object.freeze([
  {
    kind: 'no-model',
    pattern: /has no configured model|no configured model|unknown model|model not found|no such model/i,
    setting: 'chatModel',
    title: '没有配置可用的模型',
    titleEn: 'no usable model is configured',
    hint: '到「配置项」里把 chatModel 与 chatProvider 一起填上（两个都填才生效）；模型名要写成供应商要求的样子',
    hintEn: 'set both chatProvider and chatModel in Options — one without the other is ignored — spelling the model the way the provider does',
  },
  {
    kind: 'no-provider',
    pattern: /has no configured provider|unknown provider|provider not found|no such provider/i,
    setting: 'chatProvider',
    title: '供应商名字不认识',
    titleEn: 'the provider name is not known',
    hint: '检查 chatProvider 的拼写；它要和宿主里已经配置好的供应商 id 完全一致',
    hintEn: 'check the spelling of chatProvider — it must match a provider id the host already has',
  },
  {
    kind: 'auth',
    pattern: /401|unauthori[sz]ed|invalid api[ _-]?key|incorrect api key|authentication|permission denied|403/i,
    setting: 'chatProvider',
    title: '鉴权失败',
    titleEn: 'authentication failed',
    hint: '这个供应商的 key 可能过期或被撤销了；在宿主的模型配置里重新登录/换 key 之后再试',
    hintEn: 'the key for this provider may be expired or revoked; sign in again (or replace the key) in the host, then retry',
  },
  {
    kind: 'quota',
    pattern: /insufficient_quota|quota exceeded|rate limit|429|too many requests|余额|billing/i,
    setting: 'chatModel',
    title: '额度用完或被限流',
    titleEn: 'out of quota, or rate limited',
    hint: '等一会儿再试；如果是额度真用完了，换一个供应商或加额度',
    hintEn: 'wait a bit and retry; if the quota is really gone, switch providers or add credit',
  },
  {
    kind: 'context',
    pattern: /context length|context window|too many tokens|maximum context|prompt is too long/i,
    setting: 'memoryConvMaxChars',
    title: '上下文太长',
    titleEn: 'the context is too long',
    hint: '把 memoryConvMaxChars / memoryGlobalMaxFacts 调小，或者让这个会话少聊一点再继续',
    hintEn: 'lower memoryConvMaxChars / memoryGlobalMaxFacts, or start a fresh session for this chat',
  },
  {
    kind: 'timeout',
    pattern: /timeout|timed out|etimedout|aborted|deadline exceeded/i,
    setting: 'maxTurnWaitMs',
    title: '模型这一轮超时了',
    titleEn: 'the model turn timed out',
    hint: '重发一句就会重试；如果老是超时，多半是网络或供应商在忙',
    hintEn: 'saying it again retries; repeated timeouts usually mean the network or the provider is slow',
  },
  {
    kind: 'network',
    pattern: /fetch failed|econnrefused|enotfound|econnreset|network|socket hang up|dns/i,
    setting: '',
    title: '连不上模型服务',
    titleEn: 'could not reach the model service',
    hint: '检查网络与代理；本机代理没开时，宿主的请求会直接失败',
    hintEn: 'check the network and any proxy — requests fail outright when the local proxy is down',
  },
])

/**
 * 归类一条模型错误。
 *
 * @param {unknown} error
 * @returns {{ kind: string, setting: string, title: string, titleEn: string, hint: string, hintEn: string, raw: string }}
 */
export function classifyModelError(error) {
  const raw = oneLine(error)
  const lower = raw.toLowerCase()
  for (const entry of KNOWN_MODEL_ERRORS) {
    if (entry.pattern.test(raw) === true || entry.pattern.test(lower) === true) {
      return { kind: entry.kind, setting: entry.setting, title: entry.title, titleEn: entry.titleEn, hint: entry.hint, hintEn: entry.hintEn, raw }
    }
  }
  return {
    kind: 'unknown',
    setting: '',
    title: '模型调用失败',
    titleEn: 'the model call failed',
    hint: '把下面这句原文连同你的 provider/model 配置一起报给开发者，一眼就能定位',
    hintEn: 'send the line below, plus your provider/model settings, to whoever maintains this plugin',
    raw,
  }
}

/**
 * 发给微信的那一条消息。
 *
 * 第一行说人话，第二行给原文（压到固定长度）。`/diag` 里能看到最后一条错误的分类，
 * 所以这里不留 ID、不做交互。
 *
 * @param {unknown} error
 * @param {{ maxChars?: number }} [options]
 */
export function describeModelError(error, { maxChars = NOTICE_MAX_CHARS } = {}) {
  const info = classifyModelError(error)
  const head = `（${info.title}：${info.hint}）`
  // The raw line is what makes this actionable for whoever debugs it, so it
  // gets the remaining budget — but never more than the whole message may use.
  // `\n原文：` is three characters of the budget before the raw text starts.
  const room = Math.max(0, maxChars - head.length - '\n原文：'.length - 1)
  if (info.raw === '' || room < 12) return head
  const body = info.raw.length > room ? `${info.raw.slice(0, room - 1)}…` : info.raw
  return `${head}\n原文：${body}`
}

/** 一行化：去掉换行、压缩空白、去掉控制字符（原文常带 \r 与缩进）。 */
export function oneLine(value) {
  const text = typeof value === 'string'
    ? value
    : (() => {
        try {
          return value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? '')
        } catch {
          return ''
        }
      })()
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 把同类错误连成一句话，给 `/diag` 用。没有记录就返回 `''`。
 *
 * @param {Array<{ kind: string, raw: string, at: number }>} recent
 * @param {{ now?: number }} [options]
 */
export function summarizeRecentModelErrors(recent, { now = Date.now() } = {}) {
  if (Array.isArray(recent) === false || recent.length === 0) return ''
  const last = recent[recent.length - 1]
  const info = classifyModelError(last.raw)
  const minutes = Math.max(0, Math.round((now - Number(last.at ?? now)) / 60_000))
  const when = minutes < 1 ? '刚刚' : `${minutes} 分钟前`
  const tail = recent.length > 1 ? `（最近 ${recent.length} 次失败都归到这一类）` : ''
  return `最近一次模型错误：${when} · ${info.title}${info.setting === '' ? '' : ` · 相关配置 ${info.setting}`}${tail}`
}

/** 最近几次模型错误（进程内，最多 20 条；重启清零是刻意的，它不是审计）。 */
const recentErrors = []

/**
 * @param {unknown} error
 * @param {{ at?: number }} [options]
 */
export function noteModelError(error, { at = Date.now() } = {}) {
  const info = classifyModelError(error)
  recentErrors.push({ kind: info.kind, title: info.title, raw: info.raw, at })
  if (recentErrors.length > 20) recentErrors.shift()
  return recentErrors.length
}

/** @returns {Array<{ kind: string, title: string, raw: string, at: number }>} */
export function readRecentModelErrors() {
  return recentErrors.slice()
}

/** 测试用：清空。 */
export function clearRecentModelErrors() {
  recentErrors.length = 0
}
