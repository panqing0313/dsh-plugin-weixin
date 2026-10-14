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
