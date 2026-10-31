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
