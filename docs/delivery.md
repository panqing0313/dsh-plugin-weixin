# dsh-weixin 媒体能力 — 交付说明

> 本文档记录微信媒体能力（入站图片/文件/语音、出站图片/文件、Markdown 转纯文本）的交付状态、
> 验证证据与遗留事项。面向后续维护者与"这功能到底能不能用"的追问。

## 一句话结论

微信 ↔ DSH 的**文本 + 图片 + 文件**双向通路已在真机验证可用；语音仅降级落盘（无 ASR）。
全量 **83 tests / 83 pass / 0 fail**，无新增运行时依赖。

## 真机验证证据（最强证据，非模拟）

2026-10-14 07:30，用户从微信发送一张图片（一锅冬瓜虾仁玉米汤 + 一盘青椒板栗炒牛肉，1280×1707）。

会话文件 `~/.dsh/sessions/--<cwd-key>--/weixin-<your-wechat-id>-im-wechat/session.v4.jsonl.zstd`
（用 `/opt/homebrew/bin/zstd -d -c` 解压，60 条事件）记录了完整链路：

```
微信图片
  → iLink 入站（ImageItem + aeskey）
  → 先过 allowlist 鉴权（未授权不产生任何 CDN 请求）
  → 下载密文 → AES-128-ECB 解密 → 落盘
       ~/.dsh/weixin/media/inbound/956b939c-image.jpg  (273131 字节)
  → 把本地绝对路径作为文本交给 agent
  → agent 调用 read_image 真读到像素
       tool-call name: read_image
       arguments: {"file_path":"~/.dsh/weixin/media/inbound/956b939c-image.jpg"}
       result: "image/jpeg image, 1280x1707 px, 303190 bytes" + image 附件块
  → 回复经 Markdown 转纯文本 → 分片 → 发回微信
       turn/end: {"kind":"completed"}
```

agent 在 reasoning 里分出了菜色（`Chestnuts (板栗), green bell pepper slices, beef pieces`），
证明拿到的是**真实像素**而非文件名占位。

## 架构与移植边界

**只移植 Hermes/openclaw-weixin 的通信层，不移植其 Agent 运行时** —— 避免两个控制中心、
两套会话/工具/权限系统。

```
src/
  index.js          插件入口：Config schema、apply()、鉴权→去重→会话→agent→出站 的编排
  agent-bridge.js   与 DSH agent 的桥接：agentOptions({provider,model})、cwd、workspace 登记
  transport/ilink.js  iLink 长轮询、normalizeInbound()、send()/sendMedia()
  media/inbound.js   入站媒体：下载→解密→落盘→交给 agent
  media/outbound.js  出站媒体：路径闸门→引用检测→上传→发送
  message/markdown.js  Markdown→纯文本（包装 vendor 的 StreamingMarkdownFilter）
  message/chunker.js  按 maxMessageLength 分片
  message/dedupe.js   按 messageId 去重
  security/allowlist.js  发送者/会话白名单
  state.js           状态目录：accounts / sessions / media/inbound
vendor/openclaw-weixin/   上游 @tencent-weixin/openclaw-weixin@2.4.10 的移植副本（26 文件）
```

### 关键顺序（承重，改动前必读）

出站链路 **媒体先、Markdown 后**（`src/index.js:378` 的注释与 `:380` 的调用）：

```
resolveOutboundReply()   ← 先消费 ![alt](path)，替换为 alt 文本   (src/index.js:380)
       ↓
sendChunked()            ← 再 Markdown 转纯文本，然后分片        (src/index.js:476)
```

**颠倒会让所有附件静默消失**：实测 `markdownToPlainText('看图 ![柱状图](/tmp/out/chart.png) 结束\n', 'strip')`
→ `"看图  结束\n"`，图片语法被整个删除（是删除，不是降为 alt 文本）。

同一约束还要求 **先转换后分片**，否则转换可能使文本超过 `maxMessageLength`。

### 鉴权顺序（有意与上游相反）

上游 `process-message.ts` 先下载（:157）再鉴权（:188）。本项目**先鉴权再下载**
（`src/index.js:301` 注释、`:305` 鉴权、`:330` 才下载）：
未授权发送者不得让本机对腾讯 CDN 发出任何请求。e2e 断言 `cdnHits === 0`。

## 配置项（`src/index.js` Config schema）

| 选项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 加载时启动长轮询 |
| `accountId` | `''` | 空 = 使用唯一已保存账号 |
| `cwd` | `''` | agent 工作目录；空 = 默认到 `~/.dsh/weixin/sessions` |
| `allowedSenders` | `[]` | **空 = 拒绝所有人**（安全默认） |
| `allowedChats` | `[]` | 空 = 允许已授权发送者的任意会话 |
| `maxMessageLength` | `1500` | 出站单条上限 |
| `progressAfterMs` | `45000` | 超过此时长发一条进度提示 |
| `maxTurnWaitMs` | `1200000` | 放弃等待轮次的时限 |
| `typingIndicator` | `true` | 有 typing ticket 时显示"正在输入" |
| `mediaEnabled` | `true` | 是否把 agent 引用的本地文件发回微信 |
| `maxMediaBytes` | — | 出站单个文件上限 |
| `maxInboundMediaBytes` | 20MB | 入站单个附件上限 |
| `cdnBaseUrl` | `''` | 空 = 让账号记录供给，再退回上游默认 |
| `markdownMode` | `'strip'` | `'strip'` 转纯文本 / `'off'` 逐字节原样（调试用） |

`cdnBaseUrl` 三级优先级（`src/index.js:127`）：
`config.cdnBaseUrl?.trim() || account.cdnBaseUrl || DEFAULT_CDN_BASE_URL`

## 移植的上游模块（vendor，26 文件 / 3481 行）

来源 `@tencent-weixin/openclaw-weixin@2.4.10`（MIT，上游 GitHub `Tencent/openclaw-weixin`），
取自 `dist/src` 编译产物，已删 `.map` 与 sourceMappingURL。

新增（本轮媒体能力）：
`cdn/{aes-ecb,cdn-url,pic-decrypt,cdn-upload,upload}.js`、
`media/{mime,media-download,silk-transcode}.js`、
`messaging/{markdown-filter,send-media,send,partial-quote}.js`、`util/random.js`

### 三处有意的机械改动

1. `openclaw/plugin-sdk` 的 import 重定向到 `./openclaw-shim.js`。
2. 加 `package.json`：`api.js` 读取 `pkg.ilink_appid` 与 `pkg.version`。
3. `src/state.js` 设 `OPENCLAW_STATE_DIR`，把凭据重定向到 `~/.dsh/weixin/`。

### 两处判断（含一处偏离）

- `messaging/send-media.js` 依赖 `./send.js`（不在原定移植清单里），**一并移植**。
- `messaging/inbound.js` **故意不移植** —— 会拖入整套未使用的 MsgContext/quote 层；
  改为把 `send.js:5` 的 `getMediaLabel` 指向 shim（`openclaw-shim.js:63-75`，
  与上游 `dist/src/messaging/inbound.js:126-138` 功能等价）。
  因此 `send.js` 与上游只差**一行**功能代码。

## 已修复的真实缺陷（按发现顺序）

| # | 缺陷 | 严重度 | 修复位置 | 复核 |
|---|---|---|---|---|
| 1 | 围栏/行内代码里的 `![alt](path)` 被当真实附件上传到 CDN（maskCode 逃逸） | high | `src/media/outbound.js` 遮蔽逻辑（含 `isCloserTail`） | t8 发现，t7 repair，t8/t10 确认 |
| 2 | `resolveAllowedPath` 只对候选路径 realpath、不对 roots realpath；macOS `/var` vs `/private/var` 使**所有**合法文件被误拒 | high | `src/media/outbound.js` `realpathOrSelf()` | t3 |
| 3 | 允许目录内**不存在**的文件被误报为"越界"（原因完全误导） | medium | `src/media/outbound.js` `realpathNearestAncestor()` | t3 |
| 4 | F5-C：schema `.default(生产URL)` 让账号记录的 `cdnBaseUrl` 成**死代码**，账号配置永不生效 | high | `src/index.js:73-79` 改 `.default('')` | t9/t10 |
| 5 | T9-WS：空白串 `cdnBaseUrl` 被 `\|\|` 当 truthy，顶掉可用账号记录 → `Failed to parse URL from    /upload?...` | medium | `src/index.js` `:127`/`:267`/`:323` 三处 `.trim()` | t10/t11 |
| 6 | T9-DEADTAIL / F5-DEAD：不可达尾项 | low | `resolved?.cdnBaseUrl` 已移除咨询 | t10 |

### 上游线格式（非本项目 bug，勿"修"）

`vendor/openclaw-weixin/cdn/upload.js:83` 返回的 `aeskey` **是 hex 字符串**；
`messaging/send.js:223/255/287` 对其做 `Buffer.from(uploaded.aeskey).toString('base64')`，
按 UTF-8 编码，故解码后是 **32 个 ASCII 字节**而非 16 个原始密钥字节。

已对上游已发布 TS 源码核实（`/tmp/ocwx-full/package/src/cdn/upload.ts:20` 声明 `aeskey: string;`
`:92`/`:117` `.toString("hex")`；`src/messaging/send.ts:298/342/386` 同样的写法）。
入站方向 `media/media-download.js:19-20` 反而是正确写法（`Buffer.from(img.aeskey, "hex")`）。
判定为上游互通缺陷，**vendor 原样保留**，测试固定真实行为并注明。

## 测试

```
node --test --test-timeout=25000 "test/**/*.test.js"
→ tests 83 / pass 83 / fail 0
```

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `test/core.test.js` | 19 | allowlist、去重、分片、会话分组 |
| `test/inbound-media.test.js` | 26 | 下载/解密/落盘、两种 aeskey 编码、越界、超大、未授权不触 CDN |
| `test/outbound-media.test.js` | 14 | 路径闸门、引用检测、上传请求体 |
| `test/markdown.test.js` | 18 | 保留/剥离清单、off 逐字节一致、转换后分片 |
| `test/e2e.test.js` | 6 | 完整接线：假 iLink + 假 CDN |

### 测试陷阱（后续勿踩）

1. **`path.join(root, '/etc/passwd')` 会拼回 root 内部**（= `root/etc/passwd`），
   越界样本的断言会恒为真。本任务在此坑上踩了三次。越界样本必须用真正的相对/绝对逃逸。
2. **假 iLink 的 getuploadurl 不得返回 `upload_full_url`**，否则上传永远打到假 CDN，
   看不出客户端实际使用的 `cdnBaseUrl`。
3. **跑全量务必带 `--test-timeout`**；仓库 `node_modules/@deepseek-ai/` 下三个符号链接
   （cosmokit / schemastery / dsh-llm）若缺失会报 `Cannot find package '@deepseek-ai/dsh-llm'`，
   属环境问题非产品缺陷。

### 验证方法论教训

曾用"退回 `:127` 的 `?.trim()` 后测试失败"来证明**出站方向**被覆盖 —— **这是错的**。
全量退回时 `new URL('   ')` 先抛错，入站下载根本没发出，失败停在**入站**断言，
从未执行到出站断言。方向的覆盖必须靠**单向隔离实验**证明（只让一个方向失效，观察失败点）。

## 部署

插件运行的是 profile 里的**副本**，不是工作区：

```bash
cd <repo>
node bin/install.mjs --profile desktop
# installed package → <profile>/node_modules/dsh-weixin
# refreshed the dsh-weixin row in .../cordis.patch.yml (kept allowedSenders, enabled)
```

安装会 `fs.rmSync(targetDir)` 后全量重拷，并**保留** operator-owned 值
`KEPT_KEYS = ['allowedSenders','allowedChats','cwd','accountId','enabled']`。

部署后必须验证：

```bash
diff -rq src    <profile>/node_modules/dsh-weixin/src
diff -rq vendor <profile>/node_modules/dsh-weixin/vendor
grep -c "disabled: !!js" <profile>/cordis.patch.yml  # 必须为 1
```

**最后一条是硬性要求**：`disabled` 必须是**单行**标量。多行块标量会让 loader 的 `eval()`
抛 `TypeError: object is not iterable`，插件**静默不激活**（表现为"没有 iLink 连接、agent 不回复"）。

## 遗留事项

| 项 | 状态 | 说明 |
|---|---|---|
| **语音完整识别（ASR）** | 未实现 | 无 `silk-wasm` 时降级存 `.silk`；完整识别需另加 ASR。`silk-wasm` 为动态可选导入，**未安装**。 |
| 出站无独立工具 | 设计如此 | 靠 agent 回复文本里引用路径（Markdown 图片语法或纯路径行），且路径必须在允许目录内。 |
| T10-R1（low） | 判定不做 | `:127`/`:323` 仍各自重算同一 CDN 回退表达式。两处 `.trim()` 语义相同故不可能分歧，改动面会碰到 transport 构造路径。 |
| T10-R3（low） | 建议不做 | 语法合法但语义错误的 CDN URL 被静默接受，属用户配置问题。 |
| Hermes LICENSE 复核 | 未完成 | 早期网络失败（`TypeError: fetch failed`）未能读取。**本项目实际未移植 Hermes 代码**，vendor 来源为 `@tencent-weixin/openclaw-weixin`（MIT），故此项对交付无阻塞。 |

## 团队协作状态说明

AgentTeams 团队 `dsh-weixin-media` 显示 `escalated`，且 `t8`/`t9` 为 failed、unresolved ——
**这是记账状态，不是产品状态**。二者均为 review 任务，因 review round 触顶（3）
无法自动开下一轮而停机。它们报出的缺陷（上表 #1、#4、#5、#6）**均已修复并被后续轮次独立复验通过**。

任务图：t1（vendor 移植）→ t2/t3/t4（入站/出站/Markdown，并行）→ t5（端到端验证）
→ t6/t7（maskCode 修复循环）→ t8 → t9（F5-C 修复）→ t10 → t11（全部 pass）。

---

# 语音识别（ASR）真机验证记录

## 验证日期与方式

真实微信账号，用户从手机发出一条语音（**未经任何模拟**）。全部证据取自
`~/.dsh/sessions/--Users-panqing-.dsh-weixin-sessions--/weixin-…-im-wechat/session.v4.jsonl.zstd`。

## 链路与实测值

| 阶段 | 实测 |
| --- | --- |
| 入站下载 | `235aa830-voice.silk`，4016 字节，头 `02 23 21 53 49 4c 4b 5f 56 33`（`#!SILK_V3`） |
| SILK → WAV | `938a2e5d-235aa830-voice.silk.wav`，106604 字节 |
| WAV 参数 | `pcm_s16le` / 24000 Hz / 单声道 / 2.22s |
| 转写结果 | **「大金鱼」** |
| ASR 桥 | 单进程 pid 64597 持续运行 —— **常驻复用生效**，未按语音逐条重启 |

## 交给 Agent 的原文（逐字）

`agent/inbox/spliced` 与 `user/message` 两处记录一致：

```
[用户发送的语音已保存到本地：~/.dsh/weixin/media/inbound/938a2e5d-235aa830-voice.silk.wav（938a2e5d-235aa830-voice.silk.wav, 104KB）]
【语音转写】以下为语音识别结果，均按用户原话处理：
大金鱼
```

Agent 随后在自己的 reasoning 中写道 **"the harness provided a transcription: \"大金鱼\""** ——
确证它拿到的是转写文本，而非仅仅一个文件路径。

## 为什么这条证据不可替代

同一条语音在 t12 之前只能交付一个 `.silk` 路径，Agent 只能回答「我读不了音频」。
现在它拿到了**语义内容**并能据此追问「大金鱼指什么」。这是「转码 + 识别」与「只存文件」的
分水岭，也是本轮功能唯一的验收标准。

## 冷/热延迟（本机 M4）

- 冷启动（含加载 `mlx-community/whisper-small-mlx`）：4032ms
- 热调用：**294ms**（2.4s 音频）
- 因此 `DEFAULT_ASR_TIMEOUT_MS = 60000` 是**兜底**而非延迟目标：它防的是病态挂起，
  冷启动几十秒仍属正常。

## 磁盘（用户明确要求）

- 模型缓存 668MB 放在数据盘（非系统盘）的独立目录；
  系统盘 `~/.cache/huggingface` 仅 28KB，**未被污染**。
- 转发/探测产生的脚本与 harness 一律放在数据盘的 scratch 目录下，
  系统盘 `/tmp` 已清空我方产物。
