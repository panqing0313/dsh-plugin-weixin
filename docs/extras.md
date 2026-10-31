# 扩展功能：日常可用的那些开关

这一页只写**怎么用**。每一项在 `docs/progress.md` 里都有实现与取舍记录，版本号标在标题后。

## 通知桥：让脚本给你发微信（0.9.14）

长任务跑完、备份成功、cron 出错时，不用再等你主动来问：

```sh
TOKEN=$(node -p "require('$HOME/.dsh/weixin/notify.json').token")
curl -s -X POST http://127.0.0.1:47832/notify \
  -H "x-notify-token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"📦 构建完成"}'
```

- 在设置卡「配置项 → 通知桥」打开；默认关闭。
- 只绑 `127.0.0.1`，必须带 token。token 首次启动自动生成，存在 `<状态目录>/notify.json`（0600）；也可以用 `notifyToken` 自己指定。
- 纯文本也行：`curl … -d '构建完成'`。
- 每分钟最多 30 条，正文最多 4000 字（超出截断）；token 错了返回 401，发不出去返回 502。
- 推到最近说过话的那个会话；还没有任何会话时返回 502，不会静默吞掉。
- 它**不经过模型**，一条通知只花一条微信消息。

失败排查：日志里搜 `notify bridge`（端口占用）或 `notify send failed`（传输层）。

## 离开模式：出门时说一声，回来收一份汇总（0.9.14）

```text
/away 2h 开会        # 两小时后回来，备注「开会」
/away 20:30          # 到今晚 20:30
/away                # 只看还剩多久
/back                # 提前回来，立刻收汇总
```

- 离开期间消息照收，但**每个会话每 30 分钟最多自动回一句**「我现在不在，看到会回你～（大概 HH:mm 回来）」，不经过模型，不花 token。回复文案可用 `awayAutoReply` 覆盖。
- 其他消息记在 `<状态目录>/away.json`，最多 30 条；回来说 `/back`，或到点自动发一条汇总到最后一个找你的会话：几条、几个人、都说了什么。
- 命令始终可用（`/away`、`/back` 的拦截在命令处理之后），所以在离开模式里也能随时改时间或提前结束。
- `/away` 的时间写法与提醒一致：`10m`、`2h`、`20:30`、`2026-10-29 09:00`。

## 共享清单：群里的事有一处落脚（0.9.14）

```text
/todo                     # 看整份清单
/todo add 周末买牛奶       # 加一条（直接写「/todo 周末买牛奶」也行）
/todo done 2              # 第 2 条做完了
/todo rm 2                # 删掉第 2 条
```

- 按**机器人账号**存，不按会话：同一个机器人的群聊和私聊看到的是同一份清单 —— 这才叫共享。
- 每条记下是谁在哪个会话加的、什么时候完成；序号就是当前显示的顺序。
- 上限 100 条；满了会明确拒绝，并提示先 done / rm，而不是悄悄挤掉最旧的。
- 状态在 `<状态目录>/lists.json`，原子写；群里几个人同时加也不会写坏。

## 稍后读：链接不再被刷走（0.9.14）

```text
/later https://example.com/post   # 存链接，插件取回标题
/later 读那篇讲 RSC 的文章        # 不是链接也行，原样存一条
/later                            # 看清单（未读/总数）
/later done 2                     # 第 2 条读完了
/later rm 2                       # 删掉第 2 条
```

- 按账号存，状态在 `<状态目录>/reading.json`，上限 50 条。
- 标题取不到就退回域名（`news.example.org`），不会因为网络问题存不进去；非链接文本不会触发任何网络请求。
- 同一条未读链接只存一次；标记读完后再存同一个 URL 会作为新的一条。

## 要一个文件：`/send`（0.9.14）

```text
/send out/report.pdf          # 相对工作目录
/send /Users/me/notes/todo.md # 绝对路径也行，但必须在允许的目录里
```

- 只发真实存在的普通文件，且必须落在**工作目录、状态目录、`mediaDirs`** 之内（与自动附件同一套 `resolveAllowedPath` 守卫，`..` 与符号链接逃逸都拒绝）。
- 受 `maxMediaBytes` 限制（默认 100 MB），超了直接说明，不会偷偷截断。
- 发送失败时文件保留，回复里说明失败，不会假装已发。

## 加密备份：把状态带走（0.9.14）

`npm run backup create` 是目录对目录的快速回滚，**不设防**——里面就是明文 token 和聊天原文。要跨机器或放网盘，用密封备份：

```bash
export DSH_WEIXIN_BACKUP_PASSPHRASE='一句只有你知道的话'
node bin/backup.mjs seal ~/Desktop/weixin-state.enc
# 另一台机器 / 恢复时
node bin/backup.mjs open ~/Desktop/weixin-state.enc
```

- AES-256-GCM + scrypt（随机 salt/iv），密文带认证标签：口令错或文件被改会直接拒绝，不会还原出半套状态。
- 只封 `config.json`、`memory/`、`journal/` 等真实状态；跳过 `backups/`、`instance.lock`、`node_modules`。
- 恢复前会检查 DSH 是否在跑（在跑就拒绝，`--yes` 可强来），写入走临时文件 + rename。
- 口令不写进任何文件，也不进命令行历史（走环境变量）。

## 省钱路由：三种花销分开定价（0.9.14）

| 配置 | 谁在用 | 留空时 |
| --- | --- | --- |
| `chatProvider` / `chatModel` | 主对话 | 会话默认 |
| `sideProvider` / `sideModel` | `/summary`、`/subscribe` 到点 | 记忆模型 → 会话 |
| `proactiveProvider` / `proactiveModel` | 主动开口 | side → 记忆 → 会话 |
| `reportProvider` / `reportModel` | 日报、记忆核对 | side → 记忆 → 会话 |

主动开口只有一句，放最便宜的模型；日报要读流水再压缩，单独给一个。两者都必须成对填写，只填一半不生效（回落到下一层），避免把自己路由到一个没有模型名的线路。

## 文档理解：发进来的文件能直接问（0.9.14 起，PDF 从 0.9.15 起）

把 `.docx` / `.txt` / `.md` / `.csv` / `.json` 发到微信里，插件会在下载后把**正文**拼进这一回合的提示，你可以直接问「第三条写了什么」，不用打开文件。

- `documentExtract`（默认开）控制是否抽取；`documentTextChars`（默认 4000）是每个文档的上限，超出会截断并注明。
- `.docx` 是零依赖解析（zip + `word/document.xml` + 去标签）。
- `.pdf` 走**可选依赖** `pdfjs-dist`：装了就把正文抽出来（按页取文字，保留换行），没装就只给路径并在日志里说明原因——不假装支持，也不把几十 MB 的解析器塞进默认安装。要启用：在插件所在环境执行 `npm i pdfjs-dist`（DSH profile 里则是 `pnpm add pdfjs-dist`）。只取文字，不需要 canvas。
- 抽出的正文和用户消息一样按不可信内容转义，不会把文档里的标签变成指令。

## 引用回复：被引用的那句话也进上下文（0.9.15）

别人引用一条消息再回你时，微信不会把原消息重发一遍，只在 item 上挂一个 `refermsg`。插件现在会把里面的发送者、标题和正文读出来，拼成提示开头的：

```
【引用 小王】
下午三点开会
```

- 三种常见形状都认：`item.refermsg`、`item.appmsg.refermsg`（引用卡片）、`item.quote.refermsg`。
- 只引用、不配文的消息也会走模型（以前 text 为空会被当成「没看懂」）；外层是插件不认识的 item 类型时，引用内容仍然能到达模型。
- 引用文本按不可信内容处理：先 `redactSecrets` 脱敏、截断到 500 字，再由 `neutralizeTags` 转义。

## 重要日子的当天提醒（0.9.15）

记忆里的「重要日期」（生日、纪念日，`/remember` 或设置卡写入）和带日期的待办，到了当天会收到一条短消息：

```
📅 今天是重要日子
- 生日（第 36 年）
- 交房租
```

- 每天 `dateReminderWhen`（默认 `09:00`，本地时区）之后检查一次，当天只发一条；没命中就不发，也不标记 —— 当天晚些时候补记的日期仍来得及。
- 不跑模型、不花 token、不写消息流水。
- 已完成的待办（`done`）和没写日期的待办不会触发；没有日期的「重要日期」条目本来就不会被记忆接受。
- 关掉：`dateReminderEnabled: false`，或设置卡「汇报」组里的开关。

## 识别图片文字：OCR 桥（0.9.15）

插件不内置识别引擎，只规定一个最小约定：**一个可执行文件，唯一参数是图片路径，stdout 是文字**。配置 `ocrEnabled: true` + `ocrCommand` 后，每张入站图片都会被它读一遍，结果作为 `<weixin_ocr>` 块拼进这一回合的提示。

接 tesseract 的 wrapper（存成 `/usr/local/bin/ocr-img` 并 `chmod +x`）：

```bash
#!/bin/sh
exec tesseract "$1" stdout -l chi_sim+eng 2>/dev/null
```

- 超时 `ocrTimeoutMs`（默认 20000）到点直接 `SIGKILL`，按「没有文字」处理；退出码非 0、输出为空同样只降级，不让回合失败。
- 每张图最多保留 `ocrMaxChars`（默认 2000）字。
- 不配置就完全不走这条路：图片仍按原来的方式保存、把路径交给模型。
- 识别结果是不可信文本，和文档正文一样先 `neutralizeTags` 再进提示。

## 出站 webhook：把发生的事推给你自己的系统（0.9.15）

通知桥是入站（外面推一条给微信），webhook 是出站（插件把事件推给 n8n、面板或日志服务）。配置 `webhookUrl` 即开启：

```
POST https://your-host/hook
content-type: application/json
x-weixin-signature: sha256=<hex>        # 配置了 webhookSecret 才有

{"event":"message.received","at":"2026-10-31T02:00:00.000Z","accountId":"…","conversationId":"…","text":"…"}
{"event":"reply.settled","at":"…","accountId":"…","conversationId":"…","sent":true}
```

- 两个事件：`message.received`（通过闸门、即将进模型）与 `reply.settled`（发出成功，或因失败进了 outbox 时 `sent:false` + `queued`）。
- 签名对**原始 body** 做 HMAC-SHA256，密钥是 `webhookSecret`；校验示例（Node）：
  ```js
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-weixin-signature']))
  ```
- 超时 `webhookTimeoutMs`（默认 5000）；非 2xx、网络错误、超时都只写日志，不影响回复。
- 只支持 http(s)；URL 不合法时启动日志会说明并停用，不会悄悄重试。

## 后台预算：给不面向用户的调用设个上限（0.9.15）

记忆折叠、日报、记忆核对、订阅到点、主动开口都会真的调模型，但它们不由某条用户消息触发——出问题时没人立刻发现。`backgroundDailyLimit` 给这些调用一个**按天**的总量：

- 默认 `0` = 不限；配成正数后，当天后台调用达到上限就不再发起，日志写 `background model call skipped: background budget N/N used today`。
- 跨天自动归零；计数在 `<状态目录>/budget.json`。
- **主对话永远不受影响**：用户说话不受预算限制，闸门只装在 `AgentBridge.summarize()` 这一条后台入口上。
- 被挡下的调用不计数、不 attach、不计费。

## 提醒时间说人话（0.9.17）

`/remind` 的时间除了 `10m` / `18:30` / `2026-10-20 09:00`，还认这些口语写法：

| 写法 | 含义 |
| --- | --- |
| `明天 9:00` / `明天9点` | 明天 09:00 |
| `后天下午3点半` | 后天 15:30 |
| `今晚8点` | 今天 20:00（已过则报错，不悄悄改到明天） |
| `下周一 10点` | 下一周的周一 10:00（`周一` 才指本周） |
| `3小时后` / `半小时后` | 相对现在 |
| `9点` | 今天 09:00，已过则明天 09:00（与 `09:00` 同一规则） |

只给日期不给钟点（`明天下午`）会明确要求补时间，不替用户猜。时间本身可以带空格，命令按「第一个能解析的时间前缀」切分，剩下的都是提醒内容。

## `/diag`：它为什么没动静（0.9.17）

「怎么不回我」多数时候不是崩了，而是某个闸门关着。`/diag` 把答案压成一条消息，**不调模型、不花 token**：

```
自检 · v0.9.17 · 宿主 0.2.1-rc.5（已测）
账号：b1b2…@im.bot
模式：女友（陪聊）
开关：主动开口 开 · 记忆 开 · 群聊 关 · 免打扰 开 · 文档抽取 开
待发：提醒 2 条 · 订阅 1 条
主动开口：今天 1/3 条 · 上次 2026/10/31 09:12:03 · 连发未回 0 次
数据：今天流水 12 条 · 会话记忆 4 个 · 白名单 1 人
免打扰：当前不在静默时段
```

看三行就够：**连接**（收不收得到）、**开关**（主动开口/记忆/群聊是否被关）、**免打扰**（现在是不是静默）。主动开口不触发时，先看额度是不是用完、`连发未回` 是否触发了退避。

## `/outbox`：没发出去的那句话去哪了（0.9.17）

出站失败不是消失：`sendChunked` 会把失败的那条（含后续分块）写进本地队列，后台每 30 秒按退避重试，重启也不丢。但以前只能从设置卡里看见它，聊天里没有入口。

```
/outbox
待重发 1 条：
1. m3k2-9f1a · 5 分钟前 · 尝试 2 次 · 上次失败：fetch failed
   刚下班，路上风有点凉…

/outbox retry 立即重试；/outbox drop <id> 丢弃一条。
```

- `/outbox retry` 调 `flush({force:true})`，忽略退避立刻再试，回报发出/失败/剩余条数。
- `/outbox drop <id>` 丢弃一条（比如内容已经过时）。
- 队列按账号隔离，最多保留 200 条；`/diag` 里的「今天流水」不会因为重发而重复计数。
