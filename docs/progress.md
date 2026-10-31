# 开发进度

更新时间：2026-10-27

## 当前状态（2026-10-26）

- **版本**：`0.9.9`，2026-10-27 已发布（npm `latest`、tag `v0.9.9`、GitHub release 三者齐全；注册表 `dist.shasum` `2bd3d597…` / `dist.integrity` `sha512-caG529vI…`、`gitHead` `2c07a90` 与本地 tarball 逐字节一致）。`package.json` 与 `package-lock.json` 现由发版脚本强制一致，锁文件的版本漂移已被 preflight 挡住。
- **仓库**：`main` 干净。相对 `v0.9.2` 的 14 个 commit 全部在 0.9.3 里（`19b1a73` 回合内工具流式推送、`5602fb3` 进度文档、`99624e8` 出站限速接线、`96cb617` `/cancel` + 工具审计、`5aa1845` 状态卡自刷新、`2077934` 发版清单守卫、`9170642`/`dc4e0b3`/`be2c030` 文档、`39cd6c6` 轮内派发改造、`26e1a42` 被取消的调用补 `aborted`、`a035e46` 版本号、`27b689e` e2e 断言改为按发送者、`4faad53` README 发布行）；0.9.3 之后新增**出站语音**（整条管线 + 真机复测，见下，待随下次发版）、**个性化与记忆**（对话模式 /mode、长期记忆 /remember /forget /memory、后台会话摘要，`f78f5ca` + `8f7dba2`）、**可玩性三件套**（游戏模式 /mode 海龟汤|成语接龙|文字冒险 `ea59e86`、亲密度+心情 `081759d`、定时主动消息 /subscribe `79307dc`，见下，待随下次发版）；**第二轮六项**（即时总结 `/summary` `d868362`、聊天记录导出 `/export` `75f7bcb`、免打扰时段 `7260839`、账号级默认人设 `5b11fe1`、统计页签 `668dc7d`，见文末；第六项发版 0.9.4 见发布记录）。其后又有**贾维斯模式** `5e8c3a8`、**冷启动记忆窗口** `d68bd21`（每条消息的常驻提示词开销 945→322 字）、**本地回忆检索** `e0834d1`（消息流水倒排索引 + `/recall`），见文末；**左侧栏面板** `14636d6`（`sidebar.panellist` 行 + `main` 页，同一张卡片不再是设置卡专属）；0.9.5 之后 **配置项中文化 + 默认折叠** `36b0af6`（`t(en, zh)` 参数顺序反了 5 处、首组不再自动展开，见文末；0.9.6 已发）；证据见下一条：**发版脚本第 9 步装的东西会被 App 回滚**，现已让脚本顺手钉住 profile 依赖（`pinProfileSpec`，0.9.6 之后已在 main，随 0.9.7 发）。0.9.6 之后新增**陪聊节奏与生活状态**（首条延迟 + 气泡分条 `humanPace`、按时间推断的心情/精力 `lifeState`、卡片按会话显示模式与状态，见文末；**「默认助手」一律不做**）。
- **测试**：`npm test` → `tests 736 / pass 736 / fail 0`（约 47s；相对 0.9.2 新增 103 条，其中个性化与记忆占 38、可玩性三件套占 15：出站限速接线 9、`/cancel` 5、工具审计 8、发版清单一致性 5、状态卡自刷新 1、e2e 审计接线 1、轮内派发 6、install 来源信息提示 2、**出站语音 13**；个性化与记忆：persona 9、memory 8、会话命令 6、后台摘要 7、e2e 注入与摘要 2、设置卡/远程方法/表单接线 6；可玩性：游戏模式 1、亲密度 6（memory 3 + login-remote 1 + 会话命令 1 + e2e 1）、订阅 9（subscriptions 单测 8 + 会话命令 1）。本轮再涨 19 条：即时总结与导出（chat-export 3 + 会话命令 2）、免打扰 6、账号级默认人设 1、统计 5、/summary 1、/export 1。耗时从 ~103s 降到 ~41s 是因为 `notifyStart/notifyStop` 的兜底定时器改成 `unref`，不再让进程空等 80s）。本轮再涨 15 条：陪聊节奏 6（human-pace）+ 生活状态 6（life-state）+ e2e 分条/状态 1 + 卡片按会话显示模式与状态 2（login-remote 1、设置卡 1）；角色池扩容再加 1 条（老目录按名册顺序补齐新角色，见候选后续 13）。本轮再涨 13 条：贴纸 5（16 张里的新增断言，含角色包过滤）、记忆模型 v2 7（结构化档案/事件/预算 3 + 抽取与整理 4）、远程方法 1；并更新 e2e 摘要断言 1。0.9.7 之后新增**记忆模型 v2**（结构化档案 / 事件与待办 / 人物小传整理 / 记忆专用模型）与**表情包扩容**（36 张、按角色分套），见文末；**0.9.8 已发布**（发布记录见文末）。本轮再涨 1 条：发版脚本输出写入的回归（`writeOut` 吞掉 pty 消失的 EIO）。
- **完成度**：按「可运行的生产插件」计约 **98%**；剩下的都是长尾验证与体验增强，没有阻断性缺口。

### 已落地能力

- **收发闭环**：文本 / 图片 / 文件 / 入站语音（SILK→WAV→ASR 桥，热调用约 300ms），下载、解密、落盘、转码、降级齐全。
- **多账号**：逐个扫码接入、各自独立长轮询、账号级 Pause/Resume、账号级白名单覆盖全局、首联系人自动登记、扫码后即时生效（不重启）。
- **会话**：一个微信会话挂多条 DSH 会话（`/new` `/list` `/use` `/clear`），标题带账号前缀并镜像成宿主会话名；`/status` `/help` 让命令族自描述；`/cancel` 中断正在跑的那一轮（排队消息仍继续）。
- **出站**：分片 + Markdown→纯文本 + 限速（`sendIntervalMs` / `sendCooldownMs`）+ **滚动窗口上限**（默认 15 条 / 2 分钟，到顶自动等窗口滑过而不是硬发）+ 失败冷却；回合中的工具变化流式推送；音频附件可发成语音气泡（`voiceOutbound`，**默认关**：服务端接受不投递，见「未完成」；wav/silk 进程内转 SILK、其余走 ffmpeg，发送被拒自动降级为文件）。
- **主动消息**：`/remind`（相对时长 / `HH:mm` / 绝对日期，**不经过 agent 轮次**）、`/remindlist`、`/remindcancel`；调度器原子落盘 `<stateRoot>/reminders.json`，每账号上限 50 条。
- **观测**：消息流水 JSONL（按天滚动、文本截断 200 字符、失败只 warn）+ **工具审计 JSONL**（`<stateRoot>/audit/`，工具名 / 截断参数 / 账号 / 会话 / 触发者 / 结果是否带错，`callId` 配对；被 `/cancel` 打断的调用补 `aborted:true`）；设置卡 9 个页签（账号（登录 + 状态）/ 会话 / 配置 / 语音 / 消息流水 / **统计** / 定时提醒 / **个性化** / 关于）；消息流水页签带**导出记录**（最近 30 天 Markdown 浏览器直下）。
- **语境增强**：`sourceContext` 来源块、`readLinks` 抓正文、`autoSendFiles` 产出文件自动送达。
- **入口**：同一张卡片注册在三个位置——插件页（`plugins.bundle.config`）、宿主设置导航（`settings.section`，排在 dsh-im 之后）、以及**左侧栏的「微信」页**（`sidebar.panellist` 行 + `main` 键控面板，同一 id `dsh-weixin`）；面板页自带滚动、24/28px 边距与 920px 阅读宽度（卡片原本按 ~520px 对话框设计）。
- **个性化与记忆**：`/mode` 切换对话模式（**12 个内置角色**：默认助手/女友/男友/朋友/贾维斯/**小鲸娘/御姐/知心大姐姐/暖男/可爱闺女/猫娘/傲娇** + **三个游戏模式** 海龟汤/成语接龙/文字冒险 + 至多 8 个自定义，切换开一条新会话线，`/list` 可切回；角色与游戏分组显示）、`/remember` `/forget` `/memory` 管理跨会话长期记忆（存满拒绝新增而不是挤掉最旧的）、每 N 回合后台侧会话自动更新会话摘要（不发任何微信消息）、最近消息窗口折进提示词、**亲密度**（认识天数/消息数/确定性心情，进提示词 `/status` `/memory` 与设置卡，且只对陪聊模式显示）；设置卡「个性化」页签可视管理，并**按会话**显示「模式 · 此刻状态 · 认识多久」。
- **陪聊节奏与生活状态**：非「默认助手」模式下回复按人来的节奏走——首条停 0.2–2.4s 抖动（累时 ×1.35）、长回复拆 2–3 条气泡（条间 0.4–1.1s）、收尾短句单独成条；心情/在做什么/精力由「几点 + 隔了多久 + 今天聊了多少条」确定性推断（不调模型，5 分钟节流落盘 `memory/life-<账号>.json`），精力低时提示词里要求回得更短更慢。**「默认助手」不延迟、不分条、不注入状态**，`/status` `/memory` 的感情行同样只在陪聊模式出现。
- **表情图片**：内置 12 张表情图（`assets/stickers/`，`scripts/make-stickers.py` 可重出图），陪聊模式下模型写 `[表情:困了]` 就把标记摘掉、改走图片通道发原生图片气泡（微信协议没有贴纸类型，这是能做到的最近形态）；未知名字/超两张自动丢弃并记警告，全角冒号与尾缀粒子都能识别。
- **主动开口**：`proactiveEnabled`（默认关）开着时，陪聊模式的会话在对方安静够久后自己先发一条——每 5 分钟看一次候选，闸门依次是「时段 → 最短间隔 → 未被回应的指数退避（上限一天）→ 每日上限 → 35% 骰子」；内容由侧会话带着人设/状态/记忆生成（含「你上次发过什么，别重复」），空文本整条不发，对方一说话退避立即清零。**「默认助手」永远不主动。**
- **定时主动消息**：`/subscribe <时间> <提示词>`（每天/每周X/裸 HH:mm/一次性）到点开侧会话让 agent 带着人设与记忆生成一条再走标准出站管线（分片/限速继承），`/subscribelist` `/subscribecancel`；错过的到点 30 分钟内补发一次、否则丢弃，一次性到期自动移除；每账号上限 20 条。`/remind` 保持零模型消耗不变，两者互补。
- **即时总结与导出**：`/summary` 现场让侧会话总结这段会话（不写回摘要，纯「看一眼」）；`/export [天数]` 把最近 N 天流水渲染成 Markdown——短的直接回复，长的落盘 `<stateRoot>/exports/`；设置卡消息流水页签的导出按钮走同一渲染，改为浏览器下载。
- **免打扰时段**：`quietHoursEnabled` + `quietHoursStart`/`quietHoursEnd`（默认 23:00–07:00，支持跨午夜）。时段内到点的 `/remind` 与 `/subscribe` 全部重新排期到时段结束：提醒保留在盘上、订阅不消耗次数，夜里不响、早上不丢。
- **统计**：设置卡「统计」页签给最近 7/14/30 天的总量/按天/24 小时分布/最活跃会话，全部由本机流水现算（不缓存、不回传）。
- **本地回忆检索**：消息流水做倒排索引（中文二元切片、BM25、按天增量、只覆盖 `memoryRecallDays` 天），消息提到旧事或词面命中够密时把带日期的**原文**折进 `<weixin_recall>` 块，闲聊 0 token；`/recall <关键词>` 手动翻记录不经过模型。
- **账号级默认人设**：模式优先级「会话 `/mode` 覆盖 > 此账号默认 > 全局默认 > 配置项」；设置卡个性化页签可改账号默认。
- **健壮性**：长轮询看门狗（响应头到达后 body 挂死）、归档会话自动恢复、模型调用失败不卡队、二维码 PNG 只用 `node:zlib` 自编码（Windows 可用）。

## 未完成 / 待办

### 一、只差真机与时间验证（代码已就绪）

- **长时间运行**：断线重连、sync buf 漂移、iLink 丢消息后的自愈，还没有跨天观察记录。
- **多账号长期并发**：两个账号同时高频收发没跑过；限速是**按账号**的，跨账号互不影响这点未实测。
- **群聊**：入站 `group_id` 非空路径目前只有单元测试（空 group_id 回归也在其中），真实群消息未验证。
- **0.9.3 的真机覆盖**：回合中工具流式推送、出站限速（实测发送间隔 0/1200/2400/3600ms）、工具审计（`tool/call`+`tool/result` 按 `callId` 配对，带发送者与 sessionId；被中断的调用补 `ok:false` + `aborted:true`）、`/cancel`（`sleep 120` 跑到 65s 时中途取消，回「已请求取消当前回合。」，日志记 `turn cancelled by user`）都已真机验过；状态卡自刷新与发版清单守卫靠单测覆盖，没做人工长观察。

### 二、功能缺口（有明确原因，不是遗漏）

- **出站语音：服务端接受但不投递（真机复测结论）**：管线完整（`voice_item` 语音气泡，SILK 5/24kHz/playtime 秒，发送被拒自动降级文件），但真机实测 `ret=0` 后手机端收不到——与 2026-06 实测一致，判定为 iLink 服务端账号能力开关。`voiceOutbound` 默认 **false**（开着会无声吞附件），想试的人可在设置卡打开；测试锚定该默认。
- **出站视频**：需要视频编码管线（缩略图 + 时长 + md5），未做。
- **原生图像理解**：入站图片以本地路径交给 Agent，由 Agent 用 `read_image` 打开——依赖当前模型与工具链，插件不保证。

### 三、工程与发布

- **依赖源切换（已完成，2026-10-23）**：作者的 desktop profile 已从 `file:/tmp/dsh-plugin-weixin-0.8.0.tgz` 换成 `^0.9.3`，`pnpm-lock.yaml` 同步（specifier / version / integrity 与 registry 一致，而那个 tarball 其实早已不存在了）。设置卡「来源信息」印的是 profile **声明的** spec，所以 `bin/install.mjs` 现在会在仍声明 `file:…tgz` 时打印该换成的 semver；它不会擅自改作者的依赖。
- **0.9.4 发版被 npm 登录挡住（2026-10-26）**：代码、测试（483/483）、文档、tag 全就绪，`node bin/release.mjs 0.9.4 --yes` 在 preflight 停在 `✗ not logged in to npm`——`~/.npmrc` 里的 `_authToken` 已被注册表判 401（`npm whoami` 401；0.9.3 是 10-23 用同一 token 发的）。需要作者在真终端跑一次 `npm login --auth-type=web`，然后重跑发版脚本即可（脚本的 preflight 会重查 `npm view`、`gh`、清单一致性与工作区干净度，不会重复发版）。已从源码装进 desktop profile（`node bin/install.mjs --profile desktop`），重启 DSH 就能先用上这批功能，版本号仍显示 0.9.3。
- **市场收录跟进**：`awesome-dsh-plugin` PR #7426 合并后核对 dsh-market 的搜索结果与条目渲染。
- **低优先整洁性**（判定不值得单开一轮）：`src/media/inbound.js:127` 与 `:323` 各自重算同一 trim 表达式；语法合法但语义错误的 CDN URL 被静默接受（属用户配置问题）。

## 关键决策（仍然有效）

1. **不移植 Hermes runtime，只借通信层。** 避免两套控制中心（session / 工具 / 权限各存一份）。
2. **vendor 腾讯官方 SDK，不手写 iLink 客户端。** 协议细节（uint64 精度、AES-128-ECB 媒体、typing ticket、sync buf）已由官方实现覆盖。
3. **不引入 OpenClaw。** 只需要 3 个叶子 helper，用 `openclaw-shim.js` 顶掉即可。
4. **运行时用 JS，不用 TS。** 装进 profile 后位于 `node_modules` 下，Node 拒绝在那里做类型剥离（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）；类型用 JSDoc 表达。
5. **会话 meta 不写自定义 `origin`。** session header schema 只允许 `origin: 'subagent'`，写了会抛 `SessionFormatError`。
6. **白名单默认拒绝所有人。** 微信文本不是授权凭据。
7. **提醒不经过 agent 轮次。** 定时消息是插件自己的行为，不应消耗模型调用。

## 已知环境限制（仍然有效）

- 写入 `~/.dsh/profiles/desktop/node_modules/` 在 workspace-write 模式下被沙箱拒绝；提权到 danger-full-access 后 `node bin/install.mjs --profile desktop` 可直接安装。
- 探针脚本必须设 `OPENCLAW_STATE_DIR`（vendored `accounts.js` 读它，不读 `DSH_WEIXIN_STATE_DIR`）；否则 `loadWeixinAccount` 返回 null → `TypeError: Cannot read properties of null (reading 'baseUrl')`。
- 本环境无 `tsc`；`npm install` 会卡住（需 `--cache <workspace 路径>`），`npm pack` 正常。
- 顶层函数不能引用 `apply` 作用域里的变量：被错误边界吞掉后表现为「全部消息无回复」，必须参数透传或提到模块级（已两次踩中，见下方日志）。

## 历史阶段记录（2026-10-13 起，最新在下）

## 2026-10-13 深夜 — round-6（T10-R2 补强后复验中）

- t10 复验通过（verdict=pass）：T9-WS（空白串 cdnBaseUrl 顶掉账号记录）与 T9-DEADTAIL 修复成立。
- 按 t10 的 T10-R2 建议，captain 把空白串回归测试扩展为**同时覆盖入站下载与出站上传**：
  - 假 CDN 同时回加密下载体与 `x-encrypted-param` 头（上传路径需要）；请求体按 Buffer 收集。
  - agent 回复改为引用允许目录内的 `note.txt`，触发真实出站上传。
  - 等待条件改为等出站 FILE item（type 4），避免断言与上传竞态。
  - 断言从合并计数改为**按方向分别断言**：`/c2c/download` 与 `/c2c/upload` 各 1 次。
- captain 过程中自查出一个自身错误：最初写的 `cdnRequests.length === 1` 在该测试同时驱动两方向时恒假
  （实测 `2 !== 1`），已改为按方向分别断言。
- 辨别力实测：退回 `src/index.js:127` 的 `?.trim()` → 该测试失败（`saw []`，出站方向全面失守）；
  恢复后 6/6 通过。全量 **83 tests / 83 pass / 0 fail**。
- 已部署 `node bin/install.mjs --profile desktop`，部署副本 trim 三处一致。
- **t11（round-6 复核）已派发给 verifier，待结论。**

## 遗留 / 已知事项（round-6 当时，已过时——见顶部「未完成 / 待办」）

- ~~语音完整识别（ASR）未实现~~ → 已由仓库自带 `bin/asr-bridge.py` 解决（0.3.0 起开箱可用；无 silk-wasm 时仍降级存 `.silk`）。
- T10-R1（low）：`:127`/`:323` 仍各自重算同一 trim 表达式，属整洁性，判定不值得本轮抽函数。
- T10-R3（low）：语法合法但语义错误的 CDN URL 被静默接受，属用户配置问题，建议不做。
- **待用户确认**：插件尚未在真机上重发一轮验证（重启后需用户从微信发一条消息确认双向通路）。

## round-6 复验结论（t11）— verdict=pass

verifier 独立复核确认：新增的空白串回归测试**两条方向断言各自具备辨别力、互不遮蔽**。
它用三组单向隔离副本证明了这一点（captain 的原始证据不足以证明）：
- 仅出站失效（副本出站链路不再用已规范化值）→ 入站断言先通过，独立失败于出站断言。
- 仅入站失效 → 出站请求确实到达账号 CDN，独立失败于入站断言。
- uploads 计数通过但注入 `Failed to parse URL` → 独立失败于回复文本断言。
全量 83 tests / 83 pass / 0 fail；真源码指纹 PRE/POST 一致。

**captain 承认的推理错误**：我最初用「退回 `:127` 的 `?.trim()` 后测试失败」来证明出站方向被覆盖，
这是不成立的 —— 全量退回时 `new URL('   ')` 抛错，入站下载根本没发出，失败停在**入站**断言，
从未执行到出站断言。出站方向的覆盖必须靠单向隔离实验证明，不能靠全量退回。

**harness 经验（勿改回去）**：假 iLink 的 getuploadurl **不得返回 `upload_full_url`**，
否则上传永远打到假 CDN、看不出客户端实际使用的 cdnBaseUrl。

**最终指纹**：`src/index.js` sha256 `b65e2d06b9b13a9a0181426af1fe9027bfcc724910afc46b4553a01e35530f4c`；
`test/e2e.test.js` sha256 `2703fa5f33f0f7581bf4a57dcf7610328f963d5b1f2a35918af43ae5d4cba30f`。

**唯一遗留**：T10-R1（三处重算 CDN 回退链，low，纯整洁性，不阻塞，判定不值得本轮收拢）。

## 关于团队 escalated 状态的说明（重要）

团队状态显示 `escalated`，且 `t8`/`t9` 为 failed、unresolved —— 但这是**记账状态，不是产品状态**。
两者都是 review 任务，因 review round 触顶（3）而无法自动开下一轮，于是循环停机并把裁决权交回用户。
它们报出的缺陷**均已修复并经后续复核通过**：

| 任务 | 缺陷 | 修复位置 | 复核结论 |
|---|---|---|---|
| t8 | F5-C（high）：schema `.default(DEFAULT_CDN_BASE_URL)` 使账号记录的 cdnBaseUrl 成为**死代码**，出站/入站都打到生产 CDN | `src/index.js:73-79` schema 改为 `.default('')`；`:127` 三级链 `config…trim() \|\| account… \|\| DEFAULT` | t9 独立复验修复成立；t10 確認 |
| t8 | F5-DEAD（low）：不可达尾项 | `resolved?.cdnBaseUrl` 已不再被咨询（grep 无命中） | t10 確認 |
| t9 | T9-WS（medium）：空白串 cdnBaseUrl 被 `\|\|` 当 truthy，顶掉可用账号记录 → `Failed to parse URL` | `:127`/`:267`/`:323` 三处 `.trim()` | t10 + t11 两轮确认 |
| t9 | T9-DEADTAIL（low） | 同上 | t10 确认 |

**结论：无未修复的阻塞项。** t8/t9 的 failed 只表示「该轮 review 以 needs_revision 结束」，不代表当前源码有问题。

## 交付说明已产出

本轮媒体能力的完整交付说明见 **`docs/delivery.md`**（218 行），含：
真机验证证据（含会话原文）、架构与移植边界、承重顺序约束、配置项表、
移植模块清单与三处机械改动、6 个已修复的真实缺陷、测试陷阱与方法论教训、
部署流程与部署后必验项、遗留事项、团队 escalated 状态说明。

其中文档内所有行号引用已逐条对源码核验通过。

## 2026-10-15 — 设置页扫码登录从未成功过（已修复）

**用户报告**：「退出登录后重新扫码登录，手机端微信显示已绑定，但插件还是显示未登录，不是实时的吗」。

**根因（两个独立缺陷，叠加成同一个现象）**

1. **卡片轮询永远在 `poll(null)`**（`src/client.js`）。`start()` 里用
   `setInterval(() => poll(sessionKey), 1000)` 启动轮询，而该闭包捕获的是**本次渲染**的
   `sessionKey` —— 此刻仍是 `null`（`setSessionKey` 只排程下一次渲染，不会改写已捕获的变量）。
   于是每一秒都调 `poll(null)`，宿主 `logins.get(null)` 未命中并抛 `RemoteError("no_login")`，
   而轮询体的 `catch { /* transient poll failure: keep going */ }` **把它静默吞掉**：界面永远停在
   二维码页，扫码结果无人处理。`git log -S setInterval -- src/client.js` 只有引入那一笔
   （`544538c`），即这个循环**从来没有成功过一次**；历史 transcript 里 `"status":"confirmed"` 出现
   **0 次**，与此互证。CLI（`bin/login.js`）一直正常，所以账号是 10-13 用 CLI 绑上的。
2. **`get_qrcode_status` 是 30 秒长轮询**（实测三次分别为 30065/30076/30159 ms），因此 1 秒
   `setInterval` 会在 30 秒内堆积约 30 个悬挂请求。固定间隔本身就不成立的形状。

**附带缺陷（推断，非本次实测观测）**：`binded_redirect` 被当成硬失败。证据边界要说清楚 ——
缺陷 1 使卡片**根本没有调用过状态端点**（`poll(null)` 在本地就抛错了），所以「服务端这次回了
`binded_redirect`」**没有被观测到**，它是从 vendor 源码推断的：退出登录只删本机凭证（iLink 无服务端
解绑接口），服务端仍认为该机器人绑定在本机，vendor 对 `binded_redirect` 的处理是「幂等成功」而那只在
**本机仍持有 token** 时成立。旧 token 已实测失效
（`getconfig` → `{"errcode":-14,"errmsg":"session timeout"}`），所以本机没有任何恢复路径。
这一支现在有了自己的状态与日志，下次真的遇到时会被记录成事实。

**修复**

| 位置 | 改动 |
| --- | --- |
| `src/client.js:491-495` | 新增 `sessionKeyRef`（`:494`）：轮询读 ref，不再闭包捕获 render 期 state |
| `src/client.js:532-593` | `setInterval` → 自调度 `tick`（`:538`；`:590` 一次长轮询返回后才排下一次；`:593` 启动） |
| `src/client.js:559-565` | `failed` 分支补 `refreshStatus()` |
| `src/client.js:566-574` | 新增 `alreadyBound` 分支 → `phase:"blocked"` + `refreshStatus()` |
| `src/client.js:577-586` | `catch` 区分 `err?.code === "no_login"`（`:580` 终态 + 提示重新扫码）与真正的瞬时错误（继续轮询），不再静默吞错 |
| `src/client.js:702, 784-788, 790` | 按钮区（`:702`）与 notice（`:784-788`）支持 `blocked` 相位；caption 排除该相位（`:790`） |
| `src/login-remote.js:167-184` | `binded_redirect` → 新状态 `alreadyBound`（`:179`）+ 可操作文案（手机端解绑），不再谎称普通失败 |
| `src/login-remote.js:118-120, 130-137, 175-177, 197-200` | 登录生命周期日志（`logger.info/debug` + `redactToken` 脱敏）；此前登录流程零日志，故障完全不可观测 |
| `README.md:95-108` | 新增「退出登录与重新绑定」：说明「未登录」是如实显示、以及手机端解绑才是恢复路径 |

**验证**

- 新增 `test/login-remote.test.js`（7 tests，stub `globalThis.fetch` 驱动真控制器，无网络）与
  `test/client-login-poll.test.js`（5 tests，自带最小 hook 运行时真渲染卡片并驱动定时器）；
- **辨别力实测**：`git stash push -- src/client.js src/login-remote.js` 后两个文件分别
  **5/5 fail** 与 **1 fail（其余 6 pass）**，恢复后全通过 —— 证明新测试钉住的是真缺陷；
- 全量 `node --test "test/**/*.test.js"` → **tests 178 / pass 178 / fail 0**（原 166）；
- 真端点探针（隔离 state/log 目录，经修复后的 `WeixinLoginController`）：`startLogin` 323ms 拿到真实
  二维码；两次 `poll` 各 30056/30073ms 返回 `wait`；日志落下三行
  `weixin login: QR issued … / polled status=wait …`，token 已脱敏。

**当日结论（尚未收拢）**：修复后设置页扫码流程本身可用，但**它能否帮这位用户恢复绑定仍未验证** ——
需要用户在手机上实际操作一次。若服务端确实回 `binded_redirect`（推断，见上），唯一恢复路径是
**先在手机微信里解除该机器人的绑定**；本机侧已排除的免解绑路径：旧 token 失效、`force` 只管本地二维码
缓存、服务端不下发新凭证。修复后这一支会写下
`weixin login: server refused a new credential (binded_redirect) …`，届时以日志为准。

## 2026-10-15 — 登录成功之后，微信仍显示「无法连接 openclaw」（已修复）

用户在设置页扫码成功（卡片显示「已绑定」）后，手机微信仍然提示「暂时无法连接 openclaw」。
这不是登录失败，而是**收消息的那条循环从未启动**。

**根因（两条，独立）**

| # | 缺陷 | 说明 |
| --- | --- | --- |
| 1 | 账号解析只发生一次 | `resolveAccount()` 只在插件加载时调用。全新安装时那一刻**本机还没有凭证**（用户是之后才扫码的），于是 effect 直接 return，入站 `getUpdates` 长轮询永不启动。凭证后来才落盘，但没有任何机制会重跑解析 → 手机显示「已绑定」、卡片显示「已绑定」、本机却没有任何轮询。 |
| 2 | `getConfig` 永远拿不到 typing ticket | transport 发 `ilink_user_id: ''`，服务端答 `{ret:-2,"ilink_user_id required"}`。`getConfig` 不对非零 `ret` 抛错、调用方只找缺失的 `typing_ticket`，于是整个失败是**静默**的：没有 typing indicator，且不带 context_token 的回复失去了回退 token。 |

**实测证据（缺陷 1）**

- 宿主 pid 24737 启动于 `2026-10-15 07:24:13`，凭证 `accounts/82ddcdd8c61c@im.bot.json`（mtime `07:24:52`）
  晚 39 秒落盘 → 启动那一刻本机账号目录是空的；
- 该进程此后仍活着、从未重读凭证；按 `ilinkai.weixin.qq.com` 的 4 个解析 IP 过滤 `lsof`，
  每 5 秒采样一次、共 40 秒，**始终 0 条连接**（长轮询每次约 30 秒，在跑就必然可见）；
- 走插件启动路径的探针显示：现在解析**能**拿到账号（`RESULT: account resolves with a token — a reload WILL start the inbound loop`）；
- 按 `src/transport/ilink.js` 的调法打真实 `getupdates`：`#1 ms=627` 返回**一条真实未投递消息**
  （`from_user_id` 正是白名单里的 `o9cq804qN9Kjha_YsRWQwG8hWo3I@im.wechat`，`to_user_id` = 新 bot id）。
  → 凭证完全可用，只是没人去取。

**实测证据（缺陷 2）**

| 请求 | 响应 |
| --- | --- |
| `ilinkUserId: ''`（transport 原先发的值） | `{"ret":-2,"errmsg":"ilink_user_id required"}` |
| `ilinkUserId: <真实 userId>` | `{"ret":0,"typing_ticket":"AARTBK8FAAABAAAAAAC752zki…"}` |
| 伪造 token（对照组） | `{"errcode":-14,"errmsg":"session timeout"}` |

→ `ret:-2` = token 被接受（该请求只是缺参数）；`errcode:-14` = token 被拒。新凭证有效。

**修复**

| 位置 | 改动 |
| --- | --- |
| `src/index.js:201-222` | 抽出 `setup`：cwd / `AgentBridge` / `AsrBridge` 与账号无关，建一次、重绑时复用 |
| `src/index.js:230-321` | 抽出 `bringUpLoop()`：解析账号 → 建 transport → 换掉旧 transport → `start()`；不再只跑一次 |
| `src/index.js:281-284` | 去重守卫：账号与 token 都没变时只记一行 `is already being listened to`，不抖动连接 |
| `src/index.js:308-317` | **先停后启**：同一凭证两条长轮询会把入站队列**分摊**（服务端给先到的那个），必须在 `start` 之前 `stop` |
| `src/index.js:327-334` | `startLoop()` 用 `handoff` 串行化交接，避免两次登录并发交接留下两条循环或零条 |
| `src/index.js:340-343` | `onAccountBound` 挂到登录控制器上，登录成功后自动起循环 |
| `src/index.js:245` | transport 新增 `userId: account.userId`（缺陷 2 的接线） |
| `src/index.js:348-353` | disposer 里清掉 `onAccountBound`（仅当仍指向本闭包），避免指向死掉的循环 |
| `src/transport/ilink.js:217` | `this.userId = options.userId?.trim() \|\| undefined` |
| `src/transport/ilink.js:441-461` | `refreshConfig()`：无 userId 时**不再发注定被拒的请求**，改为记一行；非零 `ret` 时把 `ret/errmsg` 写进日志，失败不再静默 |
| `src/login-remote.js:100` | 新增普通属性 `onAccountBound`（注释说明为何不能用 `#private`：宿主经 Proxy 调用 Remote 方法） |
| `src/login-remote.js:217-226` | `confirmed` 分支写入凭证后触发 `onAccountBound()`，失败只记日志不影响登录结果 |
| `README.md:114-129` | 「退出登录与重新绑定」补一条：扫码成功后**不再需要重载 DSH** |

**验证**

- 新增 `test/inbound-loop-start.test.js`（4 tests，假 iLink 服务器 + 一次性 state root，无网络、不碰真实凭证）：
  1. 加载时无凭证 → 0 次轮询且日志写明原因；`onAccountBound()` 后循环起来并打印 `listening as account`；
  2. 重绑到新凭证 → 新循环起来、旧 transport 停掉（断言旧服务器的 `getUpdates` 不再增长）；
  3. 同一凭证重复触发 → 只记 `is already being listened to`，不重建连接；
  4. transport 带 operator id → `getconfig` 收到真实 `ilink_user_id`，`sendtyping` 拿到 `TT`；
     无 id 时**根本不发**该请求。
- **辨别力实测**：`git stash push -- src/index.js src/transport/ilink.js src/login-remote.js`
  后跑该文件 → **4/4 fail**；恢复后 4/4 pass。
- 全量 `node --test "test/**/*.test.js"` → **tests 182 / pass 182 / fail 0**（原 178）。
- **真端点探针**：以「加载时无凭证」的真实状态启动插件（真实凭证复制到隔离 state root），
  `onAccountBound()` 后 **413ms / 807ms** 两次都打印
  `dsh-weixin: listening as account 82ddcdd8c61c@im.bot`，且全程未重载 → 修复在真实服务端上成立。
- 端到端 canary（登录 → 退出登录 → 重扫码 → 连接可用）走完，服务端观测到**新 token** 的轮询，
  重复触发不抖动连接。

**当日结论**：本机侧的两条缺陷都已修复并验证。用户侧现在的状态是：**重启 DSH 一次**让新代码生效，
此后扫码即可自动开始收消息，不再需要「扫码 → 重载 → 才通」。

## 2026-10-15（续）— 扫码成功、循环也修好了，微信依旧说连不上（已修复）

上一条修复上线并重启后，用户复现（其原话）：重启后扫码显示已登录，手机微信仍提示无法连接 openclaw
（m01711）。

**根因（第三条，与上一条相邻但独立）**：`ctx.plugin()` 被喂了一个 **Cordis Service 实例**。

`src/index.js` 原先是这么接线的：

```js
loginController = new WeixinLoginController(ctx, {})
ctx.plugin(loginController)   // ← 必然抛错
```

`Service` 的**构造函数本身**就完成了注册（基类在构造里调 `ctx.reflect.provide(name, self, ...)`），
实例立刻能从 context 上取到。再把它交给 `ctx.plugin()` 则是错的：插件必须是函数、或带 `apply` 的对象，
而 Service 实例两者都不是，于是真 Cordis 抛

```
invalid plugin, expect function or object with an "apply" method, received object
```

**为什么它一直没被发现**：这行抛错**恰好被紧随其后的 `try/catch` 吞掉**，只记一行
`settings login service unavailable: ...`，然后把 `loginController` 置为 `undefined`。于是——

- 循环起来了（上一条的修复有效）、卡片正常渲染、扫码也真的写出了凭证；
- 但**没有任何控制器在听「登录已完成」这个事件**，`onAccountBound` 从未被回调，
  入站循环不会切到新凭证 → 手机侧看到的仍然是「无法连接 openclaw」。

`asrController` 是同一模式的第二个受害者（`:179` 附近的同一段 try），表现为**整个 ASR 服务静默失效**。

**修复**

| 位置 | 改动 |
| --- | --- |
| `src/index.js:168` | 删掉 `ctx.plugin(loginController)`；把「构造即注册、绝不可再传给 `ctx.plugin()`」写成长注释 |
| `src/index.js:184` | 删掉 `ctx.plugin(asrController)`，同因 |
| `test/host-wiring.test.js` | 新增 3 条接线测试（下详） |
| `test/inbound-loop-start.test.js` | 补强：假 iLink 服务器现在**校验** `ilink_user_id`，缺了就答 `{ret:-2}`，让缺陷 2 可被断言 |
| `README.md:120-137` | 「扫码成功后不需要重载 DSH」补一条排查顺序，把「卡片已绑定但微信说连不上」指向这一根因 |

**实测证据**

- **真 Cordis 探针**（临时 `probe-real-cordis.mjs`，`new Context()` + 假 iLink http server）：
  修复前只打出一行 `settings login service unavailable`，`onAccountBound` 后**无任何** `listening as`
  日志；删掉那行后，同一条探针在 `onAccountBound()` 后打印 `listening as account ...`。
- **缺陷来源考古**：`git log --oneline -S "ctx.plugin(loginController)" -- src/index.js` 只命中
  `68d047c fix(transport): treat a non-zero errcode as a failure`（2026-10-14 20:38）——即该行是
  在那次「把接线塞进 try」的重构里被引入的，与登录/循环两条修复无关。

**为什么旧测试没抓住（教训，已写进测试注释）**

原 `makeCtx()` 把 `plugin(x)` 实现成「记录下来」而不是真跑。这是**假宿主**：真 Cordis 会在这里抛错，
而假宿主照单全收，于是「抛错被 catch 吞掉」这条路径在测试里根本不存在。凡是包在 `try/catch` 里的接线，
其测试替身都必须复现**真实宿主会抛错的那一面**。`test/host-wiring.test.js` 因此改为让 `plugin()`
抛真 Cordis 的那条错误，并断言：

1. `plugin(<Service 实例>)` 抛 `invalid plugin, expect function or object with an "apply" method`；
2. 该错误**不得**出现在 `settings login service unavailable` 里（即控制器没被击落）；
3. 登录完成后 `onAccountBound()` 仍被触发。

**辨别力实测**：把两行 `ctx.plugin(...)` 加回去（`git stash` 恢复旧 `src/index.js`）→ `host-wiring` **3/3 fail**；
删掉后 3/3 pass。

**验证**

- `node --check src/index.js` 通过；全量 `node --test "test/**/*.test.js"` →
  **tests 185 / pass 185 / fail 0 / duration 9493ms**（原 182，新增 host-wiring 3 条）。
- 退出登录 → 重扫码 → 连接可用的端到端 canary 已走完（承接上一条的 canary，本机侧全链路可用）。

**遗留**：`README.md` 的 ASR 一节仍按「服务在设置页可用」描述；本次修复顺带把它修好了，
但**未做**针对 ASR 的独立验证（只断言了控制器不被击落）。

**部署核查（重要，别再犯）**：修复在仓库里并不等于修复在这台机器上。本次修复完成时，
`~/.dsh/profiles/desktop/node_modules/dsh-plugin-weixin/src/index.js` 仍带着
`:158 ctx.plugin(loginController)` 与 `:173 ctx.plugin(asrController)` ——
**用户当时运行的正是这个副本**，所以「源码已修 + 用户已重启」依然复现。
`node bin/install.mjs --profile desktop` 之后两份 SHA-256 一致
（`f868b5a4…`），据此才算部署完成。核对方式：

```bash
shasum -a 256 ~/.dsh/profiles/desktop/node_modules/dsh-plugin-weixin/src/index.js \
              src/index.js          # 两行必须相同
```

**核对凭证是否有效的正确姿势（我在此处曾误判）**：手写一个 `getconfig` 请求体
（只带 `ilink_user_id` + `bearer`）对**有效**凭证会答 `{"errcode":-14,"errmsg":"session timeout"}`，
看上去像「登录已过期」。真正的原因是缺 `base_info`。同一个凭证走插件自己的
`getConfig`（`vendor/openclaw-weixin/api/api.js`，带 `buildBaseInfo()`）答
`{"ret":0,"typing_ticket":"AART…"}` = **有效**。所以判凭证必须用插件自带的 helper，
不要手搓请求体——否则会给用户一个理直气壮的、错误的「请重新扫码」。
（`getconfig` 不消费入站队列，只有 `getupdates` 会，因此这个检查不抢消息。）

**真宿主复现脚本**（`/tmp/wxprobe8/real-host.mjs`，非仓库文件）：用**真** `@deepseek-ai/cordis`
的 `Context` 加载**已部署**的副本，扫描落盘后调 `onAccountBound()`，断言日志出现
`listening as account <id>` 且**没有** `settings login service unavailable`；对修复前的副本
（`/tmp/deployed-weixin-backup-*`）则失败并打印出那句被吞掉的
`invalid plugin, expect function or object with an "apply" method, received object`。
注意 cordis 的 logger 默认 exporter `level: 1` **会丢掉 warn(2)/debug(3)**——
正是本缺陷产生的日志级别，捕获时须显式 `levels: { default: 3 }`。

## 2026-10-15（续）— 测试污染了操作者日志，且把「无日志」误当成「无请求」（已修复）

排查上面三条缺陷时，有一条线索把我带偏过：为确认入站循环是否在跑，我 grep 了操作者日志里的
`getupdates`，得到 **277 条命中**。看上去证据确凿，实际**一条都不是真的** —— 全是 `node --test`
的流量。它们是本机回环地址（`http://127.0.0.1:<port>`），只有端口号能泄底。

**根因**：vendor logger 在 `vendor/openclaw-weixin/util/logger.js` 首次 import 时**一次性地**
解析日志目录，默认 `~/.dsh/weixin/logs/openclaw-YYYY-MM-DD.log`，也就是操作者排查「微信不回消息」时
真正会读的那个文件。只有两个测试文件自己重定向了目录，其余文件全部把测试流量追加进了真日志。

**量化**（逐文件比对前后字节数）：

| 测试文件 | 追加字节 |
| --- | --- |
| `test/e2e.test.js` | +5378 |
| `test/outbound-media.test.js` | +1637 |
| `test/markdown*.test.js` | 少量 |

一次全量运行约 **+8 KB**。危害不是「不整洁」，而是**证据被污染**：这正是本次排查的失败模式。

**修复**：新增 `test/isolate-vendor-log.mjs`，由 `package.json` 的 `test` 脚本用 `--import`
在**每个** `node --test` 子进程加载任何测试文件**之前**执行（`--import` 而非 `--require`，因为
它是 ESM），把 `DSH_WEIXIN_LOG_DIR` 指向每个进程独立的 mkdtemp，并在 `process.on('exit')` 清理。
放在这里而不是各测试文件里，是为了让**新写的测试无法因为忘记 opt-in 而重新泄漏**；需要读日志的
测试仍可自己设 `DSH_WEIXIN_LOG_DIR` 再读回（`test/login-remote.test.js`、
`test/inbound-loop-start.test.js` 就是这么做的）。

**验证**：修复后跑 `npm test`，操作者真实日志字节数 **310296 → 310296，零增长**。

## 2026-10-15（续）— 偶发红：`setTypeOfService EINVAL`（已修复）

现象：全量运行偶尔 `tests 186 / pass 185 / fail 1`，失败的是**整个**
`test/inbound-loop-start.test.js`（不是其中某条），报

```
Error: A resource generated asynchronous activity after the test ended.
```

附带的错误是 `Error: setTypeOfService EINVAL`（`node:net` → `Socket.setTypeOfService`），
从 undici 的 `writeH1` 抛出。**约每 20 次跑出 1 次**，且与被测代码无关——这类红最消耗信任。

**根因**：`test/inbound-loop-start.test.js` 的 re-bind 用例在**它自己体内**关掉了第二个假服务器
（`finally { await closeServer(second.server) }`），而那一刻传输层**正在对它做长轮询**。
`closeAllConnections()` 在客户端写到一半时销毁 socket，undici 便在自己的写入路径上炸了。

**修复是顺序问题，不是强度问题**：把关闭推迟到**插件 dispose 之后**。`withPlugin` 现在持有
一个 `servers` 数组，测试启动第二个服务器时调 `registerServer(second.server)` 登记，
统一在 `finally` 里**先 dispose、再关闭**。此时传输层已停止，不再有 in-flight 写入。

**同时修掉 3 秒 teardown**：`server.close()` 只停止接受新连接，已 park 的 keep-alive socket
会一直吊着回调。原先的 `closeIdleConnections()` 仍会漏掉「关闭那一刻长轮询还在飞行中」的
socket——响应几毫秒后才落地，那时已经没有东西去回收它了（试过用定时器反复回收：能work，但
**哪个用例卡住每次都不一样**，不是确定性修复）。改为 `closeAllConnections()`：因为顺序已经
正确，激进销毁是安全的。

| | 之前 | 之后 |
| --- | --- | --- |
| 本文件耗时 | 6679ms | ~700ms |
| re-bind 用例 | 3017ms | 177ms |
| 30 次连跑 | — | **30/30 pass，EINVAL 0 次** |

**教训**：`--test` 把「测试结束后仍有异步活动」归到**整个文件**上，看不出是哪条用例——所以
定位靠的是 `--test-timeout` + 流式输出（能看出是哪条挂住），以及给 `closeServer` 加计时打印。
另外：那次「挂住不返回」的直接原因是**我自己的编辑错误** —— re-bind 用例的回调忘了从参数里
解构 `registerServer`（`ReferenceError`），而它发生在第二个服务器创建**之后**，于是那个监听句柄
再也没人关，事件循环永远不空。**报错发生在资源获取之后，就等于资源泄漏。**

## 2026-10-15 — the archived-session gate ate the replies (fixed)

The last of the four stacked defects behind "scan, login, typing bubble, but
never a reply": the DSH host's `ArchivedSessionGate` rejects every pre-step of
an archived session, so a turn ends `blocked` 25ms after it starts — the
message was received, typing was shown, and nothing else ever happened. The
WeChat conversation id had landed in `~/.dsh/storages/workspace.json`
`global.archivedSessionIds` (GUI state, not written by this plugin).

Fixes shipped:

- `001f2bf` — `attach()` now lifts the session out of the archive set
  (best-effort, via `workspaceRegistry.unarchiveSession`) so a GUI-side
  archive can never silently kill the bot; the manual removal of the id is
  preserved as `workspace.json.bak-unarchive` on the operator's machine.
- `4e9fa8a` — the schemastery schema instantiates every field, so a
  composition that never mentions `allowedSenders` still arrived as `[]` and
  spread-merge let that default erase the operator's saved allowlist; the
  refusal (surfaced only after `89a2145` added the file-log line with the
  sender and the full allowlist) showed `allowedSenders=[]` while config.json
  listed exactly one id. Merge rule: a non-empty saved allowlist always wins
  over an empty composition value.
- `89a2145` — allowlist refusals, duplicate skips and settled turns are now
  also written to the vendor file log, so "the bot ignores me" is always
  greppable.

## 2026-10-15 — first marketplace release (dsh-plugin-weixin@0.1.0)

Published to npm (the registry DSH's plugin page installs from), as
`dsh-plugin-weixin@0.1.0` — the same tree the operator's desktop profile runs
(verified: all four core files SHA-256 identical between the published tarball
and the deployed copy).

Publish path and its one human step:

- The npm CLI's OTP browser flow cannot be driven from a captured (non-TTY)
  shell: `npm publish` prints the auth URL masked as `***`. So publishing is a
  two-party routine: the agent bumps the version, prepares and verifies
  everything, then the OPERATOR runs `npm publish` in a real terminal and
  approves the browser prompt.
- A `0.0.0-stage` placeholder was briefly created while grabbing the name;
  publishing 0.1.0 as the same account superseded it (`latest` now points at
  0.1.0). Re-running publish after a success fails with "cannot publish over
  the previously published versions" — that error means the earlier run won.
- Pre-publish gate (every future release): full suite green, stash-proven
  discriminating tests, real-endpoint verification, `bin/install.mjs` redeploy
  + SHA-256 check, then bump the version — never republish over an existing
  one.
- Post-publish verification performed: `npm view` (latest = 0.1.0, integrity
  matches the local `npm pack`), fresh `npm install dsh-plugin-weixin` into a
  scratch directory (9 deps resolved, 0 vulnerabilities), tarball copy vs
  deployed copy hashes.

## 2026-10-15 (late) — dsh-im study port: five features (0.2.0)

Studied `/tmp/dsh-im` (github.com/xmanrui/dsh-im) and ported the features that
fit a WeChat channel, one task at a time, each with discriminating tests
(stash the fix → new tests must fail), full suite green, desktop redeploy +
SHA-256 check, independent commit:

- `477b336` **T1 busy queue/steer** — a message arriving mid-turn used to be
  refused; now it is queued by default (caller gets a receipt, and the queued
  entry resolves with its own real reply) or steers the running turn
  (`busyMessageMode: "steer"`). `/steer <instruction>` always injects.
  `src/agent-bridge.js` `deliver()` gained `busyMessageMode`; `record.queue[]`
  holds entries. Test harness lesson: register the release timer BEFORE
  awaiting the drain, or the interval wins the race after completion.
- `43223c7` **T2 late delivery** — a turn that outlived the wait printed
  "processing timed out" and DROPPED the eventual answer. Now the wait keeps
  listening (normal cadence, capped by `lateReplyMaxWaitMs`, default 60min)
  and hands the final text to `onLateReply`: an immediate notice, then the
  real answer with a FRESH typing ticket (the original context_token is
  one-shot — reusing it is rejected by the server). `deliver()` resolves
  `{text:'', sessionId, late:true}` so the caller skips the normal send.
- `4dca924` **T3 sourceContext** — optional (default off) config; when on,
  every prompt is prefixed with a single-line self-closing
  `<weixin_source channel="weixin" senderId=… conversationId=… kind=…
  timestamp=… />` (`weixinSourceBlock(message)`, exported for tests).
  Timestamp uses `toISOString` — in tests expect UTC, not local.
- `81ee282` **T4 settings tabs + atomic saves** — the settings card is a real
  tablist (role=tab/tablist, aria-selected, ArrowLeft/Right) instead of one
  long scroll; the download-source and proxy radios no longer write on every
  click — they stage, and one Save/Reset bar writes the pair in a single
  `setDownloadSettings(endpoint, proxy)` call (Reset re-reads host truth).
  The instant-clear path (`setProxyInput(""); saveProxy("")`) must stay dead —
  it is the stale-closure bug class.
- `a7fb8d0` **T5 icon** — WeChat-green rounded square + white speech bubble,
  512/128 in `assets/`, wired as the package `icon` field.
- `fce3f9a` **fix**: the icon field pointed at `assets/` which neither the npm
  `files` list nor the installer's `COPY_ENTRIES` carried → the host's
  metadata reader died with ENOENT (`lstat .../assets`) on the deployed copy.
  Rule: anything the manifest points at must be in BOTH shipping lists.
- `0f99885` **settings.section entry** — the card is hoisted to a named
  function shared by two registrations: the plugin bundle page
  (`plugins.bundle.config`) and the shell Settings nav
  (`settings.section`, order 22, after dsh-im's 21, locale-thunk label
  `t("WeChat","微信")`). Test contracts updated accordingly
  (`client-login-poll` now expects 2 seats).
- Flake fixed in passing: `test/e2e.test.js` built the log filename from the
  UTC date while the vendor logger uses the LOCAL date — every run in the
  00:00–08:00 CST window failed. Mirror the logger's local date key. Lesson:
  a date-key assertion must use the same timezone source as the code under
  test.

## 2026-10-16 — release 0.2.0 and the profile-pin regression

- `1473cdb` + tag `v0.2.0` + GitHub release. npm publish again needs the
  operator's terminal for the OTP browser flow (same as 0.1.0; the tarball is
  prepared and verified by the agent first).
- **Why the desktop copy kept regressing on restart**: the profile's
  `package.json` pinned `dsh-plugin-weixin:
  file:../../../../../tmp/dsh-plugin-weixin-0.1.0.tgz` — a file dependency on
  the day-one tarball. Every DSH start reinstalls from the manifest+lockfiles
  and overwrote whatever `bin/install.mjs` had placed. Fix: point
  `package.json`, `package-lock.json` AND `pnpm-lock.yaml` (all three!) at the
  0.2.0 tarball; keep a `.keep` backup of the tarball because `/tmp` is
  cleaned. Future releases must update all three references (or switch the
  dependency to the npm registry version instead).
- Marketplace entry (awesome-dsh-plugin PR #7426) is CI-green and
  conflict-free but awaits a maintainer merge; the dsh-market search reads
  the generated `dsh-plugin-catalog` package, which only refreshes after
  merge. A polite ping comment was left on the PR.

## 2026-10-16 — 自带 ASR 桥：语音识别不再要求用户自己写服务端

**背景**：此前 README 明确写「本仓库不含 ASR 服务端」，用户必须自己写一个行协议子进程才能把语音
变成文字。用户要求把这部分做进插件里，方便别人下载后直接用（m05803）。

**新增 `bin/asr-bridge.py`**（随 npm `files` 与安装器 `COPY_ENTRIES` 一起分发）：

- 实现既有的行协议（stdin `{"wav":"…"}` → stdout `{"ok":true,"text":"…"}`）；
- **双引擎**：优先 `mlx-whisper`（Apple Silicon GPU），否则 `faster-whisper`（CPU，跨平台）。
  引擎各自的模型格式不同（`weights.npz` vs `model.bin`），所以候选目录按引擎分别列举——
  实测把 CTranslate2 目录喂给 mlx 会在转写时抛 `expected str, bytes or os.PathLike object,
  not NoneType`；
- **从磁盘离线加载**：设置页下载的模型直接可用，不发网络请求。这一条是刻意的——
  `huggingface_hub` 的元数据探测（到 CDN 重定向的 HEAD）在 hf-mirror 上以
  `SSLEOFError: UNEXPECTED_EOF_WHILE_READING` 失败，而同一个 URL 的普通 GET 正常
  （curl 实测 483MB/17s）。绕开元数据探测比修镜像可靠；
- **简体输出**：whisper 对中文默认输出繁体。默认初始提示词是一句普通话样本，
  实测把 `今天天氣不錯` 变成 `今天天气不错`；
- **非语音返回空**：纯音调会让 whisper 编内容（实测出现 `字幕by索兰娅` 这种字幕署名）。
  mlx 路径用 `no_speech_threshold` + 逐段 `no_speech_prob` 判定，faster 路径用 `vad_filter`。
  空是诚实答案，插件会转成「没听清」；
- **stdout 纯净**：CTranslate2 加载时从 native 层往 fd 1 打 MKL 弃用横幅，Python 层拦不住，
  所以在那段窗口把 fd 1 指向 fd 2；mlx 的 tqdm 进度条用 no-op 的上下文管理器替掉
  （直接返回 `None` 会崩在 `with tqdm.tqdm(...)`）；
- **错误截断**：ffmpeg 解码失败会把整段构建信息塞进异常（数百行），截到首行 300 字符。

**插件侧**：`resolveAsrSettings` 增加 `cwd`（默认插件包目录）——`args: [bin/asr-bridge.py]`
是相对路径，不设 cwd 就会按宿主启动目录解析。`#ensureChild` 把它传给 `spawn`。

**实测数据**（M4，3.7s 音频，whisper-small）：

| 路径 | 热调用 | 说明 |
| --- | --- | --- |
| mlx-whisper（arm64 env，GPU） | **0.29s** | 快 18 倍 |
| faster-whisper（x86_64 conda，Rosetta CPU） | 5.3s | 慢，但任何平台都能跑 |

Rosetta 那一档是本机环境造成的（conda 是 x86_64 构建），不是代码问题；桥本身只是两个引擎都支持。

**踩到的环境坑**（都不是本仓库的 bug，但会让用户以为桥坏了）：

- `mlx` 0.32.1 的 wheel 缺少 `mlx.metallib`，任何矩阵运算都抛
  `Failed to load the default metallib`；`--force-reinstall` 到 0.32.4 解决；
- `DSH_WEIXIN_ASR_MODEL` 被 `resolveAsrSettings` 写成**模型根目录**（设置页逻辑），
  而手写配置时它是**尺寸名**（`small`）。桥现在两者都认：值是已存在目录就当根目录。

**测试**：`test/asr.test.js` 24 条（+5）。新增覆盖 `cwd` 解析与实际 spawn 目录、
自带桥真的存在且可执行、协议三种非法输入、stdout 每行都是 JSON、以及平台默认 repo
不能硬编码 mlx。全量 **203 pass**。

## 2026-10-16 — 一键发布脚本 `bin/release.mjs`

**诉求**：用户要「一键提交和发布的脚本，后续自己执行上线发布」。

**为什么不是一行 `npm publish`**：把此前几次手工发布做过的事逐条列出来，发现每一步都至少
失败过一次，且失败只在事后才看得见 —— 先发布后改版本号、npm 还在处理上传时就去查 registry
（读到旧版本，误判为失败）、给没推上去的提交打 tag、上传的 tarball 里少了 `bin/`。脚本把
「实际跑通的顺序」固化下来。

**执行顺序**：预检 → `npm test` → 改 `package.json` 与 README 版本行/版本列表 → `npm pack`
并检查文件清单 → **在临时解压目录里真跑一次 `bin/asr-bridge.py`** → 提交 → `npm publish`
→ 轮询 registry 直到版本可见 → 比对 `dist.shasum` → 打 tag/推/GitHub Release → 本机安装。

**这次顺手查出的真实漂移**（不是假设）：

- **`0.3.0` 已发布但从未打 tag**。于是 `git describe --tags --abbrev=0` 还指向 `v0.2.0`，
  下一次发布的 Release Notes 会把 ASR 桥那批工作当成新内容再报一遍。已补 `v0.3.0`
  并建对应 GitHub Release；`0.1.0`/`0.1.1` 同样漏打，一并补上（`0.1.0` 是 `2405fd5`，
  `0.1.1` 是 `751e18e`）。`0.0.0-stage` 是当初试发布管线的产物，本就不该有 tag，
  预检按 prerelease 跳过 —— 否则每次跑都报一条真警告，会训练出「看到就忽略」的习惯。
- 补 tag 后 GitHub 把 `Latest` 徽标挪到了 `0.1.1`，已 `gh release edit v0.3.0 --latest` 拨回。

**脚本自身测出并修掉的两个 bug**：

1. **`--dry-run` 说「工作区未改动」却真的改了** `package.json` 与 `README.md`。改为先快照这两个
   文件、跑完真实 bump+pack 后还原并删掉 tarball；实测跑完 `git status --porcelain` 为空。
2. **确认提示在真终端里必然失败**：原来是 `sh -c 'read line; ...'` 且没接 stdin，`read` 在
   stdio 继承下仍从**管道**读，stdin 在 EOF → 直接 `aborted`，而操作者明明就在终端前。
   改为 `spawnSync(..., { stdio: ['inherit','pipe','inherit'] })` + `read -r line </dev/tty`。
   用 `script -q /dev/null` 造真 pty 实测：答 `n` → `aborted (answer "y" to release)`，且未进入
   测试步骤；答 `y` 才继续。另外 Release Notes 改为**在改版本号之前**生成，否则会把
   `chore(release)` 提交自己也算进去。

**验证**：`npm test` 全量 **203 pass**；`--dry-run` 端到端跑通（57 files、836 kB、桥冒烟通过）；
预检的六道关卡逐条手工触发确认（无版本号 / 非法版本号 / 脏工作区 / 未同步 origin /
已发布版本 / 未登录 npm），其中「已发布版本」是靠先 staging 脚本制造脏工作区反向确认的。

### 后续：脚本自身又查出两个真问题

**1）文件权限被带进了 tarball（真实缺陷，已修）**

比对 `npm pack` 出的 tarball 与 registry 上 `0.3.0` 的 `dist.shasum` 时对不上，
本以为「npm 打包不可复现」，实测**同一份源码连打两次 sha1 完全一致**。真正原因在
`tar -tvzf` 的权限位：

```
本地：-rw-r--r-- … package/LICENSE      （644）
线上：-rw------- … package/LICENSE      （600）
```

git 只记录「是否可执行」，**不记录 600 还是 644**；`npm pack` 读的是**文件系统**。
本机 umask 导致 39 个已跟踪文件是 600（含 `LICENSE`、`THIRD-PARTY-NOTICES.md`、
`src/` 大部分），这些权限原样进了 tarball —— 用户装下来是**别人读不了的文件**。
已全部改为 644（可执行文件 755），并在 `buildAndVerify` 里读 tarball 自己的权限清单，
发现非 world-readable 就**中止发布**。辨别力实测：把 `LICENSE` 改回 600 → 立即报
`1 file(s) in the tarball are not world-readable` 并 exit 1。

**2）失败时 `finally` 被跳过（已修）**

`die()` 原本调 `process.exit(1)`，会**跳过 finally**：于是一次**失败**的预演会把
版本号改动留在工作区 —— 正是预演要防的事。改为 `die()` 抛错、全局 `cleanup` 钩子
先跑、顶层 catch 设 `exitCode`。实测：`LICENSE` 设 600 后跑预演 → 报错、退出码 1、
`git status --porcelain` 为空；正常路径的 abort（无版本号 / 非法版本号 / 已发布版本）
同样 exit 1 且不打印堆栈。

**最终验证**：全量 **203 pass**；预演端到端跑通（57 files / world-readable / 桥冒烟通过 /
838 kB）；预演结束与预演失败两种情况都确认工作区干净、无残留 `.tgz`。

---

## 一个微信会话可以用多条 DSH 会话（会话线）

**要解决的问题**：一个微信会话只对应一条 DSH 会话，上下文只增不减。用户要的是
「能发消息新建/切换会话，并在配置设置里管理用哪个」，且**切换必须是保留的**：
切走的那条不能被结束或清空，切回来上下文原样都在。

### 设计：会话线，第一条沿用历史 id

`src/sessions.js` 是唯一的存放处。一个会话的条目形如
`{ lines: [{sessionId, title?, createdAt?, lastUsedAt?}], active: "<sessionId>" }`。

`baseSessionIdFor(conversationId)` = `weixin-<conversationSlug>`，**这条必须是历史 id**：
升级前的老会话就是它，换成新 id 等于用户装上新版本后上下文凭空消失。新会话线是
`<base>--<base36 时间戳><6 位随机>`。实测确认升级后 `lines.active()` 仍返回历史 id。

### 三个真 bug（都是探针跑出来才暴露的，读代码看不出来）

1. **标题永远不出现**。`title()` 读 `this.store[conversationId]`，而新会话**根本没有条目**
   ——`list()` 是按默认值合成的、不落盘。于是第一条消息设的标题被静默丢弃。修法：
   `title()` 里**物化**条目。
2. **`/new` 会把新会话线永久钉成「无标题」**。原先 `create()` 后顺手 `title(..., '')`，
   而 `title()` 对已存在标题直接返回 → 占位标题挡死了真标题。修法：`/new` **不设标题**，
   「尚无对话」由渲染层兜底。
3. **切换后 `attach` 仍用旧会话**。`attach()` 原本 `sessionIdFor(conversationId)` 取的是
   固定 id；改为 `#activeSessionId(conversationId)`，并且**在任何 await 之前同步读**，
   这样同一会话的两条并发消息不会对「当前是哪条」产生分歧。

### 命令

`/new`、`/list`、`/use <n>`，只有**整条消息恰好是命令**才生效（`/steer /new`、
`看看 /new 这个命令`、`/newx`、`/use abc` 都不算）。由插件直接回，**不消耗模型对话**：
端到端实测 `/new` 后 `sessionsOpened === []`。序号是**绝对序号**，折叠到最近 10 条时
仍然从 1 数起（`▶ 15.`），不会错位。

### 「测试全绿」曾经完全不能证明这个功能存在

第一次辨别力检验：把 `attach()` 改回 `sessionIdFor(conversationId)`，**227 条全量测试
仍然全绿**——因为 `test/sessions.test.js` 只测 store 这个孤岛，**从没碰过路由**。
补了 `test/session-routing.test.js`（断言 `attach()` 究竟打开哪条会话）之后同样改法
立刻 **3/6 红**；再关掉 `src/index.js` 的拦截，`test/session-commands.test.js` **3/5 红**。
教训：**孤立单测证明不了接线**，必须断言「哪条会话被打开」。

### 设置卡：一个协议陷阱

`ctx.remote.$mount` 的调用会经 `unwrap()` 剥掉 carrier 信封（`{ok, value}`）。
最初宿主 `sessions()`/`useSession()` 返回 `{ok: true, ...}`，而 `unwrap` 的判据是
**「对象里有 `ok` 键」**——于是宿主自己的 `ok` 被当成信封，剥出 `undefined`，
卡片永远空。改为返回**裸值**：`sessions()` → `{conversations}`，`useSession()` →
`{switched, sessionId}` / `{switched:false, error}`。这是协议层的坑，不是笔误。

`test/client-sessions-section.test.js` 用**真的 hook 运行时**渲染卡片（`useState` 真更新、
`useEffect` 比较依赖、`flush()` 会 await 异步 effect）。期间踩到的两个 harness 坑：
槽位**必须按组件分段**（扁平游标会让切换标签后的 `SessionsSection` 读到
`LoginSection` 的值 → `data.map is not a function`），且 `segments` **必须跨轮保留**
（每轮重建会让每个 effect 都像首次运行 → 无限渲染直到 OOM）。

### 验证

- 全量 **246 pass / 0 fail**，连跑 3 次一致；
- 辨别力：把 `▶` 标记去掉 → 「active line is marked」红；去掉切换后的 `load()` →
  「switching … reloads」红；
- 真机路径探针：历史 id 保住、`/new` 开第 2 条、`/list` 标题正确、卡片 `sessions()`
  与切换后的 `active` 一致、越界返回 `{switched:false,error}`、并行保留两条都在；
- **操作者状态目录不再被测试污染**：`test/isolate-host-state.mjs` 现在同时隔离 vendor
  日志目录与 state 根目录（原先只有日志）。根因是 bridge 默认 `lines` 落盘、而
  `stateDir()` 在 `DSH_WEIXIN_STATE_DIR` 未设时回退到 `~/.dsh/weixin`——
  `test/busy-turns.test.js` 的 fixture（`room-1` / `first`）就是这样写进了操作者的真文件。

## 2026-10-16 — 收不到出站图片：相对路径被当成越界

用户报告「我收不到出站图片」。出站媒体这条链路早就有、也有测试，所以先看现场而不是读代码。

### 现场

- 操作者日志里 `sent N outbound media` / `refusing media` **一条都没有**，出站决策完全无痕；
- 真实会话 transcript 里 agent 写的是 `![桌面截图](desktop2.png)` —— **相对路径**；
- 文件确实在盘上：`~/.dsh/weixin/sessions/desktop2.png`（71KB）与 `desktop2.png`（2.4MB）。

### 根因

`resolveAllowedPath`（`src/media/outbound.js`）用 `path.resolve(filePath)` 解析相对路径，
基准是**宿主进程的 cwd**；而 agent 的工作目录是 `~/.dsh/weixin/sessions`。两者不同，于是

- 每个相对引用都落在允许目录之外 → `path is outside the allowed directories` → 拒绝；
- 而 `detectMediaReferences` 明明匹配到了它（我先单独验过：markdown 图片、裸路径单行、
  bullet 内的裸路径都能匹配，代码块与行内代码里的正确忽略）。

对用户来说，「检测器没匹配」和「匹配了但被拒」看起来完全一样：图片就是不来。

### 三个缺陷

1. **相对路径基准错了**（主因）。修法：相对引用按**允许目录**逐个尝试，落在哪个就取哪个；
   含 `..` 的越界判定改读**原文引用**，因为 `path.join(root, 'sub/../../x')` 会先把 `..` 折叠掉，
   之后再判断就永远分不清「爬出去了」和「本来就不在里面」。
2. **缺失文件会遮蔽后面的真实文件**。第一个根里没有该文件时，旧写法直接返回「不存在的候选」，
   于是第二个根里真有的那个永远找不到。修法：`existed: false` 的候选记下来接着找，
   全都没有才把它作为结果返回——这样调用方用准确的「does not exist」拒绝，而不是说谎的越界理由。
3. **出站决策写进了会丢的日志**。`resolveOutboundReply` 的 warn 只走 `ctx.logger`，
   而宿主 exporter 会按配置丢级别；这份日志文件里只有 vendor logger 的行。
   修法：每一次发送/拒绝/异常都同时写 vendor 文件日志（带文件名、字符数、原因）。

### 「测试全绿」曾经完全不能证明这条链路可用

`test/e2e.test.js` 里早就有「a reply that references a local file uploads it and sends an
IMAGE item」并且一直绿——**因为它用的是绝对路径**（`path.join(stateRoot, 'work', 'report.txt')`）。
agent 在真实场景里写的恰恰是相对路径，于是这个测试从一开始就绕开了真缺陷。

### 验证

- 全量 **250 pass / 0 fail**；
- 辨别力：把 `isAbsolute` 改回恒真（旧行为）→ 新增 3 条 `outbound-media` 测试 **3/3 红**，
  新增的 e2e 也红；单独把「缺失遮蔽」改回去 → 只有「resolves inside whichever allowed root」红；
- 真实文件、真实服务端：`desktop2.png`（2,413,739 字节）上传成功
  （`filekey=bcc68285bcd51bd3c555950c5a149ac3 size=2413739`），
  `sendImageMessageWeixin: success`。此前它 100% 走拒绝分支。
- 操作者状态与日志无测试污染：`~/.dsh/weixin/sessions.json` 里只有用户自己的会话线。

### 一个容易踩的坑：item 类型两套枚举

`vendor/openclaw-weixin/api/types.js` 里 `MessageItemType` 与另一套枚举都叫 `IMAGE`，但一个是
`IMAGE: 1`、一个是 `IMAGE: 2`。出站图片的 item 是 `{type: 2, image_item: {…}}`，出站文件才是
`{type: 3, file_item: {…}}`。断言时用 **item 的键名**（`image_item` / `file_item`）比用数字可靠。

## 2026-10-16 — 出站附件都能发哪些：实测与一个 URL 缺陷

用户收到图片后问「我还能收到其他类型的附件吗」。答案不能靠读路由代码给，于是真机试了一遍。

### 三类都通（真服务端）

`sendWeixinMediaFile`（`vendor/openclaw-weixin/messaging/send-media.js`）按 MIME 三分支，
但底下的 `uploadMediaToCdn` 是**同一条**，只是 `media_type` 不同：

| MIME | 上传函数 | 发送函数 | 实测 |
| --- | --- | --- | --- |
| `image/*` | `uploadFileToWeixin`（IMAGE） | `sendImageMessageWeixin` | ✅（desktop2.png 2.4MB） |
| `video/*` | `uploadVideoToWeixin`（VIDEO） | `sendVideoMessageWeixin` | ✅（ffmpeg 真实 mp4） |
| 其他 | `uploadFileAttachmentToWeixin`（FILE） | `sendFileMessageWeixin` | ✅（txt / pdf） |

**扩展名陷阱**：路由按 **MIME** 不按扩展名，而 `getMimeFromFilename` 只认一小撮扩展名。
`.svg` `.heic` `.tif` `.avif` `.m4v` `.3gp` `.flv` `.wmv` 都被判成 `application/octet-stream`，
于是**降级成 file 附件**发出——能到，但不是原生的图片/视频气泡。要原生效果就用
`.png/.jpg/.jpeg/.gif/.webp/.bmp` 与 `.mp4/.mov/.avi/.mkv/.webm`。

出站上限 `DEFAULT_MAX_MEDIA_BYTES = 100MB`（`config.maxMediaBytes` 可调），超了直接拒绝并说明。

### 发现并修掉：URL 被当成不存在的本地文件

`detectMediaReferences` 的 `MARKDOWN_IMAGE_RE` 不看 scheme，于是回复里写
`![示意图](https://example.com/a.png)`（引用网络图，本来就不该上传）会被当成候选路径 →
解析器 `stat` 失败 → 用户在一条好好的回复后面收到
`（附件发送失败：https://example.com/a.png — the file does not exist）`。
**没人犯的错，却报了一个错**。

修法：`push()` 里丢弃除 `file:` 以外的 scheme。两个必须保住的边界：

- `file://` 是本地路径，保留；
- **Windows 盘符不是 scheme**。第一版写成「带冒号即 URL」，把 `C:\x\y.png` 一起丢了——
  靠 `(?![A-Za-z]:[\\/])` 的负向断言修正。这条是自查出来的，值得记一笔。

### 还不能发的

`silk` 是**入站**语音格式；出站没有语音分支，`.mp3/.wav/.m4a/.silk` 一律按 file 附件发，
不会变成微信语音气泡。服务端对 BOT 的 voice_item 只接受不投递（此前已实测），所以这不是遗漏。

### 引用怎么写才会被识别

**先看扩展名，再看语法**（2026-10-16 放宽；规则与理由见 `docs/security.md`「出站附件」）：

| 写法 | 图片类 `png/jpg/…` | 附件类 `pdf/docx/zip/mp3/…` |
| --- | --- | --- |
| `![说明](路径)` 图片语法 | ✓ | ✓ |
| `[说明](路径)` 普通链接 | ✗ 仍不认 | ✓ |
| 单独成行 / bullet 的绝对、`~`、盘符路径 | ✓ | ✓ |
| 单独成行 / bullet 的**相对**路径 | ✗ | ✓ |
| 行内正文里的路径 | ✗ | ✗ |
| 行内代码 / 围栏代码块 | ✗ | ✗ |
| `![x](my shot.png)` 裸空格 | ✗ | ✗ |
| `![x](<my shot.png>)` 尖括号包裹 | ✓ | ✓ |

**为什么当时收不到 PDF/Word**：agent 写文档用的是
`[OpenWrt-…指南.pdf](OpenWrt-…指南.pdf)`（链接语法 + 相对路径），这个形状**同时**踩中「链接不认」
和「相对路径不认」（旧规则里相对路径只在图片语法下被接受），文件根本没进上传流程。这条是**量出来的**——
从本项目自己的 DSH 会话记录里翻到 agent 的真实回复并复现（检测到 0 个附件），不是推测。放宽后同一条文本可被识别。

放宽不改变安全边界：识别只决定「要不要尝试发」，能不能读仍由 `resolveOutboundMedia` 的
`realpath` + 目录包含检查决定，认错只会得到 `not-found` 并如实告知用户。


### 一次自己造成的服务端节流（值得记）

为了定位失败原因，几分钟内连打了 **22 次上传**。随后连**纯文本**都发不出去：
`sendMessage ret=-2 errmsg=prepare failed`，而 `getConfig` 仍 `ret=0`（凭证有效）。
即账号级发送节流，与早先「约 20 条/几分钟触发 ≥30min 封锁」的记录一致。

教训：**验证要有节制**，失败重试会叠加热度；诊断一旦确认是服务端拦截，就该停下等，
而不是换文件、换大小继续试——那样既拿不到结论，又把账号推得更深。

#### 第二次踩同一个坑（2026-10-16，更该记住）

排查「PDF 收不到」时**又踩了一次**，而且这次更蠢：我用「发一份 → 问用户收到没 → 再发一份」
的方式做 A/B 对比，来回 4 轮。加上微信里那个 agent 连发的 3 条，**10 分钟内共 7 次**。
时间线是铁证：

| 时刻 | 动作 | 结果 |
| --- | --- | --- |
| 19:02:22 | 插件发 PDF | ✅ 用户收到了 |
| 19:34:13 | 插件发 734KB PDF | ✅ 用户收到了 |
| 19:31 | agent 脚本连发 3 条 | ❌ 返回 `message_id` 但未投递 |
| 19:38:52 | 插件发 | ❌ `ret=-2 prepare failed` |
| 19:39–19:42 | 我又重试 6 次 | ❌ 全部 `-2` |

**19:34 还能成功，4 分钟后就不行了**——就在我连发诊断/修复/差分之后。

两条必须固化的规则：

1. **诊断发送前先查历史节流记录**（本节就是），并**预算**总发送次数；A/B 对比要一次算清
   差异再发，绝不能把「问用户收到没」当成循环里的同步点——那等于让用户帮我做速率控制。
2. **`message_id` 不等于投递**。`ret=0` + `message_id` 只说明服务端受理；账户处于节流期时
   仍然照发这个 id，消息却被静默丢弃。用户报告「没收到」而日志显示 success 时，
   **第一嫌疑是节流，不是协议写错了**。

第 2 条尤其反直觉：它让「发送成功」的日志变成假信号，从而把排查方向引向协议细节（我这次就
去比对 `X-WECHAT-UIN` 编码、`run_id`、`file_item` 结构，全是白费）。真正的判据是
**用户端是否收到**，以及节流期结束后**完全相同的代码是否恢复投递**。


## 会话行前那个微信图标（不是回归，是从来没做过）

现象：工作区会话列表里，本插件开的两条会话只显示「微信 · 问候与协助请求」这样的纯文字，
行首没有图标。

### 排查：先排除文件，再找渲染面

按顺序全部实测排除：图标文件（`assets/icon-128.png`，5019 字节，128×128 RGBA）、
部署副本（`assets/` 四个文件都在，icon 与仓库逐字节一致）、`package.json` 的
`"icon": "./assets/icon-128.png"`、`exports` 里的 `./package.json` 子路径解析、
宿主自己的 `readPluginMeta()` 读出 `has icon: true` 且无 error、产出的 data URL
（`data:image/png;base64,iVBORw0K...`）解码回来是魔数 `89504e47`、IHDR 128×128 的合法 PNG。
**这条链路是好的**——但它管的是插件管理器里的**卡片**，不是会话行。

真正的渲染面在 `@deepseek-ai/dsh-client-ui-workspace` 的会话行里：

```js
children: showStatus
  ? <SessionStatusDots statuses={statuses} />
  : renderSlot("sidebar.session.row.leading", { sessionId: node.id })
```

`sidebar.session.row.leading` 是**留给插件的槽位**，按行渲染、只接收该行的 Session 身份。
本插件此前只注册了 `plugins.bundle.config` 与 `settings.section` 两个座位，
**从没注册过这个槽位**——所以那片空白是设计如此，图标不是丢了。

### 实现

`src/client.js` 新增 `SessionRowMark`，并注册第三个座位：

- 判定只看前缀 `weixin-`（`baseSessionIdFor` 生成 `weixin-<slug>`，新会话线追加 `--<stamp>`），
  不是本插件的会话**返回 `null`**——座位是共享的，贪心的前缀判断会把微信图标贴到别人的会话上；
- 图标用 simple-icons 的 WeChat 路径（1220 字符，24×24 viewBox）**内联**在组件里。
  之所以内联：客户端 bundle 只允许 `require("react")` 与 `require("react/jsx-runtime")`，
  图形模块不在白名单上；而这条路径与宿主自己给 `weixin.qq.com` 链接画的图形**完全一致**，
  于是会话行的这个标记和正文里的微信链接看起来是同一个身份；
- 颜色用微信品牌绿 `#07C160`，**不用** `--dsw-alias-state-success-*`：那套 token 是界面的
  「一切正常」绿，会随壳的语义色板变化，而品牌标记不该变；
- 座位 id 独立（`dsh-plugin-weixin-row-mark`，order 20），排在 ui-schedule 的时钟（order 10）
  之后。`list` 座位每个 cell id 只取一个赢家，独立 id 是两者共存、而不是互相顶掉的原因。

### 测试

新增 `test/client-session-row-mark.test.js`（6 条）。harness 沿用
`client-sessions-section.test.js` 的真 hooks 运行时，但**按座位名记录注册**——
旧 harness 只保留「最后一个带组件的注册」，插件一旦注册第二个座位就会把卡片换成行标记，
这正是本次暴露出的 harness 假设。

**辨别力**（逐个注入回归，看是否被抓）：

| 注入的回归 | 结果 |
| --- | --- |
| `isWeixinSession` 恒为 `true`（吞下所有会话行） | 2 条红（外来 id / 非字符串 id） |
| 槽位完全不注册 | 6 条全红 |
| 只认裸 base id（额外会话线丢图标） | 3 条红 |
| 用主题绿替代 `#07C160` | 1 条红（品牌色） |
| 换成另一个通用聊天图标 | 1 条红（形状） |

另外三处既有测试的断言写死了座位数量或位置（`client-remote.test.js` 断言 2 个座位、
`client-login-poll.test.js` 断言 2 个座位且用 `seats[0]` 取卡片、
`client-sessions-section.test.js` 用「最后一个带组件的注册」取卡片），
都已改为**按座位名**定位——否则新增座位会让它们悄悄测错对象。

### 验证

- 全量 **257 pass / 0 fail**，连跑 3 次稳定；
- 跑完操作者日志 `~/.dsh/weixin/logs/openclaw-2026-10-16.log` 字节数 **19811 → 19811，零增长**；
- 装到 desktop profile 并核验 `src/client.js`、`package.json` 逐字节一致；
- 用**部署副本**跑一遍真实注册：3 个座位，行标记座位 `dsh-plugin-weixin-row-mark` order=20；
  拿真实会话 id 逐条调用组件——`weixin-o9cq804qN9Kjha-YsRWQwG8hWo3I-im-wechat` 与其
  `--mvag9l5s0vuey9` 那条**有标记**，DSH 自己的 `session-ddac398a-...` **无标记**。

## Windows 扫码不显示二维码：编码器依赖了机器上恰好存在的东西

**现象**（用户报告 + 截图）：Windows 上装好插件、点「扫码登录微信」后，卡片中间是一个**破图
图标**（浏览器的 broken-image 占位），下面「在浏览器打开」「复制链接」两个按钮却是好的。

**为什么是破图而不是报错**：`src/client.js` 的渲染是一个三元链——
`qrDataUrl ? <img src={qrDataUrl}> : qrUrl ? <img src={qrUrl}> : 提示"二维码加载中"`。
`qrUrl` 是 iLink 返回的**登录链接**（`https://liteapp.weixin.qq.com/q/...`），不是图片。
`qrDataUrl` 为 `undefined` 时，第二个分支就把这个链接塞进 `<img src>`，于是浏览器画一个破图。
两个按钮正常，正好说明链接本身是好的——坏的只有「把链接当图片」这一步。

**为什么 `qrDataUrl` 是 undefined**：`src/qr-png.js` 的 `writeQrPng` 依次尝试两条外部路线——
① `import('qrcode')`（npm 包）；② `python3` / `python` / DSH 自带 python 的 `qrcode` 模块。
两条在 Windows 上都不成立：
- `qrcode` **从来不是本包的依赖**（`dependencies` 只有 typert-protocol / schemastery /
  qrcode-terminal；`qrcode-terminal` 只能画半块字符，不能出图），所以 ① 必然 `ERR_MODULE_NOT_FOUND`；
- Windows 上没有 `python3`/`python` 在 PATH 上，而自带 python 的路径按 POSIX 布局拼
  （`bin/python`），Windows 上若没有对应 runtime 目录同样落空。

**为什么本机测试全绿却漏了**：开发机 macOS 上 `~/miniconda3/bin/python3` 在 PATH 里，且
DSH 自带 python 恰好装了 `qrcode` wheel，于是 ② 成功。而当时的测试写成了：

```js
if (url === undefined) { assert.ok(true); return }   // ← 静默通过
```

「这台机器没有编码器」被当成合法结果，所以**恰好覆盖了失败的那条路**——套件在 Windows 坏掉
的同时保持全绿。

**修法（去掉整类环境依赖）**：不再依赖任何外部工具。
- 二维码矩阵取自 `qrcode-terminal` **自带的**编码器（`vendor/QRCode`）：它本来就是声明的依赖，
  安装脚本也已经把它拷进 profile，所以这条路在每台机器上都在。用 `createRequire` 从
  `require.resolve('qrcode-terminal')` 出发解析，保证在部署后（本模块与依赖不在同一棵树）也能找到。
- PNG 由新增的 `src/png.js` 手工编码，只用 `node:zlib`：1 位灰度（颜色类型 0）、每行 filter
  None、单个 IDAT 用 `deflateSync`、CRC 用 `zlib.crc32`（Node ≥ 20.15，本包要求 ≥ 22.13）。
  二维码只有两色，所以 1 位灰度比真彩小 4 倍；高熵图形下 filter None 也是最小输出。
- 旧的 `qrcode` / python 两条路保留为兜底，但**不再是唯一路径**。

**正确性是怎么验的**（不是"看起来像二维码"）：
- 自写解码器逐块校验每个 chunk 的 CRC、filter 字节、位深/颜色类型，并把像素和原矩阵**逐模块**
  比对（含 quiet zone 必须为白）；极性注入（黑↔白反转）会让 3 条测试立刻红。
- 矩阵正确性对照：Python `qrcode`（纠错等级 L）逐 mask 比对，**mask 7 时 1089 个模块完全一致**
  （初次比对报 422 个差异，是因为默认用了 mask 2；mask 是合法可选的，不是缺陷）。
- **真机扫码**：`zbarimg` 把我生成的 PNG 读回成
  `QR-Code:https://liteapp.weixin.qq.com/q/verify999?qrcode=cafebabe&bot_type=3`。
- **模拟 Windows 条件 A/B**（`env -i PATH=/usr/bin:/bin HOME=<clean>`，无 python、无自带 python）：
  旧代码返回 `undefined`（即破图），新代码返回 662 字符的 PNG data URL。
- 客户端那一步也钉住了：新增测试断言「`<img>` 的 src 必须是 `data:image/*`，绝不能是登录链接」，
  并把旧的「链接塞进 img」注入回去确认只有这一条测试变红。

**顺带修掉的测试缺陷**：`test/client-remote.test.js` 里 `if (url === undefined) assert.ok(true)`
的静默分支已删除，改为硬断言——正是它让 Windows 的失败在套件里隐形。

**测试**：新增 `test/qr-png.test.js`（6 条）；`test/client-login-poll.test.js` 加 1 条破图回归。
全量 264 pass / 0 fail。

## 2026-10-16 — 把可配置项放进设置页（原来只能手改 JSON）

**起因**：设置卡能编辑的只有它当初为 ASR 写的那几个字段（模型目录、下载源、代理），
其余十几个选项——发件人白名单、长度上限、忙时策略、媒体大小上限、CDN 根——
只能靠手改 `~/.dsh/weixin/config.json` 或 `cordis.patch.yml`。用户要求「把可配置项都可以放到设置界面」。

### 做法：表单由宿主的数据驱动

新增 `src/config-remote.js`（`ConfigController`，服务名 `configController`，命名空间 `weixinConfig`），
导出三张表：`FIELDS`（每项的类型、标签、提示、默认值、范围、是否只读）、分组、以及
`list` / `save` / `reset` 三个 Remote 方法。`src/client.js` 新增 `ConfigSection`，
渲染宿主发来的字段列表——**宿主加一个选项，界面自动多一项，客户端不用改**。

优先级链：**已保存 > `config`（来自 YAML）> schema 默认**，并且每一项都带
`source` 字段告诉界面这个值从哪来，界面据此显示 `已保存` / `来自 config` 徽标，
并提供「恢复默认」。表单里只发送**改动过**的字段，避免把没碰过的项用陈旧值覆盖掉。

### 沿路修掉的四个真问题

1. **`enabled: false` 会提前 return，导致设置服务根本不注册。** 注释上写着服务
   「Registered regardless of enabled so a disabled plugin can still be configured」，
   但代码在 `return` 之后就再没走到那些 `new`。这意味着**一旦关闭插件，设置页就再也打不开，
   也就无法把它打开**——唯一的开关被自己锁死了。改为：服务先注册，只跳过轮询循环；
   `onAccountBound` 也加了守卫，禁用时扫码成功不会偷偷把循环拉起来（凭证照常保存）。

2. **`bringUpLoop` 在没有凭证时静默 return。** 「加载了，但因为没有凭证所以什么都没在听」
   是排查「消息怎么不进来」时最需要的一句话，而它原本一个字都不打——与一个起来了却卡住的
   循环无法区分。补了日志。

3. **批次非原子写入。** `save` 先整批校验、再一次性落盘；半途失败的保存会让操作者看到报错
   却分不清哪些已经写进去了。测试专门验证了这一点（见下）。

4. **清空一个字符串字段会存 `""` 而不是删键**，于是 `source` 显示「已保存」而值是空的——
   与清空数字字段（删键、回到默认）行为不一致。统一为：空且默认值也是空 ⇒ 删键。
   `allowedSenders` 例外，空列表是**有含义的**（谁都不允许），必须写入而不是删除。

另外把 `deletePath` 补上父对象剪枝：重置 `asr.model` 后不该留下一个空的 `asr: {}` 让文件
看起来还带着配置（同时保证 `asr.env` 这类兄弟键不被误删）。

### 远端参数为什么传 JSON 字符串

`save` 收的是 `entriesJson`（一个 JSON 字符串），不是结构化数组。原因是 **wire 层会按声明的
codec 校验每个参数，而这个插件的 codec 词表（`string`/`number`/`record`/`unknown`）里没有数组节点**，
数组参数会在网关就被拒掉、根本进不到方法里。JSON 字符串复用已有的 `_str` codec。

顺带查出一个**潜伏的坏代码**：`src/client.js` 里 `_strMap` 调用了不存在的 `record()`
（这个 schemastery 版本只有 `dict`）。它当前没有任何调用点，所以没炸；没有动它，只在
探测中确认了它是死代码。

### 测试与辨别力

新增 `test/config-remote.test.js`（10 条）。其中最重要的一条是**双向 schema 一致性**：
表单自带的每份默认值必须等于 schema 的默认值，且 schema 里的每个字段都必须在表单里出现
（后者正是这次的原始投诉）。逐条注入了 4 种缺陷确认测试真的会红：

| 注入的缺陷 | 结果 |
| --- | --- |
| 默认值与 schema 漂移 | 1 条红 |
| 清空字符串不删键 | 1 条红 |
| 已保存不再压过 config | 4 条红 |
| 逐条校验并写入（非原子） | 1 条红 |

其中**非原子那条最初没被抓住**：我先注入的「缺陷」其实被前面的整批预校验循环挡掉了，
真正的 `save` 根本没走到写入。把预校验循环一并换成逐条写入后测试才变红——
教训是注入的缺陷必须确认**真的执行到了**，否则「测试没红」证明不了任何事。

**另外四处 harness 更新**：插件现在注册三个服务（登录、ASR、配置），
`test/client-login-poll.test.js`、`test/client-session-row-mark.test.js`、
`test/client-sessions-section.test.js`、`test/client-remote.test.js` 的假 ctx
需要补上 `remote.weixinConfig`，否则 `ctx.inject` 直接断言失败（21 条一起红）。
`test/client-remote.test.js` 的方法清单也加了三个 `weixinConfig/*`。

**验证**：全量 **274 pass / 0 fail**；操作者日志 24061 → 24061 字节（零增长）；
用假宿主加载真 `src/index.js` 确认禁用时注册 3 个服务且不起循环、启用时照常；
新文件权限 600 → 644（否则 release 脚本的 world-readable 检查会中止）。

## 2026-10-16 — 语音转写「未配置」：schema 默认值又压过了存档

操作者在设置页配好了 ASR（`config.json` 里 `asr.enabled=true`、
`asr.command=/Users/panqing/miniconda3/envs/mlx-arm/bin/python3`），发语音过来
却仍然收到 `转写失败：no ASR bridge is configured`。

### 根因：和 `allowedSenders` 是同一个 bug 形状，只是没人给 `asr` 补规则

`withSavedConfig` 对 `asr` 只做了一层浅合并：

```js
merged.asr = { ...savedAsr, ...config.asr }
```

而宿主传给 `apply(ctx, config)` 的 `config` 是 **schemastery 实例化过**的——
schema 给 `asr` 的每个字段都填了默认值，`command: ''`、`args: []`、`env: {}`。
于是展开合并把 `''` 盖在了操作者的真命令上。实测（真 schema + 真 config.json）：

```
saved.asr       = {"enabled":true,"command":"/Users/panqing/miniconda3/envs/mlx-arm/bin/python3","args":["bin/asr-bridge.py"],…}
hostConfig.asr  = {"enabled":true,"command":"","args":[],"timeoutMs":60000,"env":{},…}   ← schema 凭空补的空默认值
merged.asr      = {"enabled":true,"command":"","args":[],…}                              ← 空 "" 赢了真命令
=> resolveAsrSettings(merged, …) = null  →  asrBridge = undefined  →  「未配置」
```

`allowedSenders` 在 2026-10-15 撞过一模一样的墙（`4e9fa8a`），当时只修了白名单。

### 为什么我之前的探针全都漏了

**它们传的是空 config**（`withSavedConfig({})`）。`{}` 里没有 `asr` 键，
所以 saved 自然胜出，一路绿灯。真宿主传的是 schema 实例化的 config，
`saved` 与 `config` 之间有冲突——而冲突才是这个 bug 的载体。
**教训：验证合并逻辑时，喂给它的必须是宿主真会传的那个形状，不是最省事的空对象。**

### 修法

按字段判定，且刻意保守：**存档里的值一律优先，除非存档里那个值本身是 schema 的空形态**
（`''`、`[]`、`{}`、`undefined`）。理由是 `withSavedConfig` **无法区分**
「schema 默认」和「操作者在 YAML 里写的值」——两者在 `config` 上形状完全相同——
所以唯一安全的读法是「设置页是更新、更具体的陈述」。
`false` 和 `0` 是真值，永远不当空，操作者关掉转写就保持关掉。

### 测试与辨别力（`test/core.test.js`，+3 条）

| 注入的缺陷 | 结果 |
| --- | --- |
| 退回 `{...savedAsr, ...config.asr}`（旧行为） | **3 条全红** |
| 把 `false`/`0` 也当空值 | 恰好 1 条红（`an operator turning asr off …`） |

### 验证

- 全量 **284 pass / 0 fail**（281 → 284）；操作者日志 46438 → 46438 字节零增长。
- **前后对照，同一探针同一配置**（`/tmp/e2easr.mjs`，加载部署副本）：
  - 修复前：只有 `listening as account 973b0028f767@im.bot`
  - 修复后：**`voice transcription enabled via /Users/panqing/miniconda3/envs/mlx-arm/bin/python3`** + 同一行
- **完整链路真跑**（真 schema → `withSavedConfig` → `resolveAsrSettings` → `AsrBridge`
  → 真 bridge 进程 → mlx-whisper 加载模型）转写操作者那条真语音：
  `{"ok":true,"text":"我还是没说到。"}`
- **反向**：`config.json` 写 `enabled:false` → `merged.asr.enabled === false`、
  `resolveAsrSettings` 返回 `null`（关掉就是关掉，不被 schema 默认重新打开）。
- 部署：`node bin/install.mjs --profile desktop`，`src/state.js` 两侧 SHA-256
  均为 `5d4ab8657f04d92a58fd7d98f274a7ca9efcfc946f74f9144de69ad5abb58093`（肉眼比对）。

---

## 2026-10-16 晚：长轮询 body 挂死（「暂无法连接 openclaw」实锤）

### 现场（21:05–21:17 本地）

手机显示「暂无法连接 openclaw」；`dde7e4010d55@im.bot.sync.json` mtime 停在
21:05:59（11 分钟无推进）、21:05:10 之后日志一条都没有（35s 超时本应每轮打一条）；
TCP 采样看到**一条对 iLink 的连接纹丝不动**（另一条消失了）——入站循环整个停了，
但没有报错、没有重试，因为**什么都没"失败"**。

### 根因：vendor 的超时在响应头到达那一刻就被清掉

`vendor/openclaw-weixin/api/api.js` 的 `apiPostFetch`：

```js
const res = await fetch(...)      // 头到了
if (t !== undefined) clearTimeout(t)   // ← 自己的 35s 定时器在这里被清
const rawText = await res.text()       // ← body 读取没有任何超时
```

服务端把头发了、body 吊住 → `res.text()` 永远 pending → `getUpdates` 永远
不返回 → 循环卡死在一个死请求上。TCP 看着是 ESTABLISHED，日志里什么都没有。

**第二暴露点（探针发现的）**：`start()` 里 `await notifyStart` 在武装循环**之前**
执行。`notifyStart` 没有外部 signal，撞上同样的 body 挂死就**永远不返回**——
watchdog 根本没机会武装，整个 transport 从第一轮挂死起就死了。
`stop()` 里的 `notifyStop` 同理，会让插件 dispose 也挂住。

### 修法（`src/transport/ilink.js`，不碰 vendor）

1. **`#loop` 的 getUpdates watchdog**：每轮 poll 限时
   `longPollTimeoutMs * 2 + 10s`（35s 默认 → 80s 硬上界），超时 `abort()` 掐掉
   底层请求、打一行日志、计一次失败走既有 2s/30s 退避。
   **关键细节**：vendor 的 `getUpdates` 会把 `AbortError` 吞掉并返回
   `{ret:0, msgs:[]}`（把外部 abort 当长轮询超时的正常出口），所以 watchdog 的
   abort 以「正常返回 + signal 已 aborted」的形态出现，**不会进 catch**。
   循环在 poll 返回后检查 signal：aborted 且 `running` 仍为 true ⇒ 是 watchdog
   触发（`stop()` 先翻 `running` 再 abort，以此区分两种 abort），重建
   controller 继续轮询。若只靠 `while (!signal.aborted)` 判断，这里会**静默退出
   循环**——正是现场那个冻结状态。
2. **`start()` 的 notifyStart 竞速**：与同一 deadline race，输了打日志继续，
   不再无限阻塞循环武装。
3. **`stop()` 的 notifyStop 竞速**：同上，dispose 不再可能挂住。
4. **退避 sleep 可中断**：`interruptibleSleep(100ms 步进)`，`stop()` 不用等完
   30s 退避才返回。

### 测试（`test/transport-watchdog.test.js`，1 条端到端）

**复现挂死的关键是服务器形状**：plain headers-only 响应 undici 视为
零长度 body **立即完成**（前几版测试因此什么都没测到）；必须发
**chunked 响应且不给终止 chunk**——`fetch()` 在头处 resolve（vendor 清掉自己的
定时器）、`res.text()` 永远 pending，才是生产形态。`longPollTimeoutMs=100` 把
watchdog deadline 压到 ~10.2s。

断言：`start()` 在 deadline 返回并打 `notifyStart did not answer within …`；
watchdog 打 `one poll round exceeded … (headers arrived, body never did)`；
watchdog 之后**仍在发起新请求**（不是静默退循环）；`stop()` 干净退出。

### 验证

- 全量 **285 pass / 0 fail**（284 → 285）；操作者日志 48697 → 48697 零增长。
- 独立探针（非测试进程）完整时间线：
  `start returned in 10208ms` → 两次 `ERR: getUpdates watchdog: one poll round
  exceeded 10200ms` → `stopped` → `server closed`。循环对持续挂死的服务器
  **永不卡死、每次都有日志、每次都重试**。

## 2026-10-16 深夜：出站附件的收件人被 send seam 丢掉（`to=undefined`）

### 现场

22:21 微信 agent 回复 `pdf_test/测试文档-test.pdf`，文件日志：

```
[weixin] sendWeixinMediaFile: uploading file attachment filePath=... to=undefined
uploadFileAttachmentToWeixin: getUploadUrl returned no upload URL (need upload_full_url or upload_param), resp={"ret":-2}
outbound media: sending media ... failed: upload/send failed: ...
```

关键差异：20:25 一次直接调 vendor（探针）的上传 `to=o9cq804qN9Kjha_YsRWQwG8hWo3I@im.wechat`
能走到 sendMessage（`ret=-2 prepare failed` 是当时的账号级封锁）；插件自己路径的
`to=undefined` 连 getUploadUrl 都过不了。

### 根因：两个模块对同一个值的命名不同，seam 原样转发

- `deliverOutboundMedia`（src/media/outbound.js）的 send seam 传 `to`（对端 id，见
  `OutboundMedia` typedef）。
- `ILinkTransport.sendMedia`（src/transport/ilink.js:459）解构的名字是 `conversationId`。
- `src/index.js` 的 seam 写的是 `send: (mediaParams) => params.transport.sendMedia(mediaParams)`
  ——**逐字转发**，键名不改。`to` 掉在解构的缝隙里，`conversationId === undefined`。

于是每个插件驱动的附件都带着 `to_user_id: undefined` 发出 `getuploadurl`
（`JSON.stringify` 直接丢掉 undefined 键），服务端回 `{ret:-2}`。**从
`2405fd5`（初始提交）起就是坏的**：图片/文档的「成功收到」全部来自探针直调
vendor 或后来修好的检测让文件走进了这条路之外的通道——不，恰恰相反，走了这条路
的从来没成功过。假服务器对什么都回成功 + 测试从不断言 `to_user_id`，让它一直绿灯。

### 修法

`src/index.js` 的 seam 显式改键：

```js
send: ({ filePath, to, contextToken, cdnBaseUrl }) =>
  params.transport.sendMedia({ filePath, conversationId: to, contextToken, cdnBaseUrl }),
```

### 测试补钉（test/e2e.test.js，两条既有 e2e 加断言）

- 绝对路径上传测试：断言 `uploadUrls[0].to_user_id === ALLOWED` 且
  sendmessage 信封 `msg.to_user_id === ALLOWED`。
- 相对路径上传测试：断言 `uploadUrls[0].to_user_id === ALLOWED`。

**辨别力**：stash 修复后 `getuploadurl lost the peer id: {...无 to_user_id...}`，
两条都红；恢复后全绿。单文件跑 `node --test test/e2e.test.js`（不带 npm test 的
`--import ./test/isolate-host-state.mjs`）会因 `DSH_WEIXIN_LOG_DIR` 未设而误红——
辨别力判定必须用 `npm test`。

### 验证

- 全量 **285 pass / 0 fail** 连跑 2 次；操作者日志 outbound media 行 24 → 24 零增长。
- 部署：`node bin/install.mjs --profile desktop`；`src/index.js` 两侧 SHA-256
  `d80f89f3…` 均打印肉眼比对一致。

## 2026-10-16 深夜（二）：`/clear` 清空当前会话并重开

### 需求

用户：「增加清除会话的功能」；确认的语义是**清空当前会话并重开**（推荐项）：当前这条
从 `/list` 里删掉，立刻开一条全新会话接续；旧上下文不再出现在列表里。

### 设计决策

- **不带参数**：`/clear 3` 不识别。带序号的「清除第 N 条」读起来像 `/use 3` 加重置，
  误触会销毁上下文；更安全的表面是**打不歪的那一个**——只清当前。
- **只删索引，不碰宿主文件**：`SessionLines.clear()` 把该会话的 lines 重置为一条全新的
  `--` 戳记 id；宿主的 `session.v4.jsonl.zstd` 原样保留为孤儿（那是宿主的数据）。
- **新 id 而非复用旧 id**：新行拿到新的戳记 id，旧的内存 record 被 dispose 并从
  `this.sessions` 移除——否则排队中的旧消息会到达一条用户认为已经不存在的会话；
  `/use` 也永远切不回已清掉的上下文。

### 实现踩坑

`clear()` 最初写成 `{lines:[], active:''}` 再调 `create()`——但 `list()` 对空条目会
**合成历史 base id**，`create()` 把新行压到它上面，等于 `/clear` 之后列表里第一条还是
被要求删除的那条老 base 线（实测 store：`[base, stamped]`）。改为 `clear()` 直接写入
单条新行，绕开合成。

### 测试（辨别力）

- `test/sessions.test.js` +3：clear 后恰一条新戳记行且老 id（含 base）全部不在；
  只认整条消息（`/clear 3`、`/clearall`、句中提及都不算）；回复话术。
- `test/session-commands.test.js` +1（端到端，fake host）：第一条消息建上下文 →
  `/clear` 由插件直接回答且不耗模型轮 → **旧会话句柄被 dispose**（`disposedSessions`
  追踪）→ 下一条消息打开的是带 `--` 戳记的全新会话，绝不是旧 id。
- 辨别力：stash `src/agent-bridge.js` → dispose 断言超时红（5/6）；stash 两个源文件
  → 4 红。恢复后全绿。

### 验证

- 全量 **289 pass / 0 fail**（285 → 289）。
- 部署：`node bin/install.mjs --profile desktop`；`src/sessions.js` `5ceef83a…`、
  `src/agent-bridge.js` `5a1a5b67…` 两侧 SHA-256 均打印肉眼比对一致。

## 2026-10-17 深夜：产出文件自动送达（`autoSendFiles`）

### 需求

用户（截图为证）：agent 明明在回合里产出了截图/PDF，却必须再发一条「发我微信」才收得到——
因为现有出站媒体只认**回复文本里的引用**（`![x](p)` / 链接 / 裸路径），agent 用散文描述
产物而不写引用时，文件就躺在工作目录里。

### 实现

- `src/media/outbound.js` 新增 `listProducedFiles({dir, sinceMs, max})`：纯扫描，深度 1
  （绝不递归进 `tools/`、`crops/`、`pdf_test/`）、只认 `MEDIA_EXT` 扩展名（脚本/中间产物
  按构造排除）、跳过点文件、mtime ≥ sinceMs、新者在前、默认上限 `MAX_MEDIA_PER_REPLY`。
- `src/index.js` 新增 `sendProducedFiles`：回合结束（含 late reply 路径）后扫描 agent cwd
  （`resolveCwd` 的结果，与 bridge 注册的 workspace 同一目录），剔除 `resolveOutboundReply`
  已发送的，逐个 `transport.sendMedia`；单文件失败只落一行日志，绝不影响已发出的文本回复。
  开关 `autoSendFiles`（schema 默认 true），设置页「媒体」组同步新增该项（双向 schema
  一致性测试强制要求表单出现）。
- `resolveOutboundReply` 返回值从 `string` 改为 `{text, sent}`——调用方需要 `sent` 来去重。

### 测试（辨别力）

- `test/outbound-media.test.js` +2：扩展名过滤（.py 不认）、点文件跳过、子目录内容永不卷入
  （`crops/inner.png`）、mtime 截止、`max` 截断取最新。
- `test/e2e.test.js` +1（端到端，真 `src/index.js`）：包一层 fake agents 的 `resume`/
  `create`，在会话创建时写 `produced-report.pdf`（等价于真 agent 在回合中写文件），回复
  文本只说 "done, nothing attached" → 断言 FILE item（**出站信封 FILE=4**，与引用路径
  的既有测试一致）到达且 `msg.to_user_id === ALLOWED`，getuploadurl 也带对了收件人。
  stash 修复后该测试红（无 FILE item）。**测试坑**：冷启动走 `resume` 不走 `create`，
  只包 create 会写出 0 个文件；出站 item 编号与 api/types 注释里的枚举不同，以既有
  e2e 断言为准。
- `test/asr.test.js` 的既有失败（stash 验证为**先于本次改动存在**）：系统 `python3`
  （homebrew）丢失 whisper 引擎后，桥对缺失文件报 `no usable ASR engine` 而非
  `no such file`——导入失败先于 stat。断言改为按桥的实际报错分支（两种都是 ok:false，
  「缺失文件绝不伪装成转写」的钉子保持不变）。

### 验证

- 全量 **292 pass / 0 fail**（289 → 292，asr 1 转 0）。

## 2026-10-17 深夜（二）：模型调用失败会卡住后续消息（`turnError`）

### 需求与现场

用户：「一但有一次模型调用失败，下一次发送的消息就卡那了」。

### 机制（从真实会话 transcript 量出，非推测）

解压 `~/.dsh/sessions/.../session.v4.jsonl.zstd` 找到失败回合（turn 8，429 RATE_LIMIT
「余额不足」），事件序列铁证：

```
assistant/attempt ×6   stream 只有 usage/finish chunk，绝无 text-delta
llm/retry ×5           重试 5 次全失败
turn/end               reason.kind='error'，code='RATE_LIMIT'
```

**`readAssistantReply` 完全没看 `turn/end`**：SETTLED_TYPES 里的 `assistant/attempt`
虽然被扫到，但 body 为空字符串 → `text` 恒为 `''` → `#awaitReply` 空转到 `maxWaitMs`
（**默认 20 分钟**）才超时。这期间 `record.busy = true` 不放，用户下一条消息走
`#enqueue` 排队「已排队，等当前回复完成后自动发送」，然后陪第一个死回合等满 20 分钟
——正是「卡那了」。

### 修法

- `src/session-reader.js`：读 `turn/end`，`reason.kind === 'error'` 时置
  `turnError = reason.error?.message`（新回合开始时重置）；`turnError` 进入返回值。
- `src/agent-bridge.js`：`#awaitReply` 主循环见 `turnError` 立即返回
  `（模型调用失败：<原因>）`——失败回合已终结，等待只会占住 busy 锁；late-reply
  循环同样见 `turnError` 即止（不再空转 1 小时）。排队路径（`#runQueuedTurn` →
  同一个 `#awaitReply`）自动受益。

### 测试与踩坑

`test/busy-turns.test.js` +1：合成 attempt(仅 usage) + `turn/end(error)`，断言
① 回复含「模型调用失败」与「429」且 <5s 返回（不是 60s 空转）；② 下一 条消息立刻
正常运行。**两个自造测试坑**：

1. **推送事件与 `before` 游标的竞态**：固定 50ms 定时器推事件，可能在 `deliver()`
   捕获 `#lastSeq` 之前落地 → 901 被当作「游标前」跳过 → 空转照旧。改为轮询等
   `followup` 被记录后再推（followup 在 `before` 捕获之后发生，从此必然大于游标）。
2. **事件 seq 与假 agent 计数器冲突**：第二轮用 `fake.release()` 发回复，其内部
   计数器从 1 起，低于本测试推的 900/901 → 读者把回复当「游标前」跳过 → 第二轮
   超时。改为手动推 `seq: 950` 的 assistant/message。

### 验证

- 全量 **293 pass / 0 fail**（292 → 293）。
- 部署 `node bin/install.mjs --profile desktop`；`src/session-reader.js`
  `ce61d88e…`、`src/agent-bridge.js` `e75e30bd…` 两侧 SHA-256 肉眼比对一致。

## 2026-10-18：发布后「代码来源」显示旧 tarball 的机制与处置

### 机制

DSH GUI 的插件「来源信息」面板读的是 **profile 的依赖声明**
（`~/.dsh/profiles/desktop/package.json` 的 `dependencies['dsh-plugin-weixin']`），
不是 `node_modules` 里实际装的内容。`bin/release.mjs` 的第 8 步只跑
`bin/install.mjs`（把仓库构建产物拷进 node_modules），**不改依赖声明**——所以每次
发布后 GUI 都显示上一个版本的 `file:/tmp/dsh-plugin-weixin-<旧>.tgz`，而装的内容
其实是新的。0.5.0 时代更严重：宿主的 npm install 会按声明从旧 tarball 把插件
**重新物化回旧版**，出现「修好又变旧」的回退。

### 处置（本次）

手动把声明指到 `/tmp/dsh-plugin-weixin-0.6.0.tgz`（release 构建的 tarball 副本），
`npm install --legacy-peer-deps` 重物化；lock 与 node_modules 均为 0.6.0，三个核心
文件 SHA-256 与仓库逐字节一致。

### 待办（用户已拍板，2026-10-18）

- **profile 依赖暂留 `/tmp` tarball**（用户决策，同步记录于 `.learnings/LEARNINGS.md`）：
  用户仍在开发期，每次发布由 release 脚本装 + 手动重指 tarball 即可。**开发结束或
  准备长期稳定运行时，提醒改成 registry 版本号（`"dsh-plugin-weixin": "^0.6.0"`）**
  ——`/tmp` 会被系统清理，清掉后宿主 npm install 会失败。用户拍板前不动。
- `release.mjs` 第 8 步更新 profile 依赖声明并重跑 npm install（消除每次发布后
  「来源显示旧版」），同样等用户确认后再动。

## 2026-10-18：多账号阶段 1 —— 每个账号一条自己的入站循环

### 改动

入站循环从「单个 `transport` 变量」改为「`transports: Map<accountId, ILinkTransport>`」：

- `resolveAccounts(config, wantedAccountId, warn)` 取代 `resolveAccount`：`wantedAccountId`
  指定单个账号（卡片登录完成回调传入），undefined 表示「盘上所有账号」。旧的
  「存了多个账号又没配置 accountId 就拒绝服务」分支删除——多账号是稳态，每个
  已存凭证都该有自己的循环。
- `bringUpLoop(wantedAccountId)` 逐账号 `bringUpAccount`，单账号失败只 warn 不拖垮其余。
- `bringUpAccount` 的去重守卫（同凭证已在跑 → `is already being listened to`）、
  先 `previous.stop()` 再 `next.start()` 的顺序、`startLoop` 的 handoff 串行链全部保留，
  只是作用域从全局收窄到单个账号。
- `onAccountBound(accountId)`：登录完成只重挂**那个**账号，其余账号的活连接不许眨眼。
  `login-remote.js` 的 confirmed 分支随之改为 `onAccountBound?.(status.ilink_bot_id)`。
- disposer 逐账号 stop 且 delete 后继续——一个 teardown 失败不再跳过其余账号。

### 辨别力

`git stash push -- src/index.js src/login-remote.js` 退回单 transport 实现 →
`test/inbound-loop-start.test.js` 恰好 **2 红**（两条新测试），既有 4 条绿；恢复后全绿。
新测试：

- 「two saved accounts are both listened to, on their own servers」——双 fake server，
  断言两个账号各自轮询自己的服务器、第一个账号在第二个起来后继续轮询。
- 「a completed login re-arms only the account that bound」——断言 bot1 的
  `listening as account bot1` 恰好 1 次：裸 `onAccountBound()` 会把 bot1 的活连接
  拆掉重建，操作者体感就是「机器人掉线了一下」。

### 验证

全量 **295 pass / 0 fail**（293 → 295）。既有两条裸 `onAccountBound()` 测试
（rebind swap、same credential）在单账号场景下语义不变，无需改动。

## 2026-10-18：多账号阶段 2 —— 账号登记表与设置页的账号管理

### 改动

- 新增 `src/account-registry.js`：`accounts-registry.json`（state 根目录下）登记每个
  账号的 `label` / `paused` / `pausedAt` / `lastSeenAt` / `createdAt`。纯元数据——
  任何读写失败只警告，绝不阻塞消息收发。坏 JSON 走 `process.emitWarning`
  （`dsh-weixin: ignoring malformed …`），因为 caller 的 warn 收不到模块级通道。
- `src/index.js`：`resolveAccounts` 跳过 paused 账号并明确打日志（「刻意静音」必须
  和「坏掉」区分开）；`onAccountControlChange(accountId)` 让设置页的暂停立即生效
  （pause → 该账号 transport 停止，resume → 立即重新 bring-up，不等重载）；
  dedupe 接受消息后 `touchAccount` 记录 `lastSeenAt`。
- `src/login-remote.js`：`status()` 每个账号合并登记表条目；新增 `pause` / `resume`
  / `label` 三个 Remote 方法。
- `src/client.js`：登录卡的账号行——每个账号显示 label（或 raw id）、最近活跃时间
  （「刚刚 / N 分钟前 / N 小时前 / N 天前」）、paused 标记，及 Rename / Pause|Resume
  / Log out 三个操作；操作失败显示在卡片上的 notice 区。

### 过程中抓到的真缺陷

`resolveAccounts` 的 paused 守卫最初调用了 `log(...)`——但 `log` 只存在于 `apply`
闭包里，这个模块级函数从没有过它。ReferenceError 会被调用方的逐账号 catch 吞成
`could not start the loop`，把「操作者刻意暂停」伪装成「坏凭证」。改为 warn
（本就是该函数的参数），并用一条专门的测试钉住：暂停的账号 bring-up 时必须打出
`account "<id>" is paused; not starting its loop`。

### 新测试

- `test/account-registry.test.js`（4 条）：fresh entry、pause/resume 往返、
  lastSeenAt 触达 + 坏文件不抛、label 设置/清除/re-bind 保留。
- `test/inbound-loop-start.test.js` +2（共 8 条）：
  - 「pausing an account stops its polling now, without touching other accounts」
    —— 双账号，暂停 bot1 后它的轮询立即归零、bot2 继续轮询。
  - 「a paused account gets no loop on bring-up; resuming brings it back without a reload」
    —— 暂停后 bring-up 必须打出「刻意静音」日志且不轮询；resume 后立即恢复。

### 辨别力

`git stash push -- src/index.js src/client.js src/login-remote.js
test/client-remote.test.js` 退回阶段 1 → 两条新行为测试恰好 **2 红**；
恢复后全绿。

### 验证

全量 **301 pass / 0 fail**（295 → 301）。测试发现的重要行为语义：`seedAccount`
写死单元素 `accounts.json` 索引，所以「双账号」测试必须用 `onAccountBound('bot2')`
走真实登录完成路径带起第二个账号——这本身就是被测代码的真实入口。

### 教训

- harness 的 `ctx.logger` 只透传字符串行； Cordis record 形状（`{args:[…]}`）的
  logger 在探针里会静默丢行——断言日志前先确认 logger 形状与被测代码写日志的
  方式一致。
- emitWarning 是模块级 process 通道，caller warn 收不到；断言它必须先 await 一个
  tick（setImmediate）。

## 2026-10-18：多账号阶段 3 —— 会话线按账号隔离

### 缺陷

会话线（`/new` `/list` `/use`）的存取以**裸 conversationId** 为 key 写在
`sessions.json`。多账号下若两个账号出现同一个会话 id，两边会共用同一条会话线：
给 A 账号发 `/new` 会把 B 账号也切到新线，B 的标题会出现在 A 的列表里。

### 修复

- `src/sessions.js` 新增 `scopedLineKey(accountId, conversationId)`：有账号时
  store key 变 `<accountSlug>:<conversationId>`（`@` 等折叠成 `-`，与 session id
  同一套 slug 规则）；无账号（或空账号）保持裸 key，既有单账号条目原样可读。
- `SessionLines` 的 `list/active/clear/create/use/title/render` 全部加可选尾参
  `accountId`；`runSessionCommand` 透传。session id 本身不变（仍是
  `weixin-<slug>`），换的只是 store 的 key——按用户拍板接受「升级后既有单账号
  会话另起一条新线」（旧 transcript 保留，`/list` 不再显示旧线）。
- `src/agent-bridge.js`：`attach/handleCommand/deliver/#enqueue/sessionLines` 全链路
  带 `accountId`，`conversationTargets` 改用 scoped key。
- `src/index.js`：`handleCommand`/`deliver` 调用点传 `message.accountId`。

### 测试与辨别力

- `test/sessions.test.js` 新增 5 条：`scopedLineKey` 形状（含空账号回退裸 key）、
  双账号同 conversationId 的线表隔离与标题隔离、跨账号 `/use` 不可达、
  跨账号 `/clear` 不波及、无账号调用方仍读写裸 key。
- `test/session-routing.test.js` 新增 1 条：bridge 层一个账号的 `/new` `/list`
  不触碰另一账号的线。
- 辨别力实测：`git stash push -- src/sessions.js src/agent-bridge.js src/index.js`
  后恰好 5 红（新加的账号隔离测试），恢复后全绿。全量 **307 pass / 0 fail**。

### 顺带修复：「新增账号登录」入口不可发现

已绑定状态下卡片只有「重新扫码登录」按钮，文案读起来像重登当前账号，没有表达
「可以再登录一个」。改为：未过期时按钮显示**新增账号登录**（会话过期时仍是
「重新扫码登录」——那是补救场景）。后端本就支持：凭证按 `ilink_bot_id` 分账号
落盘，confirmed 后 `onAccountBound(bot_id)` 只重挂该账号的循环。

### 教训

- 测试里断言「另一个账号有 key」前先想清楚它是否真的发生过写入：`list()` 刻意
  不落盘（首条线按需合成），只读不写的账号在文件里没有 key 是预期行为。
- heredoc 追加测试时撇号（`account's`）会闭合单引号字符串——`node --check` 先行。

## 2026-10-18：多账号阶段 4 —— 白名单按账号分层，改动立即生效

### 需求与设计

全局 `allowedSenders`/`allowedChats`（config.json）对每个账号一视同仁；多账号后需要
**按账号收窄**：某个账号只允许特定发送者，另一个账号仍走全局白名单。

- 覆盖存**账号登记表**（`accounts-registry.json`），不存凭证文件——vendor 的凭证
  写入器每次重登都会重写该文件，存那里会被静默抹掉。
- **空覆盖 = 清除**（回退全局），不做账号级 deny-all：想让一个账号安静用 Pause，
  deny-all 会把账号锁死到只能手改 JSON。
- 生效规则：账号覆盖 > 全局 config；入站 handler 在**每次 bring-up** 时解析一次
  生效列表（部署属性，不是消息属性）。

### 真缺陷：改了白名单不生效

测试抓出来的：`startLoop` 的去重守卫「同凭证已在跑就跳过」把白名单变更也挡住了——
registry 里的覆盖落了盘，但运行中的 handler 还拿着它起来时读到的旧列表。修复：
`startLoop`/`bringUpLoop`/`bringUpAccount` 加 `{force}`（停旧再起新，只影响目标账
号），`allowlist()` 远程方法落盘后强制重挂该账号；resume 路径同样强制（resume 也
可能跟在白名单变更后面）。

### 交付

- `src/account-registry.js`：`setAccountAllowlist`（clean 规整、空删字段）、
  `allowlistForAccount`（覆盖优先，否则全局）。
- `src/index.js`：`createInboundHandler` 开头合成 `accountConfig`，白名单检查与
  拒绝日志全部走生效列表；拒绝的文件日志带完整 `allowedSenders`（重登后 sender id
  会变，这行既是诊断也是要粘贴的值）。
- `src/login-remote.js`：`status()` 每账号返回生效白名单（卡片显示「实际管辖」的
  列表，不是其中一层）；新增 `weixin/allowlist` 远程方法（卡片只发逗号/换行分隔
  字符串，codec 层没有数组构造器，方法内 split 归一）。
- `src/client.js`：账号行加 **Allowlist** 按钮（prompt 预填当前生效发送者，留空即
  清除覆盖回退全局）。
- 测试：`test/account-registry.test.js` +1（覆盖设置/生效/清除/重触保留），
  `test/inbound-loop-start.test.js` +1（双账号各接一台可注入消息的 fake server，
  bot1 覆盖收窄后拒绝全局允许的 sender、bot2 照常接受——钉住强制重挂链）。
- 辨别力：stash 产品修复后恰好 1 条 handler 测试红（正是新链路），恢复全绿；
  全量 309 pass。

### 教训

- vendor 文件日志是 JSON-line：内层引号被转义（`[\"someone-else\"]`），文本断言
  要匹配转义后的形状；文件名用**本地日期**，别用 `toISOString()` 拼路径——直接问
  vendor logger 的 `getLogFilePath()`。
- `list()` 刻意不落盘的教训在本阶段再次应验：断言「账号 B 有 key/条目」前先确认
  B 真的写过。

## 2026-10-18（二）：改名称/白名单点了没反应 —— Electron 没有 window.prompt

### 现场

用户重启 DSH 后反馈：「改名称和白名单点不了」。按钮与远程方法都在位（404 已随
重启消除），但 handler 第一步走 `globalThis.prompt?.(...)` → Electron 渲染进程
**不实现 window.prompt**（返回 undefined）→ `typeof next !== "string"` 处静默
return。registry 里 label 字段从未写入，日志无任何报错——静默失败最迷惑的一点。

### 修复

编辑改为**卡片内联行**：点「改名称」/「白名单」后账号行下方出现输入行（预填当前
值），**保存**提交、**取消**放弃；提交走原远程方法（`weixin.label` /
`weixin.allowlist`），成功后关闭编辑行并刷新状态。退出登录的 `confirm()` 在
Electron 可用，不受影响。

### 验证

- 新测试「the account editors are inline rows, never window.prompt」（文本断言
  惯例）：禁 `globalThis.prompt` 回归、三 handler 形状、draft 传参、成功关编辑行；
  stash 修复后恰好 1 红，恢复全绿；全量 310 pass。
- 会话标题核查：sessions.json 已出现账号作用域 key
  `b1b2d0b10d66-im-bot:o9cq…@im.wechat`（标题「在不」）——**标题功能实际已生效**，
  用户看到的「没变」是升级前的旧裸 key 历史线（按拍板方案不迁移）。

### 教训

- Electron 渲染进程没有 `window.prompt`；`globalThis.prompt?.()` 的可选链把
  「环境不支持」变成「静默什么都不做」。凡是依赖浏览器全局的输入路径，先确认
  宿主环境真的提供它——卡片内联编辑行才是桌面壳的形状。

## 2026-10-18（三）：设置页会话标签增加删除按钮

### 需求

多账号会话线按账号隔离后，`/new` 积累的旧线只能切回、不能清理。设置页「会话」标签
的每条非使用中线新增**「删除」**按钮（确认后生效），只移除那一条线。

### 设计（与 /clear 的分界）

- `SessionLines.remove(conversationId, index, accountId)`：按 1-based 序号删一条；
  删**使用中**的那条会回退到剩余第一条（否则 `attach()` 会在死 id 上开一条空会话）；
  **最后一条拒绝删除**——没有线的会话会被 `sessions()` 跳过，从卡片上消失且无法修复。
- 正在使用中的那一行不提供删除按钮（先切换再删）；卡片确认框形状与退出登录一致
  （`confirm()`，Electron 可用）。
- 宿主新增 `weixin/removeSession` 远程方法（4 空格缩进、remoteMethods 列表追加、
  失败形状不带 `ok` 键以免被 unwrap 当 carrier envelope 剥掉）。

### 验证

- store 层新测试（set 比较断言，不依赖 id 字面量——create() 在空 store 上会把合成
  base 线一并落盘，3 次 create 实际 4 条线）：拒绝 0/越界、删背景线不动 active、
  删 active 回退首条、删到剩一条再断言拒绝、账号作用域隔离。
- 宿主/卡片接线：期望方法清单加 `weixin/removeSession`（字典序在 pause/poll 后）。
- 辨别力：stash 三文件后恰好 2 红（descriptor 清单 + 新 remove 测试）；全量
  311 pass。

## 2026-10-18（四）：删除放开 + 卡片按账号区分会话

### 实机反馈

多账号会话隔离上线后用户截图：三个会话条目全部「使用中」且各只有一条线 → 全都没有
删除按钮（v1 设计拒绝），且看不出哪条会话属于哪个账号。

### 两处调整

- **删除放开**（`src/sessions.js` `remove()`）：删使用中线照旧回退剩余第一条；
  **最后一条不再拒绝**——整个会话条目移除（返回 `''` 与坏序号的 `undefined` 区分），
  下一条入站消息会按 scoped key 自动新建干净会话线，没有不可达状态。
  `src/client.js` `removeOne` 的确认文案区分两种情况，使用中行也渲染 Delete。
- **账号标识**（`src/login-remote.js` `sessions()`）：每个会话条目新增
  `accountId`/`accountLabel`（registry 备注名），按 store key 的账号 slug 反查；
  裸 key（升级前历史）两者为 null，卡片不显示标识。卡片在标题行渲染
  备注名（或账号 id）chip。

### 验证

- `test/sessions.test.js` 删除断言反转（最后一条可删、条目消失）；store 层 33 条全绿；
  全量 311 pass。辨别力：stash src 三文件 → 恰好 1 红（remove 放开测试）。
- 踩坑：辨别力必须只 stash src——把 test 一起 stash 等于把断言也回退，全绿毫无意义。
  `list()` 对缺失 key 会重新合成 base 线（既有回退语义），删光后断言要查落盘文件
  而不是 `list()`。

## 2026-10-18（五）：侧栏会话行的账号弱提醒

### 需求

用户截图圈出侧栏会话行的微信图标旁：多账号下分不清这行会话属于哪个账号，希望加一段
「微弱的提醒」，只显示 6 个字符、超出带省略号。

### 实现（src/client.js）

- 模块级 `sessionOwnerMap`（`Map<sessionId, {accountId, accountLabel}>`，由
  `sessions()` 的 `lines[].sessionId` 建映射——sessionId 里的 slug 是会话的不是账号的，
  不可从 id 推导）+ `sessionOwnerFetched` + `sessionOwnerCtx`（`registerUi` 开头停靠，
  因为 seat 只传 sessionId 不传 ctx）。
- `loadSessionOwners(ctx)` fetch once 失败静默；`ownerHintText` 按 code point 截
  6 字加 `…`；`useSessionOwner(sessionId)` hook（惰性初值 + effect fetch，按 sessionId
  依赖，卸载置 `alive=false`）。`SessionRowMark` 在 svg 后渲染淡色 span（fontSize 11、
  maxWidth 84、ellipsis），无归属渲染不出。
- 归属与卡片同源（`/api/weixin/sessions`），历史裸 key 会话对不上号 → 只有图标。

### 测试（test/client-session-row-mark.test.js，8 条）

- `mountRowSeat({conversations})` / `markFor(sessionId, {conversations})` 增参；
  新 helper `stringChildren(tree)`；新测试 2 条（6 字截断提示、无归属无提示但图标在）。
- **两个教训**：(1) vm sandbox 里没有 `console`——src 里插桩 `console.error` 静默不打印，
  测试 harness 的 sandbox 必须注入 `console`；(2) walk 树的类型守卫顺序——
  `typeof tree !== 'object'` 放在字符串分支**之前**会把所有文本子节点丢弃，
  `stringChildren` 的正确顺序是 array → string → object。
- 调试弯路：用 `node -e` 字符串替换做插桩，TAB 缩进不匹配时**静默不生效**，
  得出「loadSessionOwners 没跑」的错误结论；可靠插桩必须用 edit 工具。
  诊断插桩绝不能用 `git checkout -- <file>` 还原——会把整天的测试改动一起清掉。
- 辨别力：stash src/client.js → 恰好 1 红（faint account hint 测试）；全量 313 pass。

## （六）账号标识并进会话标题（2026-10-18）

用户两轮实机反馈侧栏行内的「弱提醒」元素被宿主挤压（fixed 44px 单元格也没能幸免），
且本地源码 grep 不到宿主对该槽位的布局约束，无法在插件侧修。采纳用户提议：**放弃独立
hint 元素，把账号标识写进标题本体**（`备注名: 第一条消息`，用户原话
「panqing:会话标题 这样」）。

- `src/account-registry.js` 新增 `labelForAccount(accountId)`（只读、容错，失败读作 ''）。
- `src/sessions.js` 新增 `titledWithAccount(text, accountId)`：账号作用域线标题 =
  `<label 或账号 id 短形式>: <titleFrom(text)>`；裸 key 线（升级前历史）不加前缀。
  `title()` 改走它。registry 读取包 try/catch，绝不阻塞命名。
- `src/client.js` SessionRowMark 撤掉 hint span，回归纯图标；`useSessionOwner`/
  `loadSessionOwners` 保留（卡片仍读归属）。
- 测试：`two accounts…` 断言改为读前缀形状；row-mark 的 hint 测试改断言
  「不再渲染任何带 … 的 hint、svg 仍在」。
- 辨别力：stash src 三文件 → 恰好 2 红（两条新断言）；全量 313 pass。
- 教训：往宿主槽位塞第二元素会被挤压两次证明，**文本并入既有字段是最挤不坏的载体**；
  更新既有测试断言时先跑一次看实际形状再改期望，别凭记忆写。

## （七）首条消息把标题镜像进宿主会话（2026-10-18）

（六）落地后用户反馈「新会话没看见改变」：实测确认插件侧已生效（sessions.json 标题
`panqing: …`），但**侧栏渲染的是宿主的会话标题**（宿主自己用 LLM 起名），不经插件的
sessions.json。要让侧栏也显示 `备注名: 消息`，必须写宿主的标题。

- **宿主机制**（asar 反汇编确认）：`sessionTitle` 是宿主根 context 的 Cordis 服务
  （`SessionTitleService`，inject `["sessions","sessionProjections"]`）；
  `rename(session, title)` 校验 session 在宿主 store 内活跃后
  `session.append("session/title", { title, source: { kind: "user" } })` —— user 来源
  **钉住标题**：自动生成被取代、后续消息不再起名。这正是我们要的语义：第一条微信消息
  定名，宿主不再覆盖。
- **实现**：`src/sessions.js` `title()` 返回本次**新设**的标题（已有标题/找不到行返回
  undefined，调用方据此只在首条消息时镜像）；`src/agent-bridge.js` deliver 在
  `lines.title(...)` 返回新标题时调 `#mirrorTitle(agent, title)`：
  `ctx.get('sessionTitle').rename(agent.session, title)`。best-effort——服务缺失
  （纯 CLI）、session 不在宿主 store（冷启动竞态）、标题被拒都只 warn 不抛，store 标题
  才是事实源；第二条消息永不改名，宿主标题也保持钉在第一条。
- **测试**（test/busy-turns.test.js +2）：镜像恰一次、携带 store 的前缀标题
  （`c0ffee000000: 你好`）、第二条消息不再镜像、无 sessionTitle 服务不致投递失败。
  教训两条：夹具 session.id 是写死的 `weixin-room-1`，断言镜像目标要按夹具值；
  守卫只应查 `session.id` 是非空字符串——查 `session.append` 会把一切假 agent 挡在门外，
  而宿主的 rename 并不需要 append 在调用方手上。
- 辨别力：stash src/agent-bridge.js + src/sessions.js → 恰好 2 红（两条镜像测试）；
  全量 315 pass。

## （八）关于页签：版本、检查更新、项目链接

**需求**（2026-10-18，截图参照 DSH 内置 web-login 设置页）：设置卡加「关于」页签——当前版本、检查更新、项目 GitHub 链接、介绍与数据位置。

**实现**：
- `src/client.js` 新增 `AboutSection`（TABS 第五项 `id: "about"`）。检查更新走**浏览器侧 `fetch("https://registry.npmjs.org/<pkg>/latest")`**——卡片本就运行在宿主渲染进程、拿得到全局 fetch，一次 GET 不值得加宿主 Remote 方法与 round-trip。
- 版本号来自 `src/client.js` 顶部常量 `PLUGIN_VERSION`（`const PLUGIN_VERSION = "0.7.0";`）：卡片不能 import package.json，所以 release 脚本负责同步——`bin/release.mjs` 的 `bumpVersion()` 新增 client.js 的 `PLUGIN_VERSION` 行替换（缺行即 `die`，防止静默漂移）。
- 检查失败文案明确「可能是网络拦截，插件本身没有问题」（GitHub/npm 在部分网络下不可达是常态，不能让用户以为插件坏了）。
- 三块内容：版本+检查更新按钮+结果行；项目链接（github.com/panqing0313/dsh-plugin-weixin）+一句介绍；数据位置（`~/.dsh/weixin`，卸载不删、删目录即清空）。

**测试**：`test/client-settings-tabs.test.js` tablist 断言加 `id: "about"` 与 `createElement(AboutSection, { ctx, t })`。辨别力：stash `src/client.js` + `bin/release.mjs` → 恰好 1 红；全量 315 pass。

**教训**：react stub 测试只能做源码文本断言，`AboutSection` 的 fetch 状态机无法在测试里驱动——首渲染 `checkState="idle"` 无副作用，因此文本断言足够钉住接线；真正的网络分支靠文案形状断言。

## （九）首联系人自动登记：扫码人自动进白名单

**需求**（2026-10-18）：第二人扫码后发消息无回复，日志实锤 `refused message from ... not on the
allowlist`。这是设计行为，但暴露一个真缺口——扫码时服务端只给 bot id（`@im.bot`），**人的微信 id
要等第一条消息才出现**，所以「首次扫码自动加白名单」不可能在登录时做，只能在第一条消息处做。

**拍板方案**（用户确认）：账号级白名单为空（卡片没配过、registry 也没登记过）时，第一个发信人
视为扫码人本人，自动登记进该账号的 registry 白名单并放行这一条；只认第一条——之后的其他陌生人
照旧拒绝，防止「随便谁先发消息谁就拿到权限」。

**实现**：
- `src/account-registry.js` `enrolFirstContact(accountId, senderId, hasOverride, note)`：已登记
  过（`firstContactEnrolledAt`）或账号有自己的白名单覆盖则不动；登记时 `allowedSenders` 取
  **全局名单 ∪ 首联系人**（第一版只写 `[senderId]`，被 e2e 抓出：`allowlistForAccount` 的语义是
  entry 非空即整体替换，登记瞬间把全局名单顶掉了）。
- `src/index.js` createInboundHandler 拒绝分支先尝试登记，成功后重解析
  `allowlistForAccount` 放行本次；`effectiveConfig = { current: accountConfig }` cell 让同一条
  消息立即按新名单走（`accountConfig` 是 const 捕获，不能重指向）。
- `src/client.js` 登录卡账号行下方新增白名单摘要：有名单列 sender id；没有则提示
  「暂用全局名单，第一条消息的发送者会自动登记」。

**测试**：`test/e2e.test.js` 两条改为新契约（首陌生人登记放行、第二个陌生人才拒、CDN 下载数按
新行为计）；`test/session-commands.test.js`「refused sender cannot steer」改两步——首陌生人
`/new` 得到回复（**命令永不开 agent session**，第一版断言 `sessionsOpened>0` 等超时是设计错误），
第二陌生人 `/list` 被拒且 `sessionsOpened` 仍为空。

**辨别力**：stash src/index.js + src/account-registry.js → 恰好 3 红（全是新契约测试）；全量
316 pass。

**教训**：改「陌生人的第一件事」这类安全前置路径时，先把每个依赖「陌生人一律拒」假设的测试翻出来
（e2e、session-commands），契约一起改，否则全量回归要来回几轮。

## （十）出站限速与失败冷却（2026-10-18）

**为什么**：发送封锁的实测教训——约 20 条/几分钟会触发账号级发送封锁（≥30 分钟）。
一条分片回复 + 附件在热闹会话里就能逼近这条线，而服务端开始拒绝后继续猛发，只会把
临时拒绝升级成封锁。此前这两件事都没有保护。

**做法**（不丢消息，只延迟）：

- `src/message/rate-limit.js` 新建 `OutboundPacer`：`acquire()` 等到距上次发送
  ≥ `minIntervalMs`（默认 1200ms）才放行；`noteSuccess()` 清零失败计数；
  `noteFailure()` 连续 3 次失败后进入 `cooldownMs`（默认 30s）冷却。`now`/`sleep`
  是测试缝，虚拟时钟下零真实等待。首条消息永不延迟（`lastSendAt` 初始 `-Infinity`，
  默认 0 在 t=0 的时钟下会算出 gap=0 触发整段等待——测试抓出来的真缺陷）。
- `src/transport/ilink.js`：`send()` 与 `sendMedia()`（文本分片和附件的唯一共同缝隙）
  均改为 acquire → try → noteSuccess / catch noteFailure + throw；pacer 挂在
  `this.pacer` 普通属性上（构造参数 `sendIntervalMs`/`sendCooldownMs` 可注入覆盖）。
- `src/index.js`：Config schema 加 `sendIntervalMs`(1200)、`sendCooldownMs`(30000)，
  传入 ILinkTransport 构造；`src/config-remote.js` 设置页配置项标签页同步两字段
  （中英标签/提示/范围），否则「每个 schema 字段必须在表单可达」的一致性测试红。

**测试**：`test/rate-limit.test.js` 8 条（虚拟时钟 fakeClock/fakeSleep）：首发不等待、
间隔补足、间隔已过不等待、3 次失败武装冷却、成功清零计数、冷却与间隔的组合等待
（pacer 在间隔 sleep 后重测冷却剩余）、默认值与封锁线的关系、非法配置回退默认。
**辨别力**：移除全部 5 个改动文件后 8 条全红 + config-remote 一致性测试红；恢复后
324 pass / 0 fail。

**教训**：`git stash push` 对 intent-to-add（`git add -N`）的新文件会报
`Entry ... not uptodate. Cannot merge.`——辨别力改用「备份 → checkout 原文件 →
删除新文件 → 跑 → 还原」的文件级操作更稳。

## （十一）/status 会话命令（2026-10-18）

**为什么**：之前每次「为什么没回复」都要翻宿主日志；手机微信里没有一条命令能自己看
账号活不活着、白名单收了谁、当前在用哪条会话线。

**做法**：`/status` 加入会话命令族（`/new` `/list` `/use` `/clear` 同一路径）。

- `src/sessions.js`：`parseSessionCommand` 加 `/status`（与 `/clear` 一样不带参数，
  带参数就不算命令，整条消息落到 agent）；`runSessionCommand` 加可选第 5 参
  `context`——账号级事实由调用方组装，无 `context` 时（裸调用、测试）降级为只报
  会话线信息，不虚构账号数据。
- `src/index.js` 入站 handler 在 `bridge.handleCommand` 调用点现场读 registry
  （entry 可能自 handler 构建后已变）：label、`isAccountPaused`、`lastSeenAt`、
  白名单来源（entry 有 override → 「本账号专属名单」，否则「全局名单」）与生效
  名单（`effectiveConfig.current.allowedSenders`，首联系人登记热换后的名单）。
- `src/agent-bridge.js` `handleCommand` 加第 4 参透传。
- 回复形态：`账号：panqing（<id>）`/`状态：正常收发|已暂停`/`最近收发：…`/
  `发信人白名单：N 人（来源）`/`本微信会话共 N 条会话线，当前使用第 X 条：标题`。

**测试**（新 5 条）：sessions.test.js 4 条（无 context 降级、带 context 全字段、
paused+全局名单、解析精确性——`/status extra` 与 `/statistics` 都不算命令）；
session-commands.test.js 1 条（真 handler 链路：白名单行、会话线行、
`sessionsOpened` 保持空 = 不花模型轮次）。

**辨别力**：把三个源文件还原到 HEAD 再跑受影响两个测试文件 → 恰好 5 红（全部
/status 用例），恢复后 44 全绿、全量 329 pass。教训：对**已 staged 的文件**用
`git stash push --staged` 再跑，红测试在 stash 期间反而 pass——staged 状态下
`--staged` 只撤 index 不撤工作树的场景使「无修复」基线不可信；可靠的辨别力
做法是 `git show HEAD:<file> > <file>` 还原三件源文件、跑完立即从 /tmp 备份恢复。

## （十二）消息里的链接自动抓取（readLinks）（2026-10-18）

**为什么**：用户把文章、GitHub issue、文档页链接粘进微信问「这讲了什么」，Agent 之前只能回
「我打不开链接」——prompt 里只有 URL 字符串，没有页面内容。

**做法**：入站消息含 http(s) 链接时自动抓取正文拼进 prompt（`config.readLinks`，默认开）。

- `src/message/links.js`（新）：`extractUrls`（lookahead 正则剥尾部中文标点——`。！？；，、`
  粘在 URL 尾部会被剥掉，query string 里的 `?a=b` 不受影响；去重保序）、`fetchLinkText`
  （http(s) only；二进制 content-type 拒读并报「内容是 image/png，不是可读文本」；正文上限
  20000 字符截断标记、原始响应上限 512KB；**任何失败都返回 `{ok:false,reason}` 不抛错**）、
  `htmlToText`（去 script/style/head、块标签转行、常见实体解码——刻意不是完整 DOM 解析器，
  目标是「够 Agent 回答」的文本）、`describeLinkResults`（成功=【链接内容：title】+三引号围栏
  正文；失败=【链接无法读取】url：原因 一行）。
- `src/index.js`：prompt 组装处（媒体下载之后）最多取 3 条链接逐个 fetch，成功正文围栏进
  prompt，失败一行原因——**死链绝不吞掉用户的其它问题**。
- `src/config-remote.js`：表单加 `readLinks`（boolean，默认 true，权限组之后）。

**测试**：`test/links.test.js` 7 条（提取唯一性+中文标点、HTML 剥取带 title、截断标记、
四种失败形状不抛错、htmlToText 实体解码、describeLinkResults 围栏形状）；
`test/e2e.test.js` 新增 readLinks e2e（on：页面正文进 prompt、script 体不进、用户原话保留；
off：零网络请求、prompt 无链接块）。

**辨别力**：三个源文件还原 HEAD → 恰好 1 红（readLinks e2e）；恢复后全量 337 pass / 0 fail。
**教训**：裸 `node --test test/e2e.test.js` 不加载 `test/isolate-host-state.mjs`，
`DSH_WEIXIN_LOG_DIR` 未重定向会让两条既有断言（vendor log dir redirected、readDurableLog）
假红——辨别力和全量都必须走 `npm test` 的 script 入口。

## 定时消息 /remind（本轮）

- 用户诉求：希望机器人能在指定时间主动发消息（例如开会前 10 分钟提醒）。
- `src/message/scheduler.js`（新）：`parseWhen` 支持相对时长（`10m`/`2h`/`1d30m` 连写）、
  `HH:mm`（今天/明天滚动）、`YYYY-MM-DD HH:mm`；拒绝过去时间、25:00、超过 366 天。
  `ReminderScheduler` 持久化到 `<stateRoot>/reminders.json`（tmp+rename 原子写）；到点用
  当前账号的 transport 直发「（提醒：内容）」，**不经过 agent 轮次**（定时消息是插件自己的
  行为，不应消耗模型调用）；到点时账号未在线则警告并丢弃（重启后不补发过期提醒——
  「晚到好过静默丢」只适用于进程活着的情况）；每个账号上限 50 条待发。
- `src/sessions.js`：`/remind`、`/remindlist`、`/remindcancel` 三个会话命令；调度器不可用时
  诚实报错而不是假装已安排。
- `src/index.js`：scheduler 在 setup 时创建（stateRoot + warn + fire 回调查 transports），
  经 `createInboundHandler` 参数透传给命令层。**教训：顶层函数不能引用 apply 作用域的变量**——
  最初直接写 `reminders: reminderScheduler`，每条消息 dispatch 都抛 ReferenceError 被错误
  边界吞掉，表现为「全部消息无回复」；这正是它必须走参数透传的原因。
- 测试：`test/scheduler.test.js` 7 条（虚拟时钟）；`test/session-commands.test.js` 2 条
  全链路（真 transport 出站、持久化落盘、取消）。辨别力：HEAD 还原后恰好 2 条新测试红。

## 消息流水 messageJournal + 设置卡「消息流水」页签（本轮）

- 用户诉求：定时任务希望有界面管理（/remindlist 已够聊天侧用）；补做之前排序里的可选功能 5
  （多账号消息聚合视图）。
- `src/message/journal.js`（新）：`appendJournal` 追加 JSONL 到 `<stateRoot>/journal/journal-YYYY-MM-DD.jsonl`
  （按天滚动、文本截断 200 字符、**失败只 warn 永不抛**——流水是观测工具，不能反过来弄坏收发）；
  `readJournal` 从最新文件往回读到 limit（默认 50），坏行跳过。
- `src/index.js`：出站在 `sendChunked` 挂点（覆盖回复/提醒/媒体文本全部出站），入站在
  `createInboundHandler` 入口（仅 text）。**教训重演**：`sendChunked` 是模块级函数，
  `journalOutboundRef` 声明在 apply 作用域内会再现 `ReferenceError` 被吞 → 必须提到模块级
  （声明处注释写明原因）；`createInboundHandler` 侧继续走参数透传。
- `src/login-remote.js`：新增 `journal({limit?, accountId?})` remote 方法（host 侧），
  `src/client.js` 补同名 descriptor（form↔schema 一致性测试强制两侧同步，这次真的先红后绿抓到了）。
- `src/client.js`：新增 `JournalSection` + 第 6 个页签「消息流水」（时间、↓收/↑发、账号、内容）。
- `src/config-remote.js`：配置表单加 `messageJournal` 开关（默认 true）。
- 测试：`test/journal.test.js` 6 条（含 unwritable path 不抛、torn line 跳过）；e2e 1 条
  on/off 双态（收发都落盘 / off 零文件）；settings-tabs 断言新页签。辨别力：HEAD 还原后
  恰好 1 条 messageJournal e2e 红。

## 设置卡「定时提醒」页签（本轮）

- 用户追问「没有定时任务的管理界面吗」→ 补上：`RemindersSection` 第 7 个页签，列出待发提醒
  （时间 + 内容）并带取消按钮，走新的 `reminders` / `remindCancel` remote 方法。
- 接线沿用 messages journal 的教训：`remindersProvider` 是 controller 上的普通属性（绝不 #private），
  setup IIFE 创建 scheduler 后挂上；provider 缺失时方法诚实回 `{available:false}` 而不是崩溃。
- **两个新教训**：
  1. 真 Cordis 的 ctx 是受保护对象，`ctx.anything = x` 抛 `cannot set property ... without provide`
     且被 apply 的 try/catch 吞掉 → 之后 `ctx.get('weixinLoginController')` 变 undefined。
     测试钩子不能往 ctx 上挂属性；e2e 的假 ctx 改从 `reflect.provide(name, self)` 的第二个参数捕获。
  2. python 插入组件时第一个断言失败后，重试只补了引用（tab 行）没补函数体 →
     `RemindersSection is not defined` 一口气红了 17 条卡片测试。教训：插入失败后必须
     `grep -c "function X"` 确认本体真的在。
- e2e 用 `/remind 90m …` 而不是绝对日期：`parseWhen` 的命令切分是首空格，
  `/remind 2050-01-01 09:00 x` 会把 when 切成 `2050-01-01`、text 切成 `09:00 x` → 「看不懂这个时间」。
- 辨别力：HEAD 还原 6 文件 + 移走未跟踪测试后全绿（353），恢复后 357——新测试钉住新代码。

## /help 会话命令（本轮）

- 用户诉求：增加一个命令显示有哪些命令可以用、各自干嘛。
- `src/sessions.js`：`parseSessionCommand` 加 `/help`（别名 `/帮助`、`/指令`）；`runSessionCommand`
  直接回 `SESSION_COMMANDS_HELP`（帮助文本首行改为「发 /help 或 /帮助 可再看一遍」）。命令族由此
  自描述：以后加新命令只需同步 SESSION_COMMANDS_HELP，用户侧就能发现它。
- 测试：`test/session-commands.test.js` 2 条（内容逐行断言 + `/帮助` 别名 + 不产生 agent 轮次）。

## 长尾补齐一轮：出站限速接线 / `/cancel` / 工具审计 / 发版清单 / 状态卡自刷新（2026-10-23）

用户要求「分任务继续完成，全量验证成功了后才能提交」：把上一轮列出的未完成项拆成任务逐条做，只有
`npm test` 全绿才提交。五项，全量 389 条测试通过。

### 一、出站限速真的接上了（原先只有库，没有接线）

- **发现**：`src/message/rate-limit.js` 的 `OutboundPacer` 写得很完整，`test/rate-limit.test.js` 也测它，
  但 **`src/` 里没有任何地方 import 它**。`git log -S "this.pacer" -- src/transport/ilink.js` 与
  `-S sendIntervalMs -- src/index.js` 都是空的——`docs/progress.md` 里那段「`this.pacer` 普通属性上…
  Config schema 加 sendIntervalMs/sendCooldownMs」记录的是一个**从未提交的设计**。结果是 0.9.0 的
  「出站限速」实际没生效，README 与设置卡都在描述一个不存在的行为。
- **教训**：文档写「已实现」不等于实现。收尾时必须用 `grep`/`git log -S` 验证「文档说的符号真的被引用」，
  而不是相信上一轮的文字。
- `src/transport/ilink.js`：构造器建 `this.pacer`（可用 `options.pacer` 注入，`sendIntervalMs`/`sendCooldownMs`
  分别映射到 `minIntervalMs`/`cooldownMs`）；`send()` 与 `sendMedia()` 都是 `await this.pacer.acquire()` →
  发送 → 成功 `noteSuccess()` / 失败 `noteFailure()` 后重抛。`sendMedia()` 的 acquire 覆盖「说明文本 + 附件上传」
  整段（注释写明为什么不是两次）。
- `src/index.js`：schema 加 `sendIntervalMs`（默认 `DEFAULT_SEND_INTERVAL_MS` = 1200）/ `sendCooldownMs`
  （默认 30_000），并把两者传给 transport；`src/config-remote.js` 表单加两个字段（毫秒，带上下限）。
- **新增滚动窗口**：固定间隔挡不住「一分钟内连发 20 条」。`rate-limit.js` 加 `DEFAULT_WINDOW_MS = 120_000`、
  `DEFAULT_WINDOW_MAX = 15`：`acquire()` 在间隔等待后 prune 窗口，满了就等到最早那条滑出窗口再发，并 warn
  `outbound send window is full …`。15 条 × 1500 字符 = 22 500 字符，普通长回复不会被这条挡到。
- 测试：`test/rate-limit.test.js` 17 条（8 条原有 + 9 条新：接线三条用记录型 pacer + stub fetch 断言
  `acquire/success`、`acquire/failure` 且仍抛 `sendMessage ret=1`；媒体路径同样；配置值真的进到 pacer；
  窗口四条含「满窗等 8000ms」「过期不计」「失败不占窗口」「默认值 15/120_000」）。
- **注意**：没有测试构造真的会发网络的 `ILinkTransport`，所以真实 pacing 不会拖慢测试套件。

### 二、`/cancel`：中断正在跑的那一轮

- 缺口：长工具跑（构建、扫描、卡住的子代理）在微信里没有出口。`/steer` 是往已经太慢的那一轮里加话，
  普通消息则排在它**后面**——用户说「停」，要等它自己跑完才听得见。
- `src/sessions.js`：`parseSessionCommand` 加 `/cancel`（别名 `/取消`），`SESSION_COMMANDS_HELP` 加一行，
  `runSessionCommand` 加分支，走 context 里的 `cancelRunningTurn()`（只有 bridge 拿得到活 agent）。
- `src/agent-bridge.js`：`#cancelRunningTurn` 在 `record.busy !== true` 时回「不需要取消」，宿主没有
  `cancel` 时诚实回「不支持中断回合」，否则**先置 `record.cancelled = true` 再** `agent.cancel({ kind: 'user' })`
  （顺序反了会让 abort 先被读成模型失败）；`#awaitReply` 两个轮询循环都在读回复**之前**检查这个标记，
  命中就返回 `{ text: '', cancelled: true }`；`finally` 里清标记（否则下一轮的回复会被吞）。
  `src/index.js` 收到 `cancelled` 只记日志、**不发空消息**（微信里会变成空白气泡）。
- 测试：`test/cancel-turn.test.js` 5 条（解析含别名、空闲时不动手、忙时回执 + `cancel({kind:'user'})` +
  结果是「已取消」不是「模型调用失败」、标记不泄漏到下一轮、宿主无 `cancel` 时不假报成功）。
- 假 agent 的 `snapshotEvents` 事件必须带 `type`：我第一版只 push 了 `{ seq, time, data }`，reader 读到
  `undefined` 类型 → 一轮永远不 settle → 3s 后超时。**假事件流的形状要跟真事件一致**，否则测的是自己的 bug。

### 三、工具审计落盘（`<stateRoot>/audit/`）

- 缺口：`ctx.logger` 是滚掉的过程流，消息流水只有文本进出，所以「昨天 15:20 是谁让它删了那个目录」
  答不出来。
- `src/message/audit.js`（新，仿 `journal.js`）：`appendToolAudit` 追加到
  `<stateRoot>/audit/audit-YYYY-MM-DD.jsonl`，一行一件事，靠 `callId` 配对——`tool/call`（工具名、截断 500
  字符的参数、账号 / 会话 / 发送者）与 `tool/result`（`ok`、`durationMs`）。文件永远追加，不改历史。
  参数 `JSON.stringify` 失败（循环引用 / BigInt）退回 `String()` 也要留一行；追加失败只 warn，**绝不抛**。
- `src/agent-bridge.js`：新增 `onToolAudit` 选项（不传 = 不审计，裸 bridge 不写文件），`record.auditSeq`
  保证同一次工具调用在多轮轮询里只记一次、也不会把历史事件重复记；`#auditEvents` 在**读回复之前**调用，
  所以「同一个 poll 里就 settle 的快速回合」也能被记到。`deliver({ senderId })` 把触发者一路带到
  `#enqueue`/`#runQueuedTurn`；`sessionId` 在**发出审计行时**读 `agent.session.id`（`/new` 可能在排队期间
  换了会话，审计要记工具真正跑在哪条线）。
- `src/index.js`：`toolAudit` 配置（默认 true）→ `onToolAudit: (entry) => appendToolAudit(stateRoot, entry, { warn })`；
  `deliver` 传 `senderId: message.senderId`。`src/config-remote.js` 加同名开关。
- 测试：`test/tool-audit.test.js` 7 条（写入/读回、截断与不可序列化、撕裂行跳过 + 过滤 + 不可写目录只 warn、
  一轮只记一次且带归属、错误结果 `ok:false`、无 sink 不影响轮次、默认开关）；e2e 加 1 条 on/off 双态
  （真的接到磁盘 / 关掉零文件），e2e 的假 agents 因此支持脚本化 `tools`。
- **没记什么**：不记工具输出内容（可能极大，且已在会话记录里）。参数是模型原文，可能含密钥——审计文件
  是本地文件，别直接贴进公开 issue。

### 四、发版清单不再漂移

- `package-lock.json` 的两处 `version` 还停在 `0.1.1`，而 `package.json` 是 `0.9.2`。用真 npm 刷新
  （`npm install --package-lock-only --cache "$PWD/.npmcache"`），顺带把依赖图对齐到 `package.json`。
- `bin/release.mjs`：新增 `manifestVersionProblems()`，preflight 在两个清单版本不一致时 **die**（并给出
  刷新命令），`--allow-stale-lockfile` 可显式绕过；`bumpVersion` 同步改锁文件两处版本；`snapshotTextFiles`
  把锁文件纳入 `--dry-run` 回滚范围；脚本只在被当脚本跑时执行（`import.meta.url === pathToFileURL(argv[1])`），
  所以测试能 import 这个守卫。
- 测试：`test/release-lockfile.test.js` 5 条（一致 / 两处都旧 / 只旧一处 / 字段缺失 / 锁文件解析失败）。

### 五、状态卡自己刷新

- 多端登录或服务端会话失效时，设置卡原来只在挂载与登录事件时刷新，会一直显示过期状态。
- `src/client.js`：`STATUS_POLL_MS = 15000` 的自调度 `setTimeout`（**不用 `setInterval`**，登录轮询的
  harness 把 setInterval 判为失败），加上 `focus` 与 `visibilitychange`→visible 时立即刷新；`reading`
  保证不叠请求（跳过而不是排队）；QR 登录轮询持有卡片时后台不读（`sessionKeyRef` 已在那里）；没有
  `window`/`document` 的宿主（测试 harness）不装定时器与监听；卸载时清定时器与监听。
- 测试：`test/client-login-poll.test.js` 加 1 条（15000ms 定时器、两个监听、隐藏不读、不叠请求、登录中不抢读）。

### 六、真机复测：`/cancel` 结构上根本打不通（`39cd6c6`）

- 真机两次实测（`sleep 90` / `sleep 180`）全失败：轮次跑着时发的 `/cancel` 全部在**轮次结束后**才被回答，
  内容是「当前没有正在跑的回合」；四次 `/cancel` 集中在轮次结束后 2–3 秒内回复，这就是指纹。
- 根因：`src/transport/ilink.js` 的 `for (const raw of msgs) { … await dispatchMessage(...) }` 把「处理这一条
  消息」和「整轮 agent」串成一条链。轮次跑着时循环停在一条消息里，没有新的 `getUpdates` 在飞，后面的消息
  （包括 `/cancel`）只能留在服务端。也就是说 `/cancel` 是个**实现过但到不了**的功能——和 `99624e8` 之前的
  `OutboundPacer` 同一类缺陷；`test/cancel-turn.test.js` 之所以一直是绿的，是因为它直接调 `handleCommand`
  并手工把 `busy` 置真，根本没经过轮询循环。
- 修复分三半（解决的是三个不同问题）：
  1. 循环不再 `await` 处理结果 → 轮次在跑时下一次 `getUpdates` 已经在飞；
  2. 同一会话仍然**按顺序**投递：`createInboundScheduler()` 用 `chains`（`Map<conversationId, Promise>`）
     串链，`.then(run, run)` 保证一条失败不毒化后面的链，不同会话互不阻塞。只去掉 `await` 不加链，会让
     同一会话相邻两轮的工具调用与回复交错——bridge 自己的队列顶不上，它要等 `deliver()` 被调用才生效；
  3. `/cancel` 走 `bypass`：`isInterruptCommand()`（`src/sessions.js` 导出，与解析器共用 `CANCEL_COMMAND`）
     → `src/index.js` 传 `bypassQueue`，这条命令跳过链立即处理，否则它会排在它要去中断的那一轮后面。
- `stop()` 现在 `await scheduler.drain()`，保留原来「卸载时等当前轮次结束」的语义（否则插件已经卸载还在往外发）。
- 顺带修掉一个潜伏的句柄泄漏：`start()`/`stop()` 用 `sleep(longPollTimeoutMs * 2 + 10_000)` 给
  `notifyStart`/`notifyStop` 兜底，race 输掉后那个 80s 定时器仍然存活，进程要空等它 → 改成
  `deadline()`（`timer.unref?.()`）。全套测试因此从 ~103s 降到 ~36s，断言一条没动。
- 测试：新增 `test/turn-dispatch.test.js` 6 条（同会话按序、跨会话并发、`/cancel` 插队、抛错的 handler 不毒化
  链、`isInterruptCommand` 只认 `/cancel` `/CANCEL` `/取消`、以及**真的经过 `ILinkTransport.start()` 的
  socket 级回归**）。做了负向验证：把循环改回 `await`，那条 socket 用例立刻失败（只跑完 `long task`），
  改回来即绿。
- 真机复测（23:29：`sleep 120` → 23:30:25 `/cancel`）通过：轮次中途就回「已请求取消当前回合。」，
  日志出现 `turn cancelled by user for …`，之后 `/help` 正常。同时暴露一个审计缺口：被中断的
  `tool/call bash` 永远等不到 `tool/result`（宿主被杀掉的工具不会报结果，桥也提前返回了），文件里留下
  一条悬空的调用——恰好事后最想问的那条。修法：取消分支先把这一轮已产生的事件刷进审计，再对仍在飞行
  的调用补一行 `ok:false, aborted:true, durationMs`（`#auditAbandoned`），「工具报错」与「没人报结果、
  用户停了它」在文件里不再混淆。
- 测试基建的两个教训（都踩实了）：
  - `test/inbound-loop-start.test.js` 的假服务器原来「每次 poll 都造一条新消息」。派发改成不等之后，循环
    毫秒级拉取，一轮队列涨到 **16558** 条，`stop()` 的 drain 永远等不完（全套卡死 400s+）。改成消息队列
    （`push()` 才有一条）+ 响应 10ms（客户端单轮截止时间由服务端 `longpolling_timeout_ms` 决定，50ms/50ms
    就会客户端超时、消息丢失，表现为「handler 一次都没被调用」）+ 死连接时把消息 `unshift` 回队列。
  - 「账号级白名单覆盖后重启」的用例必须等**新一轮的 `listening as account …`** 再投递消息：
    `createInboundHandler` 的 `accountConfig` 每次 bring-up 只解析一次，消息被正在被替换的那条 transport
    抢走时还用旧白名单判断（约 1/3 概率失败）。`onAccountControlChange` 是 fire-and-forget，所以只能靠这行
    日志确认新 transport 已经起来。

## 发布 0.9.3（2026-10-23）

- npm `latest` = `0.9.3`，tag `v0.9.3` 指向 `4faad53`，GitHub release 已建；注册表 `dist.shasum`
  `5e9a4dfb76f1f778840f5ff90943baefd978e9f6` 与本地 `dsh-plugin-weixin-0.9.3.tgz`（67 个文件，986 kB）
  一致，`dist.integrity` 也对得上。
- 发版过程中真踩到的三件事，记下来省下次的时间：
  - `bin/release.mjs` 的 publish 步骤必须有真 TTY。在非 TTY 下 npm 会把一次性验证链接打成
    `https://www.npmjs.com/auth/cli/***`（打码），拿不到就没法授权。用 `script -q /tmp/out.log node
    bin/release.mjs 0.9.3 --yes` 起一个伪终端才拿得到真实链接；而且 npm 停在 `Press ENTER to open in the
    browser...` 等 stdin，得配上 `(sleep 70; printf '\n'; sleep 600) | script -q …` 喂回车。
  - 浏览器里授权完成后，那一条「卡在回车」的进程其实已经把包发出去了——重跑会撞
    `npm error You cannot publish over the previously published versions: 0.9.3`。看到这句先去
    `npm view dsh-plugin-weixin version` 确认，别再改代码。
  - 包内文件权限会被检查（`✗ file(s) in the tarball are not world-readable`）。工具写出来的文件是 0600，
    发版前 `chmod 644` 一下 `src/`、`test/` 下新增的文件。
- e2e 的一条断言原来是隐性依赖「所有会话串行」的：它按下标取 `sent[0]/[1]/[2]`。派发改成同会话有序、
  跨会话并发之后，两个发送者的回复会交错，这条用例就会偶发失败（同一小时内先绿后红）。改成按
  `to_user_id` 分组断言，谁的回谁的回，顺序无关。

## 出站语音：音频附件发成语音气泡（2026-10-25）

需求来自用户：「我看了一下机器人是可以发语音的，你能发实现这个出站语音功能」。此前 `silk` 只用于
入站（下载→WAV→ASR），出站侧 `media_type` 枚举里有 `VOICE=4`、wire 上有 `voice_item`，但 vendor
（Tencent openclaw-weixin 2.4.10，与 npm latest 同版）只实现了 image/file/video 上传，没有任何
`sendVoice`——所以这是补 vendor 缺失的那一半。

### 探针阶段（全部失败，教训比结论多）

- 先在插件外用脚本直发：3 秒正弦波 → silk-wasm `encode(pcm, 24000)` → 自建 `uploadVoice()`
  （`getUploadUrl` media_type=4 + `uploadBufferToCdn`，**上传成功**，能拿到 `x-encrypted-param`），
  再 `sendMessage`。第一版把 item type 写成 4（那是 FILE，VOICE 的 item type 是 3）被拒可以理解；
  第二版补齐 Codex_iLink 拆解文档里的完整字段
  `{type:3, voice_item:{media, encode_type:5, bits_per_sample:16, sample_rate:24000, playtime}}`
  的 6 种变体（含带 text、playtime 用毫秒、加 len）**全部 `sendMessage ret=-2 errmsg=prepare failed`**。
- 最可疑的变量是 `context_token`：kadaliao 的协议拆解说官方插件**没有 token 就拒发**（文本例外的
  事实成立——此前的 live-pace 脚本无 token 发文本确实送达）。想拿新 token：日志/流水里 grep 不到
  （0.9.x 的 file 发送记录过 `contextToken missing … sending without context`，说明历史上无 token
  也发出去过文件）；用持久化的 `get_updates_buf` 重放 getupdates 40 秒 → `msgs:0`，取不到。
  **结论：探针环境拿不到新鲜 token，wire 形态只能在插件真机上验证。** 插件路径一直带着真 token，
  这也是「先落实现、靠降级兜底、真机一测定形态」的依据。
- 反面教训：探针**绝不能自己 poll getupdates**——cursor 在活着的插件进程手里，乱 poll 会抢消息。

### 实现（5 个文件 + 12 条测试）

- `src/media/voice-encode.js`（新）：`isVoiceCandidate`（扩展名判断）、`parseWavPcm`（RIFF 解析，
  任意声道平均降混，非 PCM16 抛错转 ffmpeg）、线性插值重采样（目标 24kHz，SILK 支持的速率直接过）、
  `ffmpegToPcm`（`-ac 1 -ar 24000 -f s16le pipe:1`，覆盖 mp3/m4a/ogg/flac 等）、`transcodeToSilk`
  （`.silk` 直接透传 + `isSilk` 校验）、`buildVoiceItem`
  （`encode_type:5, bits_per_sample:16, sample_rate, playtime: max(1, round(ms/1000))`——playtime
  为 0 微信会渲染成不可播）。
- `src/media/outbound.js`：新增 `sendOutboundVoice`——SILK 上传走 `getUploadUrl(media_type=VOICE)`
  + `uploadBufferToCdn`（与图片/文件同一 CDN 管线，AES-128-ECB，aes_key 用 vendor 的
  base64(hex) 形态）；**说明文字先单独发一条文本**（上游规则：文字与媒体分开两条），信封与
  transport 的 `#body` 同形（`client_id` 前缀 `dsh-weixin-voice-`，回显 `context_token`）；失败包成
  `OutboundMediaError('send-failed')` 交调用方降级。上传/发送留 seam（transcode/buildItem/upload/send）
  供测试注入。
- `src/transport/ilink.js`：`sendMedia` 在 pacer 闸门内分支——`voiceOutbound !== false` 且
  `isVoiceCandidate(filePath)` 走语音路径，**失败则记一行日志并退回 `sendOutboundMedia`（文件）**：
  形态不对的最坏结果是「以文件送达」，绝不是「附件丢了」。
- `src/index.js` / `src/config-remote.js`：`voiceOutbound`（默认开）进 schema 与设置卡「配置」页签，
  描述里写明 ffmpeg 依赖与降级行为。
- `test/voice-outbound.test.js`（12 条）：wav 转码（含立体声降混 + 22050→24000 重采样）、非法 RIFF
  报错、silk 透传逐字节不变、ffmpeg 解 mp3（无 ffmpeg 环境自动 skip）、`buildVoiceItem` wire 形态
  （aes_key = base64(ASCII hex)，playtime 秒取整、250ms 也得 1）、`sendOutboundVoice` 信封断言
  （文本先行、token 回显、message_type/state、client_id 前缀）、seam 注入下发送拒绝 →
  `OutboundMediaError`、转码失败先于上传、以及三条走真 transport + 逐步脚本化 fetch 的集成：
  wav → `voice_item(encode_type 5)`；服务端 `ret=-2` → 降级发出 `file_item` 并留日志；
  `voiceOutbound:false` → 直接文件路径。
- 过程中抓到一个自己的 bug：`parseWavPcm`/`resamplePcm` 里用 `new Uint8Array(n)` 存中间 PCM，
  而 `writeInt16LE` 是 Buffer 的方法——纯 Uint8Array 上没有，转码必炸，且因为被「降级为文件」
  兜住，第一批 transport 集成测试只表现为 `kind:'file'` 而不是报错。教训：**降级兜底会把实现 bug
  化妆成路由 bug**，新分支的第一条集成测试要同时断言「走了新分支」（本例是 `kind:'voice'`）才能
  抓住这类问题。

### 状态

单测 12/12 绿，全量 `npm test` 410/410（~35s）。**真机气泡形态未验证**（探针拿不到
context_token，见上）；发到手机上若仍是文件，日志里会有 `voice send failed (…); sending … as a
file instead` 一行可定位。视频出站仍需编码管线，未做。

### 真机复测（2026-10-26）：服务端接受 `ret=0`，但不投递

用户重测后反馈「试了没发我」。排查链：

- 宿主 00:06:32 重启过，跑的确实是新代码；日志 `00:07:16 sent produced file: …sine-440hz-3s.wav`
  说明 `sendMedia` **成功返回**（若语音路径抛错会有降级日志、且文件路径成功的话手机会有文件——都没有）。
- 44.1kHz wav 本地逐环验证：silk-wasm `encode` 在 44100/48000/24000 都正常（1408/1451/1357 B，
  时长 300ms）；`#!SILK_V3` 前加 0x02（所谓微信味 silk）会让 `isSilk`/`decode` 都失败，而每日入站
  ASR 解码服务端下发的 silk 一直正常 → 本管线就是裸 `#!SILK_V3`，前缀论排除。
- 排除到最后只剩一个结论：**iLink 服务端接受机器人的 `voice_item`（`ret=0`）但不投递给收件人**。
  与 2026-06 的实测（旧 progress 记录「只接受不投递」）完全一致；token 新鲜、上传成功、send 成功、
  手机没声。大概率是账号侧语音/TTS 能力开关，客户端侧无解。

顺带抓到一个**观测盲区**：`ILinkTransport` 的 `log`/`errLog` 此前只接了宿主 logger，**weixin 日志文件
里从来没有过 transport 的任何一行**（grep 全部 10-13 至 10-26 日志，`sent … media` 为 0），「语音到底
发没发」这类问题在文件里无迹可查。修复：transport 的 `log`/`errLog` 现在同时写宿主 logger 与
`fileLog`；发送结果日志带上 sendmessage 的响应字段（`server ret=…, errmsg=…, server_message_id=…`），
下次再遇到「接受了没投递」从日志就能直接判定。

### 处置（2026-10-26）

- `voiceOutbound` 默认 **true → false**（schema、设置卡、README 同步）：一个「服务端 ret=0 但附件
  无声消失」的功能不能当默认路径；想要语音气泡的人在设置卡打开即可，发送被**拒**时仍自动降级文件。
- SILK 透传速率集收紧为编解码器真正支持的 {8k,12k,16k,24k}——silk-wasm 对 32/44.1/48k 也能编码
  但超出 codec 规范，一律重采样到 24k。
- 新增 1 条默认值锚定测试（`voiceOutbound` 默认 false、可显式打开），语音路径的两条 transport
  集成测试改为显式 `voiceOutbound: true`。全量 `npm test` → **411/411**（~35s）。
- 结论一句话：**代码就绪、默认关闭；服务端哪天放开机器人语音投递，把开关打开就行**。TTS（文字→
  语音合成）依旧是另一回事，未做。

## 个性化与记忆（2026-10-26，`f78f5ca` + `8f7dba2`，待随下次发版）

用户需求（原话）：“会话可以定制话对话风格，如女友、男友、朋友等等模式……配置项新开页签可以配置
个性化模式，增加配置全局记忆和会话记忆，让对话更亲和更人性化”。方案确认后按 P0 模式 → P1 记忆
命令 → P2 后台摘要三步实现。

### 行为

- **对话模式**：内置 默认助手 / 女友 / 男友 / 朋友，用户可自定义至多 8 个。`/mode` 看列表，
  `/mode 女友` 切换——切换会**开一条新会话线**（旧会话保留，`/list` 可切回），避免旧上下文污染
  新人设。模式以 `<weixin_persona>` 块注入 prompt；内置提示词自带边界段（人设只改语气，不改编
  事实、不拒任务、不做医疗/法律/投资建议）。`/mode 默认` 显式钉回纯助手（哪怕全局默认是人设）。
- **两级默认**：会话覆盖（`persona-active.json`，键 `accountId|conversationId`）> 全局默认
  （同文件的 `__global__`，设置卡选）> 配置项 `personaDefaultMode`。`activeModeFor` 是唯一
  解析点，命令/注入/卡片共用。
- **长期记忆**：`/remember 内容` 写入 `memory/global-<账号>.json`（去重、上限
  `memoryGlobalMaxFacts`=30 条；**存满后拒绝新增**而不是挤掉最旧的——用户当它可靠清单用）。
  `/forget 编号或关键词` 删除，`/memory` 查看全部 + 本会话摘要 + 最近窗口。
- **会话摘要**：每 `memorySummaryTurns`（默认 10）个已完成的 agent 回合，后台用一条**侧会话**
  （`wx-mem-<sha1>`，origin 'subagent'，无任何出站通道）把「旧摘要 + 最近 10 条流水」压成
  ≤400 字新摘要，写入 `memory/conv-<账号>-<会话>.json`。下一个 prompt 以 `<weixin_memory>` 块
  注入：长期事实 + 会话摘要 + 最近 5 条消息（每条截 160 字）。计数不受 `memoryEnabled` 开关影响
  （关了再开节拍不乱）；摘要在 fire-and-forget 里跑，失败只记日志，绝不延迟或搞挂已发出的回复。
  e2e 断言：摘要落盘的同轮**只发出 1 条微信消息**。
- **最近消息窗口只在冷启动注入**（2026-10-26 优化）：会话已经接上时 agent 自己的历史里就有
  那些对话，每回合复述一遍是重复计费；入站流水写在拼 prompt 之前，窗口里还含**正在被回答的
  那条消息**。现在窗口只在新会话线（首条消息 / `/new` / `/mode` 切换）注入一次，把注入过的
  `recentSessionId` 记在会话记忆文件里，并排掉当前这条消息；条数由 `memoryRecentTurns`
  （默认 5，0 关闭，每条截 120 字）控制。实测常驻开销 945 字（≈630 token）→ 322 字
  （≈215 token），冷启动那一次多 ~300 token。坑：落盘记号要在**窗口为空时也写**，否则新会话
  的第二条消息又被当成冷启动重复注入。
- **提示词顺序**：`<weixin_persona>` → `<weixin_memory>` → `sourceContext` 之后是用户原文。
  `memoryEnabled: false` 关掉记忆块与记忆命令（/mode 不受它管）。

### 设置卡

「个性化」页签（第 7 个）：模式列表（新增/编辑/删除自定义，内置只读）、「默认模式」选择器
（实时生效，不用重载）、会话覆盖查看/清除、长期记忆的增删、各会话摘要查看/清除。远程方法
`personaOverview / personaModeSave / personaModeRemove / personaDefaultSet / personaOverrideClear /
memoryFactAdd / memoryFactRemove / memoryConvClear`（RemoteError 的文案在 code 槽，测试断言 `code`）。

### 存储

`<stateRoot>/persona-modes.json`（目录，首读播种内置）、`persona-active.json`（覆盖 + `__global__`）、
`memory/global-<账号>.json`、`memory/conv-<账号>-<会话>.json`。写坏/丢内置自愈（重播种、丢条目
跳过并告警）。

### 坑与教训

- `setActiveMode` 曾把**过滤后的视图**写回（会抹掉 `__global__`）——变更操作必须走原始文件往返，
  有回归测试钉住。
- 摘要器的 catch 把 `ReferenceError: accountId is not defined` 吞成了静默——测“吞错误”的模块时
  必须传真 logger。
- `createMemorySummarizer` 一度建在 setup IIFE 里，而 `createInboundHandler` 是模块级函数靠参数
  取依赖——启动即 `createMemorySummarizer is not defined`，只有 e2e 的 ctx.logger.warn 抓得到；
  最终按 `bridge` 的模式放外层 `let` + setup 内赋值，settle 点用 `?.` 兜底。
- config-remote 表单与 schema 的 parity 测试很有用：新 schema 字段忘加表单会被它当场拦下。
- e2e 精确断言 prompt 的旧用例需要 `memoryEnabled: false`（memory 块默认会出现在 prompt 里）。

### 测试

persona 9、memory 8、会话命令 6（/mode 列表/切换/按 id/钉回默认、/remember 往返、/forget 关键词）、
后台摘要 7、e2e 2（persona+memory 注入顺序与关闭行为；摘要落盘且不发气泡）、设置卡页签 1、
远程方法 parity、config-remote 表单 5 字段。全量 `npm test` → **449/449**（~36s）。

## 可玩性三件套（2026-10-26，`ea59e86` + `081759d` + `79307dc`，待随下次发版）

用户问「还有什么好的建议，有更好的可玩性」，给了四档清单后选定三项，按小到大独立提交。

### 行为

- **游戏模式**（`ea59e86`）：`BUILTIN_MODES` 新增海龟汤（出谜面、只答是/否/无关、可要提示）、
  成语接龙（接不上判负、记连胜）、文字冒险（第二人称选项制），每个都是 `game:true` 的普通模式——
  游戏状态就是会话上下文（摘要器兜底跨长局），`/mode` 切换开新线即重开一局。`/mode` 列表按
  角色/游戏分组，游戏区标着「玩完 /mode 默认 就退出」。每个 prompt 都带边界段（正事优先、健康内容）。
- **亲密度 + 心情**（`081759d`）：`memory/*.json` 的 conv 文件多一个 `bond` 键（firstDay/msgs/
  msgsToday/lastMessageAt/mood），由摘要器的每回合计数顺带更新（`bumpTurnAndBond` 一次读改写，
  零额外 IO）。心情是**确定性规则**不走模型：深夜(23–5)「夜深了，还醒着」> 刚认识 > 超一天没聊
  「好久没聊，有点想你」> 今日 ≥19 条「聊得很热络」> 平静。展示为「我们认识第 N 天 · 聊过 M 条
  消息 · 此刻：<心情>」，进提示词（memory 块首行【我们】）、`/status`、`/memory`、设置卡会话行。
  开关跟随 `memoryEnabled`，不加配置项；老 conv 文件没有 bond 键时形状不变（deep-equal 测试钉住）。
- **定时主动消息**（`79307dc`）：`/subscribe <时间> <提示词>`。时间支持 每天/每日/daily HH:mm、
  每周X HH:mm、裸 HH:mm（=每天）、一次性（复用 /remind 的 parseWhen：10m、绝对日期）。存储
  `<stateRoot>/subscriptions.json`（结构同 reminders + prompt，每账号上限 20 条）。到点开侧会话
  `wx-sub-<sha1>`（`bridge.summarize` 加了 `sessionPrefix` 选项），prompt = 人设块 + 记忆块 + 时间戳
  + 订阅指令，生成的正文走 sendChunked 标准出站。错过的到点：循环订阅 30 分钟内补发一次，否则只
  推进不补发；一次性到期直接丢弃。同一会话同时只跑一个订阅回合。空正文不发。`/remind` 不变。

### 坑与教训

- 会话命令的裸命令（`/subscribe` 不带参数）必须显式给规则，否则会**落到 agent** 变成一轮普通对话，
  用户看到的是「处理失败：record.agent.followup is not a function」。`/remind` 当年也一样，这次给
  `/subscribe` 补了裸命令 → usage 的规则。
- `parseSessionCommand` 的两词时间（每天 08:00）要一次正则吃下，先按第一个空格切会把 when 切成「每天」。
- statusContext 里引用 setup IIFE 的 `let` 变量（subscriptionScheduler）会 ReferenceError——
  createInboundHandler 是模块级函数，依赖必须走参数（与 reminderScheduler 同款接线）。
- 测「吞错误」路径时必须传真 logger（摘要器这次已经吃过一回，订阅器学乖了）。
- 调试插件静默：`withPlugin` 的 `finally` 里用 `DSH_DEBUG_LINES` 环境变量 dump `lines`，
  一次就能看到插件到底 warn 了什么（比临时改源码快）。
- `assert.match(x, re, msg)` 第三个参数是失败**说明**不是实际值——排错时别被它带偏。

### 测试

游戏模式 1（persona 游戏内置与 round-trip）+ 列表分组断言并入既有 /mode 用例；亲密度 6
（memory 3：bump 跨天/心情表/渲染、login-remote 1、会话命令 1、e2e 1：bond.msgs 与心情落盘）；
订阅 9（subscriptions 单测 8：解析表/nextFireAt/触发推进/一次性自移除/宽限窗/过期丢弃落盘/
校验与上限/描述，会话命令 1：schedule→list→cancel 全流程）。全量 `npm test` → **464/464**（~36s）。

## （十一）第二轮六项：总结 / 导出 / 免打扰 / 账号人设 / 统计（2026-10-26）

用户在「还有好的功能建议吗」之后从 8 项候选里勾了 6 项，按 ①→⑥ 逐个落地，每步全量测试绿再提交。

- **① 即时总结 `/summary`**（`d868362`）：侧会话现场总结这段会话（聊到哪 / 定了什么 / 待办 /
  约定，≤300 字），**只回复、不写回会话摘要**——「看一眼」与「记住」是两件事，后者仍归自动摘要。
  有对话在跑时回「等这轮结束再试」而不是排队。`handleCommand` 因此允许返回 Promise
  （同步路径的 `/clear` bookkeeping 不受影响）。
- **② 聊天记录导出 `/export [天数]`**（`75f7bcb`）：新模块 `src/message/chat-export.js`——
  `readJournalRange`（按**文件日期**取日历窗口，不是按条数）、`renderChatMarkdown`（按天分组、
  `[HH:mm] 对方/我：…`、内嵌换行压成 ` ⏎ `）、`writeChatExport`（`<stateRoot>/exports/`，文件名带
  时间戳）。≤3000 字直接作为回复，更长落盘并回路径。设置卡消息流水页签加了「导出记录」按钮，
  走同一份 Markdown 改为浏览器 Blob 下载。
- **③ 免打扰时段**（`7260839`）：`src/message/quiet-hours.js` 纯函数 `quietDelay`（跨午夜按两段算，
  结束时刻多算 1 分钟避免边界竞态；两端相等 = 未配置，否则等于永远静音）。ReminderScheduler 与
  SubscriptionScheduler 的构造器都收一个 `quiet(now)` 门：**到点先问门**，被推迟就改写 fireAt 重新
  arm——提醒留在盘上（重启会重排）、订阅不消耗次数。index.js 的门每次现读已保存配置，卡片改完即生效。
- **④ 账号级默认人设**（`5b11fe1`）：`persona-active.json` 里新增 `accountId|` 这个保留键；
  `activeModeFor` 的优先级变成「会话覆盖 > 此账号默认 > 全局默认 > 配置项」。设置卡个性化页签加了
  「此账号默认」下拉。坑：`listActiveOverrides` 必须把空会话键过滤掉，否则账号默认会显示成会话覆盖。
- **⑤ 统计页签**（`668dc7d`）：`src/message/stats.js` `computeStats`——按天零填充桶、24 小时本地
  分桶、会话排行、可选账号过滤，**全部现算**不缓存；远程方法 `weixin.stats({days, accountId})`
  （1..90，默认 14）。设置卡第 9 个页签：7/14/30 天切换、按天柱状、小时分布、最活跃会话；纯 div
  内联样式，不引图表库。

### 坑与教训

- 统计的 total 要按**窗口**算（和 daily 一致），不能把窗口外条目混进总数——否则卡片顶部数字和柱子
  对不上。测试先按「总数含窗口外」写，实现是窗口内，最后以「都描述窗口」统一。
- 远程方法列表在 `test/client-remote.test.js` 是**排序过的硬编码数组**：`weixin/stats` 要插在
  `weixin/startLogin` 之后（`start` < `stat`），插在 `sessions` 后面测试会报顺序差。
- 免打扰的门必须是「会自己打开」的窗；常真门在测试里会让调度器无限重排。
- 会话命令的裸命令一定要有独立规则（`/summary`、`/export` 都补了），否则落到 agent 变成一轮对话。

### 测试

全量 `npm test` → **483/483**（~41s）。本轮新增 19 条：chat-export 3（日历窗口 / 渲染分组 /
文件名唯一）、会话命令 2（/summary 侧会话不落库、/export 短回复与长落盘）、quiet-hours 6（解析
严格性 / 跨午夜 / 同日 / 关闭形状 / 提醒推迟 / 订阅推迟不消耗）、persona 1（账号默认优先级链）、
login-remote 2（journalExport、stats 夹取与过滤）、stats 4（零填充窗口 / 小时桶 / 会话排行 /
账号过滤与空窗）。

## 本地回忆检索（2026-10-26，`e0834d1`，待随下次发版）

### 动机

全量数据本来就在本地（流水一条不落），但没有任何东西去**查**它：摘要是有损的、事实是手工的、
冷启动窗口只覆盖最近几条，于是「聊得越久回忆越糊」。这一轮补的就是检索：**全量留在磁盘上，
检索按需发生**。

### 行为

- `src/message/recall.js`：中文连续段切二元（`上次那个报错`→上次/次那/那个/个报/报错）、英文数字
  整段成词（单字符丢弃，否则命中一切）；`ensureIndex` 每个账号一份索引
  `<stateRoot>/memory/index/<账号>.json`，按天文件分片、只补新行、窗口外的文件整段移出；
  `queryRecall` 用 BM25（k1=1.2、b=0.75、idf 下限 0.05 避免「到处都有的词」变负数），
  **正文不入索引**——只存 (文件, 行号, 时间, 方向, 账号, 会话, 词数)，命中后再回读原文。
- 注入门 `shouldRecall`：消息里出现「上次/之前/那天/我说过…」这类词必查；否则要求
  「≥2 个词面命中且分数 ≥3」。命中才拼 `<weixin_recall>`（最多 `memoryRecallHits`=3 条、
  各截 140 字、带 `[YYYY-MM-DD HH:mm]`），闲聊 0 token。
- `/recall <关键词>`：先在本会话找，找不到再扩到整个账号；直接回原文，不经过模型。
- 配置：`memoryRecall`（默认开）、`memoryRecallDays`（180）、`memoryRecallHits`（3），设置卡
  「本地回忆」组。索引是纯派生数据：读坏了就重建，写失败只 warn，绝不影响收发。

### 坑与教训

- **指令行不能进索引**：入站流水在拼提示词之前就写了，`/recall 报错` 这条命令本身会命中自己的
  检索（测试第一次就撞上，返回 2 条）。索引阶段直接跳过以 `/` 开头的行：指令不是聊天内容。
- **当前这条消息要排掉**：它同样已经在流水里。给入站流水和检索排除用**同一个** `journaledAt`
  时间戳（`excludeAt`），比按文本比对稳。
- **索引按账号分文件**：`_all` 是「不分账号」的保留名（设置卡全量检索用），别把它当成账号 id
  传给行过滤器，否则整份索引会是空的。
- 文档太碎时 BM25 的 idf 会变成负数（词在全部文档里都出现），要夹到一个小正数而不是放任。

### 测试

全量 `npm test` → **499/499**（~44s）。本轮新增 16 条：recall 10（分词、命中回原文、账号隔离、
增量追加、窗口剪枝、排除当前消息、指令行跳过、闸门、块渲染、坏索引重建）、会话命令 1（/recall
三态：命中/未命中/用法，且不花模型回合）、e2e 1（旧事消息带 `<weixin_recall>`、闲聊不带）、
persona 1（贾维斯在角色表中且有边界段）、memory 2（冷启动窗口排除当前消息、注入标记落盘）。

## 左侧栏面板（2026-10-26，`14636d6`，待随下次发版）

### 行为

- 同一张微信卡片现在注册在**三个**座位：插件页 `plugins.bundle.config`（`key` = 包名）、
  宿主设置导航 `settings.section`（排在 dsh-im 之后）、以及左侧栏的「微信」页——后者是
  **两个必须同步的注册**：`sidebar.panellist` 画那一行（微信绿图标 + 展开时的「微信」标签，
  `order` 20 排在宿主 Plugins 0 与日程任务页 10 之后），`main` 键控槽用**同一个 id**
  承载页面。宿主按行 id 去 `main` 里找页面，找不到会在点击时抛错且不切换选中项。
- 面板页自带滚动、`24px 28px` 边距与 920px 阅读宽度：卡片原本按 ~520px 的设置对话框设计，
  直接铺满工作区会让全宽行贴着边框、长内容无处滚动。
- `src/client.js` 导出 `PANEL_ID`（`dsh-weixin`），测试断言两个座位的 `id`/`key` 都等于它，
  而不是各自抄一份字面量——行与页只在对得上时才算一个功能。

### 坑与教训

- **id 必须避让宿主面板名**：`conversation`、`plugins`、`schedules` 已被占用，用包名最稳。
- **两个注册是原子的一对**：只加 `sidebar.panellist` 会得到一个点了没反应的行（宿主抛
  `missing main entry`），只加 `main` 则根本没有入口。
- 座位计数断言（`seats.length`）是硬编码的：从 3 变 5 会同时打死两个测试文件；改成按名字
  查找座位后，新增座位不再让测试按位置失联。

### 测试

全量 `npm test` → **500/500**（~44s）。本轮 +1：用登录轮询那套 hook 运行时挂载 `main` 座位，
断言页面是带滚动/边距的宿主元素、且卡片页签栏（微信账号/会话/配置项/统计/个性化/关于）都在
里面——避免「页面渲染成别的东西但行还是能点」这种半坏状态。座位断言两个文件同步更新。

## 发布 0.9.5（2026-10-26）

0.9.4 之后的工作全部随 0.9.5 出：**贾维斯模式**（`5e8c3a8`）、**冷启动记忆窗口**
（`d68bd21`，常驻提示词 945→322 字）、**本地回忆检索**（`e0834d1`，倒排索引 + `/recall` +
按需注入 `<weixin_recall>`）、**左侧栏面板**（`14636d6`，`sidebar.panellist` 行 + `main` 页）。
发布记录：commit `06e3085 chore(release): 0.9.5`、tag `v0.9.5`、GitHub release
https://github.com/panqing0313/dsh-plugin-weixin/releases/tag/v0.9.5 ，注册表 `dist.shasum`
与本地 tarball 一致；全量测试 500/500。

### 坑与教训

- **`node bin/install.mjs` 装好的东西，会被 App 下一次启动悄悄换掉**。桌面端启动时会在
  `<profile>/` 里跑一次 `pnpm install`，按 `package.json` + `pnpm-lock.yaml` 把
  `dsh-plugin-weixin@0.9.3` 从 npm 装回来；手工复制的源码目录因此被整个覆盖（连 `src/persona.js`
  这种新文件都消失），表现是「重启前后功能不一样、左侧栏那一行怎么都不出现」。判断方法：
  `node_modules/dsh-plugin-weixin/package.json` 的 version、`src/` 下有没有新文件、
  `grep PANEL_ID src/client.js` 三处一查就清楚。
- **想让改动在重启后仍然在，必须走 profile 的依赖图**：把
  `<profile>/package.json` 的 `dsh-plugin-weixin` 指向已发布版本（如 `^0.9.5`），再用
  App 自带的那份 pnpm 刷新锁文件
  （`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs install --prefer-offline`；
  fnm shim 的那份在这个 profile 里会卡住不干活）。手工复制只适合当场验证，不能当作部署。
- **npm 发布需要交互式 2FA**：`npm publish` 在后台进程里会停在
  `Press ENTER to open in the browser...`，脚本化跑不通，必须由人在终端里完成一次网页认证。
- **发版脚本的 README 占位符会一起进发布提交**：`--yes` 直跑会在版本列表顶部留一条
  `TODO: describe what changed in this release.` 并直接提交、进入 tarball。先跑一次让它插入占位，
  改写成人话再 `git commit --amend` / 复跑（脚本对「版本已 bump」「README 已覆盖该版本」是幂等的）。

## 配置项中文化 + 默认折叠（2026-10-26，`36b0af6`，随 0.9.6 发版）

用户反馈：配置项页签的分组标题、字段名、提示全是英文（`Basics` / `Send interval`…），
而且第一组默认展开、其余八组被挤到折叠线以下。

### 根因

- **参数的顺序反了**，不是没有中文。`src/client.js` 的本地化助手是
  `t = (en, zh) => (zh ? zh : en)`——第一个参数才是英文；配置表单的数据驱动调用写成了
  `t(field.label, field.labelEn)`，于是中文界面拿到的是英文串。语言没选错，是取值反了。
  同一文件里 ASR 段（`SOURCE_CHOICES`/`PROXY_CHOICES`）一直是对的顺序，所以只有配置表单坏。
  `src/config-remote.js` 里另有一个 `const t = (zh, en) => (lang === "en" ? en : zh)`，顺序相反，
  两个助手同名不同序，是这个 bug 的温床。
- **自动展开是显式写死的**：`load()` 里 `setOpenGroup((current) => current || r?.groups?.[0]?.group || "")`，
  每次加载都把第一组打开。

### 改动

- 5 处调用换成 `t(en, zh)`：`option.label`、`field.unit`、`field.label`、`field.hint`、`group.group`（各 1 处）。
- 删掉自动展开那行；`openGroup` 初值本来就是 `""`，重新加载时保留当前展开项（不改也不关）。
- **测试运行时改造**：`test/client-login-poll.test.js` 的 hook 槽原来是「一次渲染内按调用顺序
  的扁平数组」，只在整棵树形状不变时成立；切页签会把一个 section 换成另一个，新组件的
  `useState` 读到上一个 section 残留的槽，报 `TypeError: groups is not iterable`。改成
  **按组件实例分槽**（key = 渲染路径 + 组件名，`frames` Map + `nextSlot()`），切页签不再串状态。
  这个运行时现在可以驱动任意页签，不再只是登录轮询。

### 坑与教训

- **两个同名本地化助手，参数顺序相反**：`src/client.js` 是 `(en, zh)`、`src/config-remote.js` 是 `(zh, en)`。
  给新调用点选助手前，先看它自己的定义，别按印象写。
- **英文串在中文界面里不会报错**，只会看起来「没做本地化」。这类问题文本断言抓不住，必须渲染出来看词。
- **hook 假运行时的槽位是隐式契约**：只要渲染树的形状会变，扁平槽就会串；按实例分槽之后，
  组件增删都不再影响别的组件。
- 装好的包文件被手工改过时，只要 `package.json` 与锁文件一致，`pnpm install` **不会**覆盖它
  （实测：改后跑一次 `install --prefer-offline`，sha1 不变），所以小的界面修法可以先落地验证，
  再随下个版本正式发出。

### 测试

全量 `npm test` → **501/501**（~44s）。本轮 +1：`the options form speaks the UI language, and starts folded`
——渲染配置卡片，断言分组标题是「基本/权限」且不含 `Basics`、折叠时不渲染字段、点开后
`发送间隔` / `两条消息之间至少等这么久` / `毫秒` 都在且不含 `Send interval`。

## 发布 0.9.6（2026-10-26）

`36b0af6` 配置项中文化 + 默认折叠随 0.9.6 出。发布记录：commit `fe1102b chore(release): 0.9.6`、
tag `v0.9.6`、GitHub release https://github.com/panqing0313/dsh-plugin-weixin/releases/tag/v0.9.6 ；
注册表 `dist.shasum` `a2a1e8f78e5c2d274d5af3327f1c5023c6fa4a29` 与本地 `dsh-plugin-weixin-0.9.6.tgz`
逐字节一致，`dist-tag latest` 指向 0.9.6；全量测试 503/503。

### 坑与教训

- **发版脚本第 9 步「装进本机 profile」本身就是那个坑**：它跑 `bin/install.mjs`（文件复制），
  但 App 下次启动的 `pnpm install` 按 profile 的 `dependencies` + 锁文件把旧版本装回来——
  0.9.5 那次正是这样：跑着的 App 里是旧代码，profile 还写着 `^0.9.3`。发完 0.9.6 后
  profile 仍写着 `^0.9.5`、锁文件也还钉着 0.9.5，手工把 spec 改成 `^0.9.6` 并刷锁文件后才真正生效。
- 因此脚本新增 `pinProfileSpec(raw, nextVersion)` + `pinProfileDependency(profile)`：文本级替换
  `"dsh-plugin-weixin": "^旧"` → `"^新"`（保留 profile 自己的缩进，不动其他依赖），再用 App 自带
  那份 pnpm `install --prefer-offline` 刷锁文件。`file:` 之类的非 caret spec **不碰**——那是操作者
  的显式选择，脚本只警告，不偷偷改成 registry 范围。
- `npm publish` 的 2FA 需要真 TTY：`yes '' | script -q /dev/null node bin/release.mjs <ver> --yes`
  能给到 pty 并把 ENTER 递进去，浏览器里点确认后全自动跑完（这次 0.9.6 一次通过）。
  收尾那行 `script: write master: Input/output error` 是 pty 关闭时的噪音，不影响结果。

## 陪聊节奏与生活状态（2026-10-26，待随 0.9.7 发版）

### 行为

- **节奏**（`src/message/human-pace.js`）：`isCompanionMode(mode)` = 模式不是 `default`。`planCompanionReply` 给出 `{delayMs, bubbles, gapMs}`：首条延迟 `(240 + 字数×16) × jitter(0.8–1.25) × (精力<30 ? 1.35 : 1)`，夹在 220ms 与 `replyDelayMaxMs` 之间；长回复按段落优先、其次按句末标点切分，短于 6 字的片段并入上一条，**≤14 字的收尾句单独成条**，条数上限 `bubbleSplitMax`；含代码块整段不拆。`sendChunked` 新增 `message.bubbles` + `message.gapMs`，逐条发送、条间 `sleep(gapMs)`。
- **状态**（`src/message/life-state.js`）：`baseEnergyFor(hour)` 给一天一条精力曲线（凌晨 22、上午 72、午饭后 58、晚间 46…），`activityFor(hour, weekend)` 给「在上班/在吃午饭/在家窝着…」，`inferMood` 按「隔了 ≥3 天 / 深夜 / 精力 ≤22 / ≤38 / ≥80 / 其余」六档给心情；跨会话共享、`LIFE_WRITE_INTERVAL_MS`（5 分钟）节流落盘 `memory/life-<账号>.json`，`persist:false` 供卡片只读。
- **提示词**：`buildHumanStyleBlock()`（`<weixin_style>`，只对陪聊模式）教它「一次说一两句、别用标题列表、口语和 emoji 别每句都带」；`lifeBlock(life)`（`<weixin_life>`）给状态并要求「累了就回短一点，别把状态念给对方听」。拼接顺序 `persona → style → life → memory → recall → 用户文字`。
- **卡片**：`personaOverview` 每个会话多返回 `modeId/modeName/life/lifeLine`（`readOrInferLifeState({persist:false})`），个性化页签那一行显示 `模式：女友 · 在家歇着 · 有点乏… · 精力 34/100 · 我们认识第 3 天`。`listConvMemories` 现在把**只有亲密度、还没有摘要**的新会话也列出来，否则卡片看不见刚开的线。
- **「默认助手」的三重隔离**：不延迟不分条（`isCompanionMode` 为假直接早返回）、不注入 style/life 块、`/status` 与 `/memory` 不显示感情行（`companionHere()` 统一判断）。

### 坑与教训

- 作息/心情必须是**纯函数 + 节流落盘**：模型推断会让每条消息多一次调用，也让同一份状态在两次读之间漂移。
- 亲密度与状态都挂在会话级文件上，但 `/mode` 切换会开新会话线——所以属性要存在 `conv` 文件（conversationId 维度）而不是 sessionId 维度，否则换模式就等于失忆。
- 卡片测试的 hook 运行时按组件实例分槽后才能跨页签断言（见 0.9.6 那条）；本次新增的设置卡用例先连续 `render()` 六次再断言，因为页签内先取 `status()` 再取 `personaOverview()`，一次 flush 只推进一轮 effect。

### 测试

- `test/human-pace.test.js` 6 条、`test/life-state.test.js` 6 条、e2e `companion pacing`（女友恰好 2 条气泡逐字相等 / 默认助手 1 条整段）与 persona e2e 的顺序断言（`persona < style < life < memory < text`）、`test/login-remote.test.js` 的「每个会话的模式与推断状态」、`test/client-login-poll.test.js` 的「个性化页签按会话显示模式与状态」。全量 `npm test` → 518/518。

## 角色池扩容（2026-10-26，待随 0.9.7 发版）

- 内置角色从 5 个扩到 12 个：`whale-girl`（小鲸娘，调皮可爱 + 「呜噜咕噜」拟声口癖）、`oneesan`（御姐，从容简练、称呼「小朋友」）、`big-sister`（知心大姐姐，先接情绪再谈事）、`warm-guy`（暖男，关心落在具体处）、`daughter`（可爱闺女，黏人懂事）、`neko`（猫娘，高冷与黏人交替）、`tsundere`（傲娇，拐弯的关心）。每个新角色都带两段式 prompt：第一段给语气/称呼/口癖，第二段是边界段（事实与任务照旧准确、不给医疗法律投资建议、不写成人内容、正事优先）。
- **老目录的补齐顺序**：`readPersonaStore` 以前把缺失的内置模式 `unshift` 到列表最前面，升上来的安装会看到新角色倒序堆在顶部。现在改成「按名册顺序重建」：内置模式按 `BUILTIN_MODES` 的顺序，**已存在但被改过 prompt 的内置条目原样保留**（只补缺的），自定义模式排在后面且保持原有相对顺序。
- 测试：`test/persona.test.js` 的名册断言扩到 12 个 id/name，并且对**每一个**内置角色断言「有边界段、有拒绝专业建议的一句、prompt > 80 字、id 唯一」；新增「老目录按名册顺序补齐」用例（含自定义条目存活）。会话命令里未知模式的提示语断言同步扩到 15 个名字。全量 519/519。

## 发布 0.9.7（2026-10-26）

- 一次跑通：`yes '' | script -q /dev/null node bin/release.mjs 0.9.7 --yes`（`script` 给真 pty，npm 的 2FA 浏览器确认才走得通）。发布前 `--dry-run` 全绿：519/519、版本四处同步、78 个文件、world-readable、bridge 协议自检、tarball 1057 kB。
- 注册表：`dist-tags.latest = 0.9.7`；`dist.shasum d9c57ddf6a2dfcca5f28f70f74ff12c5a55bb72b`（与本地 `shasum -a 1` 一致）、`dist.integrity sha512-xQMIszgsKGvK3GiCSLnEZZ3vtG4bN8NiUOPsmS5NhLlJNEZWP7SqKB/KLGtHulqOCRuh2xhO9TtpIS401PzLZA==`、`gitHead c3fb808`；tag `v0.9.7`；release https://github.com/panqing0313/dsh-plugin-weixin/releases/tag/v0.9.7 。
- **教训**：脚本在「轮询注册表等新版本出现」这一步会因 npm 的异步处理（`Your package is being processed and may take a few minutes`）超时退出，此时 publish 其实已经成功、但后面的 **tag / push / 钉 profile 依赖** 三步都没跑。`npm view version` 还会短暂返回旧版本（`dist-tags` 已更新）——发布后要分别核对 `dist-tags`、`versions --json`、`dist.shasum`，并确认 tag 与 profile 依赖都落地。
- 补做的事：`git tag -a v0.9.7` + 推送分支与 tag、`gh release create v0.9.7 --notes-file /tmp/notes-097.md`；profile `dsh-plugin-weixin` `^0.9.6 → ^0.9.7` + App 自带 pnpm `install --prefer-offline` 刷锁。

## 表情图片与主动开口（2026-10-27，随 0.9.8 发版）

### 行为

- **表情图片**（`src/message/stickers.js` + `assets/stickers/*.png`）：微信 `MessageItemType` 里没有贴纸类型（只有 1 文本 / 2 图片 / 3 语音 / 4 文件 / 5 视频），所以原生表情包发不出去。改为「内置图库 + 标记挑选」：陪聊模式的 `<weixin_style>` 块多一行 `可用：开心、哈哈…；一次最多一张`，模型写 `[表情:困了]`，出站前 `takeStickers` 把标记从正文摘掉、返回 id 列表，再由回复路径逐个 `transport.sendMedia`（与手动发图同一条图片通道，`media_type: 1`，原生图片气泡）。同一 id 只发一次；超过 `MAX_STICKERS_PER_REPLY`（2）或名字不在目录里的一律删除并记 `dropped`（正文里不会留下 `[表情:???]`）。素材由 `scripts/make-stickers.py`（Pillow）生成，360×420 透明 PNG，4–6 KB/张。
- **主动开口**（`src/message/proactive.js`）：`ProactiveScheduler` 每 5 分钟 tick 一次，候选 = 所有在线账号 × `listConvMemories` 里**非默认助手**模式的会话（按 `bond.lastMessageAt` 降序）。能不能发是纯函数 `planProactive` 决定的，顺序：`disabled` → `outside-window`（`proactiveWindowStart/End`，填反回落默认 09:00–23:00）→ `too-soon`（距对方最后一条 < `proactiveMinGapMinutes`）→ `backoff`（`min(minGap × 2^misses, 24h)`）→ `daily-cap`（`proactiveMaxPerDay`，跨天按 `dayString` 重置）→ `tick-chance`（35%）→ 发。内容是侧会话（`sessionPrefix: 'wx-pro-'`）生成的：人设 + 节奏提示 + 生活状态 + 记忆 + `<weixin_proactive>`（现在几点、对方已经几小时没说话、一两句话、别追问去哪儿、不要说「我主动来找你」、附上次自己发的那条要求别重复）。发完 `recordSent` 写 `memory/proactive-<账号>.json`：`{day, count, lastAt, misses, recent}`。
- **接线**：`src/index.js` 在 subscriptionScheduler 之后构造并 `start()`，teardown 里 `stop()`；入站处理器在推进 agent **之前**调 `noteInbound`（注释写明理由：慢回复不能被当成沉默）。

### 坑与教训

- 心情/时段这类判定如果读 `Date.now()`，测试就会「只在写它的那天通过」：本轮把三处硬编码日期改成「今天」（`test/quiet-hours.test.js` 的 `at()`、`test/login-remote.test.js` 的 bond 播种、`test/memory.test.js` 给 `buildMemoryBlock` 传 `now`）。过零点跑全量会同时挂这三条，值得记住。
- e2e 里 5 分钟 tick + 35% 骰子没法等也测不准：加了 `DSH_WEIXIN_PROACTIVE_TICK_MS`（只在测试里设），同时把 tick 间隔压到 20ms、把 `tickChance` 开到 1，一次 tick 必然做决定。生产代码不读这个变量。
- 发出去的标记必须先摘再算字数：`pacing` 现在基于 `replyText`（已摘标记）计算延迟与分条，否则 `[表情:困了]` 会被算进正文长度，还可能把一张图挤进气泡里。
- `tick()` 的返回值要带**最后一个候选的拒绝原因**，否则日志只有「没发」而看不出是退避还是窗外。

### 测试

- `test/stickers.test.js` 11 条（每张图是真 PNG、标记摘除与顺序、上限与 `dropped`、同 id 去重、未知名字、别名与尾缀粒子、全角冒号、连续空行折叠、hint 覆盖每张图）；`test/proactive.test.js` 14 条（五个闸门逐个、跨天重置、骰子、反窗口回落、状态读写与坏 JSON、调度器先说一次→退避→`noteInbound` 解除、空回复不发不计、fire 抛异常被吞且记 miss）；e2e 新增 `stickers`（标记变 `image_item`、`getuploadurl` 用 media_type 1）与 `proactive`（没有 inbound 也自己发一条、只发一条、状态文件记了内容）。全量 `npm test` → 546/546。

## 记忆模型 v2 与表情包扩容（2026-10-27，随 0.9.8 发版）

### 行为

- **结构化记忆**（`src/memory.js`）：`readGlobalMemory` 现在返回 `{facts, profile, events, digest, digestAt}`。`sanitizeProfile` 只认 `call/schedule/likes/dislikes/dates` 五个字段（字符串截 200、列表 ≤10、日期必须 `YYYY-MM-DD`）；`sanitizeEvents` 会丢掉 `when` 早于今天−2 天的事件（`EVENT_GRACE_DAYS`）并截断到 20 条；事实多了 `weight`（1–5，`clampWeight`）。新 API：`saveProfile`（卡片显式编辑，语义是**替换**它提到的那个字段/列表）、`addEvent`/`removeEvent`/`completeEvent`、`setDigest`、`replaceFacts`（只有整理会调）、`formatProfile`/`formatEvents`。
- **注入顺序与预算**（`buildMemoryBlock`）：`【我们】bond` → `【长期记忆 · 关于用户】`（digest 打头，然后档案行，再按 weight 降序塞事实，逐行扣 `maxChars`，放不下就 break）→ `【事件与待办】` → `【本会话记忆】` → `【最近消息】`。`budget = max(160, maxChars)`。
- **抽取**（`src/memory-summarizer.js`）：摘要 prompt 改成要求**一个 JSON 对象**（`summary` / `facts` / `events` / `profile`），`parseMemoryReply` 取最外层 `{…}` 解析；成功后写 conv 摘要、按每条事实 `addGlobalFact(weight: 4)`、`addEvent`、`saveProfile(mergeProfile(...))`。**解析失败回退**成把整段文本当摘要（旧侧会话、不听话的模型都不会丢摘要）。
- **整理**（`consolidate`）：事实 ≥ `CONSOLIDATE_MIN_FACTS`（10）且距 `digestAt` ≥ 6 小时才跑；prompt 要求 `{"digest": "≤200 字人物小传", "facts": [{"text","weight"}]}`，成功后 `setDigest` + `replaceFacts`；非 JSON 只记日志、保留旧小传；`consolidating` Set 防并发。
- **记忆专用模型**：`memoryProvider`/`memoryModel` → `memoryRoute()`；`createMemorySummarizer({route})` 把它传给 `bridge.summarize({route})`；`AgentBridge.#setup(routeOverride)` 用它覆盖默认 route，`#attachNew(sessionId, sideMeta, route)` 透传；侧会话 id 由 `key|provider/model` 派生（**换模型必须新开侧会话**，已建会话改不了 route）。
- **卡片**：`personaOverview.memory` 增加 `profile/events(带 index 与 done)/digest/digestAt`；新增远程方法 `memoryProfileSave`/`memoryEventAdd`/`memoryEventDone`/`memoryEventRemove`；个性化页签的记忆面板加了档案编辑（称呼/作息/喜欢/不喜欢 + 保存档案）、小传只读展示、事件列表（完成/删除）与添加行。
- **/memory**：按 bond → 人物小传 → 关于你的档案 → 事件与待办 → 长期记忆 → 本会话记忆 → 最近消息窗口 输出。
- **表情包 36 张**（`scripts/make-stickers.py`）：`BASE`(12 重画) + `CUTE`(12) + 三个角色包（`neko` 4 / `whale-girl` 4 / `daughter` 4）。`stickers.js` 拆成 `BASE_STICKERS`/`CUTE_STICKERS`/`MODE_STICKERS`，API 变成 `stickersForMode(modeId)`、`resolveSticker(name, modeId)`、`takeStickers(text, {max, modeId})`、`stickerHint(modeId)`；调用点全部传当前模式 id（回复路径、proactive fire、styleBlock）。

### 坑与教训

- `#attachNew` 里写 `options.route` 而 `options` 是 `attach` 的参数 → 普通消息全部 `ReferenceError: options is not defined`（被 `turn failed:` 捕获）。签名必须显式带 `route`：`#attachNew(sessionId, sideMeta, route)`。
- 生成图标的 `python3` 带 PIL 才是 `python3.13`（conda），系统 `python3` 没有 Pillow。
- 装饰坐标必须在脸圆半径内，否则被裁成游离小点；`bow` 一开始用三角多边形，缩小后像冰淇淋/翅膀 → 改成三个圆（左右环 + 结）；`pat` 用两条弧像划痕 → 改成手掌圆角矩形 + 三根手指；`d.ellipse(..., fill=(0,0,0,0))` 想挖月牙会**真的把脸挖个洞**（RGBA 直接替换像素）。
- `buildMemoryBlock` 的 `maxChars` 有 160 的下限（`max(160, maxChars)`），所以「紧预算只留 digest」的测试要拿一段比 160 更长的 digest 来卡。
- consolidation 用例必须用**被测账号**播种 journal（`seedJournal(conv, account)`），否则 recent window 为空、summarizeNow 直接 return。
- 卡片测试里 `saveProfile` 是**替换**语义（显式编辑），模型抽取是 `mergeProfile` 的**并集**语义 —— 这两条别混，测试各钉一条。

### 测试

- `test/stickers.test.js` 16 条（36 张真 PNG、三包计数、`stickersForMode` 过滤、角色包必须对应真实内置模式、猫贴纸在非猫模式解析不出来、hint 只列本模式）。
- `test/memory.test.js` 16 条（新增：档案 merge 只认已知字段 + 列表显式替换 + 日期校验；事件空/重复/完成/删除/越界/过期剪枝；digest 领衔 + 重要度排序 + 紧预算只留 digest）。
- `test/memory-summarizer.test.js` 11 条（新增：JSON 回复落 summary/facts(weight 4)/events/profile；代码围栏可解析、纯文本回退；12 条事实触发整理并 6 小时内不再触发；`route` 透传）。
- `test/login-remote.test.js` 18 条（新增：档案保存、事件增删改、小传只读、参数校验）。
- `test/client-remote.test.js` 17 条（新增 4 个描述符，排序数组按字母插好）；e2e 的 summarizer 用例更新断言（fake 回声里含 JSON 模板，摘要取自模板样例）。
- 全量 `npm test` → **559/559**（~47s）。

## 发布 0.9.8（2026-10-27）

- **发布**：`yes '' | script -q /dev/null node bin/release.mjs 0.9.8 --yes`。publish 成功（`+ dsh-plugin-weixin@0.9.8`），第 7 步 tag/push/GitHub release 全绿：`v0.9.8`、https://github.com/panqing0313/dsh-plugin-weixin/releases/tag/v0.9.8 。
- **核验**（注册表滞后，publish 后轮询约 1 分钟才变）：`npm view version` → `0.9.8`、`dist-tags.latest = 0.9.8`、`dist.shasum dbb8b5b849780f5dc5c2d5a13a969ed3ae77b332`（= 本地 `dsh-plugin-weixin-0.9.8.tgz` 的 `shasum -a 1`）、`dist.integrity sha512-6EQnqzkpwMJUSMSMOzeModPo56yucno9Cn5WPdJRvaZU/fysp1Q2IxJ3nS8PgZwib+wCWsv3Op7Sui1GzSgesw==`、`gitHead 866a96b`（= `chore(release): 0.9.8`）。
- **profile 钉版**：第 8/9 步又没跑（见下），手工把 `~/.dsh/profiles/desktop/package.json` 的 `^0.9.7` 改成 `^0.9.8`，用 App 自带 pnpm `install --prefer-offline` 刷锁（5.5s，`0.9.7 → 0.9.8`，锁文件两处 `dsh-plugin-weixin@0.9.8`）。核验安装副本：`0.9.8`、`PLUGIN_VERSION = "0.9.8"`、36 张 PNG、`proactive.js`/`stickers.js` 在、`memoryProfileSave` 2 处。

### 坑与教训：发版脚本在 pty 消失后会「静默截断」

- 现象：0.9.7 与 0.9.8 两次都是第 7 步（tag + release + push）成功之后，`[8] Wait for the registry` 的等待点再也没有输出，进程正常退出、`verifyPublished` 与 `installLocally`（第 9 步钉 profile）都没跑。
- 根因：`npm publish` 只在真 pty 上打印 2FA 链接，所以发版要跑在 `script -q /dev/null` 里；**这个 wrapper 会在某个时刻关掉 pty**，之后任何 `process.stdout.write` 抛 `EIO` 就把整个脚本带走。上一轮只给 `say()` 加了 try/catch，而 `step/ok/note/warn/die` 与结尾的输出仍是裸写。
- 修法（`45bb421` 之后、本轮再补）：新增 `export function writeOut(text)`，所有输出（`step/ok/note/warn/die/say`、头部与结尾）统一走它；pty 没了只是少几行日志，发布流程继续跑完第 8/9 步。`test/release-lockfile.test.js` 加了一条回归：把 `process.stdout.write` 换成抛 `EIO` 的函数，`writeOut` 必须不抛。
- 教训：**发版脚本里「不可恢复的动作」之前的每一步都要按顺序做完、并把顺序写死**；把 tag 提到 publish 之后（0.9.7 的修法）只解决「发布了但没打 tag」，没解决「tag 了但没钉 profile」——输出层不致命才是根治。


## 审计清单 A–F 推进（2026-10-27，第 1–12、24、28、29、32、36 条 + 13 的入口侧）

用户给了 36 条按 A–F 分组的审计项，要求「一条条过、一条条做」。已完成并各自提交（全量测试每步都绿）：

| # | 问题 | 落地 |
|---|---|---|
| 1 | 长轮询一次 rejection 杀宿主 | `#loop` 内 catch → 计数 → 退避（2s/30s）→ 继续；`start()` 兜住整个循环；`test/inbound-resilience.test.js` 2 条 |
| 2 | 链接抓取无超时/无私网过滤/串行 | 统一 deadline、最多 3 跳、逐跳校验 redirect、私网与元数据地址拒绝、含凭据拒绝、5 分钟缓存、并发三个链接 |
| 3 | 状态文件非原子写、无迁移 | `src/atomic.js`（temp + fsync + rename），所有 JSON 存储改走它，带 `schemaVersion` |
| 4 | 状态目录无限增长 | `src/message/retention.js` 按文件名日期清理五类；`/stats` 显示占用；保留天数可配 |
| 5 | 多实例无跨进程锁 | `src/instance-lock.js`，pid + 30s 心跳，90s 过期接管，第二个实例只警告不阻断 |
| 6 | 出站队列只在内存 | `src/message/outbox.js`，磁盘持久化、按会话保序、指数退避、上限 50、卡片可重试/丢弃 |
| 7 | 无按发送者限流、队列无上限 | `src/message/sender-limit.js`（滑动窗口 20/分钟，每窗口只提示一次）+ 单会话排队上限 6 |
| 8 | 无 Channel 抽象 | `src/channel.js`：`sendText`/`sendMedia`/`setTyping` + capabilities，三个发送点统一 |
| 9 | 命令硬编码分支 | `src/sessions.js` 的 `COMMANDS` 表统一解析/帮助/分发 |
| 10 | 无扩展 Hook | `src/hooks.js` 五个订阅点，监听器抛错不影响消息 |
| 11 | 配置作用域只有全局+账号 | `src/config-scope.js` 会话级覆盖 15 个行为键，安全键永不可覆盖 |
| 12 | 状态层散落 | `src/state-layout.js` 一张表定义 16 项状态，清理/统计/文档都引用它 |
| 13 | 两个巨型文件 | 入口侧拆出 `src/outbound.js`（`index.js` 2000 → 1891 行）；`client.js` 未拆（见「已知缺口」） |
| 24 | 无 doctor | `bin/doctor.mjs` 十项检查（现 11 项，含审计链） |
| 28 | 无 CI | `.github/workflows/ci.yml`，Node 20/22 |
| 29 | 无语法/打包门槛 | `bin/check.mjs`（`npm run check`） |
| 32 | vendor 无漂移检测 | `vendor/openclaw-weixin.manifest.json`（26 文件 sha256）+ `npm run vendor` |
| 36 | 文档缺架构与排障 | `docs/architecture.md` |

随后继续做了（同样逐条提交）：

| # | 落地 |
|---|---|
| 23 | `src/metrics.js` 计数器（收到/拒绝/发出/回合 + outbox 积压）经 hook 总线接线，统计页签显示，带 uptime |
| 25 | `src/credentials.js`：所有日志经 `redactSecrets` 掩码；启动时把账号文件与 config.json 强制 0600 |
| 26 | `src/message/fence.js`：用户文本（以及抓来的网页正文）里的 `weixin_*` 标签被中和，无法伪造/闭合我们的提示块 |
| 27 | 审计日志哈希链（`prev` + `h`，按天一条链），`verifyAuditChain()` 供 doctor 检查；旧行算 `unchained` 不算篡改 |
| 32 | 见上 |
| 21 | `openThreadLines`：主动开口时用「未完成的事件 / 人物小传 / 会话摘要」挑话题，且明确要求不要复述 |
| 34 | 人设包导出/导入（`weixin-persona-pack` v1），只新增不覆盖，卡片有导出/粘贴导入 |
| 19 | `src/tokens.js` 估算 + `memoryGlobalMaxTokens`（0 = 仅按字符），记忆块按 token 也按字符双限 |

随后补上 **30 混沌/长稳**：`test/chaos.test.js`（固定种子的伪随机、三分之一发送失败）断言 outbox 不丢消息/不乱序/磁盘永远可解析、限流不超发、清理只删认得出的文件。

**14 群聊**（`src/message/groups.js`）：`isGroupMessage`（会话 ≠ 发送者）、`mentionsBot`（首行 + 名字，正则转义）、`groupReplyPolicy`（默认关 → 只答被叫到的）、`groupSharesMemory`（群默认不注入私事记忆）；入站处理器在限流之前拦下并记 `group.ignored` 指标；schema/表单加 `groupChatEnabled`/`groupReplyWhen`/`groupShareMemory`。测试：groups 单测 4 条 + 会话命令 3 段真实插件用例（默认不回 / 开启了也不乱回 / 被叫到才回）。**坑**：这套 zod 没有 `z.enum`，`z.enum(...)` 会让插件在 import 时直接抛 `TypeError`，测试表现为一直等到超时。

**17 富内容**（`src/message/rich-content.js`）：`splitFences`（未闭合围栏按正文，流式中途不丢字）、`planRichContent`（≥`codeFileThreshold` 的代码块写成文件 + 气泡里留一行说明，短块留在气泡里）、`renderTables`/`tableToText`（CJK 按两格宽对齐）、`writeSnippets`（`snippets/`，时间戳前缀，失败只丢那一个文件）；`src/outbound.js` 的 `sendChunked` 在压平之前先过一遍，文字发完再发附件；状态布局加 `snippetsDir`。测试：rich-content 8 条 + rich-send 3 条（真发一条 + 一个附件、短块不加附件、关掉开关回旧行为）。**坑**：`configureOutbound` 里的 `snippetsDir` 必须从 `statePaths(stateRoot).snippetsDir.absolute` 取，第一版忘了 import `statePaths`，`node --check` 照样过（只查语法），要到运行时才炸。

**17 富内容**（`src/message/rich-content.js`）：`splitFences`（未闭合围栏按正文，流式中途不丢字）、`planRichContent`（≥`codeFileThreshold` 的代码块写成文件 + 气泡里留一行说明，短块留在气泡里）、`renderTables`/`tableToText`（CJK 按两格宽对齐）、`writeSnippets`（`snippets/`，时间戳前缀，失败只丢那一个文件）；`src/outbound.js` 的 `sendChunked` 在压平之前先过一遍，文字发完再发附件；状态布局加 `snippetsDir`。测试：rich-content 8 条 + rich-send 3 条（真发一条 + 一个附件、短块不加附件、关掉开关回旧行为）。**坑**：`configureOutbound` 里的 `snippetsDir` 必须从 `statePaths(stateRoot).snippetsDir.absolute` 取，第一版忘了 import `statePaths`，`node --check` 照样过（只查语法），要到运行时才炸。

**22 语音/视频**：出站语音确认是服务端不投递（两次实测），默认按文件发；入站语音已有 ASR 转写；**入站视频新增抽帧**（`src/media/video-frames.js`：`probeDurationSeconds` 从 ffmpeg banner 解析时长、`planSampleTimes` 避开首帧黑场、`extractVideoFrames` 抽三帧 PNG、失败只影响那条视频），`describeInboundMedia` 的 video 分支改成列出帧的时间点与路径 + `read_image` 指引；配置 `videoFrames`。测试：video-frames 4 条（含真 ffmpeg 生成 4 秒 testsrc 抽帧断言 PNG 头与顺序，未装 ffmpeg 时跳过）。

**18 记忆改口**：`addGlobalFact` 新增 `supersedes`（宽松子串匹配、替换而非追加、旧文本进 `superseded` 历史、存满时替换照样成功）；摘要 prompt 要求 `facts: [{text, supersedes}]`，模型看到【已经记下的】就能点名被推翻的那条；`/remember 旧 → 新`（`→`/`->`/`=>`）走同一条路；`/memory` 显示「改过的说法」；回忆块加了「冲突以时间较晚为准」。测试：memory +3（替换/宽松匹配/存满仍可替换）、summarizer +1（supersedes 替换 + 提示词要求）、会话命令 +1（箭头改口后 /memory 显示历史）。

**15 危险工具提醒**：先确认宿主侧没有可用接口（插件能 import 的 `@deepseek-ai` 只有 cordis/cosmokit/dsh-agent/dsh-llm/dsh-typert-protocol/schemastery；`dsh-agent` 的 README 与 lib 里 grep 不到 permission/approval），所以只做可执行的那一半：`src/message/tool-guard.js`（`DANGEROUS_TOOLS` 名单、`classifyToolCall` 归一化工具名/抽参数摘要/危险词标 high、`noticeText` 生成微信文案）；`src/agent-bridge.js` 新增 `onToolCall` 回调（从 `#auditEvents` 的 tool/call 事件发出，抛错只 `errLog`，与 `onToolAudit` 独立 —— 审计关掉时提醒照样有）；`src/index.js` 接线，同会话同工具 10 分钟内只提醒一次，配置 `toolNotices` + 设置卡字段。测试：`test/tool-guard.test.js` 6 条（危险名单/归一化/参数抽取/截断/危险词分级/文案不假装审批），e2e 1 条（真插件 + fake agent 发 bash 调用 → 微信收到 `/cancel` 提示并且与回复是两条消息；`toolNotices:false` 时完全没有）。

**20 一般模型路由**：新 `src/model-route.js`（`ROUTE_PURPOSES = ['chat','side','memory']`、`routeFor(purpose, config)`、`sideRouteFor(config)` 先看 side 再看 memory、`describeRoute`）；schema 新增 `chatProvider/chatModel/sideProvider/sideModel`（各默认空字符串，只填一半不生效）；`src/agent-bridge.js` 新增 `chatRoute` 选项，`#setup` 里的解析顺序变成「显式 route（侧会话）→ chatRoute()（插件配的主对话路由）→ 宿主默认」；`src/index.js` 里 `memoryRoute` 改成 `routeFor('memory', config)`，新增 `sideRoute`（**坑**：一开始声明在 setup IIFE 里，而 bringUpAccount 是它的兄弟函数 → `ReferenceError: sideRoute is not defined`，已提到 apply 作用域）；三个 summarize 调用点（/summary、订阅到点、主动开口）传 `route: sideRoute()`。测试：`test/model-route.test.js` 5 条（空配置=宿主默认、半对不生效、各用途各读各的键、side 回落 memory、describeRoute），`test/session-commands.test.js` +3（侧会话 agentOptions 是后台 model、主会话是 chat model 且侧会话不继承、未配置时什么都不钉住）。

**33 i18n 抽取**：`src/i18n.js` 新增文案表（`LOCALES=['zh','en']`、`CATALOG`、`resolveLocale`、`interpolate`、`createTranslator(localeOrGetter)`、`translate(key, params, locale)`、`catalogKeys()`），未知 locale 一律回落中文；`src/sessions.js` 的 20 条命令帮助改成 `helpKey` + `buildCommandsHelp(t)`（`SESSION_COMMANDS_HELP` 仍是中文默认值），`/help` 通过 command context 的 `t` 说话；`notice.unsupported` / `notice.rateLimited` / 危险工具提醒三条通知走文案表；配置 `locale` + 设置卡字段；`bin/i18n-report.mjs`（`npm run i18n`，可 `--fail-over N`）报告还不在表里的中文行（当前 890，主要在 client.js/config-remote.js 的表单文案）。测试：`test/i18n.test.js` 7 条（每个键两种语言齐全、未知 locale 回落、缺翻译回落中文、未知键回落键名、占位符缺失时保持可见、translator 跟随 live getter、帮助列表两种语言同序且默认仍是中文、危险提示不出现「同意/批准」）+ 会话命令 1 条（`locale:'en'` 时 `/help` 是英文）。**坑**：`notice.dangerBody` 模板是 `{tool}{detail}`，第一版只传了 `tool`，输出里留下字面 `{detail}`。

**16 流式进度**：`describePending(pendingTools, elapsedMs)` 现在带上已用时间（`running: bash (12s)`、`(2m05s)`），第一次进度提示分两种触发：只是「在想」时等 `progressAfterMs`（默认 45s → **20s**），有工具真的在跑时只用 `progressToolAfterMs`（新配置，默认 8s）——「跑 npm test 时 45 秒静默」不再像死掉。之后仍是「工具集变化 + 至少隔 progressEveryMs」才重发。测试：core +2 条断言、busy-turns +1（5s 的静默阈值下，工具在 40ms 提示、且每行带秒数）。

**35 一键安装**：新增 `bin/lib/profile-pin.mjs`（`pinProfileSpec` 文本级改写 + `pinProfileDependency({profile, version, dshHome, spawn})`，release.mjs 改成从这里 import 并 re-export），`bin/install.mjs` 新增 `--pin`：装完把 profile 的 `dependencies` 指向 `^<当前版本>` 并用 App 自带 pnpm 刷锁文件；不带 `--pin` 时明确打印「会不会被换回已发布版本，取决于 profile 声明的版本是否与装进去的一致」。**坑**：`--pin` 只对已发布版本成立（源码版本号没发布时 pin 过去 pnpm 找不到包）；本仓库长期靠「装临时副本」验证未发布改动，因为锁与 package.json 一致时 pnpm 不覆盖本地改过的包文件 —— 两条都写进 README 了。测试：`test/profile-pin.test.js` 4 条（只改 caret 范围且不重排缩进、`file:` 原样不动、pin 后按注入的 spawn 刷锁、无 package.json 只警告、刷锁失败仍保留改动并提示）。

**31 发布 provenance**：新增 `.github/workflows/release.yml`（`on: push: tags: v*` + `workflow_dispatch`；`permissions: id-token: write` + `contents: read`；`concurrency: publish-<ref>` 且 `cancel-in-progress: false`；步骤：checkout 指定 tag → node 22 + registry-url → `npm ci` → `npm run check` → `npm test`（带 `DSH_WEIXIN_LINKS_ALLOW_PRIVATE=1`）→ 核对 tag 与 `package.json` 版本一致（不一致直接 `::error::` 退出）→ `npm pack --dry-run` → `npm publish --provenance --access public`（`NODE_AUTH_TOKEN: secrets.NPM_TOKEN`）→ 轮询 registry 直到能取到该版本）。本地 `bin/release.mjs` 发布后新增一行明确提示「provenance: none —— 只有 CI 能签，想有证明请推 tag」。`bin/check.mjs` 增加 workflow 完整性检查（缺 `--provenance` 或缺 `id-token: write` 就报 problem）。测试：`test/release-workflow.test.js` 4 条（tag 触发 + OIDC + `--provenance` + token；publish 之前必须有 ci/check/test/tag 一致校验；并发不可取消；package.json 非 private、`publishConfig.access=public`、声明了 github repository）。**坑**：`npm publish` 在 workflow 注释里先出现一次，按 `indexOf('npm publish')` 切片会把「publish 之前的步骤」检查切空，要用 `run: npm publish --provenance` 作锚点。

未做（留档，按原顺序）：13 的客户端拆分（`__ModuleLoader__` 单模块打包，Section 共享同一 closure 常量）、14 群聊产品化、15 微信内工具审批、16 流式进度（间隔已可配，未改默认）、17 富内容、18 记忆改口、20 模型路由（仅记忆开关）、22 语音/视频缺口、31 发布 provenance、33 i18n 抽取、35 一键安装。

## 第 13 条收尾：客户端拆成 lazy chunk（2026-10-27）

- **改了什么**：设置卡的九个 Section 与卡片本体搬进 `src/client.card.js`（2452 行），入口 `src/client.js` 从 3590 行降到 1278 行。协议是 loader 自带的包内 lazy chunk：`load({id, chunk: "client.card.js", factory})` + 入口里的 `require.async("./client.card.js")`，loader 自己按 owner 的 `?rev=` 取那个文件。chunk 不得 require 自己的 owner（那是 materialization 循环），所以设计令牌与入口侧的助手（`callRemote`、`PKG`、`PLUGIN_VERSION`、ASR 的选项表、`pickDirectory`、`useLocaleText`）通过 `createCardModule(deps)` 传进去。
- **为什么在激活时取而不是首帧取**：`registerUi` 是 async 了，但 chunk 的取回放在它末尾、`apply()` 里 `await ui` 会等它，所以第一条渲染时卡片已经在手 —— 打开设置页不会先看到一句「正在加载设置卡…」。取失败不白屏：卡片位置渲染一行 `⚠ 设置卡没加载上：<原因>（插件包里的 client.card.js 缺失或被运行时拒绝）`。
- **坑**：① 三轮都栽在同一处 —— 从入口切走的区域要留神边界：先一刀把 `createElement`、`PANEL_ID`、`WECHAT_GLYPH`、`SessionRowMark` 也切走了，表现为 `ReferenceError: PANEL_ID is not defined`；② chunk 的 factory 忘了 `return module.exports`，入口拿到 `undefined` 才 `Cannot read properties of undefined (reading 'createCardModule')`；③ chunk 里用了 6 个入口侧名字（`callRemote`、`PICK_UNAVAILABLE`、`SOURCE_CHOICES`、`PROXY_CHOICES`、`PKG`、`PLUGIN_VERSION`）却没进 deps —— 表现不是报错而是「按钮点了没反应」（异常被 async 处理器吞掉），最费时间的一个。
- **测试**：4 个客户端 harness 都学会了 chunk（`chunkRegistrations` + `require.async`，在同一个 sandbox 里跑 chunk 源码再取注册）；`test/client-settings-tabs.test.js`、`test/client-remote.test.js`、`test/asr.test.js` 里那些对源码做正则断言的用例改成读 chunk（`\n\t+` 代替固定缩进，因为 Section 进 chunk 后深了一层）。
- 全量 **689/689**、`node bin/check.mjs` → `checked 145 files`、`doctor` 11 checks 0 problems。

## 发布 0.9.9（2026-10-27）

- **核验**：`npm view dsh-plugin-weixin version` → `0.9.9`、`dist-tags.latest = 0.9.9`、`dist.shasum 2bd3d597a7e3e16d74ddf8b82be8f938ea52469b`（= 本地 `dsh-plugin-weixin-0.9.9.tgz` 的 `shasum -a 1`）、`dist.integrity sha512-caG529vI+rinrw3HjN9GCGWGta+LIvavaATdS4UIbOrNuGe/8DNF/dNb4TwuoCClMZwZC01E9SetKNi0knwoDg==`、`gitHead 2c07a906577a5e1426a6b8332d0b43d6e6c8ff71`（= `chore(release): 0.9.9`）；tag `v0.9.9`、GitHub release https://github.com/panqing0313/dsh-plugin-weixin/releases/tag/v0.9.9 。
- **profile**：脚本第 10 步自己钉好了 —— `~/.dsh/profiles/desktop/package.json` `^0.9.8 → ^0.9.9`、锁文件刷新、装好的副本 `0.9.9` + `PLUGIN_VERSION = "0.9.9"` + `src/client.card.js` 在位；「重启后不会被回滚」这条这次是真的应验了。
- **这次一次跑通**：`writeOut` 吞 EIO 的修复（`bce45d0`）让第 7–10 步在 pty 关闭后照样跑完 —— 0.9.7/0.9.8 那两次「tag 打了、后面全没跑」的手工收尾这次没有出现。`provenance: none` 那一行仍在，属于本机发布的既定事实（要 provenance 得推 tag 让 CI 发）。
- **发布前的小插曲**：`npm whoami` 报 `E401`（`~/.npmrc` 里那个 token 是 10-26 的，已失效），`node bin/release.mjs 0.9.9 --dry-run` 在 preflight 就停住；`yes '' | script -q /dev/null npm login --auth-type=web` 重新登录后正常。

## 文档双语化与 README 重排（2026-10-27）

- **为什么要动**：README 940 行、前十屏全是版本日志 —— 想知道「怎么装、怎么连、出问题看哪儿」的人得先翻过十个版本的故事；而且只有中文，`dsh.market` 上点进来的英文用户直接退出。
- **README 现在长什么样**：顶部一行语言切换（`简体中文 ｜ English`）+ 四枚徽章（npm 版本 / CI / license / DSH Market）+ 图标；紧接着一句「这是什么」和四个「你想做什么」入口（在微信里干活 → 安装/登录/授权；改行为 → 配置；某版改了什么 → CHANGELOG；出问题 → `npm run doctor`）；然后是「目录」—— 6 行、覆盖全部 16 个 `##` 与 35 个 `###`，42 个锚点全部可解析（用 GitHub 的 slug 规则验过，包括中文标题里 `·` 前后留下的双连字符）。
- **版本日志搬到了 `CHANGELOG.md`**：「亮点」一节只留**现在能做什么**（多账号 / 账号级白名单 / 会话隔离 / 一键暂停 / 语音开箱即用 / 左侧栏入口），并写明「每个版本改了什么在 CHANGELOG.md」。十版历史原样迁过去（0.9.9 → 0.9.0），`# 更新日志` 开头一句说明这一页只回答「哪个版本改了什么」。
- **发版脚本跟着改**：`bin/release.mjs` 的「版本列表必须有本版 bullet，否则置顶插一条 TODO」从 README 挪到 `CHANGELOG.md`（README 仍保留 `当前已发布版本：…` 那行供脚本更新，`VERSION_FILES` 不变）。`package.json` 的 `files` 加 `README.en.md` 与 `CHANGELOG.md`，两个文件都会进 npm 包。
- **`README.en.md`**：968 行，结构一一对应（16 个 `##` + 35 个 `###` 同序、20 个代码块、127 行表格、13 个图片/徽章），英文锚点全部重算过。有意保留中文的只有三类：**运行时真的会打出来的字符串**（`备注名:`、`[表情:困了]`、`【语音转写】`、`（提醒：内容）`）、**被 `src/sessions.js` 正则解析的命令参数**（`/subscribe 每天 08:00`、`/mode 女友`、`/mode 海龟汤` —— 翻译了就等于教人用一个跑不通的命令，英文释义放在括号里）、以及**设置卡里由 `t(en, zh)` 双语输出的标签**（这层翻译由 `locale` 决定，文档只描述）。
- **原文档的自相矛盾没顺手改掉**（避免两边不一致）：亮点点说 11 项体检、开发节注释里写「十项体检」；写「十二个内置角色」而表格列了 11 行 —— 这些留在原文里，中英两版都照原样翻。
- 校验：`npm test` → **689/689**；`node bin/check.mjs` → `checked 145 files`；`test/release-lockfile.test.js` + `test/release-workflow.test.js` 13/13（发版列表改到 CHANGELOG 后仍然绿）。

## 发布 0.9.10（2026-10-27）

- **核验**：`npm view dsh-plugin-weixin version` → `0.9.10`、`dist-tags.latest = 0.9.10`、`dist.shasum 8ce5c79bd8fd716c57fe950f1b79ace72e6076ad`（= 本地 `dsh-plugin-weixin-0.9.10.tgz` 的 `shasum -a 1`）、`dist.integrity sha512-xPkZMq7BdLS0jzN/iQC6sonYO9OiDHmRC8C20DoM5MS10A1IP++qJVVWpcJ7zjTCf9L7ernqG3koNXo+/MSSCw==`、`gitHead 1e74363735af063e3aea439e59e3bfd9f94722e6`；tag `v0.9.10`、GitHub release https://github.com/panqing0313/dsh-plugin-weixin/releases/tag/v0.9.10 。
- **注册表有延迟**：`npm publish` 打印 `Your package is being processed and may take a few minutes to become available`，之后约 1 分 20 秒里 `npm view version` 仍返回 `0.9.9`、`npm view dsh-plugin-weixin@0.9.10` 直接 404 —— 第 4 次轮询才变成 `0.9.10`。**发布后不要用「立刻查不到」判断失败**。
- **第 8 步之后脚本又静默退出了**（`[8] Wait for the registry / waiting for the registry to serve the new version.` 之后无输出、exit code 0），`verifyPublished` 与第 9 步钉 profile 都没跑 —— 与 0.9.7/0.9.8 同现象（`writeOut` 只吞掉了 EIO，写完之后轮到等待逻辑时进程仍然提前结束）。手工收尾：`node bin/install.mjs --profile desktop --pin` 一次搞定（复制源码 + `profile dependency ^0.9.9 → ^0.9.10` + `profile lockfile refreshed — the app will not roll back on restart`）。
- **装好的副本**：`0.9.10`、`PLUGIN_VERSION = "0.9.10"`、`README.en.md` 与 `CHANGELOG.md` 随包落地；`node bin/doctor.mjs` → `up to date (0.9.10)`、11 checks 0 problems。
- 内容：README 重排（语言切换 / 徽章 / 目录 / 四个入口）+ 版本日志迁到 `CHANGELOG.md` + 新增 `README.en.md`（968 行）+ 发版脚本 bullet 目标改到 CHANGELOG + 修 `--dry-run` 不恢复 CHANGELOG 的 bug。

## 发版脚本：终端断开不再吞掉后半程（2026-10-28）

- **症状**：0.9.7、0.9.8、0.9.10 三次都是「包发了、tag 打了、GitHub Release 建了，然后没有任何输出、exit code 0」——`verifyPublished` 与「钉 profile」没跑，得手工补 `node bin/install.mjs --profile desktop --pin`。0.9.9 那次能跑完，是运气。
- **根因**：发布必须真 pty（npm 的 2FA 链接只在 TTY 上打印），所以跑在 `script -q /dev/null` 里。包装一关，内核往前台进程组发 `SIGHUP`，**node 默认直接退出** —— 之前只修了 `writeOut` 吞 `EPIPE`，那只挡住了「写输出」，挡不住「进程被杀」。所以它总是死在 `[8] Wait for the registry` 那段 `await sleep(4s)` 上。
- **修法两层**：
  - `bin/release.mjs` 顶部 `process.on('SIGHUP' | 'SIGPIPE', …)` 记一个 `hungUp` 标记并继续跑，结尾若真被打断过，多打一行「终端挂断过，但每一步都跑完了」。实测：`node -e "import(...).then(() => { setTimeout(writeFile, 1200); process.kill(process.pid,'SIGHUP') })"` → 子进程 exit 0 且文件写出，证明进程确实活着。
  - 兜底命令 `node bin/release.mjs --finish <version>`：只做发布之后的收尾（等 registry → tag/push/release → 核验 → 装本机 profile 并钉依赖），配套把每个收尾步骤都做成**幂等**（tag 已存在就跳过、`gh release view` 有就跳过、没有本地 tarball 就只核对 registry sha1 与 dist-tag）。`--finish` 没有版本号时立刻 `die` 并给出示例，不会半跑。
- **实测**：`node bin/release.mjs --finish 0.9.10`（0.9.10 已发完）→ 四步全绿、无副作用：`the registry now serves 0.9.10` / `tag v0.9.10 already exists` / `GitHub release v0.9.10 already exists` / `profile dependency already points at this version`。
- **文档**：README（中英）的「发布」节重写步骤表 —— 把顺序改成实际顺序（发布 → **立刻** 打 tag/push → 等待 registry → 核验 → `install.mjs --pin`），补上「终端中途断开怎么办」段与 `--finish` 说明；顺手把示例版本号从 0.4.0 改成 0.9.11、把版本 bullet 指向 `CHANGELOG.md`。
- **测试**：新增 `test/release-resume.test.js` 3 条（导入即安装 SIGHUP 处理器；`parseReleaseArgs(['0.9.11','--finish'])` 的完整形状；`--finish` 无版本号 → 非零退出且提示示例）。全量 **692/692**、`node bin/check.mjs` → `checked 146 files`。

## 可拓展点十三项（2026-10-27，已随 0.9.11 发版）

用户 m08866「都要做」。逐项提交、逐项全量绿，最后统一发版。

| # | 是什么 | 落在哪 | 提交 |
| --- | --- | --- | --- |
| ① | 日报：每天一条当日简报，数字全来自流水 | `src/message/reports.js` + `digestEnabled/digestWhen` | `fce796e` |
| ② | 预演模式：先说计划，回「执行」再动手 | `src/message/dry-run.js` + `dryRun` | `06e9dec` |
| ③ | 出站视频真机验证 | 代码就位，测法与结论写进 `docs/manual-checks.md` | 文档 |
| ④ | 探测 `appmsg`/`refermsg` | `src/message/unknown-items.js`（被动监听 + 审计） | `06e9dec` |
| ⑤ | 记忆核对：每周问一句「还准吗」 | `buildReviewPrompt` + `memoryReviewEnabled/memoryReviewWhen` | `fce796e` |
| ⑥ | 关系曲线：每回合一行，90 天火花线 | `src/message/affinity-history.js` | `5d92394` |
| ⑦ | 群里的人：按发送者的联系人档案 | `src/message/contacts.js` | `5d92394` |
| ⑧ | 备份与恢复 | `src/backup.js` + `bin/backup.mjs` + `backupEnabled/backupKeep` | `b146256` |
| ⑨ | 指标导出（Prometheus 文本 + JSON） | `writeMetricsSnapshot` + `bin/metrics.mjs` | `e7c4fd6` |
| ⑩ | 长稳：`npm run soak` | `bin/soak.mjs` + `test/soak.test.js` | `e7c4fd6` |
| ⑪ | 宿主版本兼容表 | `src/host-compat.js` + `docs/compatibility.md` + doctor 一项 | `41896fe` |
| ⑫ | `npx dsh-plugin-weixin` | `package.json` 的 `bin` | `e7c4fd6` |
| ⑬ | 模板包（人设+开关+订阅） | `src/packs.js` + `bin/pack.mjs` + 远程方法 | `41896fe` |

### 坑与教训

- **定时任务的「到点」判定不能在触发时重算**。`ReportScheduler` 第一版在 `#run` 里重新算 `pending()`，于是目标时刻过后一秒算出的「下一次」永远是明天 —— 日报一次都不会发。臂上装的是什么就按什么触发，容差给两秒（给一分钟会让 21:00 的日报在 20:59 发出）。
- **`parseSubscriptionWhen` 也接受 `10m` 与绝对日期**，这些对「报告」是误配置：只发一次或十分钟后发。`nextReportAt` 因此只认 `daily`/`weekly`。
- **恢复不能拿空备份演练**。soak 第一版恢复的是运行开始时那份（目录还空），结果把 journal 抹掉了 —— 恰好是 soak 该抓的那种失败；改成恢复结束时那份，并断言文件数 ≥1 且 journal 回来了。
- **Prometheus 同一指标名下混用有标签/无标签样本会让整族被拒**。注册表的 `name[label]` 键渲染时必须二选一。
- **`bin` 少了 `package.json` 的 `bin` 字段，`npx` 就没法用**；`files` 里也得包含 `bin`。
- **只在写它那天通过的测试**：`quiet-hours` 那条把 23:30 钉死，导入日期一变（或当天 22:30 之后跑）就失败。改成从真实时钟推 5 小时后取整点，断言「缓发不吞当天的正常时段」。
- **模板包不能带安全决策**。`allowedSenders` 与 `maxMediaBytes` 永远不进模板；白名单有测试断言。
- **预演模式不是审批**。插件没有工具拦截入口（`dsh-agent` 里 grep 不到 permission/approval），所以它只能靠提示词自觉，危险工具提醒必须并存。

## 发布 0.9.11（2026-10-28）

- **核验**：`npm view dsh-plugin-weixin version` → `0.9.11`、`dist-tags.latest = 0.9.11`、`dist.shasum 4f85563cc784ea160c2656155b33d190090db212`（= 本地 `dsh-plugin-weixin-0.9.11.tgz` 的 `shasum -a 1`）、`dist.integrity sha512-pYZAi7edQ8D9xiXAqlVvm/BIXfE8XWqW4IW41UmwCX8gR++LmIXfOVQFj9KZ+ep4izveSh26TfP2Ctmg/y7gsw==`、`gitHead ffc907f995f038e16d5f9be8a70dafa2c3d50555`；tag `v0.9.11`（annotated，指向 `ffc907f`）、GitHub release https://github.com/panqing0313/dsh-plugin-weixin/releases/tag/v0.9.11 。
- **发版前**：全量 `npm test` **736/736**、`node bin/check.mjs` → `checked 169 files`；`release.mjs 0.9.11 --dry-run` 打出 158 文件 / 1657kB 的 tarball 并成功还原工作树。
- **2FA 卡点与解法**：非 TTY 下 `npm publish` 只报 `EOTP`，authUrl 被打码成 `***`；`script -q /dev/null` 申请 pty 被环境拒绝（`openpty: Operation not permitted`）。用 `NODE_OPTIONS="--require /tmp/fake-tty.cjs"` 预载一个把 stdin/stdout/stderr 的 `isTTY` 标成 true 的 shim，再 `npm publish --browser=false`，npm 自己走 web-OTP 分支：打印未脱敏的 `https://www.npmjs.com/auth/cli/...`、轮询 doneUrl，浏览器授权后自动带 token 重试。不写新 token 进 `~/.npmrc`，也不需要 pty 设备。
- **注册表延迟**：publish 返回 `+ dsh-plugin-weixin@0.9.11` 后约 90 秒内 `npm view @0.9.11` 仍是 404；轮询等到 `0.9.11` 再跑 `release.mjs --finish 0.9.11`（tag + push + GitHub release + 核验四步全绿）。**发布后不要用「立刻查不到」判断失败。**
- **装好的副本**：profile 依赖 `^0.9.10 → ^0.9.11`、`node_modules/dsh-plugin-weixin` 是 `0.9.11`、锁文件已刷新；`node bin/doctor.mjs` → `✓ installed version 0.9.11`、`✓ host app host 0.2.1-rc.3 (tested)`、`✓ published version up to date (0.9.11)`。重启 DSH 后生效。
- **兼容表**：`docs/compatibility.md` 仍把 `0.9.10` 列为最后一组真机验证过的组合；0.9.11 装好但未重启复核，等按该页 5 步确认后再改，不提前写「已验证」。
- **清理**：tag push 触发的 `release` workflow（run `40610159839`）会重复 publish，已取消；GitHub CI 的历史失败是 matrix 里 node 20 与 `engines >=22.13` 冲突，与本次发版无关。

## CI 真正转绿（2026-10-28）

用户报 `npm test` 在 GitHub Actions 上 1 秒失败（`Could not find '.../test/**/*.test.js'`），继续查下去发现 Node 22 那条腿会挂 6 小时。根因不是工作流写错，而是四件事叠在一起：

- **Node 20 跑不了 `--test` 的 glob**。`engines` 本来就要求 `>=22.13`，矩阵里的 20 只是历史遗留。矩阵改成 `[22, 24]`，并给 job 加 `timeout-minutes: 15` —— 下次再挂，15 分钟就红，而不是六小时。
- **没有宿主包时测试进程不退出**。`src/agent-bridge.js` 懒加载 `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-agent`（optional peer），CI 的 `npm ci` 不装；缺模块的失败留下 unhandled rejection，进程不退出，TAP 停在 71 条，CI 只能干等超时。新增 `test/host-packages.mjs` 统一提供 `hostTest`，给 `busy-turns`（12）、`cancel-turn`（3）、`session-commands`（2）、`tool-audit`（4）共 21 条驱动 `AgentBridge` 的用例加上 skip；裸 checkout 现在是 691 pass / 46 skip / 0 fail。
- **两条只在东八区成立的时区断言**。`audit-chain.test.js` 用 15:00Z/17:00Z 假装跨本地午夜，UTC 下其实是同一天 —— 改用本地 `new Date(2026,9,26,23,0,0)` 与次日 01:00；`reports.test.js` 的 `now` 改成当地 10:00，断言改成 `> now` 且 `<= now+24h`，不再要求「至少 20 小时后」。
- **CI 全局 `DSH_WEIXIN_LINKS_ALLOW_PRIVATE=1` 把 SSRF 守卫关了**。`src/message/links.js:44` 在调用时读这个变量，于是 links 的三个用例真的放行了 `169.254.169.254`。e2e 自己会在用到时设（`test/e2e.test.js:507`），从 ci.yml 删掉即可。

验证：`node:22` 与 `node:24` 容器、非 root、UTC、无宿主包、不带该 env —— 两条都 `test=0`，737 条里 691 pass / 46 skip / 0 fail；本机 macOS（有宿主包）737/737、`node bin/check.mjs` → `checked 170 files`。

## 发布 0.9.12（2026-10-28）

- **内容**：PR #6 的首联系人修复（`58ec924`）+ CI 转绿（`bb2fa3c`）；`npm test` 737/737、`node bin/check.mjs` → `checked 170 files`。
- **认证卡点**：本机 `~/.npmrc` 里的 token 已失效（`npm whoami` → 401；publish 报 `E404 Not Found - PUT https://registry.npmjs.org/dsh-plugin-weixin`，不是 403）。首轮 release 因此停在 `[6] Publish`，版本已 bump 并提交 `1fc7770`，没有 push。用户在真实终端 `npm login --auth-type=web` 后恢复。
- **又一次 web OTP**：publish 仍要求一次性密码；用伪 TTY（`NODE_OPTIONS="--require /tmp/fake-tty.cjs"`）拿到未脱敏的 `https://www.npmjs.com/auth/cli/...`，浏览器授权后自动重试，exit 0。
- **注册表延迟比 0.9.11 更长**：metadata 先可读（`npm view ... version` = 0.9.12），tarball URL 连续 404 约 4 分钟才变 200；期间 profile 的 `pnpm install` 报 `ERR_PNPM_FETCH_404`。**不要用 tarball 404 判断发布失败。**
- **核验**：本地 `dsh-plugin-weixin-0.9.12.tgz` 的 `shasum` = `94e2f7bfd1ef30f7ad3d55a53f903dac8b329504` = registry `dist.shasum`；`dist.integrity sha512-BjVKNlibN3vLioyhAgoIprau/dUokQnFdoFAPR1IJkteFSAnhrVkboZ8tMwpo49JpDn/F/VK0OVpMBVTjDfPbQ==`；`gitHead 1fc777078e4e3eadd43fcb5667130f252c44374a`；`dist-tags.latest = 0.9.12`；tag `v0.9.12`（指向 `1fc7770`）、GitHub release https://github.com/panqing0313/dsh-plugin-weixin/releases/tag/v0.9.12 。
- **profile**：依赖 `^0.9.11 → ^0.9.12`、`node_modules/dsh-plugin-weixin` = 0.9.12、`pnpm-lock.yaml` 的 `dsh-plugin-weixin@0.9.12` integrity 与 registry 一致（`--finish` 首次刷锁文件时 tarball 还是 404，失败；tarball 可读后手工 `pnpm install --prefer-offline` → rc 0）。`node bin/doctor.mjs` → `installed version 0.9.12`、`host 0.2.1-rc.3 (tested)`、`published version up to date (0.9.12)`。重启 DSH 后生效。
- **清理**：tag 触发的 `release` workflow run `40626549110` 已取消（否则会重复 publish）；main 的 CI run `40626543250` 绿。
- **兼容表**：仍把 `0.9.10` 列为最后一组真机验证过的组合；0.9.12 装好但未重启复核，按该页 5 步确认后再改行。

## 主动开口没触发：设置卡被 schema 默认值盖掉（2026-10-28）

用户报「主动开口今天好像没触发」（m00865）。根因不在调度器，在配置合并：

- **证据链**：`Config({}).proactiveEnabled === false`（`src/index.js:209` 的 `z.boolean().default(false)`）；宿主在 `apply` 前用 schemastery 实例化组合配置（`allowedSenders` 2026-10-15、`asr` 2026-10-16 的两次事故都记录过这一点）；`withSavedConfig` 的 `{ ...saved, ...config }` 让这个 `false` 压过 config.json 里的 `true`。实跑 `withSavedConfig(Config({}))` 对真实 config.json 仍得到 `proactiveEnabled: false`。
- **为什么一点痕迹都没有**：`planProactive` 第一条闸门是 `config.proactiveEnabled !== true → { fire:false, reason:'disabled' }`，调度器不写 `proactive-*.json`、不打日志。7.5 小时 92 个 tick 全哑，与现象完全一致。
- **影响面**（都是「卡片改了但运行时没变」）：default false 被打开无效 —— `proactiveEnabled`、`quietHoursEnabled`、`groupChatEnabled`、`dryRun`；default true 被关闭无效 —— `memoryEnabled`、`digestEnabled`、`memoryReviewEnabled`。只有 `asr` 与 `allowedSenders` 因 2026-10 的两次修复逃过。
- **修法**：把 `asr` 的规则推广到顶层 —— 存档值一律优先，除非是空形态（`undefined` / `''` / `[]` / `{}`）；`false` 与 `0` 是真值。`asr` 仍做一层深合并，非空组合 `allowedSenders` 仍优先。
- **测试**：`test/core.test.js` 新增 2 条（saved `true` 胜 schema `false`；saved `false`/数字胜 schema `true`/默认）。全量 **739/739**、`node bin/check.mjs` → `checked 170 files`。

## 发布 0.9.13（2026-10-28）

- **内容**：`withSavedConfig` 优先级修复（`0613be1`）—— 设置卡里的开关从此真的生效；全量 `npm test` **739/739**、`node bin/check.mjs` → `checked 170 files`。
- **核验**：`npm view version` = `0.9.13`、`dist-tags.latest = 0.9.13`、`dist.shasum 443722858e730d3e7dc73a2676a2757a4dad9f0b`（= 本地 tarball）、`dist.integrity sha512-+e2CrjXkAykTN2onLCacvhww5x1W/Xx06XamUIHezy76Wk0tPAgeCYowSs5hZs9lPg8GsCNjE3IqZv6SVB8e7A==`、`gitHead 5f8b0c240ee6f19088709222be2d5f9c4c42ff0b`；tag `v0.9.13`（指向 `5f8b0c2`）、GitHub release https://github.com/panqing0313/dsh-plugin-weixin/releases/tag/v0.9.13 。
- **发布脚本这次一步没停**：preflight → 739 绿 → bump → tarball 158 文件 1658 kB → 提交 → publish（web OTP）→ tag/push/release → 等注册表 → 核验（远端 tarball 与本地 sha1 一致）→ 装 profile + 刷锁，exit 0。
- **profile**：依赖 `^0.9.13`、`node_modules` = 0.9.13、`pnpm-lock.yaml` 的 integrity 与 registry 一致；`doctor` → `installed version 0.9.13`、`host 0.2.1-rc.3 (tested)`、`published version up to date (0.9.13)`。
- **CHANGELOG 占位**：脚本在 bump 时插入的是 `TODO: describe what changed`；发布完成后本提交把它替换成实际内容（脚本的提示语就是这个意思，占位文案会随 tarball 一起发出去）。
- **tag 触发的 release workflow**（run `40680818150`）如预期失败（版本已存在，重复 publish），未重试；main 的 CI（`40680808435`）绿。
- **重启后生效**：重启 DSH 加载 0.9.13；之后主动开口在 09:00–23:00 窗口内每 5 分钟按 35% 概率触发，离上次入站已 >21h，所有闸门都是开的。

## 扩展九项（2026-10-28）

用户 m01192「按任务分开都给做了」。每项独立提交、独立测试、独立文档；`docs/extras.md` 是给人看的使用说明。

### ① 通知桥（`src/notify.js`）

- **为什么**：构建、备份、cron、CI 没有入口把一句话送到微信；agent 只能在一个回合里说话。
- **做成什么**：`POST http://127.0.0.1:47832/notify`，带 `x-notify-token`（或 `Authorization: Bearer`），body 是 `{"text":"…"}` 或纯文本。只绑 127.0.0.1；token 首次启动生成到 `<状态目录>/notify.json`（0600）；每分钟 30 条；正文 4000 字截断；发送失败返回 502，不静默。
- **开关**：`notifyEnabled`（默认 false）、`notifyPort`、`notifyToken`；设置卡「配置项 → 通知桥」。
- **测试**：`test/notify.test.js` 11 条（鉴权、纯文本、限速、超大 body、发送失败、端口占用、token 持久化 0600）。
- **文档**：`docs/extras.md`。

### ③ 离开模式（`src/message/away.js`）

- **为什么**：开会/开车时手机一直响，不设自动回复会显得失礼；设了又怕它对着每个人重复同一句、或者把 agent 叫起来烧 token。要的是「拦一下、记下来、回来汇总」。
- **做成什么**：`/away 2h 开会` 开窗，`/away` 查剩余，`/back` 提前收汇总。窗口内每个会话每 30 分钟最多自动回一句（默认带回归时间，可用 `awayAutoReply` 覆盖），**不经过模型**；其余消息记进 `<状态目录>/away.json`，上限 30 条；到点由 60 秒定时器把汇总发到最后一个找你的会话，然后关窗。命令仍可用（拦截在命令之后）。
- **为什么按会话限流而不是全局**：群里三个人同时找你，只回一句会漏人；按会话计时，每人每半小时最多一句。
- **测试**：`test/away.test.js` 10 条（命令识别、窗口过期、限流、窗口外不记录、30 条上限、汇总文案、空窗欢迎语、默认回复带时间、`/away`→`/back` 全流程、非法时间拒绝）。
- **文档**：`docs/extras.md`「离开模式」。

### ⑥ 共享清单（`src/message/lists.js`）

- **为什么**：「周末买什么」「谁去取快递」只活在聊天记录里，第二天谁也说不清做没做。清单要按账号共享，群聊和私聊看到同一份，才叫共享清单。
- **做成什么**：`/todo` 查看，`/todo add 买牛奶`（或直接 `/todo 买牛奶`）新增，`/todo done 2` 完成，`/todo rm 2` 删除。每条记 `by`（哪个会话加的）与完成时间；上限 100 条，满了明确拒绝；状态 `lists.json` 原子写。
- **为什么不做多清单**：`/todo 购物 add …` 的语法会让「直接写内容」这条捷径失效，而多数人只有一个清单；需要分类时用文本前缀（`[购物] 牛奶`）就够了。
- **测试**：`test/lists.test.js` 9 条（命令识别、顺序与持久化、跨会话共享、账号隔离、done/rm 越界、空内容、上限、命令全流程、help 可发现）。
- **文档**：`docs/extras.md`「共享清单」。

### ⑧ 稍后读（`src/message/reading.js`）

- **为什么**：链接在聊天里被转发两次就找不到了；「等会儿看」需要一个比聊天记录更耐久的地方。
- **做成什么**：`/later <url>` 存链接并取标题（失败退回域名），`/later 一段文字` 原样存；`/later` 看清单，`/later done 2`、`/later rm 2`。按账号存，`reading.json` 原子写，上限 50 条；同一未读链接去重，读完后可再存。
- **边界**：不替人读全文、不调模型；非链接文本不发网络请求；标题只用于显示，不改 URL。
- **测试**：`test/reading.test.js` 11 条（命令识别、空清单、标题、域名回退、纯文本、去重、done/rm、上限、格式化、help 可发现）。
- **文档**：`docs/extras.md`「稍后读」。

### ④ 要文件：`/send`（`src/message/send-file.js`）

- **为什么**：出站附件原来只由模型回复里引用的路径触发，用户没有「把那个文件发我」的直通入口。
- **做成什么**：`/send <路径>`，路径经 `resolveAllowedPath`（工作目录 / 状态目录 / `mediaDirs`，realpath 后判包含，拒绝 `..` 与符号链接逃逸），必须是普通文件，受 `maxMediaBytes` 限制；失败时文件保留并如实说明。
- **不是**「任意路径发送」：命令不绕过自动附件的守卫，这是它存在的前提。
- **测试**：`test/send-file.test.js` 10 条（命令识别、相对/绝对路径、越界拒绝、`..` 拒绝、缺失文件、大小上限、空参数、上传失败、help 可发现）。
- **文档**：`docs/extras.md`「要一个文件」。

### ⑨ 导出的文件也发出来（`src/index.js` 命令分支）

- **原来的断点**：`/export` 超过 3000 字时把 Markdown 写进 `exports/`，回复里只有一行路径 —— 命令回复走的是 `sendChunked`，不经过 `resolveOutboundReply`，所以文件不会上传，用户还得去手机之外找。
- **改法**：命令回复分支里，`/export` 的回复再走一遍 `resolveOutboundReply`（与模型回复附件同一条管线、同一个 `mediaDirs` 白名单、同一个 `maxMediaBytes`），文本与附件一起发；其它命令不受影响。
- **验证**：路径判定与上传管线沿用既有单测；真实上传需要真机，测法写进 `docs/manual-checks.md` 第 4 节（短回复直接正文、长回复文件 + 文字；失败看 `outbound media:` 日志）。
- **注意**：`resolveOutboundReply` 从 `src/index.js` 导出（`export async function`），命令分支与后续真机脚本可复用；插件默认导出不变。

### ⑤ 加密备份：一个文件、一句口令（`src/backup-crypto.js` + `bin/backup.mjs`）

- **为什么**：原有的备份是明文目录，能回滚但带不走——`config.json` 里有 token，journal 里有聊天原文。
- **做成什么**：`seal <file.enc>` 把整个状态封成一个文件（`DSHWX1` 头 + scrypt 派生的 AES-256-GCM），`open <file.enc>` 解密后逐字节还原；口令只从 `DSH_WEIXIN_BACKUP_PASSPHRASE` 读，落盘前先全量解密校验，错误口令/篡改文件不会写半个字节。
- **边界**：拒绝归档里 `..` 或绝对路径；恢复前检查 DSH 是否在跑（`--yes` 可强来）；跳过 `backups/`、`instance.lock`、`node_modules`。
- **测试**：`test/backup-crypto.test.js` 8 条（密文不含明文、往返、错口令、篡改拒绝、还原、路径逃逸、口令必填、随机 salt）。
- **文档**：`docs/extras.md`「加密备份」；`bin/backup.mjs` 用法表。

### ⑦ 省钱：按用途分开路由（`src/model-route.js`）

- **原来的问题**：主动开口、日报、`/summary` 全挤在 `sideProvider` 一条线上；开口只有二十个 token，却和要读流水的日报用同一个（往往不便宜的）模型。
- **做成什么**：`ROUTE_PURPOSES` 扩到 `chat / side / memory / proactive / report`；主动开口用 `proactiveProvider+proactiveModel`，日报与记忆核对用 `reportProvider+reportModel`，都留空则回落到原来的 `side → memory` 链。`index.js` 的 `sideRoute` thunk 改为 `(purpose) => routeFor(purpose, config) ?? sideRouteFor(config)`，三个调用点显式传 `'proactive'` / `'report'`。
- **半对不生效**：只填 provider 或只填 model 不算路由，测试钉住；避免把会话丢进一个模型名缺失的路由。
- **测试**：`test/model-route.test.js` 新增 2 条，覆盖独立性与回落；`config-remote` 表单同步加四个字段（表单/ schema 双向一致测试仍绿）。
- **文档**：README 模型路由表、`docs/extras.md`「省钱路由」。

### ② 文档理解：发进来的文件直接问（`src/media/document.js`）

- **原来的断点**：入站文件只是下载落盘，提示里只有路径；没有文件工具的回合只能回「我收到了一个文件」。
- **做成什么**：`.docx` 零依赖解析（zip 中央目录 + `word/document.xml` + 去标签/实体），`.txt/.md/.csv/.json/.log/.xml/.yaml` 直接读；抽出的正文用 `<weixin_document>` 包起来（`neutralizeTags` 转义）拼进该回合提示，`documentTextChars` 截断并注明。
- **边界**：`.pdf` 明确 `unsupported`，不假装能读；`.docx` 只取正文，不取批注/脚注；解析失败只 warn，不影响消息本身的处理。
- **测试**：`test/document.test.js` 9 条（段落/制表符/实体、deflate、截断、纯文本、pdf、空文档、缺 document.xml、坏 zip、默认上限）。
- **文档**：`docs/extras.md`「文档理解」；设置卡新增「文档理解」组。

## 发布 0.9.14（2026-10-29）

- **内容**：九项扩展全部落地（通知桥、文档理解、离开模式、`/send`、加密备份、共享清单、稍后读、按用途路由、`/export` 附件），外加 e2e 时序修复 `466f471`（persona 测试的第二次假 poll 在发布负载下 10 秒不够，放宽到 30 秒并注明原因）。
- **发布前**：全量 **809/809**、`node bin/check.mjs` 通过；CHANGELOG 条目先手写再发（`dd6a2d7`），避免脚本插入 `TODO` 占位。
- **打包**：165 文件、1.7 MB，`shasum 5f42067399b7400bf4a0d3e0ec77ba8f30a91962`、`integrity sha512-voyqTMWpyQk+/F8vDcvPfHptlB/MsTs6hf1HFywaavZyy6E6IuVWjfPg2vAv2r+wuwklkd55s+fVYZaLrkt60A==`。
- **两个卡点**：
  - `[4] Build and verify` 拒绝发布：7 个新文件权限是 `0600`，tarball 里 “not world-readable”；`chmod -R go+rX` 后重跑。
  - 第一次 publish 的 web 授权会话失效（`GET /-/v1/done` 返回 404），重新 publish 拿到新链接、用户授权后成功。
- **注册表延迟**：publish 返回 `+ dsh-plugin-weixin@0.9.14` 后约 **160 秒**才 `npm view @0.9.14` 可见；`--finish 0.9.14` 四步全绿：tag `v0.9.14`（指向 `15c7c23`）、push main + tag、GitHub release https://github.com/panqing0313/dsh-plugin-weixin/releases/tag/v0.9.14 、profile `^0.9.13 → ^0.9.14` 且锁文件已刷新。
- **核验**：`dist-tags.latest = 0.9.14`、`gitHead 15c7c23…`；`doctor` → `installed version 0.9.14`、`host 0.2.1-rc.3 (tested)`、`published version up to date (0.9.14)`。
- **清理**：tag 触发的 `release` workflow `40731262165` 失败（版本已存在，与 0.9.11–0.9.13 同一预期）；main 的 CI `40731253225` 绿。
- **兼容表**：仍把 `0.9.10` 列为最后一组真机验证过的组合；0.9.14 已装进 profile 但未重启复核。

### ① PDF 正文：可选依赖、明确降级（`src/media/document.js`）

- **为什么**：`documentExtract` 原来只解 docx/txt，`.pdf` 一律回 `unsupported` —— 用户发一份合同 PDF，模型只拿到一个路径。
- **做成什么**：`extractPdfText` 用 `pdfjs-dist` 的 legacy build（动态 `import`），`getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false })`，逐页 `getTextContent()`，按 `item.str` 拼、`hasEOL` 补换行，`destroy()` 放在 `finally`；只取文字，不需要 canvas。`extractDocumentTextAsync` 按扩展名分流（pdf 异步、其余仍走同步零依赖路径），`src/index.js` 的入站循环改成 `await`。
- **降级是明确的**：`pdfjs-dist` 声明成 optional peer（`peerDependencies` + `peerDependenciesMeta.optional`），默认安装不会带；没装时返回 `{ ok: false, reason: PDF_LOAD_HINT }`，解析失败返回具体错误，空文本返回 `empty`。截断与 docx 共用 `truncate()`（前 `documentTextChars` 字 + 注明）。
- **测试**：`test/document.test.js` 15 条 —— 同步路径仍拒绝 PDF、缺包给 hint、假 pdfjs 验证逐页拼装/换行/截断/空文本/解析错误、异步入口对非 PDF 分流，以及一个**真实最小 PDF** 的集成用例（装了 `pdfjs-dist` 才跑；本机 15/15）。
- **文档**：`docs/extras.md`「文档理解」补 PDF 与启用方法；schema 与设置卡提示同步改成「PDF 需要可选依赖 pdfjs-dist」；`package.json` 加 optional peer。

### ② 引用回复：refermsg 不再只是日志里的一行（`src/message/quote.js`）

- **原来的断点**：`unknown-items.js` 只把 `refermsg` 记进审计日志，入站解析从不读它 —— 用户引用一句话再问「这句什么意思」，模型看不到被引用的那句。
- **做成什么**：`parseQuote(items)` 依次找 `item.refermsg` / `item.appmsg.refermsg` / `item.quote.refermsg`，取 `content`（回落到 `des`）、`title`、`displayname`（回落到 `fromusr`）；`quoteBlock()` 拼成 `【引用 小王】` + 标题 + 正文。`normalizeInbound` 把它挂到消息的 `quote` 上（文本、带 caption 的媒体、以及不认识的 item 都带）；`index.js` 在拼提示时把引用块放在用户消息之前，并让「只有引用没有正文」的消息不再走「没看懂」的早退。
- **不可信处理**：引用内容先 `redactSecrets` 再 `neutralizeTags`，正文截断 500 字、标题 120 字。
- **测试**：`test/quote.test.js` 9 条（三种形状、链接卡片回落到 des、无引用、脱敏与截断、块格式、无正文引用、带 caption/媒体、未知 item 仍可达模型）。
- **文档**：`docs/extras.md`「引用回复」。

### ③ 重要日子的当天提醒（`src/message/dates.js`）

- **原来的问题**：`profile.dates` 与带 `when` 的待办只在提示词里「被看到」，模型得自己意识到今天几号；用户不主动提，生日就过去了。
- **做成什么**：`datesOnThisDay()` 按**月日**匹配（年份只用来算「第 N 年」），同时取 `when === 今天 && done !== true` 的待办；`buildDateReminderText()` 生成一条不带模型解释的短消息。`index.js` 里一个 60 秒定时器，到 `dateReminderWhen`（默认 09:00）后对每个账号检查一次，命中才发、发完记 `dates.json` 的 `lastSent`；不跑模型、不写 journal。
- **为什么不用日报**：日报在 21:00，生日提醒应该在早上；两者互不依赖，关掉日报不影响提醒。
- **状态**：`dates.json` 按账号存 `lastSent`，原子写；没命中的日子不标记，当天补记仍能发。
- **测试**：`test/dates.test.js` 7 条（时间解析、跨年匹配、当天待办/已完成/其它日期、文案、到点与每日一次、账号隔离、状态文件）。
- **文档**：`docs/extras.md`「重要日子的当天提醒」；设置卡「汇报」组两个开关。

### ④ OCR 桥：一个可执行文件，一条约定（`src/media/ocr.js`）

- **为什么**：图片里的字（截图、单据、聊天记录）模型看不见；内置识别引擎要么体积不可接受、要么中文效果差，而且每个平台的安装方式都不同。
- **做成什么**：`resolveOcrSettings(config)` 只在 `ocrEnabled === true` 且 `ocrCommand` 非空时返回设置；`extractImageText(filePath, settings)` 用 `spawn(command, [filePath])` 跑一次，stdout 即文字，超时 `SIGKILL`，退出码/空输出/ spawn 失败全部降级成 `{ ok:false, code }`，**从不抛**。`index.js` 的入站循环对 `kind === 'image'` 的附件逐张调用，成功则把 `<weixin_ocr path=...>` 拼进 `parts`（与文档正文同级、同样 `neutralizeTags`）。
- **默认关闭**：`ocrEnabled` 默认 false，`ocrCommand` 默认空——没有引擎的部署行为与之前完全一致。
- **测试**：`test/ocr.test.js` 7 条（设置解析、路径是唯一参数、截断、非零退出、空输出、超时 kill、spawn 失败）。
- **文档**：`docs/extras.md`「识别图片文字：OCR 桥」含 tesseract wrapper 示例；设置卡新增四个字段。

### ⑤ 出站 webhook：只推事件，不接管回复（`src/webhook.js`）

- **为什么**：插件里发生的事（收到消息、回复发出）只有日志和 journal 两个出口；接 n8n / 自建面板 / 告警系统需要一条 HTTP 出口，而且不能因为对端挂掉拖慢回复。
- **做成什么**：`createWebhookSender({ url, secret, timeoutMs, fetchImpl, warn })` 返回 `{ send(event, payload) }`；POST JSON `{ event, at, ...payload }`，配了 secret 就带 `X-Weixin-Signature: sha256=<hex>`（对原始 body 的 HMAC-SHA256）；`AbortSignal.timeout` 控制超时；非 2xx / 网络错误 / 超时都只 `warn` 并返回 false，**从不抛**。
- **接线**：复用已有的 hook bus，不新开调用点 —— `index.js` 在 setup 里订阅 `HOOK_POINTS.inboundAccepted` → `message.received`、`HOOK_POINTS.outboundSettled` → `reply.settled`；dispose 时统一退订。URL 为空/非法就完全不创建 sender。
- **测试**：`test/webhook.test.js` 5 条（URL 校验、JSON 形状与 ISO 时间、HMAC 签名、非 2xx、网络错误）。
- **文档**：`docs/extras.md`「出站 webhook」含签名校验片段；设置卡三个字段。

### ⑥ 后台预算闸门：只挡后台，不挡对话（`src/budget.js`）

- **为什么**：后台调用（记忆折叠、日报、核对、订阅、主动开口）没有用户消息触发，一个循环 bug 或话痨日报能在夜里把额度烧光，而没人立刻发现。
- **做成什么**：`backgroundBudget(stateRoot, { limit, now })` 读 `budget.json`（`{schemaVersion, day, used}`，跨天归零），`limit <= 0` 不限；`recordBackgroundCall()` 在**实际发起后**才 +1。闸门装在 `AgentBridge.summarize()` 入口：`allowBackground()` 返回 `{allowed:false}` 时直接返回 `undefined`，不 attach、不排队、不计数。
- **接线**：`index.js` 构造 bridge 时注入 `allowBackground`（每次读实时配置，卡片改完下一次生效）与 `onBackgroundCall`；schema 加 `backgroundDailyLimit`（默认 0），设置卡加一个字段。
- **测试**：`test/budget.test.js` 5 条（0 不限、到上限拒绝、跨天归零、损坏文件容错、bridge 被拒时不计数）。
- **文档**：`docs/extras.md`「后台预算」。

## 发布 0.9.15（2026-10-31）

- **内容**：六项扩展 —— PDF 正文（可选 `pdfjs-dist`）、`refermsg` 引用消息、日期当天提醒、OCR 桥、出站 webhook、后台预算闸门；全量 **848/848**。
- **npm 认证又过期**：`npm whoami` 401；`NODE_OPTIONS="--require /tmp/fake-tty.cjs" npm login --auth-type=web` 打印 `https://www.npmjs.com/login?next=/login/cli/...`，用户在浏览器授权后恢复（`whoami` → `panqing0313`）。publish 仍要一次 web OTP（`https://www.npmjs.com/auth/cli/5e8d2e79-…`）。
- **打包权限**：5 个新文件是 `0600`，tarball 校验 `✗ 5 file(s) in the tarball are not world-readable`；`git ls-files -z | xargs -0 chmod go+rX` 后重跑。新文件用编辑器创建时默认 0600，发版前记得这一步。
- **核验**：`dist-tags.latest = 0.9.15`、`dist.shasum f703e6eb54502dcb26f784ae0731a236b49b57b1`、`dist.integrity sha512-zsPyQusvFdyiqpuHHBcu9TEwQwVZblncKaEynBV4wSzrPSpqwLhrbtuJ6B/W4Ra5unfNJYwi0+OqsIKAlc8poA==`、`gitHead e3a29e0c3c9ad3a32d0d616053e4570cad459cb5`；tag `v0.9.15`（指向 `e3a29e0`）、GitHub release 已建；profile `^0.9.14 → ^0.9.15`、`node_modules` 0.9.15、锁文件刷新。
- **CI 两处修复**（发布后转绿）：
  - `19c191b`：`test/dates.test.js` 用 `2026-10-31T09:00+08:00` 断言「已到 9 点」，UTC runner 上那是 01:00 → 改成本地时间构造（`new Date(2026,9,31,9,0)`）。
  - `8155888`：OCR 超时定时器 `unref()` 后，事件循环可以先空而 promise 永不 settle，Node 22 报 `Promise resolution is still pending but the event loop has already resolved`；去掉 `unref`（定时器由 `finish()` 清除，且有 `timeoutMs` 上限）。
  - 两条都先在本地 `fnm exec --using=v22.23.4 -- npm test` 全量 848/848 验证；CI run `41161838714` 双绿。
- **宿主升级**：本机 DSH 已是 `0.2.1-rc.5`，不在测试表（表里是 `0.2.1-rc.3`），`doctor` 会明确标出。按 `docs/compatibility.md` 的 5 步复核通过后再加行，不提前写「已验证」。
- tag 触发的 release workflow `41161269592` 失败（版本已存在，预期）。

## 发布 0.9.16（2026-10-31）

- **一行修正**：把 `8155888` 的 OCR 定时器修复发进 npm，让 0.9.15 与 main 对齐（0.9.15 的包里还是带 `unref()` 的版本）。
- **核验**：`dist-tags.latest = 0.9.16`、`dist.shasum d76a90a6a2693d3017f79ba7e6d13083e65a0c40`、`dist.integrity sha512-wLA2A7BIx/cNHREQ1eybHCLc+PrCnqemVcmbCRenrpB2uc8xi1PJi1tEEy/D3EUP7DLwrWTDMZ/NGqSH0Q+bng==`、`gitHead 6e1096a32d6921a639090e5ae4df43ff5e28ccfd`；tag `v0.9.16`（指向 `6e1096a`）、GitHub release 已建（非 draft/prerelease）；profile `^0.9.15 → ^0.9.16`、`node_modules` 0.9.16、锁文件刷新。
- **测试**：全量 **848/848**；CI 发布提交 run `41162357569` 与 CHANGELOG 提交 run `41162197055` 均 success；tag 触发的 release workflow `41162361718` 失败（版本已存在，预期）。
- **doctor**：`installed version 0.9.16`、`published version up to date (0.9.16)`；`host app 0.2.1-rc.5` 当时还标「不在测试列表」。
- **真机复核（2026-10-31，用户确认）**：0.9.16 跑在宿主 `0.2.1-rc.5` 上，设置卡九个页签、左侧栏入口、收发、`/status` 均正常 → `src/host-compat.js` 的 `TESTED_HOSTS` 加 `0.2.1-rc.5`，`docs/compatibility.md` 加 `0.9.16 / 0.2.1-rc.5` 行；`doctor` 现在显示 `host 0.2.1-rc.5 (tested)`。

### ① 提醒时间说人话（`src/message/scheduler.js` + `src/sessions.js`）

- **原来的问题**：`/remind` 只认 `10m` / `18:30` / `2026-10-20 09:00`，而且正则把时间限制成一个 `\S+` token —— 说「明天 9:00」会被切成时间「明天」+ 内容「9:00 …」，直接报看不懂。
- **做成什么**：`parseWhen` 增加第 4 种写法：中文口语日期（今天/今晚/明天/明晚/后天/大后天/下周X/这周X）+ 时段（上午/中午/下午/晚上…）+ 钟点（`9:00`、`9点`、`9点半`、`9点15分`），以及 `3小时后` / `半小时后`。`/remind` 的正则改为整段捕获，执行分支按前缀逐段试解析，第一个能解析的前缀是时间、其余是内容。
- **不猜**：`明天下午`（没有钟点）与 `下周一`（没有钟点）都明确要求补时间；`今天 9:00` 已过则报错，不会悄悄改成明天；`下周一` 永远指下一周，`周一` 才指本周。
- **测试**：`test/scheduler.test.js` 新增 1 条（覆盖明天/后天下午/今晚/相对/下周X/裸钟点/拒绝形态）；`test/sessions.test.js` 新增 1 条（带空格的时间切分、单 token 旧写法、只给时间缺内容）。
- **文档**：README 命令表与「定时提醒」节、`docs/extras.md`「提醒时间说人话」、`/remind` 的 help 文案。

### ② `/diag`：聊天里的一条自检（`src/message/diag.js`）

- **为什么**：用户问「怎么没反应」时，真实原因通常是免打扰、白名单为空、主动开口额度用完或连接没就绪——这些状态散在配置、状态文件和调度器里；`/status` 只讲会话，`doctor` 只在终端跑。
- **做成什么**：`buildDiagReport` 纯函数拼一段话（版本/宿主、账号与连接、模式、五个开关、待发提醒与订阅、主动开口今日额度与上次/退避、今日流水/会话记忆/白名单、免打扰剩余）；`/diag` 在 persona bundle 里现场取数，**不调模型、不读大文件**。
- **细节**：宿主版本不传就不写「宿主」那行（不编造）；`transport` 为空时明说「连接未就绪，收不到消息」；主动开口没有状态文件时说「今天还没有发过」而不是 0/3。
- **测试**：`test/diag.test.js` 3 条（全量字段、静默+断连、无宿主版本）；`test/session-commands.test.js` 新增 1 条端到端（回 `自检 · v…`、不打开任何会话）。
- **文档**：README 命令表、`docs/extras.md`「`/diag`：它为什么没动静」。

### ③ `/outbox`：把「没发出去」变成可见、可重试（`src/message/outbox.js` + `src/sessions.js`）

- **原来的断点**：出站失败已经会入队并自动退避重试，但只有设置卡能看见；用户在聊天里不知道有东西卡着，也没法立刻重试。
- **做成什么**：`formatOutbox(items,{now,limit})` 纯函数渲染队列（条数、id、多久以前、尝试次数、上次错误、40 字预览）；`/outbox` 查看、`/outbox retry` 强制 `flush({force:true})`、`/outbox drop <id>` 丢弃。复用既有 `pending/flush/drop`，不新增状态，也不改变自动重试。
- **测试**：`test/outbox.test.js` 新增 2 条（空队列、列表/错误/截断、上限与剩余）；`test/session-commands.test.js` 新增 1 条端到端（空队列文案、不打开会话）。
- **文档**：README 命令表、`docs/extras.md`「`/outbox`：没发出去的那句话去哪了」。

### ④ 群里被叫到才回：称呼可配、写法更宽（`src/message/groups.js`）

- **原来的问题**：`mentionsBot` 只认 `accountId / accountLabel / botName`，而 iLink 不告诉插件机器人的群昵称 —— 没填备注名的用户，@ 了也不会被认出来；全角 `＠`、微信插的 U+2005、英文大小写也没处理。
- **做成什么**：新增 `groupBotNames`（逗号分隔）并并入 `botNames`；匹配前把 `Ｕ+2005/Ｕ+00A0/Ｕ+3000` 归一成空格、`＠` 归一成 `@`，名字比较不区分大小写；仍然只认首行、开头或空白之后的名字，宁漏勿扰。
- **测试**：`test/groups.test.js` 新增 2 条（全角/细空格/大小写/正文深处不误判、`groupBotNames` 走策略）；`config-remote` 表单同步一个字段（表单/schema 双向一致测试仍绿）。
- **文档**：README 配置表与群聊节、`docs/extras.md`「群里被叫到才回」。

### ⑤ 重复提醒（`src/message/scheduler.js` + `src/sessions.js`）

- **原来的问题**：`/remind` 只有一次性时间；「每天 9:00 吃药」要么每天手动发一遍，要么得用 `/subscribe`（那要调模型、还带人设）。
- **做成什么**：`parseRecurrence(spec, now)` 解析 `每天/天天/每日`、`工作日/每个工作日`、`每周X` + 钟点（与一次性共用 `9:00`/`9点`/`9点半` 写法），`nextRecurrenceAt` 算严格晚于当前时刻的第一个槽；`ReminderScheduler` 的提醒对象带上 `recurrence/hour/minute/scheduledFor`，到点触发后写回下一个槽并重新 `#arm`，而不是删除。`/remind` 的执行分支先试重复前缀、再试一次性前缀，其余是内容。
- **不猜**：`每周一`（无钟点）与 `每天 25:00` 都明确报错；`明天 9:00` 仍走一次性，`parseRecurrence` 对它返回 not ok。
- **测试**：`test/scheduler.test.js` 新增 2 条（三种重复的解析与首个槽、跨周末的工作日、非法写法；触发后条目仍在且槽前进一天）；`test/sessions.test.js` 的命令用例补 `每天 9:00 吃药` 与 `工作日 8:30 打卡` 的切分与计划字段。
- **文档**：README 命令表与「定时提醒」节、`docs/extras.md`「重复提醒」。

## 发布 0.9.17（2026-10-31）

- **内容**：五项让「没动静」可解释/可修 —— 提醒时间说人话（`/remind 明天 9:00`、`3小时后`、`下周一 10点`）、重复提醒（`每天/工作日/每周X`，触发后自动排下一个槽）、`/diag` 自检、`/outbox` 待重发可见与手动重试、群称呼 `groupBotNames`（全角 ＠、细空格、大小写）。
- **测试**：`npm test` → **861/861**、0 skipped；`node bin/check.mjs` → 171 files。
- **发布**：`node bin/release.mjs 0.9.17 --yes`（伪 TTY + `env -u NO_COLOR -u FORCE_COLOR`）一次过：preflight、suite、bump、tarball（171 文件 1700 kB）、publish（web OTP）、tag `v0.9.17`、push、GitHub release、registry 核验 `byte-identical`、profile 安装。
- **发布提交** `d5ab873 chore(release): 0.9.17`（tag 指向它）；`gitHead d5ab873`。
- **核验**：本地/registry `shasum 72fe6ca0e0985c66d14a4a28f8373ea84ad8fbf0`、`dist-tags.latest = 0.9.17`、GitHub release 非 draft/prerelease；`node bin/doctor.mjs` → `installed 0.9.17`、`host 0.2.1-rc.5 (tested)`、`published up to date`。
- **profile**：依赖 `^0.9.16 → ^0.9.17`、`node_modules` 0.9.17；release 脚本的锁文件刷新第一次因 tarball 404（注册表延迟）失败，约两分钟后用宿主自带 `pnpm install --prefer-offline` 手工刷新成功（`- 0.9.16` / `+ 0.9.17`）。
- **CI**：发布提交 run `41167028800` success；tag 触发的 release workflow `41166913785` 失败（版本已存在，预期）。
- **兼容表**：用户重启后复核「正常」（设置卡九个页签、左侧栏入口、收发），`docs/compatibility.md` 新增 `0.9.17 / 0.2.1-rc.5` 真机验证行；宿主版本没变，`TESTED_HOSTS` 不动。

### ① 临时静默 `/quiet`（`src/message/temp-quiet.js`）

- **为什么**：固定免打扰只覆盖「每天同一时段」；临时开会/看电影只能改配置再改回来，容易忘。
- **做成什么**：账号级状态 `quiet.json`（`{schemaVersion, accounts:{id:{until,setAt}}}`，原子写）；`/quiet 30m|2h`、`/quiet` 查剩余、`/quiet off` 立刻恢复；1 分钟–24 小时的边界。
- **闸门**：`quietGate(now, accountId)` 把固定时段与临时静默取较晚者，`ReminderScheduler` / `SubscriptionScheduler` 触发时把 `accountId` 传进来；主动开口的 `candidates()` 直接跳过静默账号（不判断、不花 token）；离开模式仍记未读但不自动回。入站回复不受影响。
- **测试**：`test/temp-quiet.test.js` 4 条（存取/清除、过期与账号隔离、边界、文案）；`test/session-commands.test.js` 端到端 1 条（设置/查询/恢复，且不开会话）。
- **文档**：README 命令表、`docs/extras.md`「临时静默」。

### ② 提醒的「等会儿」：`/snooze` 与 `/remind skip`（`src/message/scheduler.js`）

- **为什么**：提醒到点时人可能正忙；取消再重排会丢内容，重复提醒还会把周期弄乱。
- **做成什么**：`ReminderScheduler.snooze(accountId, minutes, now)` 取最早一条，清掉旧 timer、`fireAt = max(fireAt, now) + span`，重复项同步 `scheduledFor` 后写盘重臂；`skipNext(accountId)` 取最早的重复项，用 `nextRecurrenceAt(..., scheduledFor)` 跳到再下一次。一次性提醒 `skipNext` 返回 undefined（取消请走 `/remindcancel`）。
- **命令**：`/snooze 10m|1h`（`parseWhen` 解析时长）、`/remind skip|跳过`；两者都不开模型会话。
- **测试**：`test/scheduler.test.js` 新增 2 条（推后与周期对齐、跳过与一次性拒绝）；`test/sessions.test.js` 新增 1 条（命令到调度器的参数与回执）。
- **文档**：README 命令表、`docs/extras.md`「提醒的等会儿」。

### ③ 用量账单 `/usage`（`src/message/usage.js`）

- **为什么**：想知道今天花了多少，只能翻三个文件或看日志；而且「后台预算」与「主动开口额度」是两套计数器，没有一处合起来看。
- **做成什么**：`buildUsageReport(input)` 纯函数（另有 `usageSummary` 供 `/diag` 复用）；`/usage` handler 现场读 `readBudget`、`readProactiveState`、`outbox.pending()`、`reminderScheduler.list()`、`subscriptionScheduler.list()`、`readJournalRange(..., days:1)`，字符用 `estimateTokens` 折算。
- **明确的口径**：token 是「正文粗估」，不含系统提示词/工具结果/历史；预算为 0 说「未设上限」而不是除零；用完时补一行「停到明天零点重置」。
- **测试**：`test/usage.test.js` 4 条（完整一天、无预算无开口、预算用完、摘要行）；`test/session-commands.test.js` 端到端 1 条（不开会话）。
- **文档**：README 命令表、`docs/extras.md`「`/usage`：今天花了什么」。

### ④ 习惯打卡 `/habit`（`src/message/habits.js`）

- **为什么**：提醒只负责喊，做了没有没人记；「连续几天」这种正反馈是坚持的动力。
- **做成什么**：`addHabit / checkHabit / removeHabit / habitsList`（`habits.json` 按账号、原子写、上限 20、同日重复打卡明确拒绝）；`streakOf` 从今天（或昨天）往回数，`bestStreakOf` 扫历史，`weekCount` 数最近 7 天；`formatHabits` 与 `habitDigestLine`（一行进日报）。
- **命令**：`/habit`、`/habit add|done|rm <名字或序号>`；不调模型、不开会话。
- **测试**：`test/habits.test.js` 9 条（新增/重复/空名、20 上限、同日重复、连续与断点、最长连续与本周、本地日期、列表文案、命令分支）；`test/session-commands.test.js` 端到端 1 条。
- **文档**：README 命令表、`docs/extras.md`「习惯打卡」。

### ⑤ 媒体归档检索 `/media`（`src/message/media-archive.js`）

- **为什么**：入站媒体存在 `media/inbound/` 下，文件名是 UUID；想找回「上周那张截图」只能去 Finder 里翻，也没法从微信里重发。
- **做成什么**：`listInboundMedia(dir, {limit})` 只读目录、跳过子目录、按 mtime 倒序（默认 8、上限 20），`mediaKind` 按扩展名给人话类型，`humanTime`/`humanBytes` 给手机可读的表述；`formatMediaList` 编号；`/media resend <序号>` 经过 `resolveArchivePath`（`realpath` 后必须仍在归档目录内、必须是普通文件）后走调用方给的 `sendMedia`，失败时保留文件并说明。
- **测试**：`test/media-archive.test.js` 7 条（类型、时间/大小、排序与上限、缺失目录、编号文案、路径约束、命令列表/重发/越界/失败保留）。
- **文档**：README 命令表、`docs/extras.md`「媒体归档」。

### ⑥ 群内每人每日配额（`src/message/sender-daily.js`）

- **为什么**：`senderRatePerMinute` 是每分钟的，挡不住一天 300 条；`backgroundDailyLimit` 是账号级的，一人能把全家的后台额度用光。缺的是「每人每天」这一层。
- **做成什么**：`createSenderDailyLimiter({stateRoot, limit, now, warn})` → `{check(accountId, senderId), used, limit}`；状态 `sender-daily.json` 按账号分、按本地日期滚，原子写；拒绝时按 5 分钟冷却只提示一次，并写 `weixin/daily-limit` 审计。接线在 `senderDailyGate`（白名单之后、任何外网请求之前），设置卡加 `senderDailyLimit` 字段。
- **测试**：`test/sender-daily.test.js` 6 条（0 不限、按人与账号独立、冷却、跨天与持久化、损坏容错、日期键）；`test/e2e.test.js` 端到端 1 条（同一人第 3 条被拒而另一人正常）。
- **文档**：README 配置表、`docs/extras.md`「群里每人每天聊多少」。

### ⑦ 重要日子提前提醒（`src/message/dates.js` + `dateReminderLeadDays`）

- **为什么**：当天提醒只在当天说，生日当天才看到就晚了 —— 买礼物、订蛋糕都需要提前。
- **做成什么**：新增 `upcomingDates(memory, now, {leadDays})`，在 0–30 天窗口里返回 `daysAhead`（0 = 今天）；`datesOnThisDay` 保留为 `leadDays: 0` 的兼容入口。日期按「今年这一次，过了就算明年」求下一次，所以窗口不会复活已经过去的日子；`buildDateReminderText` 拆成「📅 今天是重要日子」与「🗓 快到了」两段（`明天` / `N 天后`）。schema 加 `dateReminderLeadDays`（0–30，默认 0），设置卡同步一个字段。
- **测试**：`test/dates.test.js` 新增 2 条（窗口只指向下一次、文案分段）；原有 7 条不变（`upcomingDates` 与旧行为一致）。
- **文档**：README 日报节、`docs/extras.md`「重要日子提前提醒」。

## 发布 0.9.18（2026-10-31）

- **内容**：七项扩展 —— `/quiet` 临时静默（`da50556`）、提醒 `/snooze` 与 `/remind skip`（`a03599b`）、`/usage` 用量账单（`1e9f53d`）、`/habit` 习惯打卡（`d273052`）、`/media` 媒体归档（`5a21199`）、群内每人每日配额 `senderDailyLimit`（`2696a42`）、重要日子提前提醒 `dateReminderLeadDays`（`525086c`）；CHANGELOG `92238bf`。全量 **901/901**、`node bin/check.mjs` → `checked 203 files`。
- **发布**：`e43ec1c chore(release): 0.9.18`；tag `v0.9.18` 指向 `e43ec1c`、GitHub release https://github.com/panqing0313/dsh-plugin-weixin/releases/tag/v0.9.18 、profile `^0.9.17 → ^0.9.18` 且锁文件刷新。
- **核验**：本地 tarball `shasum 14768e6ce83c4bba603ded24317d73bf77fbcfb1` = registry `dist.shasum`；`dist.integrity sha512-q5NixjAHILR1G/j1FmEcvr4tS8wvVpdGVMx1zPxOBnX7kg5AGz4oDwifNnkgcja0yK7c8ermCvMMFTNUspUTmw==`；`gitHead e43ec1c16545bbe9a753f42fbaf98a2493cd18ca`；`dist-tags.latest = 0.9.18`；`doctor` → `installed 0.9.18`、`host 0.2.1-rc.3/rc.5 (tested)`、`published up to date`。
- **两个坑**：
  1. 第一次 publish 的 web OTP 会话在等待时过期，`GET /-/v1/done?authId=…` 返回 `404`，脚本报 `npm publish failed`——**版本已 bump 但什么都没发出去**。重开一次 publish 拿新链接、授权成功，之后 `--finish` 才跑完（脚本第一次 `--finish` 还因为注册表尚未可见而拒绝，约一分钟后 `npm view` 才显示 0.9.18）。
  2. CI（Node 24 那条腿）发现 `test/media-archive.test.js` 的真 flake：同一 tick 写入的三个文件 mtime 相同，`listInboundMedia` 只按时间排序时顺序随 `readdir` 变化，Linux 上 `resend 1` 拿到的不是 `report.pdf`。修法：排序加名字作为 tie-breaker，并把测试的 mtime 固定；提交 `abbf3ae`，CI run `41182008158` 绿。
- **兼容表**：用户重启后复核「可以了」（设置卡九个页签、左侧栏入口、收发），`docs/compatibility.md` 新增 `0.9.18 / 0.2.1-rc.5` 真机验证行；宿主版本没变，`TESTED_HOSTS` 不动。

### P1 启动并行化（`src/startup.js`）

- **原来的问题**：`src/index.js` 的 `bringUpLoop` 用 `for (const account of accounts) { await bringUpAccount(...) }`，N 个账号要等 N 次握手；第二个账号的连接要等第一个账号的登录/拉取全部就绪才开始，而它们本来就是互不依赖的长轮询。
- **做成什么**：新增 `startAccounts(accounts, bringUp, warn)` —— `Promise.allSettled` 并行扇出，失败按账号收集成 `{ started, failures }` 并逐条 warn；一个坏凭据（文件损坏/CDN 不可达/ticket 被拒）只让它自己起不来。
- **测试**：`test/startup.test.js` 4 条 —— 用「三个人都进门才开闸」证明并发（串行会超时失败，不靠 wall-clock）、坏凭据隔离、空列表、非 Error 的 rejection 也能读。
- **判据**：串行时 N×t → 并行约 t；单账号行为与错误隔离语义不变。

### P2 热路径 JSON 读取缓存（`src/atomic.js`）

- **为什么**：每条入站消息都会重读 `config.json`（`readSavedConfig`）、`accounts-registry.json`（`readRegistry`）和 persona/conv 文件；`readFileSync` 的开销在 open/read/close 与 UTF-8 解码，不在 `JSON.parse`。
- **做成什么**：新增 `readTextFileCached(file)` —— 按 `mtime + size + ino` 失效，缓存的是**文本**而不是解析后的对象，所以每次调用仍 `JSON.parse` 出一个新对象，调用方照旧可以修改/写回；`atomicWriteJson` 写完显式失效；缓存上限 512 条（读命中重新插入，近似 LRU）。`readJsonFile`、`readSavedConfig`、`readRegistry` 都走它。
- **实测**（同一份 ~1KB 的 config，5000 次）：`readSavedConfig` 11.2µs → **3.7µs/op（3.0×）**；纯 `read+parse` 基线 11.6µs。
- **测试**：`test/file-cache.test.js` 6 条 —— 第二次读不碰磁盘（mock `readFileSync` 计数）、原子写后立刻可见、外部改写按 size 失效、每次返回独立对象、单条失效、缺失文件不缓存。

### F1 手动日报 `/digest`（`src/message/digest.js`）

- **为什么**：日报只能等 21:00；白天想问「今天干了啥」，没有任何入口，而且定时与手动若各写一遍 prompt，口径迟早漂移。
- **做成什么**：把「今天长什么样」抽成 `composeDigest({stateRoot, accountId, conversationId, now, warn, day})`（流水统计 + 未完成事件 + 会话摘要 + 习惯打卡行），定时器（`src/index.js` 的 `ReportScheduler.fire`）与新的 `digest` handler 共用；命令走 `sideRoute('report')`，回复即日报，不额外发消息、不写 journal、不动定时器。
- **测试**：`test/digest.test.js` 3 条（数字/事件/摘要/习惯全在、安静的一天、不追踪习惯时没有那行）；`test/sessions.test.js` 1 条（`/digest` 是命令且带参数就不算）。
- **文档**：README 命令表、`docs/extras.md`「`/digest`」。

### F2 归档清理 `/media clean` 与容量上限（`src/message/retention.js`）

- **为什么**：`media/inbound` 只有「按天」清理（`retentionMediaDays: 30`），没有手动入口，也没有总容量上限；本机已经攒到 110 个文件，突发连发会一直涨。
- **做成什么**：`enforceMediaCap(dir, {maxBytes})` 按 mtime 从旧到新删到落回上限（0 = 不限，上限以内不动作，缺失目录不算错）；`/media clean [天数]` 复用 `sweepRetention` 只对 media 一类按天数清一次，随后再受容量上限约束，回复里报告件数与字节。schema 加 `mediaMaxBytes`（默认 0），设置卡同步（MB 单位）。
- **测试**：`test/retention.test.js` 新增 1 条（删最旧、上限内不动、0 = 不限、缺失目录）；`test/media-archive.test.js` 新增 2 条（容量上限只删最旧、按天数清理与非法天数）。
- **文档**：README 命令表、`docs/extras.md`「归档清理」。

### P3 测试提速（61s → 38s）

- **根因一：事件轮询写死 1 秒**。`src/agent-bridge.js` 的 `pollMs` 默认 1000，每个回合的回答要等下一次快照才可见；单测文件都显式传 `pollMs: 10–20`，只有 e2e 用默认值。新增 `eventPollMs`（schema 默认 1000，设置卡可调 0–60000），bridge 用它轮询；生产行为不变，e2e 统一传 25。
- **根因二：出站限速 1200ms 也进了测试**。`OutboundPacer.minIntervalMs` 默认 1200（防封号的实测阈值），长回复被 `maxMessageLength` 切成 8 条就要等 7×1200ms ≈ 8.4s —— `markdown` 那条 11 秒的用例就是它。测试配置统一 `sendIntervalMs: 1`。
- **根因三：假服务端立即回空批**。`getupdates` 返回 `longpolling_timeout_ms: 20` 时传输层把它当忙循环，探针实测 1 秒 7002 次 poll。两个假 iLink 对空批次改为延迟 200ms 再回（有脚本的批次仍立即返回）。
- **结果**：`test/e2e.test.js` 61s → 24s、`test/session-commands.test.js` 57s → 6s、`test/markdown.test.js` 17s → 4s；全量 **918/918、61s → 38.4s**（目标 <40s）。
- **为什么不改生产默认值**：`eventPollMs` 与 `sendIntervalMs` 的默认值都是对着真实宿主与微信服务端的；提速只发生在测试配置里，线上仍按原来的节奏。
