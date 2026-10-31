/**
 * 出站 webhook：把「收到一条消息」「一条回复已发出」推给外部系统。
 *
 * 通知桥（`src/notify.js`）是入站方向 —— 别的进程推一条消息给微信。这里是
 * 反方向：把插件里发生的事推给 n8n、自建面板或一个日志服务。两者都只监听
 * 127.0.0.1 或一个用户显式配置的 URL，不引入任何第三方 SDK。
 *
 * 约定尽量小：POST JSON `{ event, at, ...payload }`；配置了 secret 就带
 * `X-Weixin-Signature: sha256=<hex>`（对**原始 body** 做 HMAC-SHA256）。
 * 失败只记日志：一个挂掉的 webhook 不能拖慢或拖垮一条回复。
 *
 * @module dsh-weixin/webhook
 */

import crypto from 'node:crypto'

export const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000

/**
 * @param {{ url: string, secret?: string, timeoutMs?: number, fetchImpl?: typeof fetch, warn?: (line: string) => void }} options
 * @returns {{ send: (event: string, payload?: Record<string, unknown>) => Promise<boolean> } | undefined}
 */
export function createWebhookSender({ url, secret = '', timeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS, fetchImpl = globalThis.fetch, warn = () => {} } = {}) {
  let parsed
  try {
    parsed = new URL(String(url ?? '').trim())
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (typeof fetchImpl !== 'function') return undefined
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_WEBHOOK_TIMEOUT_MS

  return {
    async send(event, payload = {}) {
      const body = JSON.stringify({ event, at: new Date().toISOString(), ...payload })
      const headers = { 'content-type': 'application/json', 'user-agent': 'dsh-plugin-weixin' }
      if (secret !== '') {
        headers['x-weixin-signature'] = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`
      }
      try {
        const response = await fetchImpl(parsed, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(timeout),
        })
        if (response.ok !== true) {
          warn(`webhook ${event} answered ${response.status}`)
          return false
        }
        return true
      } catch (error) {
        warn(`webhook ${event} failed: ${String(error?.message ?? error)}`)
        return false
      }
    },
  }
}
