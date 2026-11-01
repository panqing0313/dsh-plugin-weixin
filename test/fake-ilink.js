/**
 * 一个能顶替 iLink 服务端的假服务器。
 *
 * 为什么值得抽出来：这个假服务端被三个测试文件各写了一遍（`e2e`、`session-commands`、
 * `markdown`），三份实现细节还不一样——`session-commands` 那份让空轮询立刻返回，
 * `e2e` 那份后来才发现这会让传输层变成 ~7000 次/秒的忙循环，把整个测试文件从几秒
 * 拖到一分钟。同一个坑被踩了两次，说明它应该只有一个地方可踩。
 *
 * 用法：
 *
 * ```js
 * const fake = await startFakeILink()
 * fake.deliver('你好', 'm1')              // 下一条 getupdates 带上这条消息
 * fake.deliver('打卡', 'm2', { groupId: 'room@chatroom' })
 * fake.texts()                            // 机器人发出去的每个 chunk
 *
 * // 需要在正常路径之外再造一个错误（比如发送失败）时：
 * fake.failNext('sendmessage', { ret: -1, errmsg: 'boom' }, 1)
 *
 * await fake.close()
 * ```
 *
 * 默认行为照着真实服务端来：
 *
 * - 空 `getupdates` **挂住** `EMPTY_POLL_HOLD_MS` 再回，而不是立刻回 `[]`；
 * - 有消息的 `getupdates` 立刻返回；
 * - 每条入站消息只投递一次（按 `message_id` 去重后再排队）；
 * - 发出去的每条 `sendmessage` 都记进 `outbound`，并保留原始请求体。
 *
 * @module test/fake-ilink
 */

import http from 'node:http'

/**
 * 空轮询挂住多久（毫秒）。
 *
 * 真实服务端长轮询几十秒；假的立刻回 `[]` 会让传输层的循环变成忙循环
 * （实测约 7000 次/秒），把进程里所有定时器都饿住。200ms 既让循环安静下来，
 * 也不至于让「等下一批消息」的用例明显变慢。
 */
export const EMPTY_POLL_HOLD_MS = 200

/** iLink 的默认长轮询窗口；假的立刻有结果，所以只是回给调用方看。 */
const LONGPOLLING_TIMEOUT_MS = 20

/**
 * @typedef {object} FakeOptions
 * @property {(text: string, messageId: string, extra?: { from?: string, groupId?: string, contextToken?: string, itemList?: object[] }) => void} deliver
 * @property {() => string[]} texts
 * @property {(path: string, body: object, times?: number) => void} failNext
 * @property {() => number} pending
 * @property {() => Promise<void>} close
 * @property {{ getupdates: number, delivered: number, inboundTexts: string[], uploads: object[] }} seen
 * @property {Array<{ text: string, body: object }>} outbound
 * @property {http.Server} server
 * @property {string} baseUrl
 */

/**
 * 启动一个假 iLink。
 *
 * `batches` 是「第 1、2、3… 次 getupdates 各回什么」的脚本，用来测「第一次回空、
 * 第二次才有消息」这类时序；脚本用尽后回到 `deliver()` 的队列。
 *
 * @param {{ upload?: boolean, batches?: object[][], emptyPollHoldMs?: number, longpollingTimeoutMs?: number }} options
 * @returns {Promise<FakeOptions>}
 */
export async function startFakeILink(options = {}) {
  const {
    upload = false,
    uploadParam = 'UP-PARAM-FAKE',
    emptyPollHoldMs = EMPTY_POLL_HOLD_MS,
    longpollingTimeoutMs = LONGPOLLING_TIMEOUT_MS,
  } = options
  const batches = [...(options.batches ?? [])]

  /** @type {Array<{ text: string, body: object }>} */
  const outbound = []
  const seen = { getupdates: 0, delivered: 0, inboundTexts: [], uploads: [] }
  /** @type {Array<object>} */
  const queue = []
  /** message_id → 已经排过队，防止同一条被反复投递。 */
  const delivered = new Set()
  /** @type {Map<string, { body: object, times: number }>} */
  const failures = new Map()

  const takeFailure = (pathname) => {
    const entry = failures.get(pathname)
    if (entry === undefined) return undefined
    entry.times -= 1
    if (entry.times <= 0) failures.delete(pathname)
    return entry.body
  }

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      res.setHeader('content-type', 'application/json')

      const forced = takeFailure(url.pathname)
      if (forced !== undefined) return res.end(JSON.stringify(forced))

      if (url.pathname === '/ilink/bot/getconfig') {
        const parsed = body ? JSON.parse(body) : {}
        // 真实服务端在缺 ilink_user_id 时明确报错；照抄能让「凭据没传全」这类
        // 问题在测试里也表现为失败，而不是一个安静的 200。
        if (parsed.ilink_user_id === undefined) return res.end(JSON.stringify({ ret: -2, errmsg: 'ilink_user_id required' }))
        return res.end(JSON.stringify({ ret: 0, typing_ticket: 'TT' }))
      }

      if (url.pathname === '/ilink/bot/getuploadurl') {
        seen.uploads.push(body ? JSON.parse(body) : {})
        return res.end(JSON.stringify({ ret: 0, upload_param: uploadParam }))
      }

      if (url.pathname === '/ilink/bot/sendmessage') {
        const parsed = body ? JSON.parse(body) : {}
        const items = parsed?.msg?.item_list ?? []
        const text = items.map((item) => item?.text_item?.text ?? '').join('')
        outbound.push({ text, body: parsed })
        return res.end(JSON.stringify({ ret: 0 }))
      }

      if (url.pathname === '/ilink/bot/sendtyping') return res.end(JSON.stringify({ ret: 0 }))

      if (url.pathname === '/ilink/bot/getupdates') {
        seen.getupdates += 1
        const scripted = batches.length > 0 ? batches.shift() : undefined
        const next = scripted !== undefined ? undefined : queue.shift()
        const payloadMsgs = scripted !== undefined ? scripted : next === undefined ? [] : [next]
        if (scripted !== undefined) seen.delivered += scripted.length
        if (next !== undefined) seen.delivered += 1
        const payload = JSON.stringify({
          ret: 0,
          get_updates_buf: 'buf',
          longpolling_timeout_ms: longpollingTimeoutMs,
          msgs: payloadMsgs,
        })
        // 空轮询要挂住，否则传输层的循环变成忙循环（见文件头）。
        if (payloadMsgs.length === 0) return void setTimeout(() => res.end(payload), emptyPollHoldMs)
        return res.end(payload)
      }

      res.end(JSON.stringify({ ret: 0 }))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  /**
   * 排一条入站文字消息。
   *
   * @param {string} text
   * @param {string} messageId
   * @param {{ from?: string, groupId?: string, contextToken?: string, itemList?: object[] }} [extra]
   */
  const deliver = (text, messageId, extra = {}) => {
    if (delivered.has(messageId)) return
    delivered.add(messageId)
    seen.inboundTexts.push(text)
    queue.push({
      message_id: messageId,
      from_user_id: extra.from ?? '',
      group_id: extra.groupId ?? '',
      message_type: 1,
      message_state: 2,
      context_token: extra.contextToken ?? 'CT',
      create_time_ms: Date.now(),
      item_list: extra.itemList ?? [{ type: 1, text_item: { text } }],
    })
  }

  /**
   * 让某条 iLink 路由下一次（或几次）回一个错误响应，用来测失败分支。
   *
   * @param {string} pathname 例如 `/ilink/bot/sendmessage`
   * @param {object} response 要回给客户端的 JSON
   * @param {number} [times]
   */
  const failNext = (pathname, response, times = 1) => {
    failures.set(pathname, { body: response, times })
  }

  /** 机器人发出去的文字（每个 chunk 一项）。 */
  const texts = () => outbound.map((entry) => entry.text)

  /**
   * 只给请求体的视图，与 `outbound` 共享同一份记录：旧的手写假服务端记的就是
   * 这个形状，沿用它的测试一个字都不用改。必须是活数组——调用方在插件还在跑的
   * 时候就已经拿到引用，拷一份会永远读到空。
   */
  const bodies = new Proxy([], {
    get(_, prop) {
      const live = outbound.map((entry) => entry.body)
      const value = live[prop]
      return typeof value === 'function' ? value.bind(live) : value
    },
    has: (_, prop) => prop in outbound.map((entry) => entry.body),
    ownKeys: () => Reflect.ownKeys(outbound.map((entry) => entry.body)),
    getOwnPropertyDescriptor: (_, prop) =>
      Reflect.getOwnPropertyDescriptor(outbound.map((entry) => entry.body), prop),
  })

  /** 还没被取走的消息条数。 */
  const pending = () => queue.length

  const close = () =>
    new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    })

  return { server, baseUrl, seen, outbound, bodies, deliver, failNext, texts, pending, close }
}
