# 架构与排障

这份文档回答两个平时最难查的问题：**消息是怎么进来又怎么出去的**，以及**出问题先看哪里**。
实现细节在各个模块的注释里，这里只给地图。

## 一句话结构

```
Weixin 服务端 ⇄ vendor/openclaw-weixin（协议层，原样 vendored）
                  ⇅
              src/transport/ilink.js      长轮询 + 发消息 + 正在输入
                  ⇅
              src/index.js                 入口：装配、配置、调度器、入站处理
                  ⇅
   ┌──────────────┼─────────────────────────────────────┐
 persona/memory   agent-bridge（DSH 会话）        outbound / channel
```

`src/index.js` 只做装配和入站分发；凡是能独立成"一段逻辑"的，都搬到了 `src/message/` 下。

## 入站一条消息的旅程

1. `src/transport/ilink.js` 的 `#loop` 长轮询 `getupdates`。**一次 rejection 不再杀死循环**：
   失败计数 → 退避（2s / 30s 阈值）→ 继续；循环整体被 `start()` 的 catch 兜住。
2. `createInboundScheduler` 按会话排队（`maxQueuePerConversation`，超限拒绝并记一行日志）。
3. `src/index.js` 的 `createInboundHandler`：
   `senderGate`（`src/message/sender-limit.js`，按发送者滑动窗口，超额只回一次提示 + 审计）
   → 白名单 → 下载媒体 → 写日记（`journalInbound`，`journaledAt` 是后续所有排除用的时间戳）
   → `applyScope()`（`src/config-scope.js`，会话级覆盖，每消息重新分层）
   → 拼提示词（persona → style → life → memory → recall）→ `bridge.handleCommand` / 交给 agent。
4. `hooks.emit(inboundAccepted / inboundRefused)`：外部订阅点，抛错不影响消息。

## 出站一条回复的旅程

`src/outbound.js`（`sendChunked` / `sendProducedFiles`）：

- `markdownToPlainText` → 记日记（整条一次）→ `chunkText` 或人工分条（`bubbles` + `gapMs`）
- 每块经 `src/channel.js` 的 `channelFor(transport).sendText()`：**这里是唯一的发送收口**，
  能力声明（text / media / typing / voice / stickers）也在这里
- 发送失败 → `src/message/outbox.js` 入队（磁盘持久化、指数退避、按会话保序、上限 50 条、
  一重启仍在），`/stats` 页签可看、可立即重试、可丢弃
- 文件/表情：`sendProducedFiles`、贴纸走 `transport.sendMedia`（图片气泡；微信没有贴纸类型）

## 状态都在哪

`src/state-layout.js` 是唯一权威表（16 项：journal / audit / media / exports / logs /
memory / memory index / reminders / subscriptions / outbox / config scope / instance lock /
persona / accounts / sessions）。保留策略 `src/message/retention.js` 按同一张表清理，
`/stats` 页签按同一张表显示占用。**新增状态文件先加表，否则清理和统计都看不见它。**

写文件一律走 `src/atomic.js`（temp + fsync + rename，失败只 warn），读带 `schemaVersion`。

## 后台的四套定时器

| 谁 | 文件 | 干什么 |
|---|---|---|
| 提醒 | `src/message/scheduler.js` | `/remind`，触发前先过免打扰门（`quiet-hours.js`） |
| 定时主动消息 | `src/message/subscriptions.js` | `/subscribe`，侧会话生成正文再走出去 |
| 主动开口 | `src/message/proactive.js` | 陪聊模式才生效，克制频率 + 退避 |
| 记忆摘要 | `src/memory-summarizer.js` | 每 N 回合一次侧会话，写摘要/事实/事件/档案，定期整理人物小传 |

全部经 `bridge.summarize({sessionPrefix})` 走侧会话，**不会发任何气泡**（`/summary`、`/subscribe`、主动开口的正文才发）。

## 排障顺序

1. `npm run doctor` —— 十项检查一次说完：node 版本、包版本、状态目录可写、白名单是否为空
   （空则谁都不回）、账号 token、实例锁、outbox 积压、今日日志最后三条错误、已发布版本。
   退出码非 0 才是有问题。
2. `~/.dsh/weixin/logs/openclaw-YYYY-MM-DD.log` —— 插件写进去的每一行都带 `dsh-weixin:` 前缀。
   （历史坑：transport 的 log 曾只进宿主 logger，操作者看不到，已修。）
3. `~/.dsh/weixin/journal/journal-YYYY-MM-DD.jsonl` —— 收发原文，`/export` 也读它。
4. `~/.dsh/weixin/audit/audit-YYYY-MM-DD.jsonl` —— 工具调用与拒绝原因。
5. `/status`（微信里）看当前会话、账号、限流与积压；`/stats` 页签看 14 天曲线与磁盘占用。

## 已知缺口（诚实清单）

- **微信原生表情包发不出去**：`MessageItemType` 里没有贴纸类型，只能发图片气泡（36 张内置图）。
- **bot 语音条服务端不投递**：`ret=0` 接受但对方收不到（两次真机实测），所以 `voiceOutbound` 默认关。
- **设置卡的拆分只到"一个 chunk"这一步**：界面九个 Section 与卡片本体已经搬进 `src/client.card.js`
  （2452 行），入口 `src/client.js` 从 3590 行降到 1278 行，靠 loader 的包内 lazy chunk 协议
  （`register({id, chunk, factory})` + `require.async("./client.card.js")`）在激活时取回。
  再往下拆成几个 chunk 是可行的，但每多一个 chunk 就多一次取回，收益不足以抵消；保持一个。
  服务端侧已拆出 `src/outbound.js`（2000 → 1891 行）。
- 会话级配置覆盖（`config-scope.js`）目前只覆盖 15 个"行为"键，安全键（白名单、媒体上限）永不可覆盖。
