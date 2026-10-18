# dsh-plugin-weixin

[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-zh.svg)](https://dsh.market/)

<img src="assets/icon-128.png" width="72" alt="dsh-plugin-weixin 图标" />

把**个人微信**变成 DeepSeek Harness（DSH）的远程控制面：在微信里发一句话，DSH Agent 在本地开一个会话执行，把结果回给你。

底层用的是微信 **iLink Bot API**（`ilinkai.weixin.qq.com`），传输层来自腾讯官方开源插件
[`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)（MIT，2.4.10），
本项目把它 vendor 进 `vendor/openclaw-weixin/`，剥掉 OpenClaw 的耦合后直接绑定到 DSH 的 `agents` 服务。

![dsh-plugin-weixin：在微信里与 DSH Agent 对话](assets/hero.png)

![一条语音的旅程：SILK 转码、本地 ASR、逐级降级](assets/voice-pipeline.png)

## 当前状态

**已真机验证**：插件加载、扫码登录、长轮询收消息、白名单、去重、开 DSH 会话、读回复、分段回发、
“正在输入”、入站图片与文件、入站语音**识别成文字**（SILK → WAV → ASR，热调用约 300ms）、
**一个会话下多条 DSH 会话**（`/new`、`/list`、`/use`，切换保留上下文）。

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

当前已发布版本：[`dsh-plugin-weixin@0.6.0`](https://www.npmjs.com/package/dsh-plugin-weixin)。

- **0.7.0** —— TODO: describe what changed in this release.
- **0.6.0** —— **产出文件自动送达**：agent 在回合中写进工作目录的文件（截图、转换的 PDF 等）即使回复里没提到，也会直接发到微信（`autoSendFiles` 可关）；**模型调用失败不再卡住会话**：失败原因立即回给你，下一条消息马上正常处理（此前会空等 20 分钟并把后续消息全部压在队列里）。
- **0.5.0** —— 新增 `/clear` 清空当前会话并重开；出站附件收件人在转接处被丢成 `to=undefined` 的修复（自 0.1.0 起插件驱动的附件上传一直如此失败）；入站长轮询 body 挂死的看门狗（手机显示「暂无法连接 openclaw」的根因）；PDF/Word 等文档以 markdown 链接写出时也能送达；schema 默认值不再覆盖设置页保存的 ASR 命令。
- **0.4.0** —— 一个微信会话可挂多条 DSH 会话（`/new`、`/list`、`/use`，切走不销毁）；**全部配置项都能在设置页里看和改**；会话列表里给本插件开的会话加微信图标；二维码不再依赖 python 或未声明的包（Windows 修复）；出站相对路径按 agent 工作目录解析。
- **0.3.0** —— 仓库自带 ASR 桥，语音识别开箱可用（详见[语音识别](#语音识别asr)）。
- **0.2.0** —— 忙时排队/插话、超时补发、来源块、设置卡进入宿主 Settings。
- **0.1.0 / 0.1.1** —— 首发：扫码轮询、登录后自动起入站循环、白名单合并、归档会话自动恢复。

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
- 二维码在**任何平台**都能画出来，不需要装 python、也不需要额外装包：二维码矩阵取自
  `qrcode-terminal`（本就是依赖），PNG 由 `src/png.js` 只用 `node:zlib` 手工编码。
  早先的实现先找 npm `qrcode`、再找 `python3`——前者从来不是依赖、后者 Windows 上根本没有，
  所以 Windows 用户看到的是一个**破图图标**而不是二维码。现在这条路被测试钉死了；
- 万一真的画不出图，卡片会**说明「二维码图片不可用，请点下面的在浏览器打开」**，而不是把
  登录链接塞进 `<img>` 显示一个破图；
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

### 多账号管理

多个账号可以同时登录（`node bin/login.js --account work` 逐个添加，或在设置卡点
**新增账号登录**逐个扫码）。每个已保存的账号都有**自己的入站循环**：一个账号的
凭证过期、登录或退出，不影响其他账号的收发。会话也按账号隔离——同一个微信会话
在两个账号下是两条独立的会话线，`/list`、`/use` 只作用于收信账号自己的线。

「设置 → 微信」的登录卡会列出每个账号一行：备注名（或账号 id）、最近活跃时间
（「刚刚 / N 分钟前 / N 小时前 / N 天前」）、暂停标记，以及三个操作：

- **Rename** —— 给账号起个备注名（如「工作号」），只影响显示，存本机
  `~/.dsh/weixin/accounts-registry.json`。编辑在卡片内完成：点「改名称」后账号行
  下方出现输入框，**保存**生效、**取消**放弃（桌面端弹不出浏览器式 prompt，所以
  是内联编辑，不是弹窗）；
- **Allowlist** —— 给这一个账号单独设置允许的发送者（逗号分隔，预填当前生效
  列表）。留空 = 清除覆盖、回退全局白名单；改动**立即生效**，不需要重载。生效
  规则是账号覆盖优先于全局 `allowedSenders`；
- **Pause / Resume** —— 暂停一个账号的收信（凭证保留，手机上仍是绑定状态）。
  暂停**立即生效**，不需要重载；被暂停的账号在日志里有明确一行
  （`account "<id>" is paused; not starting its loop`），刻意静音不会被误读成故障；
- **Log out** —— 只退出这一个账号，其他账号照常收发。

登记表是纯元数据：文件损坏最多丢备注和暂停标记，绝不影响消息收发。

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

**这些选项现在都能在设置页里改**：打开「设置 → 微信」的 **配置项** 标签页，逐项编辑、
保存。表单直接读插件自己的 schema，所以每个选项都带默认值、当前值和它从哪来
（`default` / 来自 `config` / 已保存），改动过但没保存的项会标出来。保存只写你改过的那几项，
写入 `~/.dsh/weixin/config.json`（与凭证放在一起，重装插件不会丢）。

优先级：**界面保存的值 > `cordis.patch.yml` 里的 `config` > schema 默认值**。
想放弃某次修改，点该项的「恢复默认」。

只有两项在界面上是只读的：

- `maxTurnWaitMs` —— 调低它会静默截断长回复，不适合当日常开关；
- `enabled` —— 它是插件的总开关，改它请改 YAML（关掉后设置页仍然可用，
  方便你先配好再打开）。

**产出文件自动送达**：Agent 在回合中写进工作目录的文件（截图、转换的文档、导出的数据等）
在回复送出后自动发到微信，不需要再发一条「发我微信」——即使回复文本没有引用这些文件。
只认可投递的扩展名（图片/文档/音视频），不递归子目录；`mediaEnabled` 关闭时同样不生效。
设置页「媒体 → 产出文件自动送达」可关闭。


## 会话（一个微信会话可以用多条 DSH 会话）

一个微信会话默认只对应一条 DSH 会话，聊久了上下文会一直变长。插件支持**会话线**：
同一个微信会话下可以有多条 DSH 会话，每条有自己的上下文，互不影响。

在微信里直接发命令（整条消息恰好是命令才生效，`看看 /new 这个命令`、`/steer /new` 都不算）：

| 命令 | 作用 |
| --- | --- |
| `/new` | 开一条新会话，接下来的消息进入它 |
| `/list` | 列出当前会话下的所有会话线，`▶` 标出正在用的那条 |
| `/use <序号>` | 切到第 N 条（序号来自 `/list`） |
| `/clear` | 清空当前会话并重新开始：这条线从 `/list` 里移除，立刻开一条全新的 |

**切换是保留的，不是重置**：切走的那条不会被结束或清空，切回来时它之前的上下文原样都在。
`/list` 里的序号是**绝对序号**（从 1 数起），所以即使只显示最近 10 条，序号也不会因为折叠而错位。

`/clear` 是唯一会丢上下文的命令，所以它只作用于「当前正在用的那条」且不带参数——
`/clear 3` 这类写法不会被识别。被清掉的那条只是从会话线列表里移除，之后 `/use` 也切不回去；
宿主那边的会话文件原样保留，不删任何历史记录。

命令由插件直接回，**不消耗模型对话**：发 `/new` 不会在会话里留下一轮问答。

两条已确立的事实：

- **升级不会丢上下文**。第一条会话线沿用历史 id（`weixin-<会话 slug>`），装了新版本后老会话仍然是那条；
- 存放位置是 `<stateDir>/sessions.json`（默认 `~/.dsh/weixin/sessions.json`），删掉它等于只保留一条默认会话线。

### 在设置页管理

DSH 设置页的插件卡片里有「会话」标签：列出每个微信会话下的会话线、标出正在用的那条，
并可以点「切换」跳到某一条——不用回到微信里敲 `/use`。每条会话线都有
**「删除」** 按钮（确认后生效）：只从列表移除那一条线，其他线不受影响；删除正在使用的线时，
自动回退到剩下第一条；删掉最后一条线等于移除整个会话条目，下一条消息会自动新建一条干净的
会话线。每个会话条目上还带**账号标识**（多账号各自的备注名或账号 id），一眼区分哪条会话属于
哪个账号；升级前的历史会话（不带账号前缀）不显示标识。改动实时生效，不需要重载。
卡片只读该文件，改的也是它，和微信里发命令是同一条路径，所以两边看到的永远一致。

### 会话列表里怎么认出微信会话

工作区左侧的会话列表里，**本插件开的会话**行首会带一个微信图标（14px，微信品牌绿 `#07C160`），
一眼能从别的会话里分出来。

多账号下，会话线的**标题本身**就带账号标识：新建的会话线标题形如
`备注名: 第一条消息`（没有备注名时用账号 id 短形式），侧栏、`/list` 和设置卡片看到的是同一
份标题，不需要额外的行内标记。升级前的历史会话标题保持原样，不带前缀。这条标题还会在
第一条消息时**同步写入宿主会话**（`sessionTitle.rename`，user 来源钉住），所以宿主侧栏
显示的也是这条 `备注名: 消息`，而不是宿主自己起的 AI 标题；此后宿主不再自动改名。

判定只看会话 id 的前缀 `weixin-`：本插件开的是 `weixin-<会话 slug>`，同一会话的第二条线是
`weixin-<会话 slug>--<时间戳>`；别的会话用的是 DSH 自己的 `session-<uuid>`，不会被错标。

这个图标挂在宿主声明的槽位 `sidebar.session.row.leading` 上。该槽位由 ui-workspace 提供给
**每一行**会话，只在行处于 idle 时渲染，归档行留空，搜索结果没有这个位置；宿主自己的定时任务
时钟（ui-schedule）也占这个位置——本插件用**独立的座位 id**，所以两者能共存，不会互相顶掉。

对不是本插件开的会话，组件返回 `null`——一个像素都不占，也不会给别人的会话贴上微信图标。

多账号下，图标旁边还会有一段**很淡的归属提示**：这行会话属于哪个微信账号，取设置页里给
账号起的备注名（没起就用账号 id），最多显示 6 个字符、超出带省略号。归属来自卡片同一份
`/api/weixin/sessions` 数据，所以只有能对上某个账号的会话才显示；升级前的历史会话对不上号，
保持只有图标。提示和图标一样是装饰性的，不参与布局之外的任何行为。

## 出站附件（插件发给你的图片/视频/文件）

Agent 在回复里**引用本地文件**时，插件会把文件上传并作为附件发出。认哪些写法取决于**扩展名**：

```markdown
![说明](图片.png)              ← 图片语法，任何扩展名都认
![说明](/abs/path/a.png)
![说明](<带 空格的路径.png>)     ← 路径有空格时用尖括号包起来
[报告](报告.pdf)               ← 链接语法：只对「天然就是附件」的扩展名生效
报告.pdf                       ← 单独成行/列表项的相对路径：同样是附件类才认
/abs/path/a.pdf                ← 单独成行的绝对、~/、C:\ 路径：任何扩展名都认
```

**不引用也会送达**（`autoSendFiles`，默认开）：agent 在回合中写进其工作目录的文件——
桌面截图、转换好的 PDF、导出的数据——在回复送出后会自动发到你微信，即使回复文字里
完全没提到它。边界：只扫工作目录第一层（`tools/`、`crops/` 等子目录不卷入），只送
可投递的扩展名，每回合最多 5 个、新者优先；回复里已引用过的文件不重复发送；设置页
「媒体 → 产出文件自动送达」可关。

**为什么分两种待遇**：微信回复里没有任何东西会内联渲染一个 PDF，所以 `[报告](报告.pdf)` 只可能
是「把文件发我」；但 `[截图](icon.png)` 可能只是 agent 在**指路**，把它当上传会把无关图片甚至源码
树发出去。附件类的完整名单见 `ATTACHMENT_EXT`（`src/media/outbound.js`）：`pdf doc(x) xls(x)
ppt(x) csv zip tar gz 7z rar mp3 wav m4a ogg mp4 mov webm mkv avi silk`。

这些**不**认：行内代码与代码块里的路径（那是在**展示**语法）、行内正文里的裸路径（如「文件在
/tmp/a.pdf 里」）、`![x](带 空格.png)`（未用尖括号包裹）、`https://` 之类的网络图片——网络图片
本来就不该由插件上传。

发出的形式按 **MIME** 决定（不是扩展名）：

| 类型 | 扩展名 | 你会收到 |
| --- | --- | --- |
| 图片 | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.bmp` | 图片消息 |
| 视频 | `.mp4` `.mov` `.avi` `.mkv` `.webm` | 视频消息 |
| 其他 | 其余一切（含 `.pdf` `.zip` `.docx`，也含 `.svg` `.heic` `.m4v` `.wav`） | 文件附件 |

注意第三行：`getMimeFromFilename` 不认 `.svg` `.heic` `.tif` `.avif` `.m4v` `.3gp` `.flv` `.wmv`，
它们会**降级成文件附件**——能收到，但没有原生图片/视频气泡。想要原生效果，挑第一、二行的扩展名。

单文件上限 **100MB**（`maxMediaBytes` 可调），一条回复最多 5 个附件。发不出去时不会吞掉回复：
失败原因会作为一行附在文字后面。

文件必须在**允许的目录**里：agent 会话的工作目录，或 `~/.dsh/weixin`。路径经 `realpath` 后再判包含，
符号链接指向目录外也会被拒，`..` 逃逸按原文判定。放宽「引用识别」不改变这个边界——识别只决定
「要不要尝试发」，能不能读始终由目录检查决定。详见 `docs/security.md`「出站附件」。

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
  command: python3
  args: [bin/asr-bridge.py]                    # 仓库自带的桥（相对路径按插件目录解析）
  timeoutMs: 60000
  modelDir: /path/to/models                    # 模型目录（设置页里也能改，见下）
  env:
    DSH_WEIXIN_ASR_LANGUAGE: zh                # 固定语言；不填则自动检测
```

**YAML 和设置页的关系**：设置页写的是 `<stateDir>/config.json`，它比 YAML 更新，
所以同一个字段两边都写了时以设置页为准；只有设置页里是空值（`''`、`[]`、`{}`）
时才回落 YAML。改动照例需要重启 DSH 才被重新读取。

> **踩过的坑（0.4.0 及以前）**：宿主导入插件时传进来的 config 是经过 schema 实例化的，
> `asr.command` 这类字段即使你没配也会带着空字符串默认值。旧版本对这个段落只做浅展开合并，
> 空默认值会盖掉设置页里的真命令——表现是设置页明明写着命令、语音却一直回
> `no ASR bridge is configured`。现在按字段判定，存档非空即优先。

### 仓库自带一个桥：`bin/asr-bridge.py`

不想自己写桥的话，直接用仓库里这个。它实现了上面那份行协议，并自动在两个引擎里挑一个：

| 引擎 | 何时生效 | 安装 | 热调用实测 |
| --- | --- | --- | --- |
| **mlx-whisper** | 能 import 时优先（Apple Silicon） | `pip install mlx-whisper` | **0.29s**（3.7s 音频，M4 GPU） |
| **faster-whisper** | 其它平台 / 没有 mlx 时 | `pip install faster-whisper` | 5.3s（同一段音频，Rosetta CPU） |

两者都支持，是因为它们在真实机器上的差距很大：同一台 M4 上，mlx 走 GPU 比 x86_64 Python 走 CPU
快 **18 倍**。桥自己挑，用户不需要关心。

模型下载走设置页的「语音模型」区块（它按你选的镜像源下载）。**下载完就能直接用**：桥发现
`<模型目录>/mlx-community__whisper-small-mlx`（或 `Systran__faster-whisper-small`）存在时就从磁盘
加载，不发任何网络请求。这一点是刻意的——`huggingface_hub` 的元数据探测（一次到 CDN 重定向的
HEAD 请求）在某些镜像上会以 SSL EOF 失败，而普通 GET 正常；从磁盘加载完全绕开这一步。

安装（按你的机器选一个）：

```bash
pip install mlx-whisper        # Apple Silicon，走 GPU
pip install faster-whisper     # 其它平台，走 CPU
```

然后照上面的 YAML 配 `command` + `args` 即可。环境变量（都可选）：

| 变量 | 作用 |
| --- | --- |
| `DSH_WEIXIN_ASR_MODEL` | 尺寸：`tiny`/`base`/`small`/`medium`/`large-v3`（默认 `small`） |
| `DSH_WEIXIN_ASR_LANGUAGE` | 固定语言（如 `zh`）；不填则自动检测 |
| `DSH_WEIXIN_ASR_MODEL_DIR` | 模型目录（默认 `~/.dsh/weixin/asr-models`） |
| `DSH_WEIXIN_ASR_MODEL_PATH` | 直接指定模型目录或 repo，优先级最高 |
| `DSH_WEIXIN_ASR_PROMPT` | 初始提示词，默认一句普通话样本（见下） |
| `HF_ENDPOINT` | 直连不通时设为 `https://hf-mirror.com` |

**为什么要给初始提示词**：whisper 对中文会输出**繁体**。默认提示词是一句普通的普通话样本，
把输出钉在简体上——这是实测出来的（`今天天氣不錯` → `今天天气不错`），不是猜的。

**为什么非语音会返回空**：纯音调/静音会让 whisper 编出内容（测试中出现过 `字幕by索兰娅` 这种
字幕署名）。桥会识别「整段都没有语音」，返回空字符串——空是诚实的答案，插件会转成「没听清」，
而不是把编出来的词当成用户说的话。

### 模型目录可以自定义

设置页的「语音模型」区块里，目录是一个**可编辑输入框**：

- 改完点「设置目录」，host 端会 `mkdir -p` 并记住这个路径，重启后仍然生效
  （写在 `<stateDir>/asr-config.json`）；
- 该目录同时驱动**下载**和**转写**两端：下载的模型落到 `<目录>/<repo>`，
  转写时 `HF_HOME` 与 `DSH_WEIXIN_ASR_MODEL` 都指向这个目录，所以下载完就能直接用，
  不用再去改配置文件；
- 配置里的 `asr.env.HF_HOME` / `asr.env.DSH_WEIXIN_ASR_MODEL` 优先级更高——
  手写过的值不会被界面覆盖。


**桥是可选的，也可以自己写。** 插件只依赖上面那份行协议：它调用你的 `command`，把 WAV 路径写进
stdin，从 stdout 逐行读 JSON。任何满足「读一行 `{"wav": "..."}` → 写一行
`{"ok": true, "text": "..."}`」的进程都行，模型可以是 `whisper.cpp`、云端 API、或任何别的——
插件不关心。仓库自带的 `bin/asr-bridge.py` 只是把最常见的那条路铺好。

默认 `asr.enabled: false`，不配就完全没有这条链路。

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

## 发布

一条命令做完整条发布链路（校验 → 测试 → 改版本号 → 打包核验 → 发布 → 打标签 → GitHub Release）：

```bash
npm run release 0.4.0 -- --dry-run   # 预演：不提交、不发布，跑完还原工作区
npm run release 0.4.0                # 正式发布
```

脚本按「实际能跑通的顺序」执行，每一步都对应一次手工发布踩过的坑：

| 步骤 | 做什么 | 为什么 |
| --- | --- | --- |
| 预检 | 工作区干净、在 main、与 origin 同步、版本未发布过、npm 已登录、**已发布版本都有对应 tag** | `git describe` 靠 tag 定位上一版；漏打 tag 会让本次 Release Notes 把上一版内容重复报一遍（0.3.0 就漏打过） |
| 测试 | `npm test` 必须全绿 | 发布不能带着红灯 |
| 版本号 | 改 `package.json`，同步 README 的「当前已发布版本」行与版本列表 | README 曾长期写着 0.1.0 而 npm 上已是 0.2.0 |
| 打包核验 | `npm pack` 后检查文件清单（不缺 `bin/asr-bridge.py`、无 `__pycache__`/测试文件），并**在临时解压目录里真跑一次 `bin/asr-bridge.py`** | 证明要上传的那个包本身可用，而不只是测试通过 |
| 提交 | 一个 `chore(release): x.y.z` 提交 | |
| 发布 | `npm publish`，然后**轮询 registry 直到版本真的可见** | npm 会先返回成功、再异步处理上传；立刻查询读到的是旧版本，看起来像失败 |
| 核验 | 比对 registry 的 `dist.shasum` 与本地 tarball | 确认线上包就是本地构建的那个 |
| 标签 | 打 `v x.y.z`、推 main 与 tag、按提交日志生成 GitHub Release | |
| 安装 | `node bin/install.mjs --profile $DSH_PROFILE` | 本机自测 |

三点注意：

- **必须从真实终端运行**。`npm publish` 可能要求浏览器里输入一次性密码（OTP）；stdout 不是 TTY 时 npm 会把认证链接打码（`***`），这一步无法自动化。
- 预演（`--dry-run`）会真实执行打包与桥的冒烟测试，但结束前还原 `package.json`/`README.md` 并删掉 tarball，工作区保持原样。
- 新版本会在 README 版本列表顶部插入一条 `TODO` 文案的条目；**把它改成这次的实际内容再提交**（脚本会明确提示）。

## 文档

- [实施方案](docs/plan.md)
- [移植审查清单](docs/hermes-port-audit.md)
- [进度记录](docs/progress.md)
- [安全策略](docs/security.md)
- [第三方代码](THIRD-PARTY-NOTICES.md)
