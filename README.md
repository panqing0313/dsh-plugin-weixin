# dsh-plugin-weixin

把**个人微信**变成 DeepSeek Harness（DSH）的远程控制面：在微信里发一句话，DSH Agent 在本地开一个会话执行，把结果回给你。

底层用的是微信 **iLink Bot API**（`ilinkai.weixin.qq.com`），传输层来自腾讯官方开源插件
[`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)（MIT，2.4.10），
本项目把它 vendor 进 `vendor/openclaw-weixin/`，剥掉 OpenClaw 的耦合后直接绑定到 DSH 的 `agents` 服务。

不是 Hermes Agent runtime 的移植，也不是网页版微信模拟——只借通信层，控制权始终在 DSH。

![dsh-plugin-weixin：在微信里与 DSH Agent 对话](assets/hero.png)

![一条语音的旅程：SILK 转码、本地 ASR、逐级降级](assets/voice-pipeline.png)

## 当前状态

**已真机验证**：插件加载、扫码登录、长轮询收消息、白名单、去重、开 DSH 会话、读回复、分段回发、
“正在输入”、入站图片与文件、入站语音**识别成文字**（SILK → WAV → ASR，热调用约 300ms）。

**尚未验证**：长时间运行、多账号、群聊；**发送**语音/视频（需要 TTS/视频编码，当前只支持发送
图片与文件）；原生图像理解（入站图片以本地路径交给 Agent，由 Agent 用 `read_image` 打开——
这依赖当前模型与工具链，不是插件自身保证）。

## 目录结构

```
src/index.js            插件入口：name / inject / Config / apply
src/agent-bridge.js     微信会话 ↔ DSH agent 会话（create/resume + followup）
src/session-reader.js   从 session log 读回 assistant 回复与在跑的工具
src/transport/ilink.js  iLink 长轮询 + send + sendMedia + typing
src/security/allowlist.js  发信人/会话白名单（默认拒绝所有人）
src/message/{chunker,dedupe,markdown}.js  分段、有界去重、Markdown→纯文本
src/media/inbound.js    入站媒体：下载、解密、落盘、语音转码
src/media/outbound.js   出站媒体：路径白名单、附件引用识别、上传
src/media/asr.js        语音识别：常驻 ASR 桥客户端（降级而非抛错）
src/state.js            把凭证目录从 ~/.openclaw 重定向到 ~/.dsh/weixin
bin/login.js            扫码登录 CLI
bin/install.mjs         安装到指定 DSH profile
vendor/openclaw-weixin/ 腾讯官方 MIT 传输层（已剥离 OpenClaw 依赖）
```

## 安装

### 方式一：从 npm / git 安装（推荐给普通用户）

DSH 的插件页（侧边栏 **Plugins**）或 `plugin_manager` 工具可以直接从 registry 安装：

```
dsh-plugin-weixin
```

也可以填 git 地址或绝对路径。安装后 DSH 会自动把 bundle 挂上，重启生效。

当前已发布版本：[`dsh-plugin-weixin@0.1.0`](https://www.npmjs.com/package/dsh-plugin-weixin)（2026-10-15 首发，含扫码轮询、登录后自动起循环、allowlist 合并、归档会话自动恢复等全部修复）。

### 方式二：从源码安装

```bash
git clone <this-repo> && cd dsh-plugin-weixin
node bin/install.mjs                      # 默认装到 $DSH_PROFILE（或 desktop）
node bin/install.mjs --profile web        # 装到别的 profile
node bin/install.mjs --uninstall
```

脚本做三件事：

1. 把包（含 `vendor/`）放进 `<profile>/node_modules/dsh-weixin`；
2. 在 `<profile>/package.json` 的 `dsh.profile.bundles` 里追加 `dsh-weixin`；
3. 追加一行 `dsh-weixin` 到 `<profile>/cordis.patch.yml`（幂等，已存在则刷新那一行）。

同时会把两个**可选**依赖（`qrcode-terminal`、`silk-wasm`）搬到 profile 的 `node_modules`——
不搬的话它们只在这个仓库里可见，装到 profile 后会静默降级。

重启 DSH 后生效。

## 登录

```bash
node bin/login.js                    # 终端打印二维码，手机微信扫码
node bin/login.js --account work     # 多账号时指定 id
node bin/login.js --force            # 已有账号时强制重新扫码
```

凭证写入 `~/.dsh/weixin/openclaw-weixin/accounts/<id>.json`，权限 `0600`，**只在本机**。
`bin/login.js` 不接收密码，也不会把 token 打印到日志（vendor 自带 redact）。

### 在 DSH 设置页登录

「设置 → 插件 → dsh-plugin-weixin」里也能直接扫码，不用开终端：

- 点「扫码登录微信」后，卡片显示**真正的二维码图片**（host 端把 iLink 返回的登录链接渲染成
  PNG 再回传，客户端不需要任何二维码库）；
- 二维码旁边有「在浏览器打开」和「复制链接」——iLink 返回的 `qrcode_img_content` 其实是一个
  **登录链接**（`https://liteapp.weixin.qq.com/q/...`），不是图片；链接在浏览器里打开同样能扫码；
- 需要验证码时卡片会切到输入框，提交后继续轮询；二维码过期会自动刷新（最多 3 次）。

### 退出登录与重新绑定

「退出登录」只删除**本机**凭证。iLink 没有服务端解绑接口，机器人仍挂在微信侧（手机微信里仍显示
「已绑定」），所以：

- 退出登录后卡片显示「未登录」是**如实显示，不是状态不实时**——本机确实已经没有任何凭证。
  卡片的状态由本地账号文件决定，手机上的「已绑定」说的是服务端绑定关系，两者本来就不是一回事；
- 如果你在这次退出登录之前用设置页扫码，那个流程**从来没有走通过**（轮询一直在 `poll(null)`，
  见 `docs/progress.md`）。也就是说：扫码后卡片停在二维码页、扫码结果无人处理，与手机显示
  「已绑定」无关。修复后重新扫码才会真正走到服务端；
- 走到服务端之后还有一种情况：服务端仍认为这台机器绑定着同一个机器人时，会回 `binded_redirect`
  并**拒绝下发新凭证**（此支语义取自 vendor 源码；vendor 的 CLI 把它读成幂等成功
  「已连接过此 OpenClaw，无需重复连接」，但那只在**本机仍持有 token** 时才成立，退出登录后 token
  已经没了，本机也没有任何接口能解绑）；
- 卡片会把这种情况单独报成「需要处理」，并给出唯一可行的动作：**先在手机微信里解除该机器人的绑定**，
  然后重新扫码。

即：退出登录 = 本机忘记；要重新绑定 = 手机上先解绑。

### 扫码成功后不需要重载 DSH

插件刚加载时如果本机还没有凭证（全新安装，或刚退出登录），收消息的 `getUpdates` 长轮询在那时
是**无法启动**的。设置页扫码成功后，登录会通知宿主立刻为**刚写入的凭证**把这条循环拉起来，
所以「扫码 → 重载 DSH → 才通」这个多余步骤已经没有了。

如果手机微信仍提示「暂时无法连接 openclaw」，按顺序看四处：

1. 插件日志里有没有 `listening as account <id>`——没有就是循环没起来；
2. 有没有 `settings login service unavailable`——有就说明登录服务没装上，扫码**能**成功、
   凭证**会**写盘，但没有任何人在听「登录已完成」，循环不会切到新凭证（历史上这一行曾把
   `ctx.plugin()` 的误用吞掉，症状与「循环没起来」完全相同）；
3. 有没有 `no Weixin account is saved`（凭证不在）或 `is already being listened to`（重复触发，正常）；
4. 凭证是否被服务端拒绝：`getUpdates errcode=-14` 表示登录已过期，需要重新扫码。

换绑到新机器人（token 变了）时，插件会**先停掉旧的长轮询再启动新的**：同一凭证上跑两条长轮询会让
服务端把入站消息**分摊**给两条循环，而不是各收一份。

## 授权（重要）

微信文本**不是**授权凭据。因此：

- `allowedSenders` 默认**空**，等于拒绝所有人——没配白名单的插件什么都不驱动；
- 不在白名单的发信人只记一条 warn，不创建会话、不回消息；
- 真实的文件修改/命令执行仍由 DSH 自己的权限层与确认流程决定，本插件不旁路。

## 配置

`cordis.patch.yml` 里那行的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭即不启动长轮询 |
| `accountId` | `''` | 空 = 只用唯一已保存账号 |
| `cwd` | `''` | Agent 工作目录；空 = 继承会话默认 |
| `allowedSenders` | `[]` | 允许驱动 Agent 的微信用户 id |
| `allowedChats` | `[]` | 会话白名单；空 = 不限制会话 |
| `maxMessageLength` | `1500` | 单条出站消息字符上限 |
| `markdownMode` | `'strip'` | 回复的 Markdown 处理：`strip` 转微信可读纯文本，`off` 原样发送 |
| `progressAfterMs` | `45000` | 超时前发一条进度提示 |
| `maxTurnWaitMs` | `1200000` | 等待一轮的上限 |
| `typingIndicator` | `true` | 有 typing ticket 时显示“正在输入” |
| `mediaEnabled` | `true` | 把回复里引用的本地文件作为附件发出（出站） |
| `maxMediaBytes` | `104857600`（100MB） | 出站附件大小上限 |
| `maxInboundMediaBytes` | `20971520`（20MB） | 入站附件下载大小上限 |
| `cdnBaseUrl` | 空（未配置） | 入站下载与出站上传的 CDN 根。留空表示「这里没配」：会先用账号记录里的 `cdnBaseUrl`，再退回上游默认 `https://novac2c.cdn.weixin.qq.com/c2c` |
| `asr.modelDir` | `''` | 语音模型目录；空 = `~/.dsh/weixin/asr-models`。设置页的输入框会覆盖它（并写进 `<stateDir>/asr-config.json`） |

改完配置重载插件即可。

## 入站媒体（微信发来的图片/文件/语音/视频）

用户发来的媒体会**先过白名单和去重，再**从 CDN 下载——未授权的发信人不会让本机对 CDN 发起任何请求
（`test/e2e.test.js` 里有一条断言守着这点）。下载后按 AES-128-ECB 解密，存到
`<stateDir>/media/inbound/`（默认 `~/.dsh/weixin/media/inbound/`），再把**本地绝对路径 + 用哪个工具读**
拼进交给 Agent 的 prompt：图片提示 `read_image`，文件/视频提示 `read`。微信图片带的 caption 会一并
保留，所以 Agent 既有图也有问题。

两个安全要点：

- **对端给的文件名绝不用来拼路径。** 文件名先取 basename、去掉分隔符与 `.`/`..` 段，再加随机前缀，
  写盘用 `wx` 独占模式。`../../etc/passwd` 只会变成 `a1b2c3d4-passwd` 落在收件目录里，逃不出去。
- **大小先按 `Content-Length` 判、读完再按实际字节判一遍。** 头部可以缺、也可以撒谎，两道都要过。

失败**不静默**：下载失败会把具体原因回给用户（如 `CDN returned 403`、`30.0MB，超过 20.0MB 上限`），
而不是笼统的「暂不支持」。真正未知的 item 类型（如 `TOOL_CALL_*`）才保留「暂不支持」提示。

语音是微信 SILK 格式。插件会尝试用上游的 `silkToWav` 转成 WAV；`silk-wasm` 现在是
`optionalDependencies` 里的一项（已装则可用；卸载或安装失败不影响插件加载，会走降级路径）。
`silk-wasm` 缺失时按上游行为把原始 `.silk` 存下来并把路径交给 Agent，回复中说明这是未转码的
SILK。

### 语音识别（ASR）

转成 WAV 之后可以再交给一个常驻的 ASR 桥进程，真正做到「听懂」。桥是一个**行协议**子进程：
stdin 每行一个 `{"wav":"/绝对路径.wav"}`，stdout 每行一个 `{"ok":true,"text":"..."}` 或
`{"ok":false,"error":"..."}`。进程**常驻复用**——每条语音起一个新 Python 进程要付 15–25 秒冷启动，
不可接受。

```yaml
asr:
  enabled: true
  command: /path/to/your/venv/bin/python3      # 你自己的 Python 环境
  args: [/path/to/your/asr-server.py]          # 一个按行收发 JSON 的转写服务
  timeoutMs: 60000
  modelDir: /path/to/models                    # 模型目录（设置页里也能改，见下）
  env:
    HF_HOME: /path/to/your/model-cache         # 模型缓存放哪（可能很大）
```

### 模型目录可以自定义

设置页的「语音模型」区块里，目录是一个**可编辑输入框**：

- 改完点「设置目录」，host 端会 `mkdir -p` 并记住这个路径，重启后仍然生效
  （写在 `<stateDir>/asr-config.json`）；
- 该目录同时驱动**下载**和**转写**两端：下载的模型落到 `<目录>/<repo>`，
  转写时 `HF_HOME` 与 `DSH_WEIXIN_ASR_MODEL` 都指向这个目录，所以下载完就能直接用，
  不用再去改配置文件；
- 配置里的 `asr.env.HF_HOME` / `asr.env.DSH_WEIXIN_ASR_MODEL` 优先级更高——
  手写过的值不会被界面覆盖。


**本仓库不含 ASR 服务端。** 插件只带客户端：它按上表调用你的 `command`，把 WAV 路径写进 stdin，
从 stdout 逐行读 JSON 响应。服务端要自己提供（约 30 行 Python），任何能完成
「读一行 `{"audio_path": "..."}` → 写一行 `{"ok": true, "text": "..."}`」的进程都可以，
模型可以用 `mlx-whisper` / `faster-whisper` / 云端 API——插件不关心。

之所以不内置：模型约 670MB，且 Apple Silicon 上的最优方案（MLX）不跨平台。把它塞进仓库会让
绝大多数用户下载几百 MB 却用不上。默认 `asr.enabled: false`，不配就完全没有这条链路。

`command` 为空即关闭识别，语音只作为文件交付。三条降级互不影响，Agent 收到的说明能区分
「没装转码模块」「转码了但桥失败」「识别出来但是空的」：

| 情况 | 交付给 Agent 的内容 |
| --- | --- |
| 识别成功 | `【语音转写】` + 用户原话（明确标为「均按用户原话处理」） |
| 识别为空 | 明说未识别出内容，并**要求不得臆测**——空结果不许编 |
| 桥失败/超时 | 仍给出 WAV 路径，附失败原因 |
| 无 `silk-wasm` | 给出 `.silk` 路径，说明未转码 |

桥在请求中途崩溃会被自动重启，只影响当前这一条（该条降级），后续请求照常。`timeoutMs` 是
**兜底**而不是延迟目标——冷启动加载模型可以到几十秒，所以默认 60s；热调用实测约 294ms。

> 本机实测：`2ee80de6-voice.silk`（3830 字节）→ WAV 113324 字节 → 转写「你是谁」。
> 模型缓存在 `HF_HOME` 指定的位置（stationData 卷），**不要**让它落到系统盘。

## Markdown 处理

微信不渲染 Markdown，`**加粗**`、`##### 标题`、`![图](路径)` 会原样显示。出站链路因此先把回复
转成纯文本，**再**按 `maxMessageLength` 分片——顺序不能反，否则分片长度会按未转换的文本计算而超限。

`markdownMode` 为 `strip`（默认）时复用 upstream 的 `StreamingMarkdownFilter`
（`vendor/openclaw-weixin/messaging/markdown-filter.js`），规则完全与上游一致：

| 保留 | 剥离（标记去掉、内容保留） |
| --- | --- |
| `**加粗**`、`___加粗___` | CJK 内容的斜体/粗斜体标记 |
| 代码围栏 ```、行内代码 `` ` `` | H5/H6 标题（`#####`、`######`） |
| 表格 `\|…\|`、分隔线 `---` | 图片 `![alt](url)`（整段移除） |
| 非 CJK 内容的斜体 | |

空白字符（空行、行尾换行、CRLF）逐字节保留。`markdownMode: 'off'` 时原样发送，便于排障与对照。

> 注意：`![alt](路径)` 同时是**出站附件**语法。开启 `mediaEnabled` 时该引用会先交给媒体层上传，
> 文本里只剩 alt 文本；`stripMediaReferences` 已在媒体步骤处理掉的部分不会再进入 Markdown 过滤器。

## 开发

```bash
npm test                       # node --test "test/**/*.test.js"
node bin/login.js              # 真实扫码登录
```

本地 dev 需要把 DSH 的 `@deepseek-ai/{schemastery,cosmokit,dsh-llm}` 软链到 `node_modules/@deepseek-ai/`
（它们在 profile 里，不是公开 npm 包）：

```bash
mkdir -p node_modules/@deepseek-ai
ln -sfn ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery
ln -sfn ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/cosmokit    node_modules/@deepseek-ai/cosmokit
ln -sfn ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm            node_modules/@deepseek-ai/dsh-llm
```

## 文档

- [实施方案](docs/plan.md)
- [移植审查清单](docs/hermes-port-audit.md)
- [进度记录](docs/progress.md)
- [安全策略](docs/security.md)
- [第三方代码](THIRD-PARTY-NOTICES.md)
