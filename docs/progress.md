# 开发进度

更新时间：2026-06-16

## 已完成

- [x] 创建 `dsh-weixin` 项目目录与包结构；
- [x] 落地总体方案、移植边界、里程碑和安全策略；
- [x] 建立消息、会话、配置和白名单的领域模型；
- [x] 调研并确认真实的 DSH 插件契约（`name` / `inject` / `Config` / `apply`）与 `agents` 服务用法；
- [x] 放弃"手写移植 Hermes Python iLink 客户端"，改为 vendor 腾讯官方 MIT 传输层；
- [x] vendor `@tencent-weixin/openclaw-weixin@2.4.10` 的编译产物并剥离 OpenClaw 耦合（3 个 SDK import → shim）；
- [x] 把凭证目录从 `~/.openclaw` 重定向到 `~/.dsh/weixin`；
- [x] 实现 iLink 长轮询 transport（`getUpdates` / `sendMessage` / `sendTyping` / sync buf / backoff）；
- [x] 实现 `AgentBridge`：微信会话 ↔ DSH agent 会话（create/resume + `followup` + 读回回复）；
- [x] 实现 session log 读取（`assistant/message` / `assistant/attempt` 的 `stream` + 在跑工具）；
- [x] 实现扫码登录 CLI（`bin/login.js`）；
- [x] 实现插件入口 `src/index.js`（Config schema + 白名单 → 去重 → 会话 → 分段回发）；
- [x] 实现安装脚本 `bin/install.mjs`（写 node_modules / bundles / cordis.patch.yml）；
- [x] `node --test "test/**/*.test.js"`：`tests 11 / pass 11 / fail 0`；
- [x] 端到端冒烟（假 iLink 服务 + 假 agents 服务 + 真实插件代码）通过；
- [x] 真实网络扫码登录探测通过（拿到真实二维码与 fallback URL）；
- [x] 补第三方代码声明 `THIRD-PARTY-NOTICES.md`。

## 进行中

- [ ] 安装到 `desktop` profile 并在真实 DSH 里加载（受沙箱写权限限制，需用户授权或手动执行）；
- [ ] 真实微信账号闭环验收。

## 待完成

- [ ] 图片、文件、语音、视频的收发（vendor 的 media/cdn 模块未引入）；
- [ ] 长任务进度与取消（目前只有一条进度提示，无 `/cancel`）；
- [ ] 审计日志持久化（目前只有 `ctx.logger`）；
- [ ] DSH 配置 UI / 设置面板；
- [ ] 多账号路由与账号状态上报；
- [ ] 真实账号长时间运行的重连与限流观察（iLink 已知会有消息丢弃）。

## 关键决策

1. **不移植 Hermes runtime，只借通信层。** 避免两套控制中心（session/工具/权限各存一份）。
2. **vendor 腾讯官方 SDK，不手写 iLink 客户端。** 协议细节（uint64 精度、AES-128-ECB 媒体、typing ticket、sync buf）已由官方实现覆盖。
3. **不引入 OpenClaw。** 只需要 3 个叶子 helper，用 `openclaw-shim.js` 顶掉即可。
4. **运行时用 JS，不用 TS。** `.ts` 在工作区可直接跑，但安装进 profile 后位于 `node_modules` 下，Node 拒绝在 `node_modules` 里做类型剥离（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。类型用 JSDoc 表达。
5. **会话 meta 不写自定义 `origin`。** session header schema 只允许 `origin: 'subagent'`，写了会抛 `SessionFormatError`。
6. **白名单默认拒绝所有人。** 微信文本不是授权凭据。

## 当前完成度

按"可运行的生产插件"计：约 **85%**（真实收发已验证；仅剩 Agent 接管需重启 DSH 后验收）。

## 验证记录

- `node --test "test/**/*.test.js"` → `tests 13 / pass 13 / fail 0`（白名单、分段、去重、入站归一化、stream 重组、回复读取、工具跟踪、session id、空 group_id 回归、完整链路 e2e）。
- 端到端冒烟：假 iLink HTTP 服务 + 假 `agents` 服务 + 真实插件/transport/bridge。
  - 输出：`listening as account bot1` → `turn settled in ~1000ms` → 拒绝 `wxid_stranger` → 跳过重复 `1001`；
  - 出站：`{"to":"wxid_abc","ctx":"ct1","text":"pong: hi"}`、`{"to":"wxid_abc","ctx":"ct3","text":"（暂不支持这条消息：item type 2）"}`。
- 真实网络登录探测：`node bin/login.js --timeout 4000` 打印真实二维码 + fallback URL `https://liteapp.weixin.qq.com/q/...&bot_type=3`；另生成 PNG 到 `~/.dsh/weixin/login-qr.png`（终端半块字符在 GUI 里不可见）。
- **真实账号登录成功**：得到一个 `<account-id>@im.bot` 形式的机器人账号 → `~/.dsh/weixin/openclaw-weixin/accounts/<account-id>@im.bot.json`（0600），index `accounts.json` 里登记同一个 id。
- **真实收发验证通过**（2026-10-13）：真实 iLink 长轮询收到 `在不在超级大管家` / `我是谁`，回发 `echo: …` 两条均成功；`conversationId` 正确解析为发送者 id。
- 真实 `getConfig` 返回 `typing_ticket`；`sendMessage` 携带真实 `context_token` 无报错。
- 插件加载：`import('src/index.js')` → `{ name: 'dsh-weixin', inject: ['agents'], Config.type: 'object' }`，`Config({})` 返回完整默认值。
- `tsc --noEmit`：不适用，本环境无 TypeScript；已改用 JSDoc + `node --test`。

## 已知环境限制

- 写入 `~/.dsh/profiles/desktop/node_modules/` 在 workspace-write 模式下被沙箱拒绝；提权到 danger-full-access 后 `node bin/install.mjs --profile desktop` 可直接安装。
- 探针脚本必须设 `OPENCLAW_STATE_DIR`（vendored accounts.js 读它，不读 `DSH_WEIXIN_STATE_DIR`）；否则 `loadWeixinAccount` 返回 null → `TypeError: Cannot read properties of null (reading 'baseUrl')`。
- 本环境无 `tsc`；`npm install` 会卡住（需 `--cache <workspace 路径>`，`npm pack` 则正常）。

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

## 遗留 / 已知事项

- 语音完整识别（ASR）未实现：无 silk-wasm 时降级存 `.silk`，已向用户说明需另加 ASR。
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
